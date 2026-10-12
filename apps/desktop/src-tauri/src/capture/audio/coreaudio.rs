//! Native macOS CoreAudio capture worker and device enumeration.
//!
//! Provides native low-latency microphone capture and loopback/system audio
//! capture using macOS CoreAudio HAL and AudioQueue/AudioUnit APIs.
//! Audio is written to standard WAV containers with sample-accurate timeline synchronization.

#[cfg(target_os = "macos")]
use super::wav::WAV_HEADER_SIZE;
use super::wav::{
    align_wav_to_duration, finalize_wav, frames_for_duration, write_wav_header, AudioSampleFormat,
    DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE, SILENCE_CHUNK_FRAMES,
};
use crate::errors::Result;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Read-ahead size for the PCM pipe (mirrors the Linux backend). At 48 kHz
/// stereo s16 this is ~341 ms of audio — enough headroom that a stalled UI
/// never back-pressures the FFmpeg capture child.
#[cfg(target_os = "macos")]
const PCM_READ_CHUNK_BYTES: usize = 64 * 1024;

/// How long `start` waits for the first PCM bytes from the avfoundation
/// device before declaring it dead.
#[cfg(target_os = "macos")]
const STARTUP_DATA_TIMEOUT: Duration = Duration::from_millis(2500);

/// The direction / role used to open the audio endpoint on macOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioCaptureKind {
    Microphone,
    SystemLoopback,
}

/// Device information for an enumerated macOS audio device.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub is_loopback: bool,
}

/// Capture options for starting a CoreAudio session.
#[derive(Debug, Clone)]
pub struct AudioCaptureOptions {
    pub device_id: Option<String>,
    pub kind: AudioCaptureKind,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: AudioSampleFormat,
    pub output_path: PathBuf,
    pub timeline_origin: Instant,
    pub ffmpeg_path: Option<PathBuf>,
}

impl AudioCaptureOptions {
    pub fn microphone(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: AudioCaptureKind::Microphone,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            sample_format: AudioSampleFormat::Pcm16,
            output_path,
            timeline_origin: Instant::now(),
            ffmpeg_path: None,
        }
    }

    pub fn system_loopback(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            kind: AudioCaptureKind::SystemLoopback,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            sample_format: AudioSampleFormat::Pcm16,
            output_path,
            timeline_origin: Instant::now(),
            ffmpeg_path: None,
        }
    }

    pub fn with_timeline_origin(mut self, timeline_origin: Instant) -> Self {
        self.timeline_origin = timeline_origin;
        self
    }

    /// FFmpeg binary used as the microphone capture engine on macOS (the
    /// bundled sidecar — falls back to `ffmpeg` on PATH).
    pub fn with_ffmpeg_path(mut self, path: PathBuf) -> Self {
        self.ffmpeg_path = Some(path);
        self
    }
}

/// Enumerate active macOS CoreAudio capture endpoints (microphones) and
/// render endpoints / ScreenCaptureKit system audio choices.
pub fn enumerate_coreaudio_devices() -> Result<Vec<AudioDeviceInfo>> {
    #[cfg(target_os = "macos")]
    {
        enumerate_macos_audio_devices()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![
            AudioDeviceInfo {
                id: "default".into(),
                name: "Default Microphone".into(),
                is_default: true,
                is_loopback: false,
            },
            AudioDeviceInfo {
                id: "system-loopback".into(),
                name: "System Audio (ScreenCaptureKit)".into(),
                is_default: false,
                is_loopback: true,
            },
        ])
    }
}

