//! Real ScreenCaptureKit capture on macOS 13+.
//!
//! Two consumers share this module:
//!
//! - [`MacosSckCapture`] feeds `FfmpegCapture::start`: `SCStream` video frames
//!   arrive as BGRA `CVPixelBuffer`s, get packed, and flow over an OS pipe
//!   into the FFmpeg child's `rawvideo` input on fd 3 — the exact contract
//!   the Linux PipeWire backend already established, so the encode/mux path
//!   is unchanged. Window/region cropping stays in the shared filter chain.
//! - [`SckAudioCapture`] backs `CoreAudioCaptureSession`'s system-loopback
//!   arm: an audio-only `SCStream` (native macOS 13+ system audio, no
//!   virtual-driver install) converts its f32 `AudioBufferList`s to s16 PCM
//!   in the canonical WAV the mux pipeline expects.
//!
//! Our own overlay windows never reach the stream: Tauri's
//! `content_protected` sets `NSWindowSharingNone`, which ScreenCaptureKit
//! already honors.

#![cfg(target_os = "macos")]

use std::fs::OpenOptions;
use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use screencapturekit::cm::{AudioBuffer, AudioBufferList};
use screencapturekit::cv::CVPixelBufferLockGuard;
use screencapturekit::prelude::*;

use super::audio::wav::{
    append_silence_until, finalize_wav, frames_for_duration, write_wav_header, AudioSampleFormat,
    DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE,
};
use super::ffmpeg::PipeWireVideoInput;
use super::source::{Bounds, CaptureSource};
use crate::capture::config::RecordingProfile;
use crate::errors::{InternalError, Result};

/// In-flight frame queue. ~8 MiB per 1080p BGRA frame caps the steady-state
/// capture overhead at ~24 MiB; overflow drops frames rather than stalling
/// the SCK output queue.
const FRAME_QUEUE_DEPTH: usize = 3;

/// How long the audio capture waits for its first sample before declaring
/// the stream dead (cold stream startup, permission denied mid-flight).
const AUDIO_STARTUP_TIMEOUT: Duration = Duration::from_millis(2500);

/// How ScreenCaptureKit delivers frames on the wire.
///
/// NV12 (`420v`) is preferred: the stream is scaled on the GPU to the final
/// output size, the pipe carries 1.5 bytes per pixel instead of 4, and
/// VideoToolbox consumes the frames without a conversion. Packed BGRA stays as
/// the fallback (and for region captures, which crop in the filter chain and so
/// need the full display frame).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SckFrameFormat {
    Nv12,
    Bgra,
}

impl SckFrameFormat {
    fn pixel_format(self) -> PixelFormat {
        match self {
            Self::Nv12 => PixelFormat::YCbCr_420v,
            Self::Bgra => PixelFormat::BGRA,
        }
    }

    /// FFmpeg `-pixel_format` for the `rawvideo` fd-3 input.
    fn ffmpeg_pixel_format(self) -> &'static str {
        match self {
            Self::Nv12 => "nv12",
            Self::Bgra => "bgra",
        }
    }
}

/// A tightly-packed BGRA or NV12 frame ready for `rawvideo` consumption.
struct PackedFrame(Vec<u8>);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// macOS 13.0+ check — SCK video capture (and the `screencapturekit` crate)
/// is only wired on versions where its behaviour is defined; older OSes stay
/// on the avfoundation fallback path.
pub fn sck_streaming_available() -> bool {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output();
    let Ok(output) = output else {
        return false;
    };
    let version = String::from_utf8_lossy(&output.stdout);
    let mut parts = version.trim().split('.');
    match parts.next().and_then(|m| m.parse::<u32>().ok()) {
        Some(major) => major >= 13,
        None => false,
    }
}

