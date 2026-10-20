//! PipeWire screen capture for Wayland sessions.
//!
//! The XDG ScreenCast portal grants a PipeWire remote fd and a node id;
//! this module runs a PipeWire `MainLoop` on a dedicated thread, negotiates a
//! raw-video format, and pushes tightly-packed frames across an OS pipe into
//! the FFmpeg child (`-f rawvideo -i pipe:3`), which encodes and muxes exactly
//! like the `x11grab` path. `SPA_META_Cursor` metadata is forwarded into the
//! shared cursor snapshot so the cursor tracker works under Wayland.
//!
//! Structure:
//!   portal (D-Bus) ──► node_id + remote fd ──► pw MainLoop thread
//!        └─► tightly-packed frame ──► channel ──► writer thread ──► pipe ──► ffmpeg

use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use pipewire::context::ContextBox;
use pipewire::keys;
use pipewire::main_loop::MainLoopRc;
use pipewire::spa;
use pipewire::spa::buffer::meta::MetaCursor;
use pipewire::spa::param::format::FormatProperties;
use pipewire::spa::param::video::{VideoFormat, VideoInfoRaw};
use pipewire::spa::param::ParamType;
use pipewire::spa::pod::serialize::PodSerializer;
use pipewire::spa::pod::{ChoiceValue, Object, Pod, Property, Value};
use pipewire::spa::utils::{
    Choice, ChoiceEnum, ChoiceFlags, Direction, Fraction, Id, Rectangle, SpaTypes,
};
use pipewire::stream::{StreamBox, StreamFlags, StreamState};
use tracing::{debug, info, warn};

use super::cursor_v2::{update_pipewire_cursor_metadata, PipeWireCursorSnapshot};
use super::linux_portal::{
    PortalCursorMode, PortalScreenCastSession, PortalSessionNegotiator, PortalSourceType,
};
use super::source::{Bounds, CaptureSource};
use crate::capture::config::RecordingProfile;
use crate::errors::{InternalError, Result};

/// How long `start` waits for the compositor to settle on a video format after
/// the stream connects. A missing format means the stream is broken — better
/// to fail fast than to feed FFmpeg nothing.
const FORMAT_NEGOTIATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// In-flight frame queue depth. At ~8 MiB/frame (1080p BGRA) this caps the
/// steady-state capture overhead at ~24 MiB.
const FRAME_QUEUE_DEPTH: usize = 3;

/// Message that asks the PipeWire main loop to quit (cross-thread control).
#[derive(Debug)]
struct Terminate;

/// A tightly-packed video frame ready for `rawvideo` consumption.
struct PackedFrame(Vec<u8>);

pub use super::ffmpeg::PipeWireVideoInput;

/// A running Wayland screen capture. Dropping it stops the PipeWire loop and
/// joins the worker threads; the portal session closes with it, clearing the
/// compositor's recording indicator.
pub struct LinuxPipeWireCapture {
    input: PipeWireVideoInput,
    /// Read end is handed to ffmpeg via dup2; keep alive until the child
    /// inherits it — Drop closes it which also signals EOF on the pipe.
    _read_fd: OwnedFd,
    stop_tx: pipewire::channel::Sender<Terminate>,
    /// Stop signal for the frame writer — lets it abandon a pipe that no
    /// reader is draining instead of sleeping in `write` forever.
    stop: Arc<AtomicBool>,
    pw_thread: Option<JoinHandle<()>>,
    writer_thread: Option<JoinHandle<()>>,
    _portal: PortalScreenCastSession,
}

impl LinuxPipeWireCapture {
    /// Negotiate a Wayland capture: portal dialog → PipeWire stream → frame
    /// pipe. Returns `None` when the session is not Wayland or the source kind
    /// isn't a screen/window/region (webcam stays on v4l2).
    ///
    /// Blocks while the user interacts with the source-picker dialog — call
    /// sites run on the capture worker thread, never the UI thread.
    pub fn start_if_wayland(
        source: &CaptureSource,
        profile: &RecordingProfile,
    ) -> Result<Option<Self>> {
        if !matches!(source.kind.as_str(), "display" | "window" | "region") {
            return Ok(None);
        }
        if !super::linux_portal::is_wayland_session() {
            return Ok(None);
        }
        Self::start(source, profile).map(Some)
    }

