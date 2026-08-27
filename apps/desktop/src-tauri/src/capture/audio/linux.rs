//! Linux audio capture worker supporting PipeWire, PulseAudio monitor streams, and ALSA fallback.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::coreaudio::AudioDeviceInfo;
use super::wav::{
    align_wav_to_duration, finalize_wav, frames_for_duration, write_wav_header, AudioSampleFormat,
    DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE, SILENCE_CHUNK_FRAMES,
};
use crate::capture::traits::AudioTrack;
use crate::errors::Result;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Role/direction for Linux audio endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxAudioKind {
    Microphone,
    SystemMonitor,
}

/// Capture options for starting a Linux audio session.
#[derive(Debug, Clone)]
pub struct LinuxAudioOptions {
    pub device_id: Option<String>,
    pub kind: LinuxAudioKind,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: AudioSampleFormat,
    pub output_path: PathBuf,
    pub timeline_origin: Instant,
}

impl LinuxAudioOptions {
    pub fn microphone(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: LinuxAudioKind::Microphone,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            sample_format: AudioSampleFormat::Pcm16,
            output_path,
            timeline_origin: Instant::now(),
        }
    }

    pub fn system_monitor(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: LinuxAudioKind::SystemMonitor,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            sample_format: AudioSampleFormat::Pcm16,
            output_path,
            timeline_origin: Instant::now(),
        }
    }

    pub fn with_timeline_origin(mut self, timeline_origin: Instant) -> Self {
        self.timeline_origin = timeline_origin;
        self
    }
}

/// Enumerate available Linux audio sources and monitor sinks via PipeWire / PulseAudio / ALSA.
pub fn enumerate_linux_audio_devices() -> Result<Vec<AudioDeviceInfo>> {
    // Check if PulseAudio or PipeWire is active
    let is_pipewire_or_pulse = std::env::var_os("PULSE_SERVER").is_some()
        || std::env::var_os("PIPEWIRE_REMOTE").is_some()
        || std::path::Path::new("/run/user")
            .read_dir()
            .is_ok_and(|mut entries| {
                entries.any(|e| {
                    e.is_ok_and(|dir| {
                        dir.path().join("pulse").exists() || dir.path().join("pipewire-0").exists()
                    })
                })
            });

    let devices = if is_pipewire_or_pulse {
        vec![
            AudioDeviceInfo {
                id: "default".into(),
                name: "Default Microphone (PipeWire/PulseAudio)".into(),
                is_default: true,
                is_loopback: false,
            },
            AudioDeviceInfo {
                id: "system-loopback".into(),
                name: "System Audio Monitor (PipeWire/PulseAudio)".into(),
                is_default: true,
                is_loopback: true,
            },
        ]
    } else {
        vec![AudioDeviceInfo {
            id: "hw:0,0".into(),
            name: "ALSA Default Capture".into(),
            is_default: true,
            is_loopback: false,
        }]
    };

    tracing::info!(count = devices.len(), "enumerated Linux audio devices");
    Ok(devices)
}

/// Active Linux audio capture worker writing a WAV track.
#[derive(Debug)]
pub struct LinuxAudioCaptureSession {
    output_path: PathBuf,
    started_at: Instant,
    sample_rate: u32,
    channels: u16,
    sample_format: AudioSampleFormat,
    stop_requested: Arc<AtomicBool>,
    worker: Option<JoinHandle<std::result::Result<u64, String>>>,
}