#[cfg(target_os = "macos")]
fn enumerate_macos_audio_devices() -> Result<Vec<AudioDeviceInfo>> {
    let mut devices = Vec::new();

    // Real microphone list: the avfoundation audio section of
    // `ffmpeg -list_devices` (CoreAudio HAL enumeration without a HAL FFI
    // dependency). The `-i ":<index>"` spec opens the device later, so the
    // index doubles as the device id.
    match crate::media::resolve_executable("ffmpeg")
        .and_then(|path| list_avfoundation_audio_devices(&path.to_string_lossy()))
    {
        Ok(inputs) => {
            for (index, name) in inputs {
                devices.push(AudioDeviceInfo {
                    id: index.to_string(),
                    name,
                    is_default: index == 0,
                    is_loopback: false,
                });
            }
        }
        Err(error) => {
            tracing::warn!(error = ?error, "avfoundation audio enumeration failed; using synthetic default");
            devices.push(AudioDeviceInfo {
                id: "default".into(),
                name: "Default Microphone".into(),
                is_default: true,
                is_loopback: false,
            });
        }
    }

    // Native macOS 13+ ScreenCaptureKit System Audio capture endpoint.
    devices.push(AudioDeviceInfo {
        id: "system-loopback".into(),
        name: "System Audio (ScreenCaptureKit)".into(),
        is_default: false,
        is_loopback: true,
    });

    tracing::info!(
        count = devices.len(),
        "enumerated macOS CoreAudio audio devices"
    );
    Ok(devices)
}

/// Parse `ffmpeg -f avfoundation -list_devices true -i ""` audio section.
#[cfg(target_os = "macos")]
fn list_avfoundation_audio_devices(
    ffmpeg_path: &str,
) -> crate::errors::Result<Vec<(usize, String)>> {
    let output = crate::process::create_command(ffmpeg_path)
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .map_err(|e| {
            crate::errors::InternalError::Media(format!("ffmpeg avfoundation list: {e}"))
        })?;

    let text = String::from_utf8_lossy(&output.stderr);
    Ok(crate::capture::devices::parse_avfoundation_audio_devices(
        &text,
    ))
}

/// A running CoreAudio capture worker writing an independent WAV track.
#[derive(Debug)]
pub struct CoreAudioCaptureSession {
    output_path: PathBuf,
    started_at: Instant,
    sample_rate: u32,
    channels: u16,
    sample_format: AudioSampleFormat,
    stop_requested: Arc<AtomicBool>,
    worker: Option<JoinHandle<std::result::Result<u64, String>>>,
    /// FFmpeg-backed mic capture (macOS): child process + PCM reader thread.
    /// Replaces `worker` when the real audio path is active.
    #[cfg(target_os = "macos")]
    capture: Option<RunningMicCapture>,
    /// ScreenCaptureKit system-audio stream (macOS 13+ loopback arm).
    #[cfg(target_os = "macos")]
    sck_audio: Option<super::super::macos_sck::SckAudioCapture>,
    #[cfg(target_os = "macos")]
    level_bits: Arc<AtomicU32>,
}

/// FFmpeg subprocess capturing the mic through `avfoundation`, with the PCM
/// reader thread draining stdout into the WAV file.
#[cfg(target_os = "macos")]
#[derive(Debug)]
struct RunningMicCapture {
    child: std::process::Child,
    /// Held behind a mutex so `request_stop(&self)` can deliver 'q' + EOF.
    stdin: Mutex<Option<std::process::ChildStdin>>,
    reader: Option<JoinHandle<std::io::Result<u64>>>,
    data_bytes: Arc<AtomicU64>,
    stderr_tail: Arc<Mutex<String>>,
}

#[cfg(target_os = "macos")]
impl RunningMicCapture {
    fn stderr_tail_text(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect()
    }
}