    fn start(source: &CaptureSource, profile: &RecordingProfile) -> Result<Self> {
        // The region picker picked a rectangle inside one monitor; the portal
        // still streams the whole monitor and we crop in the filter chain.
        let source_type = if source.kind == "window" {
            PortalSourceType::Window
        } else {
            PortalSourceType::Monitor
        };

        let negotiator = PortalSessionNegotiator::new()
            .with_source_type(source_type)
            .with_cursor_mode(PortalCursorMode::Metadata);
        let mut portal = PortalScreenCastSession::open(&negotiator.options)?;
        let stream_info = portal
            .state()
            .streams
            .first()
            .cloned()
            .ok_or_else(|| InternalError::Capture("portal granted no streams".into()))?;
        let pw_fd = portal.take_pipewire_fd();

        let (read_fd, write_fd) = super::frame_pipe::create()?;

        let (frame_tx, frame_rx) = mpsc::sync_channel::<PackedFrame>(FRAME_QUEUE_DEPTH);
        let (format_tx, format_rx) = mpsc::channel::<PipeWireVideoInput>();
        let (stop_tx, stop_rx) = pipewire::channel::channel::<Terminate>();
        let (error_tx, error_rx) = mpsc::channel::<String>();
        let stop = Arc::new(AtomicBool::new(false));

        let writer_stop = Arc::clone(&stop);
        let writer_thread = std::thread::Builder::new()
            .name("rf-pw-writer".into())
            .spawn(move || run_frame_writer(frame_rx, write_fd, writer_stop))
            .map_err(|e| InternalError::Capture(format!("spawn pipewire writer: {e}")))?;

        let node_id = stream_info.pipewire_node_id;
        let target_fps = profile.fps.max(1);
        let pw_thread = std::thread::Builder::new()
            .name("rf-pw-mainloop".into())
            .spawn(move || {
                run_pipewire_loop(
                    pw_fd, node_id, target_fps, format_tx, frame_tx, stop_rx, error_tx,
                )
            })
            .map_err(|e| InternalError::Capture(format!("spawn pipewire loop: {e}")))?;

        // Wait for the negotiated format before building the FFmpeg command —
        // the -video_size/-pixel_format/-framerate args depend on it.
        let mut input = match format_rx.recv_timeout(FORMAT_NEGOTIATION_TIMEOUT) {
            Ok(mut input) => {
                input.read_fd = read_fd.as_raw_fd();
                input
            }
            Err(_) => {
                let _ = stop_tx.send(Terminate);
                stop.store(true, Ordering::Release);
                let error = error_rx
                    .recv_timeout(std::time::Duration::from_millis(1500))
                    .unwrap_or_else(|_| "PipeWire stream produced no format".to_string());
                // Writer/pw threads are joined by the partial-capture teardown
                // below — same work Drop does.
                let _ = pw_thread.join();
                let _ = writer_thread.join();
                return Err(InternalError::Capture(format!(
                    "PipeWire format negotiation failed: {error}"
                ))
                .into());
            }
        };

        // Region capture crops the monitor stream down to the picked rect
        // (translated into stream-local coordinates and clamped/even-aligned).
        if source.kind == "region" {
            let stream_x = stream_info.position.map_or(0, |p| p.0);
            let stream_y = stream_info.position.map_or(0, |p| p.1);
            input.crop = compute_region_crop(
                source.bounds,
                (stream_x, stream_y),
                (input.width, input.height),
            );
        }

        // SPA_META_Cursor positions are stream-local — the cursor tracker's
        // coordinate space must match the frame FFmpeg receives. That is the
        // crop rect for region captures, else the full stream surface.
        set_wayland_stream_geometry(input.crop.unwrap_or(Bounds {
            x: 0,
            y: 0,
            width: input.width as i32,
            height: input.height as i32,
        }));

        info!(
            node_id,
            pix_fmt = input.pixel_format,
            size = %format!("{}x{}", input.width, input.height),
            crop = ?input.crop,
            "Wayland PipeWire capture negotiated"
        );

        Ok(Self {
            input,
            _read_fd: read_fd,
            stop_tx,
            stop,
            pw_thread: Some(pw_thread),
            writer_thread: Some(writer_thread),
            _portal: portal,
        })
    }