/// The resolved display + window for a source, expressed in SCK terms.
struct ResolvedSource {
    display: Option<SCDisplay>,
    window: Option<SCWindow>,
    /// Native frame size of the source in physical pixels. Region captures
    /// stream at this size (the crop happens in FFmpeg); display and window
    /// captures ask SCK to scale straight to the recording's output size.
    width: u32,
    height: u32,
    /// Region/window crop in *stream* coordinates — consumed by the shared
    /// video filter chain exactly like the PipeWire crop.
    crop: Option<Bounds>,
}

/// Map a `CaptureSource` onto a content filter + output geometry.
///
/// `SCDisplay.display_id` is the `CGDirectDisplayID`, so the CG display list
/// (`enumerate_displays` — the same order FFmpeg's `Capture screen N` uses)
/// is the bridge between our `display-N` ids and SCK objects. Window ids are
/// the `CGWindowID` that `win-N` sources carry.
fn resolve_source(content: &SCShareableContent, source: &CaptureSource) -> Option<ResolvedSource> {
    let displays = super::macos_native::enumerate_displays();
    match source.kind.as_str() {
        "window" => {
            let window_id: u32 = source.id.strip_prefix("win-")?.parse().ok()?;
            let window = content
                .windows()
                .into_iter()
                .find(|w| w.window_id() == window_id)?;
            Some(ResolvedSource {
                display: None,
                window: Some(window),
                width: source.bounds.width.max(2) as u32,
                height: source.bounds.height.max(2) as u32,
                crop: None, // the window filter already yields window-sized frames
            })
        }
        "display" | "region" => {
            // `resolve_display_crop` resolves display-N ids and the display
            // under a region's center — identical to the avfoundation pick.
            let (display, crop) = super::macos_native::resolve_display_crop(source);
            let cg_display = display.or_else(|| displays.first().cloned())?;
            let sc_display = content
                .displays()
                .into_iter()
                .find(|d| d.display_id() == cg_display.display_id)?;
            Some(ResolvedSource {
                display: Some(sc_display),
                window: None,
                width: cg_display.bounds.width.max(2) as u32,
                height: cg_display.bounds.height.max(2) as u32,
                crop: if source.kind == "region" { crop } else { None },
            })
        }
        _ => None,
    }
}

/// Packed frames in, pipe bytes out. Exits on channel close (stream
/// stopped), pipe death (ffmpeg gone), or the `stop` flag while the pipe is
/// full — the last case is what makes teardown safe when the FFmpeg child
/// never drained (spawn failure) or stalls mid-capture: a blocking `write`
/// on a ~64 KiB pipe buffer holding an ~8 MiB frame can never be joined
/// otherwise, since our own `_read_fd` keeps a read end open.
fn run_frame_writer(rx: Receiver<PackedFrame>, write_fd: OwnedFd, stop: Arc<AtomicBool>) {
    let mut file = std::fs::File::from(write_fd);
    while let Ok(frame) = rx.recv() {
        if !super::frame_pipe::write_frame(&mut file, &frame.0, &stop) {
            break;
        }
    }
}

/// How long a freshly started stream may take to deliver its first frame before
/// the format is considered unusable and the next candidate is tried. SCK's
/// first frame during a steady capture lands in tens of milliseconds; a slow
/// machine plus a cold stream still fits comfortably.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_millis(1200);

