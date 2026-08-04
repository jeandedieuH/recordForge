use regex::Regex;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tracing::{info, instrument};

use super::config::{RecordingConfig, RecordingProfile};
use super::disk;
use super::manifest::{RecordingFragment, RecordingManifest, RecordingStats};
use super::source::CaptureSource;

/// Manages a running FFmpeg capture process.
pub struct FfmpegCapture {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    manifest: Option<Arc<Mutex<RecordingManifest>>>,
    output_path: PathBuf,
    fragment_index: u32,
    start_time: Instant,
}

impl std::fmt::Debug for FfmpegCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FfmpegCapture")
            .field(
                "session_id",
                &self
                    .manifest
                    .as_ref()
                    .and_then(|m| m.lock().map(|m| m.session_id.clone()).ok()),
            )
            .field("fragment_index", &self.fragment_index)
            .field("output_path", &self.output_path)
            .finish_non_exhaustive()
    }
}

impl FfmpegCapture {
    /// Build and start the FFmpeg capture command for the given configuration.
    ///
    /// `ddagrab_available` reports whether the FFmpeg build supports the
    /// `ddagrab` (Desktop Duplication API) filter. When false, display capture
    /// falls back to `gdigrab` so recording still works on builds without D3D11
    /// capture support.
    #[instrument(skip(config, profile, manifest))]
    pub fn start(
        ffmpeg_path: &str,
        config: &RecordingConfig,
        profile: &RecordingProfile,
        output: &str,
        fragment_index: u32,
        manifest: Option<Arc<Mutex<RecordingManifest>>>,
        ddagrab_available: bool,
    ) -> crate::errors::Result<Self> {
        let command = build_screen_command(ffmpeg_path, config, profile, output, ddagrab_available);
        run(command, output, fragment_index, manifest)
    }

    /// Check if the FFmpeg child process is still actively running.
    pub fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// Build and start a sidecar FFmpeg capture for a webcam device.
    #[instrument(skip(device, profile, manifest))]
    pub fn start_webcam(
        ffmpeg_path: &str,
        device: &str,
        profile: &RecordingProfile,
        output: &str,
        manifest: Option<Arc<Mutex<RecordingManifest>>>,
    ) -> crate::errors::Result<Self> {
        let command = build_webcam_command(ffmpeg_path, device, profile, output);
        run(command, output, 0, manifest)
    }

    /// Elapsed milliseconds since this capture was started.
    pub fn elapsed_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64
    }

    /// Send a graceful stop signal ("q\n") to FFmpeg and wait for it to exit.
    #[instrument]
    pub fn stop(&mut self) -> crate::errors::Result<RecordingStats> {
        // Send 'q' followed by a newline to request a clean shutdown.
        if let Some(stdin) = self.stdin.as_mut() {
            if let Err(e) = stdin.write_all(b"q\n") {
                // A broken/closed pipe (Windows os error 232) here means FFmpeg
                // already exited on its own — typically a capture failure. That
                // is expected in that case, so we don't log it as an error; the
                // wait loop below collects the real exit status and the stderr
                // reader thread will have logged the underlying cause. Other
                // write failures are unusual enough to warn about.
                let already_exited =
                    matches!(e.kind(), ErrorKind::BrokenPipe) || e.raw_os_error() == Some(232);
                if already_exited {
                    tracing::debug!("ffmpeg quit signal not delivered: process already exited");
                } else {
                    tracing::warn!(%e, "failed to send quit to ffmpeg");
                }
            } else {
                let _ = stdin.flush();
            }
        }

        // Close stdin so FFmpeg sees EOF if it did not react to 'q'.
        self.stdin = None;

        // Wait up to 10 seconds for a clean shutdown.
        let start = std::time::Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().map_err(|e| {
                crate::errors::InternalError::Capture(format!("wait for ffmpeg: {e}"))
            })? {
                break status;
            }
            if start.elapsed().as_secs() > 10 {
                let _ = self.child.kill();
                break self.child.wait().map_err(|e| {
                    crate::errors::InternalError::Capture(format!("kill ffmpeg: {e}"))
                })?;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };

        let mut stats = extract_final_stats(&self.manifest, status.code())?;

        let duration_ms = self.start_time.elapsed().as_millis() as u64;
        stats.duration_ms = duration_ms;

        let output_size = std::fs::metadata(&self.output_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        stats.output_size_bytes = output_size;
        if output_size > 0 {
            disk::sync_file(&self.output_path)?;
        }

        if let Some(manifest) = self.manifest.as_ref() {
            let now = chrono::Utc::now().to_rfc3339();
            let mut m = manifest.lock().map_err(|_| {
                crate::errors::InternalError::Capture("manifest mutex poisoned".into())
            })?;

            if let Some(frag) = m
                .fragments
                .iter_mut()
                .find(|f| f.index == self.fragment_index)
            {
                frag.stopped_at = Some(now);
                frag.duration_ms = Some(duration_ms);
                frag.size_bytes = Some(output_size);
                frag.validated = status.success() && output_size > 1024;
                m.touch();
            }

            m.set_stats(stats.clone());
            m.write()?;
        }

        if !status.success() {
            return Err(crate::errors::InternalError::Capture(format!(
                "ffmpeg exited with status {}",
                status
            ))
            .into());
        }
        if output_size <= 1024 {
            return Err(crate::errors::InternalError::Capture(
                "ffmpeg produced an empty capture file".into(),
            )
            .into());
        }

        Ok(stats)
    }
}

