//! Native Windows WASAPI capture for microphone and system-audio tracks.
//!
//! System audio is captured from a render endpoint with the WASAPI loopback
//! stream flag. Microphones use the normal WASAPI capture direction. Both
//! paths write independent float32 WAV assets so FFmpeg never needs a
//! DirectShow audio device or a virtual Stereo Mix device.

use crate::errors::Result;
use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(windows)]
use wasapi::{
    deinitialize, initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};

const DEFAULT_SAMPLE_RATE: u32 = 48_000;
const DEFAULT_CHANNELS: u16 = 2;
const AUDIO_BUFFER_DURATION_HNS: i64 = 100_000;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const WAV_HEADER_SIZE: u64 = 44;
const SILENCE_CHUNK_FRAMES: usize = 4096;

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
    pub output_path: PathBuf,
}

impl WasapiCaptureOptions {
    pub fn microphone(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: WasapiCaptureKind::Microphone,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            output_path,
        }
    }

    pub fn system_loopback(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: WasapiCaptureKind::SystemLoopback,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            output_path,
        }
    }
}

/// A running native WASAPI capture worker writing one independent WAV track.
#[derive(Debug)]
pub struct WasapiCaptureSession {
    output_path: PathBuf,
    started_at: Instant,
    #[cfg(windows)]
    stop_requested: Arc<AtomicBool>,
    #[cfg(windows)]
    worker: Option<JoinHandle<std::result::Result<u64, String>>>,
}

impl WasapiCaptureSession {
    pub fn start(options: WasapiCaptureOptions) -> Result<Self> {
        if options.sample_rate == 0 || options.channels == 0 {
            return Err(crate::errors::InternalError::Capture(
                "WASAPI sample rate and channel count must be positive".into(),
            )
            .into());
        }

        if let Some(parent) = options.output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                crate::errors::InternalError::Storage(format!(
                    "create WASAPI audio output directory: {error}"
                ))
            })?;
        }

        #[cfg(windows)]
        {
            let output_path = options.output_path.clone();
            let stop_requested = Arc::new(AtomicBool::new(false));
            let worker_stop = Arc::clone(&stop_requested);
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
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
                        "WASAPI capture did not start within five seconds".into(),
                    )
                    .into());
                }
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = worker.join();
                    return Err(crate::errors::InternalError::Capture(
                        "WASAPI capture worker exited before startup".into(),
                    )
                    .into());
                }
            };

            tracing::info!(path = %output_path.display(), "started native WASAPI capture");
            Ok(Self {
                output_path,
                started_at,
                stop_requested,
                worker: Some(worker),
            })
        }

        #[cfg(not(windows))]
        {
            let _ = options;
            Err(crate::errors::InternalError::Capture(
                "native WASAPI capture is only available on Windows".into(),
            )
            .into())
        }
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    /// Stop the worker, patch the WAV sizes, and return the number of audio
    /// payload bytes written. The worker owns all WASAPI interfaces, so stop
    /// and join happen on the same COM thread that created the stream.
    pub fn stop(&mut self) -> Result<u64> {
        #[cfg(windows)]
        {
            let Some(worker) = self.worker.take() else {
                return Ok(0);
            };
            self.stop_requested.store(true, Ordering::Release);
            let result = worker.join().map_err(|_| {
                crate::errors::InternalError::Capture("WASAPI capture worker panicked".into())
            })?;
            result.map_err(|error| crate::errors::InternalError::Capture(error).into())
        }

        #[cfg(not(windows))]
        {
            Ok(0)
        }
    }
}