    pub fn video_input(&self) -> PipeWireVideoInput {
        self.input.clone()
    }

    /// Stop the PipeWire loop and join the workers. Idempotent.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.stop_tx.send(Terminate);
        if let Some(t) = self.pw_thread.take() {
            let _ = t.join();
        }
        if let Some(t) = self.writer_thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for LinuxPipeWireCapture {
    fn drop(&mut self) {
        self.stop();
        clear_wayland_stream_geometry();
    }
}

/// The geometry the portal actually granted — the cursor tracker and the
/// filter chain key off this rather than the source's placeholder bounds.
static WAYLAND_STREAM_GEOMETRY: std::sync::Mutex<Option<Bounds>> = std::sync::Mutex::new(None);

fn set_wayland_stream_geometry(bounds: Bounds) {
    if let Ok(mut g) = WAYLAND_STREAM_GEOMETRY.lock() {
        *g = Some(bounds);
    }
}

fn clear_wayland_stream_geometry() {
    if let Ok(mut g) = WAYLAND_STREAM_GEOMETRY.lock() {
        *g = None;
    }
}

/// Bounds of the PipeWire stream in global coordinates, once negotiated.
pub fn wayland_stream_geometry() -> Option<Bounds> {
    WAYLAND_STREAM_GEOMETRY.lock().ok().and_then(|g| *g)
}

/// Writer end of the frame pipe: packed frames in, pipe bytes out. Exits on
/// channel close (pw loop stopped), pipe death (ffmpeg gone), or the `stop`
/// flag while the pipe is full — that last case is what keeps `stop()`
/// joinable when no reader ever drained the pipe (failed spawn) or the
/// FFmpeg child stalls mid-capture; with a blocking `write` the ~64 KiB
/// pipe buffer could never swallow an ~8 MiB frame.
fn run_frame_writer(rx: Receiver<PackedFrame>, write_fd: OwnedFd, stop: Arc<AtomicBool>) {
    let mut file = std::fs::File::from(write_fd);
    while let Ok(frame) = rx.recv() {
        if !super::frame_pipe::write_frame(&mut file, &frame.0, &stop) {
            // Dead pipe or stop-requested full pipe — ffmpeg is gone or wedged.
            break;
        }
    }
    let _ = file.flush();
}

/// The PipeWire main-loop thread: connects to the portal-granted remote fd,
/// wires the stream callbacks, and runs until Terminate or a fatal error.
fn run_pipewire_loop(
    remote_fd: OwnedFd,
    node_id: u32,
    target_fps: i32,
    format_tx: mpsc::Sender<PipeWireVideoInput>,
    frame_tx: SyncSender<PackedFrame>,
    stop_rx: pipewire::channel::Receiver<Terminate>,
    error_tx: mpsc::Sender<String>,
) {
    if let Err(e) =
        try_run_pipewire_loop(remote_fd, node_id, target_fps, format_tx, frame_tx, stop_rx)
    {
        let _ = error_tx.send(e);
    }
}

fn try_run_pipewire_loop(
    remote_fd: OwnedFd,
    node_id: u32,
    target_fps: i32,
    format_tx: mpsc::Sender<PipeWireVideoInput>,
    frame_tx: SyncSender<PackedFrame>,
    stop_rx: pipewire::channel::Receiver<Terminate>,
) -> std::result::Result<(), String> {
    pipewire::init();

    let mainloop = MainLoopRc::new(None).map_err(|e| format!("create pipewire main loop: {e}"))?;
    let context = ContextBox::new(mainloop.loop_(), None)
        .map_err(|e| format!("create pipewire context: {e}"))?;
    let core = context
        .connect_fd(remote_fd, None)
        .map_err(|e| format!("connect to portal PipeWire remote: {e}"))?;

    // Media properties classify us as a screen-capture sink. The `keys`
    // constants are LazyLock<&'static str>, hence the leading `*`.
    let props = pipewire::properties::properties! {
        *keys::MEDIA_TYPE => "Video",
        *keys::MEDIA_CATEGORY => "Capture",
        *keys::MEDIA_ROLE => "Screen",
        *keys::MEDIA_CLASS => "Video/Sink",
        *keys::APP_NAME => "RecordForge",
    };
    let stream = StreamBox::new(&core, "recordforge-screen-capture", props)
        .map_err(|e| format!("create pipewire stream: {e}"))?;

    // User data shared by the callbacks on this single-threaded loop.
    struct UserData {
        format_tx: mpsc::Sender<PipeWireVideoInput>,
        frame_tx: SyncSender<PackedFrame>,
        started: Instant,
        input: Option<PipeWireVideoInput>,
        dropped_frames: u64,
    }
    let user_data = UserData {
        format_tx,
        frame_tx,
        started: Instant::now(),
        input: None,
        dropped_frames: 0,
    };

    let listener = stream
        .add_local_listener_with_user_data(user_data)
        .state_changed(|_stream, _ud, _old, new| {
            debug!(?new, "pipewire stream state");
            if let StreamState::Error(e) = new {
                warn!(%e, "pipewire stream error");
            }
        })
        .param_changed(|stream, ud, id, param| {
            if id != ParamType::Format.as_raw() {
                return;
            }
            let Some(pod) = param else {
                return;
            };
            let mut info = VideoInfoRaw::new();
            if info.parse(pod).is_err() {
                warn!("pipewire: failed to parse negotiated Format pod");
                return;
            }
            let Some(input) = video_input_from_format(&info) else {
                warn!(format = ?info.format(), "pipewire: unsupported pixel format");
                return;
            };
            debug!(?input, "pipewire negotiated format");
            ud.input = Some(input.clone());
            let _ = ud.format_tx.send(input.clone());

            // Allocate stream buffers: memfd or plain memory, sizes generous
            // enough that the compositor needn't renegotiate.
            let buffers_bytes = build_buffers_pod(&input);
            if let Some(pod) = Pod::from_bytes(&buffers_bytes) {
                let mut params: [&Pod; 1] = [pod];
                let _ = stream.update_params(&mut params);
            }
        })
        .process(|stream, ud| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };

            // SPA_META_Cursor — cursor position/shape metadata for the tracker.
            if let Some(cursor) = buffer.find_meta::<MetaCursor>() {
                if let Some(snapshot) = cursor_snapshot(cursor, ud.started) {
                    update_pipewire_cursor_metadata(snapshot);
                }
            }

            let Some(input) = ud.input.as_ref() else {
                // Format not negotiated yet — buffer drops and re-queues.
                return;
            };
            let Some(frame) = pack_frame(&mut buffer, input) else {
                return;
            };
            // Full queue = encoder fell behind; drop the new frame rather than
            // block the compositor-facing main loop.
            if ud.frame_tx.try_send(frame).is_err() {
                ud.dropped_frames += 1;
                if ud.dropped_frames % 120 == 1 {
                    warn!(
                        dropped = ud.dropped_frames,
                        "pipewire frames dropped (encoder backpressure)"
                    );
                }
            }
        })
        .register()
        .map_err(|e| format!("register stream listener: {e}"))?;

    // Offer the formats we can consume. BGRx/RGBx are what compositors prefer;
    // BGRA/RGBA and 24-bit fallbacks cover the rest.
    let format_bytes = build_enum_format_pod(target_fps);
    let format_pod = Pod::from_bytes(&format_bytes)
        .ok_or_else(|| "build format pod: malformed pod bytes".to_string())?;
    let mut params = [format_pod];

    stream
        .connect(
            Direction::Input,
            Some(node_id),
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
            &mut params,
        )
        .map_err(|e| format!("connect stream to node {node_id}: {e}"))?;

    // Attach the stop channel — Terminate from the main thread quits the loop.
    let _attached = stop_rx.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |_| mainloop.quit()
    });

    // Listener holds user_data alive for the loop's duration.
    let _listener = listener;
    mainloop.run();
    Ok(())
}