/// Lock the pixel buffer and copy into a tightly-packed frame.
///
/// `bytes_per_row` may carry padding, so rows copy individually when they
/// don't line up — the `rawvideo` demuxer sees a contiguous W×H×BPP image.
/// `produced` is raised on the first frame handed to the writer, which is how
/// the start path tells a working stream from one whose frames are silently
/// dropping.
fn pack_bgra(sample: &CMSampleBuffer, frame_tx: &SyncSender<PackedFrame>, produced: &AtomicBool) {
    let Some(buffer) = sample.pixel_buffer() else {
        return;
    };
    let Ok(guard) = buffer.lock_read_only() else {
        return;
    };
    let (width, height, bpr) = (guard.width(), guard.height(), guard.bytes_per_row());
    let base = guard.base_address();
    let row_bytes = width * 4;
    if base.is_null() || row_bytes == 0 || height == 0 || bpr < row_bytes {
        return;
    }
    let mut frame = vec![0u8; row_bytes * height];
    // SAFETY: `guard` keeps the base address valid; sources and destination
    // never overlap (freshly allocated output).
    unsafe {
        for y in 0..height {
            std::ptr::copy_nonoverlapping(
                base.add(y * bpr),
                frame.as_mut_ptr().add(y * row_bytes),
                row_bytes,
            );
        }
    }
    drop(guard);
    // Never block the SCK output queue: a full channel means ffmpeg is
    // behind, so the oldest frame is the one to sacrifice.
    if frame_tx.try_send(PackedFrame(frame)).is_ok() {
        produced.store(true, Ordering::Release);
    }
}

/// Copy a two-plane `420v` buffer into the contiguous NV12 layout `rawvideo`
/// reads. A buffer that is not actually bi-planar (the OS ignored the pixel
/// format) is dropped rather than misread as BGRA — the capture then fails its
/// startup check and the caller falls back to the BGRA stream.
fn pack_nv12(sample: &CMSampleBuffer, frame_tx: &SyncSender<PackedFrame>, produced: &AtomicBool) {
    let Some(buffer) = sample.pixel_buffer() else {
        return;
    };
    let Ok(guard) = buffer.lock_read_only() else {
        return;
    };
    if guard.plane_count() < 2 {
        return;
    }
    let (width, height) = (guard.width(), guard.height());
    if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return;
    }
    let (Some(luma_base), Some(chroma_base)) = (plane_base(&guard, 0), plane_base(&guard, 1))
    else {
        return;
    };
    let luma_stride = guard.bytes_per_row_of_plane(0);
    let chroma_stride = guard.bytes_per_row_of_plane(1);
    // SAFETY: a locked CVPixelBuffer plane maps at least `bytesPerRow * rows`
    // bytes (`rows` is the plane's own height: full for luma, half for chroma),
    // so the slices stay inside the allocation. `guard` holds the lock for the
    // whole copy.
    let (luma, chroma) = unsafe {
        (
            super::nv12::Nv12Plane {
                data: std::slice::from_raw_parts(luma_base, luma_stride * height),
                offset: 0,
                stride: luma_stride,
            },
            super::nv12::Nv12Plane {
                data: std::slice::from_raw_parts(chroma_base, chroma_stride * (height / 2)),
                offset: 0,
                stride: chroma_stride,
            },
        )
    };
    let packed = super::nv12::pack_nv12(luma, chroma, width as u32, height as u32);
    drop(guard);
    if let Some(frame) = packed {
        if frame_tx.try_send(PackedFrame(frame)).is_ok() {
            produced.store(true, Ordering::Release);
        }
    }
}

/// Non-null base address of one plane, as a `*const u8`.
fn plane_base(guard: &CVPixelBufferLockGuard<'_>, plane: usize) -> Option<*const u8> {
    guard
        .base_address_of_plane(plane)
        .filter(|base| !base.is_null())
}

/// Dispatch a sample to the packer that matches the stream's wire format.
fn pack_frame(
    sample: &CMSampleBuffer,
    frame_tx: &SyncSender<PackedFrame>,
    format: SckFrameFormat,
    produced: &AtomicBool,
) {
    match format {
        SckFrameFormat::Nv12 => pack_nv12(sample, frame_tx, produced),
        SckFrameFormat::Bgra => pack_bgra(sample, frame_tx, produced),
    }
}

// ---------------------------------------------------------------------------
// Video capture → ffmpeg rawvideo pipe
// ---------------------------------------------------------------------------