impl Drop for FfmpegCapture {
    fn drop(&mut self) {
        // Best-effort cleanup so a capture dropped without an explicit stop()
        // (app crash, abandoned session) does not leave FFmpeg running as an
        // orphan holding the display/audio devices. If stop() already ran, the
        // child has exited and this is a fast no-op (try_wait returns the
        // cached exited status immediately).
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        // Close stdin to signal EOF.
        self.stdin = None;

        // Give FFmpeg a short window to flush and exit gracefully, then
        // force-kill if it is still running.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn build_screen_command(
    ffmpeg_path: &str,
    config: &RecordingConfig,
    profile: &RecordingProfile,
    output: &str,
    ddagrab_available: bool,
) -> Command {
    let mut command = Command::new(ffmpeg_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .arg("-y");

    // Use ddagrab for display capture only when the filter is present in this
    // FFmpeg build; otherwise fall back to gdigrab (see add_screen_video_input).
    let use_ddagrab = config.source.kind == "display" && ddagrab_available;

    add_screen_video_input(&mut command, &config.source, profile, use_ddagrab);
    let audio_indices = add_audio_inputs(&mut command, config);

    let video_filter = build_video_filter(&config.source, profile, use_ddagrab);
    let audio_filter = build_audio_filter(&audio_indices);

    let mut filter_complex = video_filter;
    if !audio_filter.is_empty() {
        filter_complex.push_str(&format!(";{audio_filter}"));
    }

    command.args(["-filter_complex", &filter_complex]);
    command.args(["-map", "[vout]"]);
    if !audio_indices.is_empty() {
        command.args(["-map", "[aout]"]);
    }

    add_video_encoder(&mut command, profile);
    if !audio_indices.is_empty() {
        add_audio_encoder(&mut command, profile);
    }

    command.args([
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof+faststart",
        output,
    ]);

    info!(?command, "built screen ffmpeg command");
    command
}

fn build_webcam_command(
    ffmpeg_path: &str,
    device: &str,
    profile: &RecordingProfile,
    output: &str,
) -> Command {
    let mut command = Command::new(ffmpeg_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .arg("-y");

    command.args([
        "-f",
        "dshow",
        "-thread_queue_size",
        "512",
        "-i",
        &format!("video=\"{}\"", device),
    ]);

    let filter = format!("[0:v]scale={}:{}[vout]", profile.width, profile.height);
    command
        .args(["-filter_complex", &filter])
        .args(["-map", "[vout]"]);

    add_video_encoder(&mut command, profile);
    command.args([
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof+faststart",
        output,
    ]);

    info!(?command, "built webcam ffmpeg command");
    command
}

fn add_screen_video_input(
    command: &mut Command,
    source: &CaptureSource,
    profile: &RecordingProfile,
    use_ddagrab: bool,
) {
    let bounds = source.bounds;

    if source.kind == "display" && use_ddagrab {
        // Desktop Duplication API via the lavfi ddagrab filter. Produces
        // hardware (D3D11) frames, so the filter chain must hwdownload them.
        let ddagrab = format!(
            "ddagrab=framerate={}:video_size={}x{}:offset_x={}:offset_y={}",
            profile.fps, bounds.width, bounds.height, bounds.x, bounds.y
        );
        command.args(["-f", "lavfi", "-thread_queue_size", "512", "-i", &ddagrab]);
    } else if source.kind == "display" || source.kind == "window" || source.kind == "region" {
        // GDI captures the selected rectangle directly, including displays with
        // negative virtual-desktop coordinates.
        command.args([
            "-f",
            "gdigrab",
            "-thread_queue_size",
            "512",
            "-framerate",
            &profile.fps.to_string(),
            "-video_size",
            &format!("{}x{}", bounds.width, bounds.height),
            "-offset_x",
            &bounds.x.to_string(),
            "-offset_y",
            &bounds.y.to_string(),
            "-i",
            "desktop",
        ]);
    } else {
        // Unknown source kinds still get a minimal input so FFmpeg does not
        // fail later in the filter graph with an obscure error.
        let fallback = format!(
            "testsrc=size={}x{}:rate={}",
            profile.width, profile.height, profile.fps
        );
        command.args(["-f", "lavfi", "-i", &fallback]);
    }
}

fn build_video_filter(
    source: &CaptureSource,
    profile: &RecordingProfile,
    use_ddagrab: bool,
) -> String {
    let fit_filter = source
        .bounds
        .build_aspect_fit_filter(profile.width, profile.height);

    if source.kind == "display" && use_ddagrab {
        // ddagrab emits D3D11 hardware frames; download to system memory as
        // bgra before aspect-preserving scale and letterboxing (fixes P0.5).
        format!("[0:v]hwdownload,format=bgra,{fit_filter}[vout]")
    } else {
        format!("[0:v]{fit_filter}[vout]")
    }
}

fn add_audio_inputs(command: &mut Command, config: &RecordingConfig) -> Vec<usize> {
    let mut indices = Vec::new();

    if config.capture_microphone {
        if let Some(device) = &config.microphone_device_id {
            command.args([
                "-f",
                "dshow",
                "-thread_queue_size",
                "512",
                "-i",
                &format!("audio=\"{}\"", device),
            ]);
            indices.push(1 + indices.len());
        } else {
            info!("capture_microphone enabled but no device specified; skipping microphone");
        }
    }

    if config.capture_system_audio {
        if let Some(device) = &config.system_audio_device_id {
            command.args([
                "-f",
                "dshow",
                "-thread_queue_size",
                "512",
                "-i",
                &format!("audio=\"{}\"", device),
            ]);
            indices.push(1 + indices.len());
        } else {
            info!("capture_system_audio enabled but no device specified; skipping system audio");
        }
    }

    indices
}

fn build_audio_filter(audio_indices: &[usize]) -> String {
    if audio_indices.is_empty() {
        return String::new();
    }

    if audio_indices.len() == 1 {
        return format!("[{}:a]anull[aout]", audio_indices[0]);
    }

    let resampled: Vec<String> = audio_indices
        .iter()
        .enumerate()
        .map(|(i, &idx)| format!("[{idx}:a]aresample=async=1[a{i}]"))
        .collect();

    let mix_inputs: String = (0..audio_indices.len())
        .map(|i| format!("[a{i}]"))
        .collect();

    format!(
        "{};{}amix=inputs={}:duration=longest:dropout_transition=3[aout]",
        resampled.join(";"),
        mix_inputs,
        audio_indices.len()
    )
}

fn add_video_encoder(command: &mut Command, profile: &RecordingProfile) {
    // For the spike we always use the first available/prioritized encoder.
    let encoder = profile
        .encoder_priority
        .first()
        .map(String::as_str)
        .unwrap_or("libx264");
    command.arg("-c:v").arg(encoder);

    command.args(["-pix_fmt", "yuv420p", "-r", &profile.fps.to_string()]);

    if let Some(crf) = profile.crf {
        if encoder == "libx264" || encoder == "libx265" {
            command.args(["-preset", "ultrafast", "-crf", &crf.to_string()]);
        } else if encoder.starts_with("h264_") || encoder.starts_with("hevc_") {
            // Hardware encoders generally do not support crf; use bitrate fallback.
            command.args([
                "-b:v",
                &format!("{}k", profile.video_bitrate_kbps.unwrap_or(5000)),
            ]);
        }
    } else if let Some(kbps) = profile.video_bitrate_kbps {
        command.args(["-b:v", &format!("{}k", kbps)]);
    }
}

fn add_audio_encoder(command: &mut Command, profile: &RecordingProfile) {
    command.arg("-c:a").arg(&profile.audio_codec);
    command.args(["-b:a", &format!("{}k", profile.audio_bitrate_kbps)]);
}

fn run(
    mut command: Command,
    output: &str,
    fragment_index: u32,
    manifest: Option<Arc<Mutex<RecordingManifest>>>,
) -> crate::errors::Result<FfmpegCapture> {
    info!(?command, "starting ffmpeg capture");

    let mut child = command.spawn().map_err(|e| {
        crate::errors::InternalError::Capture(format!("failed to start ffmpeg: {e}"))
    })?;

    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                crate::errors::InternalError::Capture("ffmpeg stdin unavailable".into()).into(),
            );
        }
    };

    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                crate::errors::InternalError::Capture("ffmpeg stderr unavailable".into()).into(),
            );
        }
    };

    // Spawn a reader thread to tail the FFmpeg log and extract live stats.
    // It also surfaces FFmpeg's stderr so capture failures (missing filters,
    // bad device names, encoder errors) are visible instead of silently
    // swallowed — progress lines stay at debug; error-looking lines go to warn
    // so they show up at the default log level alongside the quit/exit logs.
    //
    // Lines are also captured into `stderr_buffer` (capped) so that an early
    // FFmpeg exit can embed the real cause directly in the error returned to
    // the UI, rather than only in the terminal log.
    let stderr_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_buffer_reader = Arc::clone(&stderr_buffer);
    let manifest_reader = manifest.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let re_frame =
            Regex::new(r"frame=\s*(\d+)\s+fps=\s*([\d.]+)\s+q=\s*[\d.-]+\s+(?:size=\s*([\d.]+)\w+\s+)?time=([\d:.]+)")
                .ok();
        for line in reader.lines().map_while(Result::ok) {
            let is_progress = re_frame
                .as_ref()
                .and_then(|re| re.captures(&line))
                .is_some();
            if !is_progress && looks_like_ffmpeg_error(&line) {
                tracing::warn!(target: "recordforge::ffmpeg", line = %line, "ffmpeg stderr");
            } else {
                tracing::debug!(target: "recordforge::ffmpeg", line = %line, "ffmpeg stderr");
            }
            let _ = parse_stats_line(&line, re_frame.as_ref(), &manifest_reader);
            // Keep the last ~48 lines so a startup failure's cause survives
            // even after FFmpeg prints its banner/config preamble.
            if let Ok(mut buf) = stderr_buffer_reader.lock() {
                if buf.len() >= 48 {
                    buf.remove(0);
                }
                buf.push(line);
            }
        }
    });

    // Give FFmpeg a short window to fail fast. Missing filters, bad device
    // names, and unavailable encoders make FFmpeg exit within tens of
    // milliseconds; surfacing that here turns a silent start failure into a
    // clear error instead of a confusing "pipe is being closed" later on stop.
    let probe_start = std::time::Instant::now();
    let early_status: Option<std::process::ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => {
                return Err(crate::errors::InternalError::Capture(format!(
                    "wait for ffmpeg startup: {e}"
                ))
                .into());
            }
        }
        if probe_start.elapsed() >= std::time::Duration::from_millis(400) {
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };

    if let Some(status) = early_status {
        // Let the stderr reader drain FFmpeg's error output so the cause is
        // captured before we build the error message.
        std::thread::sleep(std::time::Duration::from_millis(120));
        let captured = stderr_buffer
            .lock()
            .map(|buf| buf.join("\n"))
            .unwrap_or_default();
        return Err(crate::errors::InternalError::Capture(format!(
            "ffmpeg exited immediately during startup (status: {status}).\n\
             FFmpeg output:\n{captured}"
        ))
        .into());
    }

    // Record the fragment now so recovery can find it.
    if let Some(m) = manifest.as_ref() {
        let now = chrono::Utc::now().to_rfc3339();
        let file_name = Path::new(output)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "output.mp4".into());

        let mut m = m
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?;

        m.add_fragment(RecordingFragment {
            index: fragment_index,
            file_name,
            started_at: now,
            stopped_at: None,
            duration_ms: None,
            size_bytes: None,
            validated: false,
        });
        m.write()?;
    }

    Ok(FfmpegCapture {
        child,
        stdin: Some(stdin),
        manifest,
        output_path: PathBuf::from(output),
        fragment_index,
        start_time: Instant::now(),
    })
}