impl Drop for WasapiCaptureSession {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.worker.is_some() {
            if let Err(error) = self.stop() {
                tracing::warn!(error = ?error, path = %self.output_path.display(), "failed to stop WASAPI capture during cleanup");
            }
        }
    }
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

    let mut audio_client = match device.get_iaudioclient() {
        Ok(client) => client,
        Err(error) => {
            return signal_start_error(&ready_tx, format!("create WASAPI audio client: {error}"))
        }
    };
    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
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

    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: AUDIO_BUFFER_DURATION_HNS,
    };
    if let Err(error) = audio_client.initialize_client(&format, &Direction::Capture, &mode) {
        return signal_start_error(
            &ready_tx,
            format!("initialize WASAPI capture stream: {error}"),
        );
    }
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
    if let Err(error) = write_wav_header(&mut file, options.sample_rate, options.channels) {
        return signal_start_error(&ready_tx, format!("write WASAPI WAV header: {error}"));
    }

    if let Err(error) = audio_client.start_stream() {
        return signal_start_error(&ready_tx, format!("start WASAPI capture stream: {error}"));
    }

    let capture_started_at = Instant::now();
    if ready_tx.send(Ok(capture_started_at)).is_err() {
        let _ = audio_client.stop_stream();
        return Err("WASAPI capture startup acknowledgement was dropped".into());
    }

    let mut data_bytes = 0u64;
    let capture_result = loop {
        if stop_requested.load(Ordering::Acquire) {
            break Ok(());
        }

        let packet_frames = match capture_client.get_next_packet_size() {
            Ok(Some(frames)) if frames > 0 => frames,
            Ok(_) => {
                thread::sleep(Duration::from_millis(3));
                continue;
            }
            Err(error) => break Err(format!("read WASAPI packet size: {error}")),
        };

        let capacity = packet_frames as usize * block_align;
        let mut packet = vec![0u8; capacity];
        let (frames_read, buffer_info) = match capture_client.read_from_device(&mut packet) {
            Ok(result) => result,
            Err(error) => break Err(format!("read WASAPI audio packet: {error}")),
        };
        let elapsed_frames = frames_for_duration(capture_started_at.elapsed(), options.sample_rate);
        let packet_start_frames = buffer_info.index.max(elapsed_frames);
        if let Err(error) =
            append_silence_until(&mut file, &mut data_bytes, packet_start_frames, block_align)
        {
            break Err(format!("write WASAPI silent gap: {error}"));
        }

        let payload_len = frames_read as usize * block_align;
        if buffer_info.flags.silent {
            packet[..payload_len].fill(0);
        }
        if let Err(error) = file.write_all(&packet[..payload_len]) {
            break Err(format!("write WASAPI audio packet: {error}"));
        }
        data_bytes = data_bytes.saturating_add(payload_len as u64);

        if buffer_info.flags.data_discontinuity {
            tracing::debug!(path = %options.output_path.display(), "WASAPI reported an audio data discontinuity");
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

    let final_frame_target = frames_for_duration(capture_started_at.elapsed(), options.sample_rate);
    append_silence_until(&mut file, &mut data_bytes, final_frame_target, block_align)
        .map_err(|error| format!("write final WASAPI silence: {error}"))?;

    finalize_wav(&mut file, data_bytes).map_err(|error| format!("finalize WASAPI WAV: {error}"))
}

fn frames_for_duration(duration: Duration, sample_rate: u32) -> u64 {
    let frames = duration.as_nanos().saturating_mul(u128::from(sample_rate)) / 1_000_000_000;
    u64::try_from(frames).unwrap_or(u64::MAX)
}

fn append_silence_until(
    file: &mut std::fs::File,
    data_bytes: &mut u64,
    target_frames: u64,
    block_align: usize,
) -> std::io::Result<()> {
    if block_align == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "WAV block alignment must be positive",
        ));
    }

    let current_frames = *data_bytes / block_align as u64;
    let mut remaining_frames = target_frames.saturating_sub(current_frames);
    if remaining_frames == 0 {
        return Ok(());
    }

    let silence_buffer_len = SILENCE_CHUNK_FRAMES
        .checked_mul(block_align)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WAV silence buffer size overflow",
            )
        })?;
    let silence = vec![0u8; silence_buffer_len];

    while remaining_frames > 0 {
        let frames = remaining_frames.min(SILENCE_CHUNK_FRAMES as u64) as usize;
        let bytes = frames.checked_mul(block_align).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "WAV silence payload size overflow",
            )
        })?;
        file.write_all(&silence[..bytes])?;
        *data_bytes = data_bytes.checked_add(bytes as u64).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "WAV payload size overflow")
        })?;
        remaining_frames -= frames as u64;
    }

    Ok(())
}