/// A running ScreenCaptureKit video session. `video_input()` describes the
/// `rawvideo` fd-3 input `add_screen_video_input` wires into the FFmpeg
/// command; dropping the struct stops the stream and drains the pipe.
pub struct MacosSckCapture {
    stream: Option<SCStream>,
    /// Read end of the frame pipe — must outlive the ffmpeg child (the child
    /// uses a dup'd fd 3; our copy keeps the pipe open for it).
    _read_fd: OwnedFd,
    read_fd: i32,
    frame_writer: Option<JoinHandle<()>>,
    /// Drop signal for the writer if the stream ends mid-run.
    stop: Arc<AtomicBool>,
    width: u32,
    height: u32,
    fps: u32,
    crop: Option<Bounds>,
    /// Wire format the stream was started with (NV12 or BGRA).
    frame_format: SckFrameFormat,
}

impl std::fmt::Debug for MacosSckCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MacosSckCapture")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fps", &self.fps)
            .field("crop", &self.crop)
            .field("frame_format", &self.frame_format)
            .finish_non_exhaustive()
    }
}

/// Create, wire and start one `SCStream` attempt for a pixel format.
///
/// Split out of `start_if_available` so a rejected format (bad config, missing
/// hardware path) can be retried with the fallback instead of aborting macOS
/// capture entirely.
fn start_stream(
    filter: &SCContentFilter,
    format: SckFrameFormat,
    width: u32,
    height: u32,
    frame_interval: &CMTime,
    frame_tx: SyncSender<PackedFrame>,
) -> Result<(SCStream, Arc<AtomicBool>)> {
    let produced = Arc::new(AtomicBool::new(false));
    let handler_produced = Arc::clone(&produced);
    let config = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_pixel_format(format.pixel_format())
        // The overlay engine draws its own cursor — hide the system one.
        .with_shows_cursor(false)
        .with_minimum_frame_interval(frame_interval)
        // Bound the SCK queue; a stalled downstream must not balloon.
        .with_queue_depth(8)
        .with_scales_to_fit(true);

    let mut stream = SCStream::new(filter, &config)
        .map_err(|e| InternalError::Capture(format!("create SCK stream: {e}")))?;
    stream
        .add_output_handler(
            move |sample, _of_type| pack_frame(&sample, &frame_tx, format, &handler_produced),
            SCStreamOutputType::Screen,
        )
        .map_err(|e| InternalError::Capture(format!("attach SCK output handler: {e}")))?;
    stream
        .start_capture()
        .map_err(|e| InternalError::Capture(format!("start SCK capture: {e}")))?;
    Ok((stream, produced))
}

