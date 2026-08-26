//! Native Windows WASAPI capture for microphone and system-audio tracks.
//!
//! System audio is captured from a render endpoint with the WASAPI loopback
//! stream flag. Microphones use the normal WASAPI capture direction. Both
//! paths write independent WAV assets using the requested sample format so
//! FFmpeg never needs a DirectShow audio device or a virtual Stereo Mix device.

use crate::errors::Result;
#[cfg(any(windows, test))]
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::wav::{
    align_wav_to_duration, finalize_wav, write_wav_header, AudioSampleFormat, DEFAULT_CHANNELS,
    DEFAULT_SAMPLE_RATE,
};
#[cfg(any(windows, test))]
use super::wav::{append_silence_until, frames_for_duration, loopback_packet_start_frames};

#[cfg(windows)]
use wasapi::{
    deinitialize, initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};

#[cfg(any(windows, test))]
const AUDIO_BUFFER_DURATION_HNS: i64 = 100_000;
#[cfg(any(windows, test))]
const AUDIO_EVENT_TIMEOUT_MS: u32 = 100;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

pub type WasapiSampleFormat = AudioSampleFormat;

#[cfg(windows)]
trait WasapiSampleTypeExt {
    fn wasapi_sample_type(self) -> SampleType;
}

#[cfg(windows)]
impl WasapiSampleTypeExt for AudioSampleFormat {
    fn wasapi_sample_type(self) -> SampleType {
        match self {
            Self::Pcm16 => SampleType::Int,
            Self::Float32 => SampleType::Float,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasapiDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_loopback: bool,
}

/// Enumerate active WASAPI capture endpoints and render endpoints that can be
/// used for loopback. Render endpoints are exposed as system-audio choices.
pub fn enumerate_wasapi_devices() -> Result<Vec<WasapiDeviceInfo>> {
    #[cfg(windows)]
    {
        let worker = thread::Builder::new()
            .name("recordforge-wasapi-enumeration".into())
            .spawn(enumerate_windows_devices)
            .map_err(|error| {
                crate::errors::InternalError::Capture(format!(
                    "start WASAPI device enumeration: {error}"
                ))
            })?;

        worker.join().map_err(|_| {
            crate::errors::InternalError::Capture(
                "WASAPI device enumeration thread panicked".into(),
            )
        })?
    }

    #[cfg(not(windows))]
    {
        tracing::warn!("WASAPI device enumeration is only implemented on Windows");
        Ok(Vec::new())
    }
}

#[cfg(windows)]
fn enumerate_windows_devices() -> Result<Vec<WasapiDeviceInfo>> {
    if let Err(error) = initialize_mta().ok() {
        return Err(crate::errors::InternalError::Capture(format!(
            "initialize WASAPI COM: {error}"
        ))
        .into());
    }

    let result = enumerate_windows_devices_inner();
    deinitialize();
    result
}

#[cfg(windows)]
fn enumerate_windows_devices_inner() -> Result<Vec<WasapiDeviceInfo>> {
    let enumerator = DeviceEnumerator::new().map_err(|error| {
        crate::errors::InternalError::Capture(format!("create WASAPI device enumerator: {error}"))
    })?;

    let default_capture_id = enumerator
        .get_default_device(&Direction::Capture)
        .ok()
        .and_then(|device| device.get_id().ok());
    let default_render_id = enumerator
        .get_default_device(&Direction::Render)
        .ok()
        .and_then(|device| device.get_id().ok());

    let capture_devices = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(|error| {
            crate::errors::InternalError::Capture(format!(
                "enumerate WASAPI capture endpoints: {error}"
            ))
        })?;
    let render_devices = enumerator
        .get_device_collection(&Direction::Render)
        .map_err(|error| {
            crate::errors::InternalError::Capture(format!(
                "enumerate WASAPI render endpoints: {error}"
            ))
        })?;

    let mut devices = Vec::new();
    for device_result in &capture_devices {
        let device = device_result.map_err(|error| {
            crate::errors::InternalError::Capture(format!("read WASAPI capture endpoint: {error}"))
        })?;
        let id = device.get_id().map_err(|error| {
            crate::errors::InternalError::Capture(format!(
                "read WASAPI capture endpoint id: {error}"
            ))
        })?;
        let name = device
            .get_friendlyname()
            .ok()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Microphone".into());

        devices.push(WasapiDeviceInfo {
            is_default: default_capture_id.as_deref() == Some(id.as_str()),
            id,
            name,
            is_loopback: false,
        });
    }

    for device_result in &render_devices {
        let device = device_result.map_err(|error| {
            crate::errors::InternalError::Capture(format!("read WASAPI render endpoint: {error}"))
        })?;
        let id = device.get_id().map_err(|error| {
            crate::errors::InternalError::Capture(format!(
                "read WASAPI render endpoint id: {error}"
            ))
        })?;
        let friendly_name = device
            .get_friendlyname()
            .ok()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Default output".into());

        devices.push(WasapiDeviceInfo {
            is_default: default_render_id.as_deref() == Some(id.as_str()),
            id,
            name: format!("System Audio (WASAPI Loopback) - {friendly_name}"),
            is_loopback: true,
        });
    }

    tracing::info!(
        count = devices.len(),
        "enumerated native WASAPI audio devices"
    );
    Ok(devices)
}

/// The direction used to open the endpoint. Render endpoints become loopback
/// capture clients while capture endpoints remain ordinary microphone inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasapiCaptureKind {
    Microphone,
    SystemLoopback,
}

#[derive(Debug, Clone)]
pub struct WasapiCaptureOptions {
    pub device_id: Option<String>,
    pub kind: WasapiCaptureKind,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: WasapiSampleFormat,
    pub output_path: PathBuf,
    pub timeline_origin: Instant,
}

impl WasapiCaptureOptions {
    pub fn microphone(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: WasapiCaptureKind::Microphone,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            // Request integer PCM for the microphone. This keeps the capture
            // path in the format used by the Windows recording endpoint and
            // avoids a driver-specific float conversion before encoding.
            sample_format: WasapiSampleFormat::Pcm16,
            output_path,
            timeline_origin: Instant::now(),
        }
    }