/// Translate a negotiated `spa_video_info_raw` into FFmpeg input parameters.
fn video_input_from_format(info: &VideoInfoRaw) -> Option<PipeWireVideoInput> {
    let format = info.format();
    // `VideoFormat` is a newtype-with-consts, so compare rather than match.
    let pixel_format = if format == VideoFormat::BGRx || format == VideoFormat::BGRA {
        "bgra"
    } else if format == VideoFormat::RGBx || format == VideoFormat::RGBA {
        "rgba"
    } else if format == VideoFormat::BGR {
        "bgr24"
    } else if format == VideoFormat::RGB {
        "rgb24"
    } else if format == VideoFormat::GRAY8 {
        "gray"
    } else {
        return None;
    };
    let size = info.size();
    if size.width == 0 || size.height == 0 {
        return None;
    }
    let rate = info.framerate();
    let (num, den) = if rate.num > 0 && rate.denom > 0 {
        (rate.num, rate.denom)
    } else {
        (30, 1)
    };
    Some(PipeWireVideoInput {
        pixel_format,
        width: size.width,
        height: size.height,
        framerate_num: num,
        framerate_den: den,
        crop: None,
        read_fd: 0, // filled by the caller — the pipe is created outside
    })
}

/// Copy a stream buffer into a tightly-packed frame. Stride padding is
/// stripped so `rawvideo` sees a contiguous W×H×BPP image.
fn pack_frame(
    buffer: &mut pipewire::buffer::Buffer<'_>,
    input: &PipeWireVideoInput,
) -> Option<PackedFrame> {
    let datas = buffer.datas_mut();
    let data = datas.first_mut()?;
    // `chunk()` borrows the Data immutably while `data()` needs &mut — copy
    // the scalar fields out first so the mutable borrow can proceed.
    let (offset, stride) = {
        let chunk = data.chunk();
        (chunk.offset() as usize, chunk.stride())
    };
    if stride <= 0 {
        return None;
    }
    let stride = stride as usize;
    let bytes = data.data()?;
    if offset >= bytes.len() {
        return None;
    }
    let available = &bytes[offset..];

    let bpp = match input.pixel_format {
        "bgra" | "rgba" => 4,
        "bgr24" | "rgb24" => 3,
        "gray" => 1,
        _ => return None,
    };
    let row_bytes = input.width as usize * bpp;
    let rows = input.height as usize;
    let mut packed = Vec::with_capacity(row_bytes * rows);
    for row in 0..rows {
        let start = row * stride;
        let end = start + row_bytes;
        if end > available.len() {
            break;
        }
        packed.extend_from_slice(&available[start..end]);
    }
    if packed.len() != row_bytes * rows {
        return None;
    }
    Some(PackedFrame(packed))
}

