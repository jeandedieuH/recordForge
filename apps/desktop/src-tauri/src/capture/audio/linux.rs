//! Linux audio capture via the bundled FFmpeg sidecar.
//!
//! The worker spawns FFmpeg with the `pulse` input (which also reaches PipeWire
//! through `pipewire-pulse`) and falls back to `alsa` when no PulseAudio
//! protocol endpoint exists. FFmpeg emits raw PCM on stdout; the worker wraps
//! it in the canonical 48 kHz / stereo / s16 WAV the mux pipeline expects,
//! prepending wall-clock silence for the startup offset exactly like the
//! WASAPI worker does.
//!
//! Device enumeration prefers `pactl` (PulseAudio sources; monitor sources
//! become the system-audio "loopback" entries) and falls back to `arecord -l`
//! on pure-ALSA systems — ALSA has no monitor devices without the snd-aloop
//! module, so system-audio entries only exist on the Pulse path.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::coreaudio::AudioDeviceInfo;
use super::wav::{
    align_wav_to_duration, finalize_wav, frames_for_duration, write_wav_header, AudioSampleFormat,
    DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE, WAV_HEADER_SIZE,
};
use crate::capture::traits::AudioTrack;
use crate::errors::{InternalError, Result};

/// Read-ahead size for the PCM pipe. 64 KiB covers ~341 ms of 48 kHz stereo
/// s16 audio, large enough that a UI-side stall never stalls FFmpeg's encoder.
const PCM_READ_CHUNK_BYTES: usize = 64 * 1024;

/// How long `start` waits for the first PCM bytes before declaring the source
/// dead. Pulse server connection handshakes can take a moment on cold D-Bus
/// activation; anything past ~2 s is a dead device, not a slow one.
const STARTUP_DATA_TIMEOUT: Duration = Duration::from_millis(2500);

#[derive(Debug)]
pub struct LinuxAudioOptions {
    device_id: Option<String>,
    output_path: PathBuf,
    sample_rate: u32,
    channels: u16,
    kind: LinuxAudioKind,
    /// Wall-clock lead-in: silence written before the first captured frame so
    /// the audio track starts aligned to the video timeline origin.
    timeline_origin: Option<Instant>,
    /// FFmpeg binary used as the capture engine. `None` resolves to the first
    /// binary with a working input (see `resolve_capture_ffmpeg`).
    ffmpeg_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxAudioKind {
    Microphone,
    SystemMonitor,
}

impl LinuxAudioOptions {
    pub fn microphone(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            output_path,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            kind: LinuxAudioKind::Microphone,
            timeline_origin: None,
            ffmpeg_path: None,
        }
    }

    pub fn system_monitor(device_id: Option<String>, output_path: PathBuf) -> Self {
        Self {
            device_id,
            output_path,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            kind: LinuxAudioKind::SystemMonitor,
            timeline_origin: None,
            ffmpeg_path: None,
        }
    }

    pub fn with_timeline_origin(mut self, origin: Instant) -> Self {
        self.timeline_origin = Some(origin);
        self
    }