/// Wait for a start attempt's first packed frame.
///
/// A stream can start successfully and still deliver frames the packer rejects
/// (for example an OS that ignores `420v` and hands back a single BGRA plane).
/// Treating "no frame produced" as a failed attempt keeps that from turning
/// into an empty recording: the caller retries the next format.
fn await_first_frame(produced: &AtomicBool) -> bool {
    let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
    while Instant::now() < deadline {
        if produced.load(Ordering::Acquire) {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    produced.load(Ordering::Acquire)
}

impl MacosSckCapture {
    /// Start an SCK capture for the source, or `Ok(None)` when SCK isn't
    /// usable (pre-13 OS, missing permission, empty shareable content) so the
    /// caller can fall back to the avfoundation input.
    ///
    /// Video only: system audio is captured by [`SckAudioCapture`] through the
    /// loopback arm of `CoreAudioCaptureSession`, keeping the `AudioTrack`
    /// wiring in `session.rs` untouched.
    pub fn start_if_available(
        source: &CaptureSource,
        profile: &RecordingProfile,
    ) -> Result<Option<Self>> {
        if !sck_streaming_available() || !super::macos_native::screen_recording_granted() {
            return Ok(None);
        }

        let content = match SCShareableContent::get() {
            Ok(content) => content,
            Err(error) => {
                tracing::warn!(error = ?error, "SCShareableContent enumeration failed; using avfoundation fallback");
                return Ok(None);
            }
        };

        let Some(resolved) = resolve_source(&content, source) else {
            tracing::warn!(
                kind = %source.kind,
                id = %source.id,
                "no SCK display/window for capture source; using avfoundation fallback"
            );
            return Ok(None);
        };

        let (read_fd, write_fd) = super::frame_pipe::create()?;
        let (frame_tx, frame_rx) = mpsc::sync_channel::<PackedFrame>(FRAME_QUEUE_DEPTH);

        let filter = if let Some(window) = &resolved.window {
            SCContentFilter::create().with_window(window).build()
        } else if let Some(display) = &resolved.display {
            SCContentFilter::create()
                .with_display(display)
                // Our overlay windows are already excluded via content_protected.
                .with_excluding_windows(&[])
                .build()
        } else {
            return Ok(None);
        }
        .map_err(|e| InternalError::Capture(format!("build SCK content filter: {e}")))?;

        // Non-region captures are scaled by ScreenCaptureKit straight to the
        // recording's output size (which `RecordingProfile::for_source_bounds`
        // has already fitted to the source aspect), so the filter chain has no
        // scale/pad stage left. A region still streams the whole display and
        // crops in FFmpeg, because the crop rect is expressed in display
        // pixels.
        let (stream_width, stream_height) = if resolved.crop.is_some() {
            (resolved.width, resolved.height)
        } else {
            (profile.width.max(2) as u32, profile.height.max(2) as u32)
        };

        let frame_interval = CMTime::new(1, profile.fps.max(1));

        // Prefer NV12; a stream that refuses it (older SCK builds, an OS that
        // ignores the requested pixel format) falls back to packed BGRA at the
        // same output size.
        let mut started = None;
        for format in [SckFrameFormat::Nv12, SckFrameFormat::Bgra] {
            if format == SckFrameFormat::Nv12 && resolved.crop.is_some() {
                continue;
            }
            let attempt = start_stream(
                &filter,
                format,
                stream_width,
                stream_height,
                &frame_interval,
                frame_tx.clone(),
            );
            match attempt {
                Ok((stream, produced)) if await_first_frame(&produced) => {
                    started = Some((stream, format, stream_width, stream_height));
                    break;
                }
                Ok((stream, _)) => {
                    tracing::warn!(
                        ?format,
                        "ScreenCaptureKit stream produced no packable frame; falling back"
                    );
                    let _ = stream.stop_capture();
                    drop(stream);
                    // Frames from the abandoned attempt must not reach the next
                    // format's pipe (their layout differs).
                    while frame_rx.try_recv().is_ok() {}
                }
                Err(error) => {
                    tracing::warn!(
                        ?error,
                        ?format,
                        "ScreenCaptureKit stream start failed; trying the next pixel format"
                    );
                }
            }
        }
        let Some((stream, frame_format, width, height)) = started else {
            return Ok(None);
        };

        let stop = Arc::new(AtomicBool::new(false));
        let writer_stop = Arc::clone(&stop);
        let frame_writer = thread::Builder::new()
            .name("rf-sck-frames".into())
            .spawn(move || run_frame_writer(frame_rx, write_fd, writer_stop))
            .map_err(|e| InternalError::Capture(format!("spawn SCK frame writer: {e}")))?;

        let read_fd_raw = read_fd.as_raw_fd();
        tracing::info!(
            width,
            height,
            fps = profile.fps,
            pixel_format = frame_format.ffmpeg_pixel_format(),
            "started ScreenCaptureKit stream"
        );

        Ok(Some(Self {
            stream: Some(stream),
            _read_fd: read_fd,
            read_fd: read_fd_raw,
            frame_writer: Some(frame_writer),
            stop,
            width,
            height,
            fps: profile.fps.max(1) as u32,
            crop: resolved.crop,
            frame_format,
        }))
    }

    /// The `rawvideo` input descriptor for the FFmpeg command.
    pub fn video_input(&self) -> PipeWireVideoInput {
        PipeWireVideoInput {
            pixel_format: self.frame_format.ffmpeg_pixel_format(),
            width: self.width,
            height: self.height,
            framerate_num: self.fps,
            framerate_den: 1,
            crop: self.crop,
            read_fd: self.read_fd,
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(stream) = self.stream.take() {
            if let Err(error) = stream.stop_capture() {
                tracing::warn!(error = ?error, "SCK stop_capture failed");
            }
            drop(stream); // releases the handler → frame channel closes
        }
        if let Some(writer) = self.frame_writer.take() {
            let _ = writer.join();
        }
    }
}

impl Drop for MacosSckCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------------------------------------------------------------------
// Audio-only capture → WAV (system loopback)
// ---------------------------------------------------------------------------

/// PCM f32 frames from the SCK audio output, normalized to s16le stereo.
struct AudioChunk(Vec<u8>);

/// An audio-only `SCStream` writing system audio to a WAV track — the same
/// `AudioTrack` contract the WASAPI/Linux loopback sessions fulfil.
pub struct SckAudioCapture {
    stream: Option<SCStream>,
    writer: Option<JoinHandle<std::io::Result<u64>>>,
    stop: Arc<AtomicBool>,
    data_bytes: Arc<AtomicU64>,
    level_bits: Arc<AtomicU32>,
    started_at: Instant,
    output_path: PathBuf,
}

impl std::fmt::Debug for SckAudioCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SckAudioCapture")
            .field("output_path", &self.output_path)
            .finish_non_exhaustive()
    }
}

impl SckAudioCapture {
    /// Start capturing system audio to `output_path`. Fails when the OS is
    /// too old, permission is missing, or no display exists to anchor the
    /// required content filter (SCK has no filter-less audio stream).
    pub fn start(output_path: PathBuf, timeline_origin: Instant) -> Result<Self> {
        if !sck_streaming_available() {
            return Err(
                InternalError::Capture("system audio capture requires macOS 13+".into()).into(),
            );
        }
        if !super::macos_native::screen_recording_granted() {
            return Err(InternalError::Permissions(
                "system audio capture needs macOS Screen Recording permission".into(),
            )
            .into());
        }

        let content = SCShareableContent::get()
            .map_err(|e| InternalError::Capture(format!("SCShareableContent: {e}")))?;
        let display = content.displays().into_iter().next().ok_or_else(|| {
            InternalError::Capture("no display available for SCK audio filter".into())
        })?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build()
            .map_err(|e| InternalError::Capture(format!("build SCK audio filter: {e}")))?;

        // Minimal video geometry: the stream exists for its audio output, so
        // ask for the cheapest frames SCK will emit (frames are never
        // consumed — no Screen handler is registered).
        let frame_interval = CMTime::new(1, 1);
        let config = SCStreamConfiguration::new()
            .with_width(2)
            .with_height(2)
            .with_pixel_format(PixelFormat::BGRA)
            .with_shows_cursor(false)
            .with_minimum_frame_interval(&frame_interval)
            .with_queue_depth(1)
            .with_captures_audio(true)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(DEFAULT_SAMPLE_RATE as i32)
            .with_channel_count(DEFAULT_CHANNELS as i32);

        let started_at = Instant::now();
        let stop = Arc::new(AtomicBool::new(false));
        let data_bytes = Arc::new(AtomicU64::new(0));
        let level_bits = Arc::new(AtomicU32::new(0));

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                InternalError::Storage(format!("create audio output directory: {e}"))
            })?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&output_path)
            .map_err(|e| {
                InternalError::Storage(format!(
                    "create audio output {}: {e}",
                    output_path.display()
                ))
            })?;
        write_wav_header(
            &mut file,
            DEFAULT_SAMPLE_RATE,
            DEFAULT_CHANNELS,
            AudioSampleFormat::Pcm16,
        )
        .map_err(|e| InternalError::Storage(format!("write WAV header: {e}")))?;

        // Wall-clock lead-in so the track aligns to the video timeline.
        if timeline_origin < started_at {
            let leading_frames =
                frames_for_duration(started_at - timeline_origin, DEFAULT_SAMPLE_RATE);
            if leading_frames > 0 {
                let block_align = usize::from(DEFAULT_CHANNELS)
                    * usize::from(AudioSampleFormat::Pcm16.bytes_per_sample());
                let mut written = 0u64;
                append_silence_until(&mut file, &mut written, leading_frames, block_align)
                    .map_err(|e| InternalError::Storage(format!("write leading silence: {e}")))?;
                data_bytes.store(written, Ordering::Release);
            }
        }

        let (audio_tx, audio_rx) = mpsc::sync_channel::<AudioChunk>(64);
        let writer = spawn_audio_writer(
            audio_rx,
            file,
            Arc::clone(&data_bytes),
            Arc::clone(&level_bits),
        )
        .map_err(|e| InternalError::Capture(format!("spawn SCK audio writer: {e}")))?;

        let mut stream = SCStream::new(&filter, &config)
            .map_err(|e| InternalError::Capture(format!("create SCK audio stream: {e}")))?;
        stream
            .add_output_handler(
                move |sample: CMSampleBuffer, _of_type| {
                    if let Ok(list) = sample.audio_buffer_list() {
                        let pcm = audio_list_to_s16le(&list, DEFAULT_CHANNELS as usize);
                        if !pcm.is_empty() {
                            // Blocking send: a full channel means the WAV
                            // writer stalled — backpressure is honest here.
                            let _ = audio_tx.send(AudioChunk(pcm));
                        }
                    }
                },
                SCStreamOutputType::Audio,
            )
            .map_err(|e| InternalError::Capture(format!("attach SCK audio handler: {e}")))?;

        stream
            .start_capture()
            .map_err(|e| InternalError::Capture(format!("start SCK audio capture: {e}")))?;

        let mut session = Self {
            stream: Some(stream),
            writer: Some(writer),
            stop,
            data_bytes,
            level_bits,
            started_at,
            output_path,
        };

        // A stream that produced no audio within the window is dead — the
        // caller degrades to "recorded without system audio" either way, but
        // a claimed-active silent track is worse than an honest failure.
        if let Err(error) = session.await_first_audio() {
            session.abort();
            return Err(error);
        }
        Ok(session)
    }

    fn await_first_audio(&mut self) -> Result<()> {
        let baseline = self.data_bytes.load(Ordering::Acquire);
        let deadline = Instant::now() + AUDIO_STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if self.data_bytes.load(Ordering::Acquire) > baseline {
                return Ok(());
            }
            if self.stop.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(Duration::from_millis(15));
        }
        Err(InternalError::Capture(format!(
            "system audio produced no samples within {AUDIO_STARTUP_TIMEOUT:?}"
        ))
        .into())
    }

    fn abort(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(stream) = self.stream.take() {
            let _ = stream.stop_capture();
            drop(stream);
        }
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        let _ = std::fs::remove_file(&self.output_path);
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Acquire))
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    /// Stop the stream, drain the writer, and finalize the WAV. Returns the
    /// number of audio data bytes written.
    pub fn stop(&mut self) -> Result<u64> {
        self.stop.store(true, Ordering::Release);
        if let Some(stream) = self.stream.take() {
            if let Err(error) = stream.stop_capture() {
                tracing::warn!(error = ?error, "SCK audio stop_capture failed");
            }
            drop(stream); // releases the handler → channel closes → writer exits
        }
        let data_bytes = match self.writer.take() {
            Some(writer) => writer
                .join()
                .map_err(|_| InternalError::Capture("SCK audio writer panicked".into()))?
                .map_err(|e| InternalError::Storage(format!("SCK audio writer failed: {e}")))?,
            None => self.data_bytes.load(Ordering::Acquire),
        };

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.output_path)
            .map_err(|e| InternalError::Storage(format!("reopen audio output: {e}")))?;
        finalize_wav(&mut file, data_bytes)
            .map_err(|e| InternalError::Storage(format!("finalize WAV: {e}")).into())
    }
}