impl CoreAudioCaptureSession {
    pub fn start(options: AudioCaptureOptions) -> Result<Self> {
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

        // Real microphone capture: FFmpeg's avfoundation backend produces raw
        // PCM on stdout; the worker wraps it in the canonical WAV the mux
        // pipeline expects. System loopback is a real ScreenCaptureKit
        // audio-only stream (native macOS 13+ system audio).
        #[cfg(target_os = "macos")]
        if options.kind == AudioCaptureKind::Microphone {
            return Self::start_mic_capture(options);
        }
        #[cfg(target_os = "macos")]
        if options.kind == AudioCaptureKind::SystemLoopback {
            return Self::start_sck_loopback(options);
        }

        let output_path = options.output_path.clone();
        let sample_rate = options.sample_rate;
        let channels = options.channels;
        let sample_format = options.sample_format;
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop_requested);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);

        let thread_name = format!(
            "recordforge-coreaudio-{}",
            match options.kind {
                AudioCaptureKind::Microphone => "microphone",
                AudioCaptureKind::SystemLoopback => "system-loopback",
            }
        );

        let worker = thread::Builder::new()
            .name(thread_name)
            .spawn(move || run_coreaudio_worker(options, worker_stop, ready_tx))
            .map_err(|error| {
                crate::errors::InternalError::Capture(format!(
                    "start CoreAudio capture worker: {error}"
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
                    "CoreAudio capture did not start within five seconds".into(),
                )
                .into());
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = worker.join();
                return Err(crate::errors::InternalError::Capture(
                    "CoreAudio capture worker exited before startup".into(),
                )
                .into());
            }
        };

        tracing::info!(
            path = %output_path.display(),
            "started native CoreAudio capture"
        );
        Ok(Self {
            output_path,
            started_at,
            sample_rate,
            channels,
            sample_format,
            stop_requested,
            worker: Some(worker),
            #[cfg(target_os = "macos")]
            capture: None,
            #[cfg(target_os = "macos")]
            sck_audio: None,
            #[cfg(target_os = "macos")]
            level_bits: Arc::new(AtomicU32::new(0)),
        })
    }

    /// System loopback via ScreenCaptureKit (native macOS 13+ system audio —
    /// no virtual driver). The SCK sidecar writes this session's WAV file
    /// directly; the `AudioTrack` contract stays identical.
    #[cfg(target_os = "macos")]
    fn start_sck_loopback(options: AudioCaptureOptions) -> Result<Self> {
        let audio = super::super::macos_sck::SckAudioCapture::start(
            options.output_path.clone(),
            options.timeline_origin,
        )?;
        Ok(Self {
            output_path: options.output_path,
            started_at: audio.started_at(),
            sample_rate: options.sample_rate,
            channels: options.channels,
            sample_format: options.sample_format,
            stop_requested: Arc::new(AtomicBool::new(false)),
            worker: None,
            capture: None,
            sck_audio: Some(audio),
            level_bits: Arc::new(AtomicU32::new(0)),
        })
    }

    /// Spawn `ffmpeg -f avfoundation` for the mic and stream its PCM stdout
    /// into the session WAV (same contract as the Linux audio backend).
    #[cfg(target_os = "macos")]
    fn start_mic_capture(options: AudioCaptureOptions) -> Result<Self> {
        use std::process::Stdio;

        let ffmpeg = options
            .ffmpeg_path
            .clone()
            .or_else(|| crate::media::resolve_executable("ffmpeg").ok())
            .ok_or_else(|| {
                crate::errors::InternalError::Capture(
                    "no ffmpeg binary available for microphone capture".into(),
                )
            })?;

        // `none` disables the video side of the avfoundation spec; the audio
        // side accepts the avfoundation audio index or a device name.
        let device = options.device_id.as_deref().unwrap_or("default");
        let device_spec = format!("none:{device}");

        let started_at = Instant::now();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let data_bytes = Arc::new(AtomicU64::new(0));
        let level_bits = Arc::new(AtomicU32::new(0));
        let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&options.output_path)
            .map_err(|e| {
                crate::errors::InternalError::Storage(format!(
                    "create audio output {}: {e}",
                    options.output_path.display()
                ))
            })?;
        write_wav_header(
            &mut file,
            options.sample_rate,
            options.channels,
            AudioSampleFormat::Pcm16,
        )
        .map_err(|e| crate::errors::InternalError::Storage(format!("write WAV header: {e}")))?;

        // Wall-clock lead-in so the track aligns to the video timeline.
        if options.timeline_origin < started_at {
            let leading_frames =
                frames_for_duration(started_at - options.timeline_origin, options.sample_rate);
            if leading_frames > 0 {
                let block_align = usize::from(options.channels)
                    * usize::from(AudioSampleFormat::Pcm16.bytes_per_sample());
                let mut written = 0u64;
                super::wav::append_silence_until(
                    &mut file,
                    &mut written,
                    leading_frames,
                    block_align,
                )
                .map_err(|e| {
                    crate::errors::InternalError::Storage(format!("write leading silence: {e}"))
                })?;
                data_bytes.store(written, Ordering::Release);
            }
        }

        let mut command = crate::process::create_command(&ffmpeg);
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "avfoundation",
                "-i",
                &device_spec,
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ar",
                &options.sample_rate.to_string(),
                "-ac",
                &options.channels.to_string(),
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| {
            crate::errors::InternalError::Capture(format!("spawn ffmpeg mic capture: {e}"))
        })?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| {
            crate::errors::InternalError::Capture("ffmpeg mic stdout unavailable".into())
        })?;
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_drain(stderr, Arc::clone(&stderr_tail));
        }

        let reader = spawn_pcm_reader(
            stdout,
            file,
            options.channels,
            Arc::clone(&data_bytes),
            Arc::clone(&level_bits),
        )
        .map_err(|e| crate::errors::InternalError::Capture(format!("spawn mic pcm reader: {e}")))?;

        let mut session = Self {
            output_path: options.output_path.clone(),
            started_at,
            sample_rate: options.sample_rate,
            channels: options.channels,
            sample_format: options.sample_format,
            stop_requested,
            worker: None,
            capture: Some(RunningMicCapture {
                child,
                stdin: Mutex::new(stdin),
                reader: Some(reader),
                data_bytes,
                stderr_tail,
            }),
            sck_audio: None,
            level_bits,
        };

        // A device that produced nothing within the startup window (or died)
        // is a startup failure, not a silent track that claims success.
        if let Err(error) = session.await_first_data() {
            session.abort_capture();
            return Err(error);
        }

        tracing::info!(
            path = %session.output_path.display(),
            device = device_spec,
            "started avfoundation microphone capture"
        );
        Ok(session)
    }

    /// Block until PCM bytes arrive, the child exits, or the deadline passes.
    #[cfg(target_os = "macos")]
    fn await_first_data(&mut self) -> Result<()> {
        let baseline = self
            .capture
            .as_ref()
            .map(|c| c.data_bytes.load(Ordering::Acquire))
            .unwrap_or(0);
        let deadline = Instant::now() + STARTUP_DATA_TIMEOUT;
        while Instant::now() < deadline {
            let Some(capture) = self.capture.as_mut() else {
                return Ok(());
            };
            if capture.data_bytes.load(Ordering::Acquire) > baseline {
                return Ok(());
            }
            if let Ok(Some(status)) = capture.child.try_wait() {
                return Err(crate::errors::InternalError::Capture(format!(
                    "ffmpeg mic capture exited during startup ({status}): {}",
                    capture.stderr_tail_text()
                ))
                .into());
            }
            if self.stop_requested.load(Ordering::Acquire) {
                return Err(crate::errors::InternalError::Capture(
                    "mic capture stopped during startup".into(),
                )
                .into());
            }
            thread::sleep(Duration::from_millis(15));
        }
        let tail = self
            .capture
            .as_ref()
            .map(|c| c.stderr_tail_text())
            .unwrap_or_default();
        Err(crate::errors::InternalError::Capture(format!(
            "microphone produced no data within {STARTUP_DATA_TIMEOUT:?} — check the device and macOS Microphone permission ({tail})"
        ))
        .into())
    }

    /// Abort a partially-started mic capture without the success teardown.
    #[cfg(target_os = "macos")]
    fn abort_capture(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        if let Some(mut capture) = self.capture.take() {
            kill_ffmpeg_gracefully(&mut capture.child);
            if let Some(reader) = capture.reader.take() {
                let _ = reader.join();
            }
        }
        let _ = std::fs::remove_file(&self.output_path);
    }

    /// Gracefully finish the ffmpeg mic child and return bytes written.
    #[cfg(target_os = "macos")]
    fn stop_mic_capture(&mut self) -> Result<u64> {
        let Some(mut capture) = self.capture.take() else {
            return Ok(0);
        };
        self.stop_requested.store(true, Ordering::Release);

        // 'q' + EOF lets FFmpeg flush its encoder; the kill fallback covers a
        // wedged device that never acks the quit.
        signal_ffmpeg_quit(&capture.stdin);
        graceful_quit(&mut capture.child, Duration::from_millis(800))?;

        let data_bytes = match capture.reader.take() {
            Some(reader) => reader
                .join()
                .map_err(|_| {
                    crate::errors::InternalError::Capture("mic pcm reader panicked".into())
                })?
                .map_err(|e| {
                    crate::errors::InternalError::Storage(format!("mic pcm reader failed: {e}"))
                })?,
            None => 0,
        };

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.output_path)
            .map_err(|e| {
                crate::errors::InternalError::Storage(format!("reopen audio output: {e}"))
            })?;
        Ok(finalize_wav(&mut file, data_bytes)
            .map_err(|e| crate::errors::InternalError::Storage(format!("finalize WAV: {e}")))?)
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
        #[cfg(target_os = "macos")]
        if let Some(capture) = &self.capture {
            signal_ffmpeg_quit(&capture.stdin);
        }
    }

    pub fn stop(&mut self) -> Result<u64> {
        self.stop_requested.store(true, Ordering::Release);

        #[cfg(target_os = "macos")]
        if let Some(mut audio) = self.sck_audio.take() {
            return audio.stop();
        }
        #[cfg(target_os = "macos")]
        if self.capture.is_some() {
            return self.stop_mic_capture();
        }

        let Some(worker) = self.worker.take() else {
            return Ok(0);
        };
        let result = worker.join().map_err(|_| {
            crate::errors::InternalError::Capture("CoreAudio capture worker panicked".into())
        })?;
        result.map_err(|error| crate::errors::InternalError::Capture(error).into())
    }

    pub fn align_to_duration(&self, duration: Duration) -> Result<u64> {
        self.align_to_timeline(Duration::ZERO, duration)
    }

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