    pub fn with_ffmpeg_path(mut self, path: PathBuf) -> Self {
        self.ffmpeg_path = Some(path);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputBackend {
    Pulse,
    Alsa,
}

impl InputBackend {
    fn ffmpeg_format(self) -> &'static str {
        match self {
            Self::Pulse => "pulse",
            Self::Alsa => "alsa",
        }
    }
}

#[derive(Debug)]
struct RunningCapture {
    child: Child,
    /// Held behind a mutex so the immutable `request_stop(&self)` path can
    /// still deliver 'q' + EOF to FFmpeg's interactive command pipe.
    stdin: Mutex<Option<std::process::ChildStdin>>,
    reader: Option<JoinHandle<std::io::Result<u64>>>,
}

#[derive(Debug)]
pub struct LinuxAudioCaptureSession {
    options: LinuxAudioOptions,
    capture: Option<RunningCapture>,
    stop_requested: Arc<AtomicBool>,
    started_at: Instant,
    data_bytes: Arc<AtomicU64>,
    level_bits: Arc<AtomicU32>,
    /// Latest stderr lines from the FFmpeg child, surfaced in stop() errors so
    /// "device unavailable" reaches diagnostics instead of a bare exit code.
    stderr_tail: Arc<Mutex<String>>,
}

impl LinuxAudioCaptureSession {
    pub fn start(options: LinuxAudioOptions) -> Result<Self> {
        let (ffmpeg, backend, device_arg) = resolve_capture_input(&options)?;

        if options.kind == LinuxAudioKind::SystemMonitor && backend == InputBackend::Alsa {
            return Err(InternalError::Capture(
                "system audio capture requires PulseAudio or PipeWire (pure-ALSA systems have no monitor source; install pipewire-pulse)".into(),
            )
            .into());
        }

        let started_at = Instant::now();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let data_bytes = Arc::new(AtomicU64::new(0));
        let level_bits = Arc::new(AtomicU32::new(0));
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&options.output_path)
            .map_err(|e| {
                InternalError::Storage(format!(
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
        .map_err(|e| InternalError::Storage(format!("write WAV header: {e}")))?;

        // Align to the video timeline: wall-clock time between the session's
        // timeline origin and this worker's start becomes leading silence.
        if let Some(origin) = options.timeline_origin {
            let leading_frames = frames_for_duration(origin.elapsed(), options.sample_rate);
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
                .map_err(|e| InternalError::Storage(format!("write leading silence: {e}")))?;
                data_bytes.store(written, Ordering::Release);
            }
        }

        let args = build_capture_args(backend, &device_arg, options.sample_rate, options.channels);
        let mut command = Command::new(&ffmpeg);
        command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|e| InternalError::Capture(format!("spawn ffmpeg audio capture: {e}")))?;

        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| InternalError::Capture("ffmpeg audio stdout unavailable".into()))?;
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_drain(stderr, Arc::clone(&stderr_tail));
        }

        let reader = spawn_pcm_reader(
            stdout,
            file,
            options.channels,
            Arc::clone(&stop_requested),
            Arc::clone(&data_bytes),
            Arc::clone(&level_bits),
        )
        .map_err(|e| InternalError::Capture(format!("spawn audio pcm reader: {e}")))?;

        let mut session = Self {
            options,
            capture: Some(RunningCapture {
                child,
                stdin: Mutex::new(stdin),
                reader: Some(reader),
            }),
            stop_requested,
            started_at,
            data_bytes,
            level_bits,
            stderr_tail,
        };

        // A device that produced nothing within the startup window (or died)
        // is reported as a startup failure so the caller can continue without
        // audio rather than recording a silent track that claims success.
        if let Err(error) = session.await_first_data() {
            session.abort();
            return Err(error);
        }

        Ok(session)
    }

    /// Block until the PCM pipe produced at least one frame, the child exited,
    /// or the startup deadline passed.
    fn await_first_data(&mut self) -> Result<()> {
        let baseline = self.data_bytes.load(Ordering::Acquire);
        let deadline = Instant::now() + STARTUP_DATA_TIMEOUT;
        while Instant::now() < deadline {
            if self.data_bytes.load(Ordering::Acquire) > baseline {
                return Ok(());
            }
            if let Some(capture) = self.capture.as_mut() {
                if let Ok(Some(status)) = capture.child.try_wait() {
                    return Err(InternalError::Capture(format!(
                        "ffmpeg audio capture exited during startup ({status}): {}",
                        self.stderr_tail()
                    ))
                    .into());
                }
            }
            if self.stop_requested.load(Ordering::Acquire) {
                return Err(
                    InternalError::Capture("audio capture stopped during startup".into()).into(),
                );
            }
            thread::sleep(Duration::from_millis(15));
        }
        Err(InternalError::Capture(format!(
            "audio device produced no data within {:?} — check that the source is not suspended ({})",
            STARTUP_DATA_TIMEOUT,
            self.stderr_tail()
        ))
        .into())
    }

    fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect()
    }

    /// Tear down without writing the "success" path — used when startup fails.
    fn abort(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        if let Some(mut capture) = self.capture.take() {
            let _ = kill_ffmpeg_gracefully(&mut capture.child);
            if let Some(reader) = capture.reader.take() {
                let _ = reader.join();
            }
        }
        let _ = std::fs::remove_file(&self.options.output_path);
    }
}

impl AudioTrack for LinuxAudioCaptureSession {
    fn started_at(&self) -> Instant {
        self.started_at
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
        if let Some(capture) = &self.capture {
            signal_ffmpeg_quit(&capture.stdin);
        }
    }

    fn stop(&mut self) -> Result<u64> {
        self.stop_requested.store(true, Ordering::Release);
        let mut capture = self
            .capture
            .take()
            .ok_or_else(|| InternalError::Capture("audio capture already stopped".into()))?;

        // 'q' + EOF lets FFmpeg flush its encoder and drain the PCM tail; the
        // kill fallback covers a wedged device that never acks the quit.
        signal_ffmpeg_quit(&capture.stdin);
        graceful_quit(&mut capture.child, Duration::from_millis(800))?;

        let data_bytes = match capture.reader.take() {
            Some(reader) => reader
                .join()
                .map_err(|_| InternalError::Capture("audio reader thread panicked".into()))?
                .map_err(|e| InternalError::Storage(format!("audio reader failed: {e}")))?,
            None => 0,
        };

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.options.output_path)
            .map_err(|e| InternalError::Storage(format!("reopen audio output: {e}")))?;
        Ok(finalize_wav(&mut file, data_bytes)
            .map_err(|e| InternalError::Storage(format!("finalize WAV: {e}")))?)
    }

    fn level(&self) -> Option<f32> {
        Some(f32::from_bits(self.level_bits.load(Ordering::Acquire)))
    }

    fn align_to_timeline(&self, head_trim: Duration, duration: Duration) -> Result<u64> {
        align_wav_to_duration(
            &self.options.output_path,
            self.options.sample_rate,
            self.options.channels,
            AudioSampleFormat::Pcm16,
            head_trim,
            duration,
        )
        .map_err(|e| InternalError::Storage(format!("align audio track: {e}")).into())
    }

    fn output_path(&self) -> &Path {
        &self.options.output_path
    }
}

impl Drop for LinuxAudioCaptureSession {
    fn drop(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        if let Some(mut capture) = self.capture.take() {
            signal_ffmpeg_quit(&capture.stdin);
            let _ = graceful_quit(&mut capture.child, Duration::from_millis(500));
            if let Some(reader) = capture.reader.take() {
                let _ = reader.join();
            }
        }
    }
}

/// Send 'q' to FFmpeg's interactive stdin and then close it. 'q' requests a
/// graceful finish; the EOF that follows covers builds that ignore keystrokes.
fn signal_ffmpeg_quit(stdin: &Mutex<Option<std::process::ChildStdin>>) {
    if let Ok(mut guard) = stdin.lock() {
        if let Some(mut pipe) = guard.take() {
            let _ = pipe.write_all(b"q\n");
            let _ = pipe.flush();
        }
    }
}

/// Ask FFmpeg to quit, then escalate to kill so stop() never hangs on a wedged
/// device.
fn graceful_quit(child: &mut Child, grace: Duration) -> Result<()> {
    if let Ok(Some(_)) = child.try_wait() {
        return Ok(());
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(InternalError::Capture(format!("poll ffmpeg exit: {e}")).into()),
        }
    }
    kill_ffmpeg_gracefully(child)
}

fn kill_ffmpeg_gracefully(child: &mut Child) -> Result<()> {
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Ok(())
        }
    }
}