impl Drop for SckAudioCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Drain converted s16 chunks into the WAV file.
fn spawn_audio_writer(
    rx: Receiver<AudioChunk>,
    mut file: std::fs::File,
    data_bytes: Arc<AtomicU64>,
    level_bits: Arc<AtomicU32>,
) -> std::io::Result<JoinHandle<std::io::Result<u64>>> {
    thread::Builder::new()
        .name("rf-sck-audio".into())
        .spawn(move || {
            let mut total = data_bytes.load(Ordering::Acquire);
            while let Ok(chunk) = rx.recv() {
                update_peak(&chunk.0, &level_bits);
                file.write_all(&chunk.0)?;
                total += chunk.0.len() as u64;
                data_bytes.store(total, Ordering::Release);
            }
            file.flush()?;
            Ok(total)
        })
}

/// Rolling peak |sample| for the level meter over s16 bytes.
fn update_peak(chunk: &[u8], level_bits: &AtomicU32) {
    let mut peak = f32::from_bits(level_bits.load(Ordering::Relaxed));
    peak *= 0.98;
    for pair in chunk.as_chunks::<2>().0 {
        let s = i16::from_le_bytes(*pair) as f32 / 32768.0;
        let a = s.abs();
        if a > peak {
            peak = a;
        }
    }
    level_bits.store(peak.to_bits(), Ordering::Relaxed);
}