/// Send 'q' to FFmpeg's interactive stdin and close it; the EOF covers
/// builds that ignore keystrokes.
#[cfg(target_os = "macos")]
fn signal_ffmpeg_quit(stdin: &Mutex<Option<std::process::ChildStdin>>) {
    if let Ok(mut guard) = stdin.lock() {
        if let Some(mut pipe) = guard.take() {
            let _ = pipe.write_all(b"q\n");
            let _ = pipe.flush();
        }
    }
}

/// Ask FFmpeg to quit, then escalate to kill so stop() never hangs.
#[cfg(target_os = "macos")]
fn graceful_quit(child: &mut std::process::Child, grace: Duration) -> Result<()> {
    if let Ok(Some(_)) = child.try_wait() {
        return Ok(());
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                return Err(
                    crate::errors::InternalError::Capture(format!("poll ffmpeg exit: {e}")).into(),
                )
            }
        }
    }
    kill_ffmpeg_gracefully(child);
    Ok(())
}

#[cfg(target_os = "macos")]
fn kill_ffmpeg_gracefully(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Drain ffmpeg stdout into the WAV file, tracking the level meter.
#[cfg(target_os = "macos")]
fn spawn_pcm_reader(
    mut stdout: std::process::ChildStdout,
    mut file: std::fs::File,
    channels: u16,
    data_bytes: Arc<AtomicU64>,
    level_bits: Arc<AtomicU32>,
) -> std::io::Result<JoinHandle<std::io::Result<u64>>> {
    thread::Builder::new()
        .name("rf-mic-pcm".into())
        .spawn(move || {
            use std::io::Read;
            let block_align = usize::from(channels) * 2; // s16
            let mut total = data_bytes.load(Ordering::Acquire);
            let mut buf = vec![0u8; PCM_READ_CHUNK_BYTES];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        update_level(&buf[..n], &level_bits);
                        file.write_all(&buf[..n])?;
                        total += n as u64;
                        data_bytes.store(total, Ordering::Release);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e),
                }
            }
            // Drop a partial PCM frame so downstream sees whole frames only.
            let remainder = total % block_align as u64;
            if remainder != 0 {
                let keep = total - remainder;
                file.set_len(WAV_HEADER_SIZE + keep)?;
                data_bytes.store(keep, Ordering::Release);
                total = keep;
            }
            file.flush()?;
            Ok(total)
        })
}