/// Heuristic: does this FFmpeg stderr line look like an error or warning?
///
/// FFmpeg prints its banner, configuration, and progress lines to stderr too;
/// we only want to elevate genuine problems to `warn` so they're visible at the
/// default log level without drowning the log in routine output. The matched
/// substrings cover the common FFmpeg failure phrasings ("No such filter",
/// "Could not open", "Unknown encoder", "Invalid ...", etc.).
fn looks_like_ffmpeg_error(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    l.contains("error")
        || l.contains("no such")
        || l.contains("not found")
        || l.contains("cannot")
        || l.contains("could not")
        || l.contains("failed")
        || l.contains("unknown")
        || l.contains("unrecognized")
        || l.contains("invalid")
        || l.contains("abort")
}

fn parse_stats_line(
    line: &str,
    re: Option<&Regex>,
    manifest: &Option<Arc<Mutex<RecordingManifest>>>,
) -> crate::errors::Result<()> {
    if let Some(re) = re {
        if let Some(caps) = re.captures(line) {
            let frame = caps.get(1).and_then(|m| m.as_str().parse().ok());
            let fps = caps.get(2).and_then(|m| m.as_str().parse().ok());

            if let Some(manifest) = manifest.as_ref() {
                let mut m = manifest.lock().map_err(|_| {
                    crate::errors::InternalError::Capture("manifest mutex poisoned".into())
                })?;

                let stats = m.stats.get_or_insert(RecordingStats::default());
                stats.frames_processed = frame;
                stats.fps = fps;
                stats.speed = parse_speed(line);
                m.touch();
            }
        }
    }
    Ok(())
}

fn parse_speed(line: &str) -> Option<f64> {
    if let Some(start) = line.find("speed=") {
        let rest = &line[start + 6..];
        let token: String = rest
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != 'x')
            .collect();
        token.parse().ok()
    } else {
        None
    }
}

fn extract_final_stats(
    manifest: &Option<Arc<Mutex<RecordingManifest>>>,
    exit_code: Option<i32>,
) -> crate::errors::Result<RecordingStats> {
    if let Some(manifest) = manifest.as_ref() {
        let mut m = manifest
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("manifest mutex poisoned".into()))?;

        let mut stats = m.stats.take().unwrap_or_default();
        stats.exit_code = exit_code;
        m.set_stats(stats.clone());
        Ok(stats)
    } else {
        Ok(RecordingStats {
            exit_code,
            ..RecordingStats::default()
        })
    }
}