fn spawn_pcm_reader(
    mut stdout: std::process::ChildStdout,
    mut file: std::fs::File,
    channels: u16,
    _stop_requested: Arc<AtomicBool>,
    data_bytes: Arc<AtomicU64>,
    level_bits: Arc<AtomicU32>,
) -> std::io::Result<JoinHandle<std::io::Result<u64>>> {
    thread::Builder::new()
        .name("rf-audio-pcm".into())
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
            // The writer may have stopped mid-frame; drop the partial tail so
            // downstream code only ever sees whole PCM frames.
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

/// Track the rolling peak |sample| (0..1) for the level meter. s16 LE pairs.
fn update_level(chunk: &[u8], level_bits: &AtomicU32) {
    let mut peak = f32::from_bits(level_bits.load(Ordering::Relaxed));
    // Cheap decay so the meter relaxes on quiet input without a second timer.
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

fn spawn_stderr_drain(mut stderr: std::process::ChildStderr, sink: Arc<Mutex<String>>) {
    thread::Builder::new()
        .name("rf-audio-stderr".into())
        .spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut guard) = sink.lock() {
                            guard.push_str(&String::from_utf8_lossy(&buf[..n]));
                            // Keep the tail bounded — FFmpeg can be chatty.
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

/// Pick the FFmpeg binary and input backend for this capture.
///
/// Returns `(ffmpeg_path, backend, device_arg)` where `device_arg` is the
/// `-i` argument for the chosen indev.
fn resolve_capture_input(options: &LinuxAudioOptions) -> Result<(PathBuf, InputBackend, String)> {
    let explicit_device = options.device_id.as_deref().and_then(|d| {
        d.strip_prefix("pulse:")
            .map(|s| (InputBackend::Pulse, s.to_string()))
            .or_else(|| {
                d.strip_prefix("alsa:")
                    .map(|s| (InputBackend::Alsa, s.to_string()))
            })
    });

    let candidates: Vec<PathBuf> = match &options.ffmpeg_path {
        Some(path) => {
            let mut v = vec![path.clone()];
            // A pinned sidecar built without Linux indevs must not strand the
            // feature — fall through to the system ffmpeg when present.
            for extra in ["ffmpeg", "/usr/bin/ffmpeg"] {
                let extra = PathBuf::from(extra);
                if !v.contains(&extra) {
                    v.push(extra);
                }
            }
            v
        }
        None => vec!["ffmpeg".into(), "/usr/bin/ffmpeg".into()],
    };

    for ffmpeg in candidates {
        if explicit_device.is_some() {
            // Caller pinned a fully-qualified device id; don't second-guess.
            let (backend, dev) = explicit_device.clone().unwrap();
            return Ok((ffmpeg, backend, dev));
        }
        if ffmpeg_has_indev(&ffmpeg, "pulse") && pulse_runtime_available() {
            let dev = default_pulse_source(options.kind).unwrap_or_else(|| "default".to_string());
            return Ok((ffmpeg, InputBackend::Pulse, dev));
        }
        if ffmpeg_has_indev(&ffmpeg, "alsa") {
            let dev = match options.kind {
                // 'default' resolves through asound's policy; honest failure if
                // no card exists beats a silently-fake name.
                LinuxAudioKind::Microphone => "default".to_string(),
                // Rejected upstream in start(); unreachable here.
                LinuxAudioKind::SystemMonitor => "default".to_string(),
            };
            return Ok((ffmpeg, InputBackend::Alsa, dev));
        }
    }

    Err(InternalError::Capture(
        "no FFmpeg binary with pulse/alsa capture support found (the bundled sidecar lacks Linux audio inputs and no system ffmpeg is installed)".into(),
    )
    .into())
}

/// `ffmpeg -hide_banner -devices` advertises compiled indevs. This is how we
/// discover a sidecar missing `pulse`/`alsa` without spawning a doomed capture.
fn ffmpeg_has_indev(ffmpeg: &Path, name: &str) -> bool {
    let output = match Command::new(ffmpeg)
        .args(["-hide_banner", "-devices"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().any(|line| {
        // Format: " D   alsa   ALSA audio output" — indevs flagged with 'D'.
        let l = line.trim_start();
        l.starts_with("D") && l.split_whitespace().nth(1) == Some(name)
    })
}

/// Whether a PulseAudio-protocol endpoint is reachable — PipeWire ships one
/// via pipewire-pulse on practically every desktop Wayland/X11 install.
fn pulse_runtime_available() -> bool {
    if std::env::var_os("PULSE_SERVER").is_some() {
        return true;
    }
    if Command::new("pactl")
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return true;
    }
    std::env::var("XDG_RUNTIME_DIR")
        .map(|d| Path::new(&d).join("pulse/native").exists())
        .unwrap_or(false)
}

/// Resolve the Pulse source name for a track kind when no explicit device id
/// was chosen: mics get the default source, loopback gets the default sink's
/// `.monitor` peer.
fn default_pulse_source(kind: LinuxAudioKind) -> Option<String> {
    match kind {
        LinuxAudioKind::Microphone => pactl_default("get-default-source"),
        LinuxAudioKind::SystemMonitor => {
            pactl_default("get-default-sink").map(|sink| format!("{sink}.monitor"))
        }
    }
}

fn pactl_default(arg: &str) -> Option<String> {
    let output = Command::new("pactl").arg(arg).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn build_capture_args(
    backend: InputBackend,
    device: &str,
    sample_rate: u32,
    channels: u16,
) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-nostats".into(),
        "-loglevel".into(),
        "error".into(),
        "-f".into(),
        backend.ffmpeg_format().into(),
        "-i".into(),
        device.to_string(),
        "-ac".into(),
        channels.to_string(),
        "-ar".into(),
        sample_rate.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-f".into(),
        "s16le".into(),
        "pipe:1".into(),
    ]
}

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------

/// Enumerate real audio endpoints. PulseAudio/PipeWire sources (via `pactl`)
/// yield both mics and monitor "system audio" devices; a pure-ALSA box falls
/// back to `arecord -l` and reports only input hardware — honest, not the fake
/// "Default Microphone" this used to fabricate.
pub fn enumerate_linux_audio_devices() -> Result<Vec<AudioDeviceInfo>> {
    if let Some(devices) = enumerate_pulse_devices() {
        if !devices.is_empty() {
            return Ok(devices);
        }
    }
    Ok(enumerate_alsa_devices().unwrap_or_default())
}

fn enumerate_pulse_devices() -> Option<Vec<AudioDeviceInfo>> {
    let output = Command::new("pactl")
        .args(["list", "sources"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let sources = parse_pactl_sources(&text);

    let default_source = pactl_default("get-default-source");
    let default_monitor = pactl_default("get-default-sink").map(|s| format!("{s}.monitor"));

    let mut devices = Vec::new();
    for source in sources {
        devices.push(AudioDeviceInfo {
            id: format!("pulse:{}", source.name),
            name: if source.description.is_empty() {
                source.name.clone()
            } else {
                source.description
            },
            is_loopback: source.is_monitor,
            is_default: if source.is_monitor {
                Some(&source.name) == default_monitor.as_ref()
            } else {
                Some(&source.name) == default_source.as_ref()
            },
        });
    }
    Some(devices)
}

#[derive(Debug, PartialEq)]
struct PactlSource {
    name: String,
    description: String,
    is_monitor: bool,
}

/// Parse `pactl list sources` output. The format is key-indented blocks; only
/// Name/Description/Monitor-of-Sink matter to us.
fn parse_pactl_sources(text: &str) -> Vec<PactlSource> {
    let mut sources = Vec::new();
    let mut current: Option<PactlSource> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Source #") {
            if let Some(source) = current.take() {
                if !source.name.is_empty() {
                    sources.push(source);
                }
            }
            current = Some(PactlSource {
                name: String::new(),
                description: String::new(),
                is_monitor: false,
            });
            continue;
        }
        let Some(source) = current.as_mut() else {
            continue;
        };
        if let Some(value) = trimmed.strip_prefix("Name:") {
            source.name = value.trim().to_string();
        } else if let Some(value) = trimmed.strip_prefix("Description:") {
            source.description = value.trim().to_string();
        } else if trimmed.starts_with("Monitor of Sink:") {
            source.is_monitor = true;
        }
    }
    if let Some(source) = current.take() {
        if !source.name.is_empty() {
            sources.push(source);
        }
    }
    sources
}

fn enumerate_alsa_devices() -> Option<Vec<AudioDeviceInfo>> {
    let output = Command::new("arecord").args(["-l"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let devices = parse_arecord_devices(&text);
    Some(
        devices
            .into_iter()
            .map(|(id, name)| AudioDeviceInfo {
                id: format!("alsa:{id}"),
                name,
                is_loopback: false,
                is_default: false,
            })
            .collect(),
    )
}

/// Parse `arecord -l` into (hw:id, description) pairs.
///
/// ```text
/// card 0: PCH [HDA Intel PCH], device 0: ALC897 Analog [ALC897 Analog]
/// ```
fn parse_arecord_devices(text: &str) -> Vec<(String, String)> {
    let mut devices = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("card ") {
            continue;
        }
        let (card, device) = (
            trimmed[5..].split(':').next(),
            trimmed.rsplit("device ").next(),
        );
        let (Some(card), Some(dev_tail)) = (card, device) else {
            continue;
        };
        let card_num: String = card
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let dev_num: String = dev_tail
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if card_num.is_empty() || dev_num.is_empty() {
            continue;
        }
        let name = trimmed
            .split('[')
            .nth(1)
            .and_then(|s| s.split(']').next())
            .unwrap_or(trimmed)
            .to_string();
        devices.push((format!("hw:{card_num},{dev_num}"), name));
    }
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACTL_FIXTURE: &str = "\
Source #0
        State: SUSPENDED
        Name: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
        Description: Monitor of Built-in Audio Analog Stereo
        Monitor of Sink: alsa_output.pci-0000_00_1f.3.analog-stereo
Source #1
        State: RUNNING
        Name: alsa_input.usb-Blue_Yeti.analog-stereo
        Description: Yeti Stereo Microphone Analog Stereo
        Driver: module-alsa-card.c
";

    #[test]
    fn parses_pactl_sources() {
        let sources = parse_pactl_sources(PACTL_FIXTURE);
        assert_eq!(sources.len(), 2);
        assert!(sources[0].is_monitor);
        assert_eq!(
            sources[0].name,
            "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor"
        );
        assert!(!sources[1].is_monitor);
        assert_eq!(
            sources[1].description,
            "Yeti Stereo Microphone Analog Stereo"
        );
    }

    #[test]
    fn parses_arecord_devices() {
        let text = "\
**** List of CAPTURE Hardware Devices ****
card 0: PCH [HDA Intel PCH], device 0: ALC897 Analog [ALC897 Analog]
  Subdevices: 1/1
card 2: Yeti [Blue Yeti], device 0: USB Audio [USB Audio]
";
        let devices = parse_arecord_devices(text);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].0, "hw:0,0");
        assert_eq!(devices[0].1, "HDA Intel PCH");
        assert_eq!(devices[1].0, "hw:2,0");
        assert_eq!(devices[1].1, "Blue Yeti");
    }

    #[test]
    fn capture_args_are_pulse_first() {
        let args = build_capture_args(InputBackend::Pulse, "alsa_input.test", 48000, 2);
        let joined = args.join(" ");
        assert!(joined.contains("-f pulse -i alsa_input.test"));
        assert!(joined.contains("-ar 48000"));
        assert!(joined.contains("-f s16le pipe:1"));
    }
}