/// Convert an SCK `AudioBufferList` (f32 samples) to interleaved s16le.
/// Handles both layouts SCK can deliver: one interleaved buffer, or one
/// mono buffer per channel (non-interleaved — the common case).
fn audio_list_to_s16le(list: &AudioBufferList, channels: usize) -> Vec<u8> {
    let num_buffers = list.num_buffers();
    if num_buffers == 0 || channels == 0 {
        return Vec::new();
    }

    let read_f32 = |buffer: &AudioBuffer| -> Vec<f32> {
        buffer
            .data()
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect()
    };

    let mut channels_data: Vec<Vec<f32>> = Vec::with_capacity(channels);
    if num_buffers == 1 {
        // Interleaved: the single buffer carries `buffer.number_channels`
        // channels of f32. Reshape into per-channel vectors for one codepath.
        let Some(buffer) = list.get(0) else {
            return Vec::new();
        };
        let data = read_f32(buffer);
        let in_channels = (buffer.number_channels as usize).max(1);
        let frames = data.len() / in_channels;
        for ch in 0..channels.min(in_channels) {
            channels_data.push(
                data.iter()
                    .skip(ch)
                    .step_by(in_channels)
                    .take(frames)
                    .copied()
                    .collect(),
            );
        }
    } else {
        // Non-interleaved: buffer i is channel i.
        for index in 0..num_buffers.min(channels) {
            if let Some(buffer) = list.get(index) {
                channels_data.push(read_f32(buffer));
            }
        }
    }

    if channels_data.is_empty() {
        return Vec::new();
    }
    // Pad a mono source onto the missing channels.
    while channels_data.len() < channels {
        channels_data.push(channels_data[0].clone());
    }
    let frames = channels_data.iter().map(Vec::len).min().unwrap_or(0);
    let mut out = Vec::with_capacity(frames * channels * 2);
    // The first channel drives the frame index; every channel holds at least
    // `frames` samples, so `channel_data[frame]` stays in bounds.
    for (frame, _) in channels_data[0].iter().enumerate().take(frames) {
        for channel_data in channels_data.iter().take(channels) {
            let s = channel_data[frame].clamp(-1.0, 1.0);
            let sample = (s * 32767.0).round_ties_even() as i16;
            out.extend_from_slice(&sample.to_le_bytes());
        }
    }
    out
}