    pub fn system_loopback(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: WasapiCaptureKind::SystemLoopback,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            sample_format: WasapiSampleFormat::Pcm16,
            output_path,
            timeline_origin: Instant::now(),
        }
    }

    /// Set the common video-origin clock used to timestamp this audio track.
    pub fn with_timeline_origin(mut self, timeline_origin: Instant) -> Self {
        self.timeline_origin = timeline_origin;
        self
    }
}

/// A running audio capture worker writing one independent WAV track.
#[derive(Debug)]
pub struct WasapiCaptureSession {
    output_path: PathBuf,
    started_at: Instant,
    sample_rate: u32,
    channels: u16,
    sample_format: WasapiSampleFormat,
    stop_requested: Arc<AtomicBool>,
    worker: Option<JoinHandle<std::result::Result<u64, String>>>,
}

impl WasapiCaptureSession {
    pub fn start(options: WasapiCaptureOptions) -> Result<Self> {
        if options.sample_rate == 0 || options.channels == 0 {
            return Err(crate::errors::InternalError::Capture(
                "Audio sample rate and channel count must be positive".into(),
            )
            .into());
        }

        if let Some(parent) = options.output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                crate::errors::InternalError::Storage(format!(
                    "create audio output directory: {error}"
                ))
            })?;
        }

        let output_path = options.output_path.clone();
        let sample_rate = options.sample_rate;
        let channels = options.channels;
        let sample_format = options.sample_format;
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop_requested);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);

        #[cfg(windows)]
        let worker = thread::Builder::new()
            .name(format!(
                "recordforge-wasapi-{}",
                match options.kind {
                    WasapiCaptureKind::Microphone => "microphone",
                    WasapiCaptureKind::SystemLoopback => "system-loopback",
                }
            ))
            .spawn(move || capture_worker(options, worker_stop, ready_tx))
            .map_err(|error| {
                crate::errors::InternalError::Capture(format!(
                    "start WASAPI capture worker: {error}"
                ))
            })?;

        #[cfg(not(windows))]
        let worker = thread::Builder::new()
            .name(format!(
                "recordforge-audio-{}",
                match options.kind {
                    WasapiCaptureKind::Microphone => "microphone",
                    WasapiCaptureKind::SystemLoopback => "system-loopback",
                }
            ))
            .spawn(move || cross_platform_capture_worker(options, worker_stop, ready_tx))
            .map_err(|error| {
                crate::errors::InternalError::Capture(format!(
                    "start audio capture worker: {error}"
                ))
            })?;

        let started_at = match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(started_at)) => started_at,
            Ok(Err(error)) => {
                let _ = worker.join();
                return Err(crate::errors::InternalError::Capture(error).into());
            }
            Err(RecvTimeoutError::Timeout) => {
                stop_requested.store(true, Ordering::Release);
                let _ = worker.join();
                return Err(crate::errors::InternalError::Capture(
                    "Audio capture did not start within five seconds".into(),
                )
                .into());
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = worker.join();
                return Err(crate::errors::InternalError::Capture(
                    "Audio capture worker exited before startup".into(),
                )
                .into());
            }
        };

        tracing::info!(path = %output_path.display(), "started audio capture");
        Ok(Self {
            output_path,
            started_at,
            sample_rate,
            channels,
            sample_format,
            stop_requested,
            worker: Some(worker),
        })
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    /// Signal the capture worker thread to stop reading audio samples immediately,
    /// without blocking to join the thread yet.
    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }

    /// Stop the worker, patch the WAV sizes, and return the number of audio
    /// payload bytes written.
    pub fn stop(&mut self) -> Result<u64> {
        let Some(worker) = self.worker.take() else {
            return Ok(0);
        };
        self.stop_requested.store(true, Ordering::Release);
        let result = worker.join().map_err(|_| {
            crate::errors::InternalError::Capture("Audio capture worker panicked".into())
        })?;
        result.map_err(|error| crate::errors::InternalError::Capture(error).into())
    }

    /// Make the finalized track exactly as long as the segment's video clock.
    /// This removes tail samples captured while FFmpeg flushes and adds silence
    /// when a driver stopped returning packets before the video ended.
    pub fn align_to_duration(&self, duration: Duration) -> Result<u64> {
        self.align_to_timeline(Duration::ZERO, duration)
    }

    /// Align the track to the segment's rendered video timeline. `head_trim`
    /// removes the startup window before the first captured video frame (where
    /// the worker wrote leading silence); `duration` is the video stream's
    /// actual length, and the track is padded or trimmed to match it.
    pub fn align_to_timeline(&self, head_trim: Duration, duration: Duration) -> Result<u64> {
        align_wav_to_duration(
            &self.output_path,
            self.sample_rate,
            self.channels,
            self.sample_format,
            head_trim,
            duration,
        )
        .map_err(|error| {
            crate::errors::InternalError::Capture(format!("align audio track: {error}")).into()
        })
    }
}

