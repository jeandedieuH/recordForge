pub mod audio;
pub mod disk;
pub mod probe;
pub mod proxy;
pub mod thumbnails;
pub mod waveform;

use regex::Regex;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, instrument};

use crate::errors::{InternalError, Result};

/// Resolve a bundled or PATH-located executable and verify it runs.
///
/// Overload without a resource directory — used when no `AppHandle` is
/// available (e.g. unit tests). Prefer `resolve_executable_with_resource_dir`
/// from Tauri setup where the resource dir is known.
#[instrument]
pub fn resolve_executable(name: &str) -> Result<PathBuf> {
    resolve_executable_with_resource_dir(name, None)
}

/// Resolve a bundled or PATH-located executable and verify it runs.
///
/// Search order:
/// 1. Tauri resource dir (`externalBin` sidecars land here in production).
/// 2. Next to the current executable (`{name}.exe`).
/// 3. Inside a `{name}/` directory next to the executable (`{name}/{name}.exe`).
/// 4. Inside a sibling `bin/` directory (`../bin/{name}.exe`).
/// 5. The OS `PATH`.
#[instrument]
pub fn resolve_executable_with_resource_dir(
    name: &str,
    resource_dir: Option<&Path>,
) -> Result<PathBuf> {
    for candidate in bundled_candidates(name, resource_dir) {
        if candidate.exists() && can_run(&candidate) {
            info!(path = %candidate.display(), "resolved {name} from bundled candidate");
            return Ok(candidate);
        }
    }

    let in_path = PathBuf::from(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    });

    if can_run(&in_path) {
        info!("resolved {name} from PATH");
        return Ok(in_path);
    }

    Err(InternalError::Media(format!(
        "{name} not found in bundled path or PATH; make sure {name} is installed \
         (run `bun run setup:ffmpeg` to download the sidecar binaries)"
    ))
    .into())
}

/// Build the list of candidate paths in priority order.
fn bundled_candidates(name: &str, resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    // 1. Tauri resource/externalBin directory (production installs).
    if let Some(res_dir) = resource_dir {
        candidates.push(res_dir.join(&file));
    }

    // 2–4. Relative to the current executable (dev builds).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&file));
            candidates.push(dir.join(name).join(&file));

            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("bin").join(&file));
            }
        }
    }

    candidates
}

fn can_run(path: &Path) -> bool {
    Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Convert an FFmpeg `time=HH:MM:SS.ms` or `time=SS.ms` string to milliseconds.
pub fn parse_time_to_ms(s: &str) -> Option<u64> {
    if s.contains(':') {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 3 {
            return None;
        }
        let hours: f64 = parts[0].parse().ok()?;
        let minutes: f64 = parts[1].parse().ok()?;
        let seconds: f64 = parts[2].parse().ok()?;
        Some(((hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0) as u64)
    } else {
        let seconds: f64 = s.parse().ok()?;
        Some((seconds * 1000.0) as u64)
    }
}

/// Parse an FFmpeg frame/time status line and return the time in milliseconds.
pub fn parse_ffmpeg_time(line: &str) -> Option<u64> {
    let re = Regex::new(r"time=([\d:.]+)").ok()?;
    re.captures(line)
        .and_then(|c| c.get(1))
        .and_then(|m| parse_time_to_ms(m.as_str()))
}

/// Run an FFmpeg command, tail its stderr for progress, and support cancellation.
///
/// `on_progress` is called with a value in `[0.0, 1.0]` when a time tag can be
/// parsed and `duration_ms` is known. Returns the child exit status.
pub fn run_ffmpeg_with_progress(
    mut command: Command,
    duration_ms: Option<u64>,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64) + Send + 'static,
) -> Result<std::process::ExitStatus> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    info!(?command, "starting ffmpeg job");

    let mut child = command
        .spawn()
        .map_err(|e| InternalError::Media(format!("failed to start ffmpeg job: {e}")))?;

    let _stdin = child.stdin.take();
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| InternalError::Media("ffmpeg stderr unavailable".into()))?;

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(|r| r.ok()) {
            if let Some(t) = parse_ffmpeg_time(&line) {
                if let Some(d) = duration_ms {
                    if d > 0 {
                        on_progress((t as f64 / d as f64).clamp(0.0, 1.0));
                    }
                }
            }
        }
    });

    let start = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            error!("ffmpeg job cancelled");
            let _ = child.wait();
            return Err(InternalError::Media("job cancelled".into()).into());
        }

        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(1) {
                    std::thread::sleep(Duration::from_millis(100));
                } else {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            Err(e) => {
                let _ = child.kill();
                return Err(InternalError::Media(format!("wait for ffmpeg: {e}")).into());
            }
        }
    }
}

/// Run a command that writes binary data to stdout and read it fully.
pub fn run_command_output(mut command: Command, cancel: Arc<AtomicBool>) -> Result<Vec<u8>> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| InternalError::Media(format!("failed to start command: {e}")))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| InternalError::Media("stdout unavailable".into()))?;
    let mut output = Vec::new();

    let mut buf = [0u8; 8192];
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(InternalError::Media("job cancelled".into()).into());
        }

        match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => output.extend_from_slice(&buf[..n]),
            Err(e) => {
                let _ = child.kill();
                return Err(InternalError::Media(format!("read stdout: {e}")).into());
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| InternalError::Media(format!("wait: {e}")))?;
    if !status.success() {
        return Err(InternalError::Media("command exited with non-zero status".into()).into());
    }

    Ok(output)
}