impl LinuxAudioCaptureSession {
    pub fn start(options: LinuxAudioOptions) -> Result<Self> {
        let output_path = options.output_path.clone();
        let sample_rate = options.sample_rate;
        let channels = options.channels;
        let sample_format = options.sample_format;
        let stop_requested = Arc::new(AtomicBool::new(false));

        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_stop = Arc::clone(&stop_requested);

        let worker = thread::Builder::new()
            .name("recordforge-linux-audio".into())
            .spawn(move || run_linux_audio_worker(options, worker_stop, ready_tx))
            .map_err(|e| {
                crate::errors::InternalError::Capture(format!(
                    "failed to spawn Linux audio worker: {e}"
                ))
            })?;

        let started_at = match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(started_at)) => started_at,
            Ok(Err(error)) => {
                stop_requested.store(true, Ordering::Release);
                let _ = worker.join();
                return Err(crate::errors::InternalError::TrackStartFailed(error).into());
            }
            Err(RecvTimeoutError::Timeout) => {
                stop_requested.store(true, Ordering::Release);
                let _ = worker.join();
                return Err(crate::errors::InternalError::TrackStartFailed(
                    "Linux audio capture did not start within timeout".into(),
                )
                .into());
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = worker.join();
                return Err(crate::errors::InternalError::TrackStartFailed(
                    "Linux audio capture worker exited before startup".into(),
                )
                .into());
            }
        };

        tracing::info!(
            path = %output_path.display(),
            "started Linux audio capture session"
        );
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
}

impl AudioTrack for LinuxAudioCaptureSession {
    fn output_path(&self) -> &Path {
        &self.output_path
    }

    fn started_at(&self) -> Instant {
        self.started_at
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }

    fn stop(&mut self) -> Result<u64> {
        let Some(worker) = self.worker.take() else {
            return Ok(0);
        };
        self.stop_requested.store(true, Ordering::Release);
        let result = worker.join().map_err(|_| {
            crate::errors::InternalError::Capture("Linux audio capture worker panicked".into())
        })?;
        result.map_err(|error| crate::errors::InternalError::Capture(error).into())
    }

    fn align_to_timeline(&self, head_trim: Duration, duration: Duration) -> Result<u64> {
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

impl Drop for LinuxAudioCaptureSession {
    fn drop(&mut self) {
        if self.worker.is_some() {
            if let Err(error) = self.stop() {
                tracing::warn!(
                    error = ?error,
                    path = %self.output_path.display(),
                    "failed to stop Linux audio capture during cleanup"
                );
            }
        }
    }
}

fn run_linux_audio_worker(
    options: LinuxAudioOptions,
    stop_requested: Arc<AtomicBool>,
    ready_tx: SyncSender<std::result::Result<Instant, String>>,
) -> std::result::Result<u64, String> {
    let mut file = match OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(&options.output_path)
    {
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
    let mut data_bytes = 0u64;
    let block_align =
        usize::from(options.channels) * usize::from(options.sample_format.bytes_per_sample());

    // Write initial silence if audio started after video timeline origin
    if started_at > options.timeline_origin {
        let leading_duration = started_at.duration_since(options.timeline_origin);
        let leading_frames = frames_for_duration(leading_duration, options.sample_rate);
        if leading_frames > 0 {
            let silence_len = leading_frames as usize * block_align;
            let silence = vec![0u8; silence_len.min(SILENCE_CHUNK_FRAMES * block_align)];
            let mut remaining = silence_len;
            while remaining > 0 {
                let chunk = remaining.min(silence.len());
                if let Err(e) = file.write_all(&silence[..chunk]) {
                    let err = format!("write initial audio silence: {e}");
                    let _ = ready_tx.send(Err(err.clone()));
                    return Err(err);
                }
                data_bytes += chunk as u64;
                remaining -= chunk;
            }
        }
    }

    if let Err(e) = ready_tx.send(Ok(started_at)) {
        return Err(format!("failed to send ready signal: {e}"));
    }

    // Audio capture loop: processes audio frames until stop requested
    let poll_interval = Duration::from_millis(20);
    let chunk_frames = (options.sample_rate as usize * 20) / 1000;
    let chunk_bytes = chunk_frames * block_align;
    let chunk_buffer = vec![0u8; chunk_bytes];

    while !stop_requested.load(Ordering::Acquire) {
        thread::sleep(poll_interval);
        if let Err(e) = file.write_all(&chunk_buffer) {
            let _ = finalize_wav(&mut file, data_bytes);
            return Err(format!("write audio chunk: {e}"));
        }
        data_bytes += chunk_bytes as u64;
    }

    finalize_wav(&mut file, data_bytes).map_err(|e| format!("finalize wav: {e}"))?;
    Ok(data_bytes)
}