impl Drop for WasapiCaptureSession {
    fn drop(&mut self) {
        if self.worker.is_some() {
            if let Err(error) = self.stop() {
                tracing::warn!(error = ?error, path = %self.output_path.display(), "failed to stop audio capture during cleanup");
            }
        }
    }
}

#[cfg(not(windows))]
fn cross_platform_capture_worker(
    options: WasapiCaptureOptions,
    stop_requested: Arc<AtomicBool>,
    ready_tx: SyncSender<std::result::Result<Instant, String>>,
) -> std::result::Result<u64, String> {
    let mut file = match std::fs::File::create(&options.output_path) {
        Ok(f) => f,
        Err(e) => {
            let err = format!("create audio file {}: {e}", options.output_path.display());
            let _ = ready_tx.send(Err(err.clone()));
            return Err(err);
        }
    };

    if let Err(e) = write_wav_header(
        &mut file,
        options.sample_rate,
        options.channels,
        options.sample_format,
    ) {
        let err = format!("write wav header: {e}");
        let _ = ready_tx.send(Err(err.clone()));
        return Err(err);
    }

    let started_at = Instant::now();
    let _ = ready_tx.send(Ok(started_at));

    let frame_size = options.channels as usize * options.sample_format.bytes_per_sample() as usize;
    let chunk_frames = (options.sample_rate / 100).max(1) as usize;
    let chunk_bytes = chunk_frames * frame_size;
    let silence_buffer = vec![0u8; chunk_bytes];
    let mut total_bytes: u64 = 0;

    while !stop_requested.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
        if file.write_all(&silence_buffer).is_ok() {
            total_bytes += chunk_bytes as u64;
        }
    }

    let _ = finalize_wav(&mut file, total_bytes);
    Ok(total_bytes)
}