/// Translate `SPA_META_Cursor` into the shared cursor snapshot.
fn cursor_snapshot(cursor: &MetaCursor, started: Instant) -> Option<PipeWireCursorSnapshot> {
    if !cursor.is_valid() {
        return Some(PipeWireCursorSnapshot {
            active: false,
            x: 0,
            y: 0,
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            shape_name: None,
            bitmap_hash: 0,
            cursor_mode: Some(PortalCursorMode::Metadata),
            updated_at_ms: started.elapsed().as_millis() as u64,
        });
    }
    let pos = cursor.position();
    let hotspot = cursor.hotspot();
    let (w, h, hash) = match cursor.bitmap() {
        Some(bitmap) => {
            let size = bitmap.size();
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            use std::hash::{Hash, Hasher};
            (size.width, size.height, bitmap.stride(), bitmap.offset()).hash(&mut hasher);
            (size.width, size.height, hasher.finish())
        }
        None => (0, 0, 0),
    };
    Some(PipeWireCursorSnapshot {
        active: true,
        // SPA cursor points are already integer pixels (spa_point is i32).
        x: pos.x,
        y: pos.y,
        hotspot_x: hotspot.x,
        hotspot_y: hotspot.y,
        width: w,
        height: h,
        shape_name: None,
        bitmap_hash: hash,
        cursor_mode: Some(PortalCursorMode::Metadata),
        updated_at_ms: started.elapsed().as_millis() as u64,
    })
}