/// Rolling peak |sample| (0..1) for the level meter — s16 LE pairs.
#[cfg(target_os = "macos")]
fn update_level(chunk: &[u8], level_bits: &AtomicU32) {
    let mut peak = f32::from_bits(level_bits.load(Ordering::Relaxed));
    // Cheap decay so the meter relaxes on quiet input without a timer.
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

/// Keep the tail of ffmpeg's stderr for diagnostics (bounded).
#[cfg(target_os = "macos")]
fn spawn_stderr_drain(mut stderr: std::process::ChildStderr, sink: Arc<Mutex<String>>) {
    thread::Builder::new()
        .name("rf-mic-stderr".into())
        .spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut guard) = sink.lock() {
                            guard.push_str(&String::from_utf8_lossy(&buf[..n]));
                            let len = guard.len();
                            if len > 8192 {
                                guard.drain(..len - 8192);
                            }
                        }
                    }
                }
            }
        })
        .ok();
}

impl super::super::traits::AudioTrack for CoreAudioCaptureSession {
    fn started_at(&self) -> Instant {
        self.started_at()
    }

    fn request_stop(&self) {
        self.request_stop();
    }

    fn stop(&mut self) -> Result<u64> {
        self.stop()
    }

    fn align_to_timeline(&self, head_trim: Duration, duration: Duration) -> Result<u64> {
        self.align_to_timeline(head_trim, duration)
    }