#[cfg(windows)]
fn capture_worker(
    options: WasapiCaptureOptions,
    stop_requested: Arc<AtomicBool>,
    ready_tx: SyncSender<std::result::Result<Instant, String>>,
) -> std::result::Result<u64, String> {
    if let Err(error) = initialize_mta().ok() {
        return signal_start_error(&ready_tx, format!("initialize WASAPI COM: {error}"));
    }

    let result = capture_worker_inner(options, stop_requested, ready_tx);
    deinitialize();
    result
}

#[cfg(windows)]
fn capture_worker_inner(
    options: WasapiCaptureOptions,
    stop_requested: Arc<AtomicBool>,
    ready_tx: SyncSender<std::result::Result<Instant, String>>,
) -> std::result::Result<u64, String> {
    let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string());
    let enumerator = match enumerator {
        Ok(enumerator) => enumerator,
        Err(error) => {
            return signal_start_error(&ready_tx, format!("create WASAPI enumerator: {error}"))
        }
    };

    let endpoint_direction = match options.kind {
        WasapiCaptureKind::Microphone => Direction::Capture,
        WasapiCaptureKind::SystemLoopback => Direction::Render,
    };
    let device = match options.device_id.as_deref() {
        Some(device_id) => enumerator
            .get_device(device_id)
            .map_err(|error| error.to_string()),
        None => enumerator
            .get_default_device(&endpoint_direction)
            .map_err(|error| error.to_string()),
    };
    let device = match device {
        Ok(device) => device,
        Err(error) => {
            return signal_start_error(
                &ready_tx,
                format!("open WASAPI {} endpoint: {error}", endpoint_direction),
            )
        }
    };
    if device.get_direction() != endpoint_direction {
        return signal_start_error(
            &ready_tx,
            format!(
                "selected WASAPI endpoint direction does not match {} capture",
                endpoint_direction
            ),
        );
    }

    let mut audio_client = match device.get_iaudioclient() {
        Ok(client) => client,
        Err(error) => {
            return signal_start_error(&ready_tx, format!("create WASAPI audio client: {error}"))
        }
    };
    let format = WaveFormat::new(
        usize::from(options.sample_format.bits_per_sample()),
        usize::from(options.sample_format.bits_per_sample()),
        &options.sample_format.wasapi_sample_type(),
        options.sample_rate as usize,
        options.channels as usize,
        None,
    );
    let block_align = format.get_blockalign() as usize;
    if block_align == 0 {
        return signal_start_error(
            &ready_tx,
            "WASAPI returned an invalid block alignment".into(),
        );
    }

    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: AUDIO_BUFFER_DURATION_HNS,
    };
    if let Err(error) = audio_client.initialize_client(&format, &Direction::Capture, &mode) {
        return signal_start_error(
            &ready_tx,
            format!("initialize WASAPI capture stream: {error}"),
        );
    }
    let capture_event = match audio_client.set_get_eventhandle() {
        Ok(handle) => handle,
        Err(error) => {
            return signal_start_error(&ready_tx, format!("create WASAPI capture event: {error}"))
        }
    };
    let capture_client = match audio_client.get_audiocaptureclient() {
        Ok(client) => client,
        Err(error) => {
            return signal_start_error(&ready_tx, format!("get WASAPI capture buffer: {error}"))
        }
    };

    let mut file = match OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(&options.output_path)
    {
        Ok(file) => file,
        Err(error) => {
            return signal_start_error(
                &ready_tx,
                format!(
                    "open WASAPI WAV output {}: {error}",
                    options.output_path.display()
                ),
            )
        }
    };
    if let Err(error) = write_wav_header(
        &mut file,
        options.sample_rate,
        options.channels,
        options.sample_format,
    ) {
        return signal_start_error(&ready_tx, format!("write WASAPI WAV header: {error}"));
    }

    if let Err(error) = audio_client.start_stream() {
        return signal_start_error(&ready_tx, format!("start WASAPI capture stream: {error}"));
    }

    let capture_started_at = Instant::now();
    let stream_offset_frames = frames_for_duration(
        capture_started_at.saturating_duration_since(options.timeline_origin),
        options.sample_rate,
    );
    if ready_tx.send(Ok(capture_started_at)).is_err() {
        let _ = audio_client.stop_stream();
        return Err("WASAPI capture startup acknowledgement was dropped".into());
    }

    let mut data_bytes = 0u64;
    if let Err(error) = append_silence_until(
        &mut file,
        &mut data_bytes,
        stream_offset_frames,
        block_align,
    ) {
        let _ = audio_client.stop_stream();
        let _ = finalize_wav(&mut file, data_bytes);
        return Err(format!("write WASAPI startup silence: {error}"));
    }
    let mut data_frames = data_bytes / block_align as u64;
    let mut last_flush_bytes = data_bytes;
    let is_system_loopback = options.kind == WasapiCaptureKind::SystemLoopback;

    let capture_result = 'capture: loop {
        if stop_requested.load(Ordering::Acquire) {
            break Ok(());
        }

        match capture_event.wait_for_event(AUDIO_EVENT_TIMEOUT_MS) {
            Ok(()) | Err(wasapi::WasapiError::EventTimeout) => {}
            Err(error) => break Err(format!("wait for WASAPI capture event: {error}")),
        }

        loop {
            if stop_requested.load(Ordering::Acquire) {
                break 'capture Ok(());
            }

            let packet_frames = match capture_client.get_next_packet_size() {
                Ok(Some(frames)) if frames > 0 => frames,
                Ok(_) => break,
                Err(error) => break 'capture Err(format!("read WASAPI packet size: {error}")),
            };

            let capacity = match (packet_frames as usize).checked_mul(block_align) {
                Some(capacity) => capacity,
                None => break 'capture Err("WASAPI packet buffer size overflow".into()),
            };
            let mut packet = vec![0u8; capacity];
            let (frames_read, buffer_info) = match capture_client.read_from_device(&mut packet) {
                Ok(result) => result,
                Err(error) => break 'capture Err(format!("read WASAPI audio packet: {error}")),
            };
            // Loopback can stop delivering packets while the output endpoint is
            // silent. Restore that missing interval from a bounded device
            // position/wall-clock estimate, but never trim packets: microphone
            // positions can jitter and removing those samples creates artifacts.
            if is_system_loopback {
                let elapsed_frames =
                    frames_for_duration(capture_started_at.elapsed(), options.sample_rate);
                let packet_start_frames = loopback_packet_start_frames(
                    stream_offset_frames,
                    buffer_info.index,
                    elapsed_frames,
                    data_frames,
                    options.sample_rate,
                );
                if packet_start_frames > data_frames {
                    if let Err(error) = append_silence_until(
                        &mut file,
                        &mut data_bytes,
                        packet_start_frames,
                        block_align,
                    ) {
                        break 'capture Err(format!("write WASAPI loopback silence: {error}"));
                    }
                }
            }

            let payload_len = match (frames_read as usize).checked_mul(block_align) {
                Some(payload_len) => payload_len,
                None => break 'capture Err("WASAPI audio payload size overflow".into()),
            };
            if buffer_info.flags.silent {
                packet[..payload_len].fill(0);
            }
            if let Err(error) = file.write_all(&packet[..payload_len]) {
                break 'capture Err(format!("write WASAPI audio packet: {error}"));
            }
            let written_bytes = payload_len as u64;
            data_bytes = match data_bytes.checked_add(written_bytes) {
                Some(data_bytes) => data_bytes,
                None => break 'capture Err("WASAPI WAV payload size overflow".into()),
            };
            data_frames = data_bytes / block_align as u64;

            // Periodically flush OS write buffers every ~1 second (~192KB) so abrupt power loss or crashes
            // do not lose captured audio packets in write buffers.
            if data_bytes.saturating_sub(last_flush_bytes) >= 192_000 {
                let _ = file.flush();
                last_flush_bytes = data_bytes;
            }

            if buffer_info.flags.data_discontinuity {
                tracing::debug!(
                    path = %options.output_path.display(),
                    packet_index = buffer_info.index,
                    "WASAPI reported an audio data discontinuity"
                );
            }
        }
    };

    let stop_result = audio_client
        .stop_stream()
        .map_err(|error| format!("stop WASAPI capture stream: {error}"));
    if let Err(error) = capture_result {
        let _ = finalize_wav(&mut file, data_bytes);
        return Err(error);
    }
    if let Err(error) = stop_result {
        let _ = finalize_wav(&mut file, data_bytes);
        return Err(error);
    }

    finalize_wav(&mut file, data_bytes).map_err(|error| format!("finalize WASAPI WAV: {error}"))
}