/// Compute the crop rect (stream-local coordinates) for a Wayland region
/// capture. Clamped to the stream and even-aligned so encoders stay happy.
fn compute_region_crop(
    region: Bounds,
    stream_position: (i32, i32),
    stream_size: (u32, u32),
) -> Option<Bounds> {
    let x = (region.x - stream_position.0).clamp(0, stream_size.0 as i32) & !1;
    let y = (region.y - stream_position.1).clamp(0, stream_size.1 as i32) & !1;
    let w = region.width.min(stream_size.0 as i32 - x).max(2) & !1;
    let h = region.height.min(stream_size.1 as i32 - y).max(2) & !1;
    if w <= 0 || h <= 0 {
        return None;
    }
    Some(Bounds {
        x,
        y,
        width: w,
        height: h,
    })
}

/// Build the `EnumFormat` offer: raw video, BGRx-first format choices, any
/// size and framerate so the compositor picks what it already renders.
fn build_enum_format_pod(target_fps: i32) -> Vec<u8> {
    let r = Rectangle {
        width: 1920,
        height: 1080,
    };
    let r_min = Rectangle {
        width: 1,
        height: 1,
    };
    let r_max = Rectangle {
        width: 16384,
        height: 16384,
    };
    let fr = Fraction {
        // spa_fraction fields are u32; fall back to 30 rather than wrap a bad fps.
        num: u32::try_from(target_fps).unwrap_or(30),
        denom: 1,
    };
    let fr_min = Fraction { num: 1, denom: 1 };
    let fr_max = Fraction { num: 240, denom: 1 };

    let formats: [u32; 6] = [
        VideoFormat::BGRx.as_raw(),
        VideoFormat::RGBx.as_raw(),
        VideoFormat::BGRA.as_raw(),
        VideoFormat::RGBA.as_raw(),
        VideoFormat::BGR.as_raw(),
        VideoFormat::RGB.as_raw(),
    ];

    let format_obj = Object {
        type_: SpaTypes::ObjectParamFormat.as_raw(),
        id: ParamType::EnumFormat.as_raw(),
        properties: vec![
            Property::new(
                FormatProperties::MediaType.as_raw(),
                Value::Id(Id(spa::param::format::MediaType::Video.as_raw())),
            ),
            Property::new(
                FormatProperties::MediaSubtype.as_raw(),
                Value::Id(Id(spa::param::format::MediaSubtype::Raw.as_raw())),
            ),
            Property::new(
                FormatProperties::VideoFormat.as_raw(),
                Value::Choice(ChoiceValue::Id(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Enum {
                        default: Id(formats[0]),
                        alternatives: formats[1..].iter().map(|f| Id(*f)).collect(),
                    },
                ))),
            ),
            Property::new(
                FormatProperties::VideoSize.as_raw(),
                Value::Choice(ChoiceValue::Rectangle(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: r,
                        min: r_min,
                        max: r_max,
                    },
                ))),
            ),
            Property::new(
                FormatProperties::VideoFramerate.as_raw(),
                Value::Choice(ChoiceValue::Fraction(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: fr,
                        min: fr_min,
                        max: fr_max,
                    },
                ))),
            ),
        ],
    };

    let (cursor, _) =
        PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &Value::Object(format_obj))
            .expect("serialize format pod");
    cursor.into_inner()
}