#[cfg(windows)]
fn signal_start_error(
    ready_tx: &SyncSender<std::result::Result<Instant, String>>,
    error: String,
) -> std::result::Result<u64, String> {
    let _ = ready_tx.send(Err(error.clone()));
    Err(error)
}

fn write_wav_header(
    file: &mut std::fs::File,
    sample_rate: u32,
    channels: u16,
) -> std::io::Result<()> {
    let block_align = channels.checked_mul(4).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "WAV block alignment overflow",
        )
    })?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(block_align))
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "WAV byte rate overflow")
        })?;

    file.seek(SeekFrom::Start(0))?;
    file.write_all(b"RIFF")?;
    file.write_all(&0u32.to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&3u16.to_le_bytes())?;
    file.write_all(&channels.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&32u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&0u32.to_le_bytes())?;
    Ok(())
}

fn finalize_wav(file: &mut std::fs::File, data_bytes: u64) -> std::io::Result<u64> {
    let data_size = u32::try_from(data_bytes).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "WAV payload exceeds the 4 GB RIFF limit",
        )
    })?;
    let riff_size = 36u32.checked_add(data_size).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "WAV RIFF size overflow")
    })?;

    file.seek(SeekFrom::Start(4))?;
    file.write_all(&riff_size.to_le_bytes())?;
    file.seek(SeekFrom::Start(40))?;
    file.write_all(&data_size.to_le_bytes())?;
    file.flush()?;
    file.sync_all()?;
    Ok(data_bytes + WAV_HEADER_SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn writes_a_float32_stereo_wav_header() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("audio.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .expect("open temporary WAV");

        write_wav_header(&mut file, DEFAULT_SAMPLE_RATE, DEFAULT_CHANNELS)
            .expect("write WAV header");
        file.write_all(&[0u8; 8]).expect("write one audio frame");
        finalize_wav(&mut file, 8).expect("finalize WAV");

        file.seek(SeekFrom::Start(0)).expect("rewind WAV");
        let mut header = [0u8; 44];
        file.read_exact(&mut header).expect("read WAV header");

        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(header[4..8].try_into().unwrap()), 44);
        assert_eq!(&header[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes(header[20..22].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(header[22..24].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(header[24..28].try_into().unwrap()),
            48_000
        );
        assert_eq!(
            u32::from_le_bytes(header[28..32].try_into().unwrap()),
            384_000
        );
        assert_eq!(u16::from_le_bytes(header[32..34].try_into().unwrap()), 8);
        assert_eq!(u16::from_le_bytes(header[34..36].try_into().unwrap()), 32);
        assert_eq!(&header[36..40], b"data");
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 8);
    }

    #[test]
    fn pads_loopback_silence_before_and_after_audio_packet() {
        let sample_rate = 100;
        let block_align = 4;
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("loopback.wav");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .expect("open temporary WAV");
        write_wav_header(&mut file, sample_rate, 1).expect("write WAV header");

        let mut data_bytes = 0;
        let first_packet_frame = frames_for_duration(Duration::from_secs(2), sample_rate);
        append_silence_until(&mut file, &mut data_bytes, first_packet_frame, block_align)
            .expect("write leading silence");
        file.write_all(&[1u8; 4]).expect("write audio packet");
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
            &[1u8; 4]
        );
        assert!(payload[packet_offset + block_align..]
            .iter()
            .all(|byte| *byte == 0));
    }
}