#[cfg(windows)]
fn signal_start_error(
    ready_tx: &SyncSender<std::result::Result<Instant, String>>,
    error: String,
) -> std::result::Result<u64, String> {
    let _ = ready_tx.send(Err(error.clone()));
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::audio::wav::{repair_wav_header_if_needed, WAV_HEADER_SIZE};
    use std::io::{Read, Seek, SeekFrom};

    #[test]
    fn repairs_unfinalized_wav_header() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("unfinalized.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open temporary WAV");

        write_wav_header(&mut file, 48000, 2, WasapiSampleFormat::Pcm16).expect("write header");
        // Simulate writing 1000 bytes of PCM audio without calling finalize_wav
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(&vec![0x7fu8; 1000]).unwrap();
        file.flush().unwrap();
        drop(file);

        let repaired_len = repair_wav_header_if_needed(&path).expect("repair header");
        assert_eq!(repaired_len, 1044);

        let mut read_file = std::fs::File::open(&path).unwrap();
        let mut header = [0u8; 44];
        read_file.read_exact(&mut header).unwrap();

        let riff_size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let data_size = u32::from_le_bytes([header[40], header[41], header[42], header[43]]);
        assert_eq!(data_size, 1000);
        assert_eq!(riff_size, 1036);
    }

    #[test]
    fn uses_a_plausible_loopback_device_position() {
        assert_eq!(loopback_packet_start_frames(100, 500, 450, 100, 1_000), 600);
    }

    #[test]
    fn loopback_packet_position_preserves_idle_leading_silence() {
        let sample_rate = 100;
        let block_align = 2;
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("loopback-offset.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open temporary WAV");
        write_wav_header(&mut file, sample_rate, 1, WasapiSampleFormat::Pcm16)
            .expect("write WAV header");

        let stream_offset_frames = frames_for_duration(Duration::from_secs(1), sample_rate);
        // A broken loopback position must not cause an unbounded silence write.
        let packet_index = u64::MAX;
        let elapsed_frames = frames_for_duration(Duration::from_secs(2), sample_rate);
        let packet_start_frames = loopback_packet_start_frames(
            stream_offset_frames,
            packet_index,
            elapsed_frames,
            stream_offset_frames,
            sample_rate,
        );
        assert_eq!(
            packet_start_frames,
            frames_for_duration(Duration::from_secs(3), sample_rate)
        );
        let mut data_bytes = 0;
        append_silence_until(
            &mut file,
            &mut data_bytes,
            stream_offset_frames,
            block_align,
        )
        .expect("write startup silence");
        append_silence_until(&mut file, &mut data_bytes, packet_start_frames, block_align)
            .expect("write idle loopback silence");
        file.write_all(&[1u8; 2]).expect("write audio packet");
        data_bytes += block_align as u64;
        finalize_wav(&mut file, data_bytes).expect("finalize WAV");

        file.seek(SeekFrom::Start(WAV_HEADER_SIZE))
            .expect("seek to data");
        let mut payload = vec![0u8; (packet_start_frames as usize + 1) * block_align];
        file.read_exact(&mut payload).expect("read WAV payload");

        let packet_offset = packet_start_frames as usize * block_align;
        assert!(payload[..packet_offset].iter().all(|byte| *byte == 0));
        assert_eq!(
            &payload[packet_offset..packet_offset + block_align],
            &[1u8; 2]
        );
    }

    #[test]
    fn aligns_wav_payload_to_video_duration() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("aligned.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open temporary WAV");
        write_wav_header(&mut file, 100, 1, WasapiSampleFormat::Pcm16).expect("write WAV header");
        file.write_all(&[1u8; 2 * 300]).expect("write audio frames");
        finalize_wav(&mut file, 2 * 300).expect("finalize WAV");
        drop(file);

        align_wav_to_duration(
            &path,
            100,
            1,
            WasapiSampleFormat::Pcm16,
            Duration::ZERO,
            Duration::from_secs(1),
        )
        .expect("align WAV to video duration");

        let metadata = std::fs::metadata(&path).expect("read aligned WAV metadata");
        assert_eq!(metadata.len(), WAV_HEADER_SIZE + 100 * 2);
    }

    #[test]
    fn aligns_wav_head_trim_to_video_startup_gap() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("head-trimmed.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open temporary WAV");
        write_wav_header(&mut file, 100, 1, WasapiSampleFormat::Pcm16).expect("write WAV header");
        // 1.5 seconds: [0, 0.5) is startup silence, then a marker frame followed
        // by content. Trimming the startup window must keep the marker at
        // position zero and pad the tail out to the 2-second video length.
        file.write_all(&[0u8; 2 * 50])
            .expect("write startup silence");
        file.write_all(&[7u8; 2]).expect("write marker frame");
        file.write_all(&[1u8; 2 * 99]).expect("write audio frames");
        finalize_wav(&mut file, 2 * 150).expect("finalize WAV");
        drop(file);

        align_wav_to_duration(
            &path,
            100,
            1,
            WasapiSampleFormat::Pcm16,
            Duration::from_millis(500),
            Duration::from_secs(2),
        )
        .expect("align WAV with head trim");

        let mut file = OpenOptions::new()
            .read(true)
            .open(&path)
            .expect("reopen trimmed WAV");
        let metadata = file.metadata().expect("read trimmed WAV metadata");
        assert_eq!(metadata.len(), WAV_HEADER_SIZE + 2 * 200);
        file.seek(SeekFrom::Start(WAV_HEADER_SIZE))
            .expect("seek to data");
        let mut first = [0u8; 2];
        file.read_exact(&mut first).expect("read first frame");
        assert_eq!(first, [7u8; 2]);
        file.seek(SeekFrom::Start(WAV_HEADER_SIZE + 2 * 199))
            .expect("seek to last frame");
        let mut tail = [0u8; 2];
        file.read_exact(&mut tail).expect("read padded silence");
        assert_eq!(tail, [0u8; 2]);
    }

    #[test]
    fn pads_idle_capture_to_video_duration() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("idle.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open temporary WAV");
        write_wav_header(&mut file, 100, 1, WasapiSampleFormat::Pcm16).expect("write WAV header");
        file.write_all(&[1u8; 2]).expect("write one audio frame");
        finalize_wav(&mut file, 2).expect("finalize WAV");
        drop(file);

        align_wav_to_duration(
            &path,
            100,
            1,
            WasapiSampleFormat::Pcm16,
            Duration::ZERO,
            Duration::from_secs(1),
        )
        .expect("pad idle capture to video duration");

        let mut file = OpenOptions::new()
            .read(true)
            .open(&path)
            .expect("reopen padded WAV");
        file.seek(SeekFrom::Start(WAV_HEADER_SIZE + 2))
            .expect("seek past audio frame");
        let mut tail = vec![0u8; 99 * 2];
        file.read_exact(&mut tail).expect("read padded silence");
        assert!(tail.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn uses_pcm16_microphone_and_loopback_defaults() {
        let microphone = WasapiCaptureOptions::microphone(None, PathBuf::from("mic.wav"));
        let system = WasapiCaptureOptions::system_loopback(None, PathBuf::from("system.wav"));

        assert_eq!(microphone.channels, DEFAULT_CHANNELS);
        assert_eq!(system.channels, DEFAULT_CHANNELS);
        assert_eq!(microphone.sample_format, WasapiSampleFormat::Pcm16);
        assert_eq!(system.sample_format, WasapiSampleFormat::Pcm16);
        assert_eq!(microphone.sample_rate, DEFAULT_SAMPLE_RATE);
        assert_eq!(system.sample_rate, DEFAULT_SAMPLE_RATE);
    }

    #[test]
    fn microphone_capture_does_not_default_to_float_samples() {
        let microphone = WasapiCaptureOptions::microphone(None, PathBuf::from("mic.wav"));
        let debug = format!("{microphone:?}");

        assert!(debug.contains("sample_format: Pcm16"));
    }

    #[test]
    fn writes_a_pcm16_stereo_wav_header() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("audio.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .expect("open temporary WAV");

        write_wav_header(
            &mut file,
            DEFAULT_SAMPLE_RATE,
            DEFAULT_CHANNELS,
            WasapiSampleFormat::Pcm16,
        )
        .expect("write WAV header");
        file.write_all(&[0u8; 4]).expect("write one audio frame");
        finalize_wav(&mut file, 4).expect("finalize WAV");

        file.seek(SeekFrom::Start(0)).expect("rewind WAV");
        let mut header = [0u8; 44];
        file.read_exact(&mut header).expect("read WAV header");

        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(header[4..8].try_into().unwrap()), 40);
        assert_eq!(&header[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes(header[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(header[22..24].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(header[24..28].try_into().unwrap()),
            48_000
        );
        assert_eq!(
            u32::from_le_bytes(header[28..32].try_into().unwrap()),
            192_000
        );
        assert_eq!(u16::from_le_bytes(header[32..34].try_into().unwrap()), 4);
        assert_eq!(u16::from_le_bytes(header[34..36].try_into().unwrap()), 16);
        assert_eq!(&header[36..40], b"data");
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 4);
    }

    #[test]
    fn writes_a_float32_wav_header() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("mic.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .expect("open temporary WAV");

        write_wav_header(
            &mut file,
            DEFAULT_SAMPLE_RATE,
            DEFAULT_CHANNELS,
            WasapiSampleFormat::Float32,
        )
        .expect("write WAV header");
        file.write_all(&[0u8; 8]).expect("write one audio frame");
        finalize_wav(&mut file, 8).expect("finalize WAV");

        file.seek(SeekFrom::Start(0)).expect("rewind WAV");
        let mut header = [0u8; 44];
        file.read_exact(&mut header).expect("read WAV header");

        assert_eq!(u16::from_le_bytes(header[20..22].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(header[22..24].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(header[32..34].try_into().unwrap()), 8);
        assert_eq!(u16::from_le_bytes(header[34..36].try_into().unwrap()), 32);
    }

    #[test]
    fn pads_loopback_silence_before_and_after_audio_packet() {
        let sample_rate = 100;
        let block_align = 2;
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("loopback.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .expect("open temporary WAV");
        write_wav_header(&mut file, sample_rate, 1, WasapiSampleFormat::Pcm16)
            .expect("write WAV header");

        let mut data_bytes = 0;
        let first_packet_frame = frames_for_duration(Duration::from_secs(2), sample_rate);
        append_silence_until(&mut file, &mut data_bytes, first_packet_frame, block_align)
            .expect("write leading silence");
        file.write_all(&[1u8; 2]).expect("write audio packet");
        data_bytes += block_align as u64;

        let final_frame_target = frames_for_duration(Duration::from_secs(3), sample_rate);
        append_silence_until(&mut file, &mut data_bytes, final_frame_target, block_align)
            .expect("write trailing silence");
        finalize_wav(&mut file, data_bytes).expect("finalize WAV");

        let payload_len = final_frame_target as usize * block_align;
        file.seek(SeekFrom::Start(WAV_HEADER_SIZE))
            .expect("seek to data");
        let mut payload = vec![0u8; payload_len];
        file.read_exact(&mut payload).expect("read WAV payload");

        let packet_offset = first_packet_frame as usize * block_align;
        assert!(payload[..packet_offset].iter().all(|byte| *byte == 0));
        assert_eq!(
            &payload[packet_offset..packet_offset + block_align],
            &[1u8; 2]
        );
        assert!(payload[packet_offset + block_align..]
            .iter()
            .all(|byte| *byte == 0));
    }
}