/// `ParamBuffers` offer — MemFd or MemPtr shared memory buffers. Returns the
/// serialized pod bytes; the caller keeps them alive for `update_params`.
fn build_buffers_pod(input: &PipeWireVideoInput) -> Vec<u8> {
    use libspa_sys as sys;
    let bpp: u32 = match input.pixel_format {
        "bgra" | "rgba" => 4,
        "bgr24" | "rgb24" => 3,
        "gray" => 1,
        _ => return Vec::new(),
    };
    let stride = input.width * bpp;
    let size = stride * input.height;

    let buffers_obj = Object {
        type_: SpaTypes::ObjectParamBuffers.as_raw(),
        id: ParamType::Buffers.as_raw(),
        properties: vec![
            Property::new(
                sys::SPA_PARAM_BUFFERS_buffers,
                Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: 4,
                        min: 2,
                        max: 8,
                    },
                ))),
            ),
            Property::new(sys::SPA_PARAM_BUFFERS_blocks, Value::Int(1)),
            Property::new(
                sys::SPA_PARAM_BUFFERS_size,
                Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: size as i32,
                        min: 4096,
                        max: i32::MAX,
                    },
                ))),
            ),
            Property::new(
                sys::SPA_PARAM_BUFFERS_stride,
                Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: stride as i32,
                        min: 0,
                        max: i32::MAX,
                    },
                ))),
            ),
            Property::new(
                sys::SPA_PARAM_BUFFERS_dataType,
                Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Flags {
                        default: (1 << sys::SPA_DATA_MemFd) | (1 << sys::SPA_DATA_MemPtr),
                        flags: vec![1 << sys::SPA_DATA_MemFd, 1 << sys::SPA_DATA_MemPtr],
                    },
                ))),
            ),
        ],
    };
    let (cursor, _) = PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &Value::Object(buffers_obj),
    )
    .expect("serialize buffers pod");
    cursor.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_crop_translates_to_stream_space() {
        // Stream covers (1920, 0)-(3840, 1080); region picked in global coords.
        let crop = compute_region_crop(
            Bounds {
                x: 2100,
                y: 150,
                width: 800,
                height: 600,
            },
            (1920, 0),
            (1920, 1080),
        )
        .expect("crop");
        assert_eq!(
            crop,
            Bounds {
                x: 180,
                y: 150,
                width: 800,
                height: 600
            }
        );
    }

    #[test]
    fn region_crop_clamps_and_evens() {
        let crop = compute_region_crop(
            Bounds {
                x: -50,
                y: 0,
                width: 1921,
                height: 1081,
            },
            (0, 0),
            (1920, 1080),
        )
        .expect("crop");
        assert_eq!(crop.x, 0);
        assert_eq!(crop.y, 0);
        assert_eq!(crop.width, 1920);
        assert_eq!(crop.height, 1080);
    }

    #[test]
    fn format_pod_serializes() {
        let bytes = build_enum_format_pod(60);
        assert!(!bytes.is_empty());
        assert!(Pod::from_bytes(&bytes).is_some());
    }

    #[test]
    fn buffers_pod_serializes() {
        let input = PipeWireVideoInput {
            pixel_format: "bgra",
            width: 1920,
            height: 1080,
            framerate_num: 60,
            framerate_den: 1,
            crop: None,
            read_fd: 0,
        };
        let bytes = build_buffers_pod(&input);
        assert!(!bytes.is_empty());
        assert!(Pod::from_bytes(&bytes).is_some());
    }
}