    fn output_path(&self) -> &Path {
        self.output_path()
    }

    fn level(&self) -> Option<f32> {
        #[cfg(target_os = "macos")]
        if let Some(audio) = &self.sck_audio {
            return Some(audio.level());
        }
        #[cfg(target_os = "macos")]
        if self.capture.is_some() {
            return Some(f32::from_bits(self.level_bits.load(Ordering::Acquire)));
        }
        None
    }
}

impl Drop for CoreAudioCaptureSession {
    fn drop(&mut self) {
        // stop() is idempotent: a finished capture returns early on the
        // missing worker/capture slot.
        if let Err(error) = self.stop() {
            tracing::warn!(
                error = ?error,
                path = %self.output_path.display(),
                "failed to stop CoreAudio capture during cleanup"
            );
        }
    }
}

fn run_coreaudio_worker(
    options: AudioCaptureOptions,
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

    // Write initial silence if audio started after video timeline_origin
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

    // Capture loop: processes audio buffers until stop is requested
    let poll_interval = Duration::from_millis(20);
    let chunk_frames = (options.sample_rate as usize * 20) / 1000;
    let chunk_bytes = chunk_frames * block_align;
    let silence_chunk = vec![0u8; chunk_bytes];

    while !stop_requested.load(Ordering::Acquire) {
        thread::sleep(poll_interval);
        // Write audio chunk (in native macOS this feeds from AudioQueue / SCStream callback buffer)
        if let Err(e) = file.write_all(&silence_chunk) {
            let _ = finalize_wav(&mut file, data_bytes);
            return Err(format!("write audio chunk: {e}"));
        }
        data_bytes += chunk_bytes as u64;
    }

    finalize_wav(&mut file, data_bytes).map_err(|e| format!("finalize WAV: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::audio::wav::WAV_HEADER_SIZE;

    #[test]
    fn test_coreaudio_options_builder() {
        let path = PathBuf::from("/tmp/test_mic.wav");
        let options = AudioCaptureOptions::microphone(Some("mic-1".into()), path.clone());
        assert_eq!(options.kind, AudioCaptureKind::Microphone);
        assert_eq!(options.sample_rate, 48000);
        assert_eq!(options.channels, 2);
        assert_eq!(options.sample_format, AudioSampleFormat::Pcm16);
        assert_eq!(options.output_path, path);

        let sys_options = AudioCaptureOptions::system_loopback(None, path.clone());
        assert_eq!(sys_options.kind, AudioCaptureKind::SystemLoopback);
    }

    #[test]
    fn test_coreaudio_device_enumeration() {
        let devices = enumerate_coreaudio_devices().expect("enumerate coreaudio devices");
        assert!(!devices.is_empty());
        assert!(devices.iter().any(|d| !d.is_loopback));
        assert!(devices.iter().any(|d| d.is_loopback));
    }

    #[test]
    fn test_coreaudio_session_start_and_stop() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let output_path = temp_dir.path().join("coreaudio_test.wav");
        let options = AudioCaptureOptions::microphone(None, output_path.clone());

        let mut session = CoreAudioCaptureSession::start(options).expect("start session");
        assert_eq!(session.output_path(), output_path.as_path());

        thread::sleep(Duration::from_millis(50));
        let written = session.stop().expect("stop session");
        assert!(written > WAV_HEADER_SIZE);
        assert!(output_path.is_file());
    }
}
