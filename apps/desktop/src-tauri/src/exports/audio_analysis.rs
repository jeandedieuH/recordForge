//! Smart Cut silence analysis over the CURRENT edited timeline. The filter
//! graph is produced by the same `append_audio_graph` used for exports, so
//! trims, moves, speed changes, mutes, and imported audio are all honored and
//! the returned ranges are output-timeline coordinates a ripple-delete can cut
//! verbatim — no source→output remapping on the caller.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::errors::{AppError, ErrorCategory, InternalError, Result};
use crate::state::CaptureWorkGate;

use super::{append_audio_graph, collect_input_assets, ProbeCache, RenderPlan, TempMaskFile};

/// Silence interval detected by Smart Cut.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SilenceRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Error returned when `cancel_smart_cut` wins the race.
pub fn smart_cut_cancelled() -> AppError {
    AppError::new(
        ErrorCategory::Media,
        "smart_cut_cancelled",
        "Smart Cut scan cancelled",
    )
}

/// In-flight Smart Cut scans, keyed by recording id — one scan per recording.
/// Each scan also carries a caller-supplied `scan_id` so cancellation and
/// registration cleanup only ever touch the matching run: an old run's Drop
/// or cancel must not kill a newer scan that took its slot.
///
/// `cancelled` is a bounded tombstone map keyed (recording, scan id): a
/// cancel that lands BEFORE the blocking task calls `begin` (the command
/// admits the registration up front, but a caller may cancel while the
/// spawn is still queued) must still be honored when that id ever arrives.
#[derive(Debug, Default)]
pub struct SmartCutRegistry {
    jobs: Mutex<HashMap<String, Arc<SmartCutJob>>>,
    cancelled: Mutex<HashMap<(String, String), Instant>>,
}

/// Tombstones expire so a very late `begin` reusing an id (tests, retries
/// after a session) isn't cancelled by a cancel meant for an older run, and
/// the map stays bounded regardless of caller churn.
const SMART_CUT_TOMBSTONE_TTL: Duration = Duration::from_secs(300);
const SMART_CUT_TOMBSTONE_MAX: usize = 128;

/// Drop tombstones older than the TTL — called under the registry's
/// `cancelled` lock before every consume/insert.
fn prune_tombstones(cancelled: &mut HashMap<(String, String), Instant>) {
    let now = Instant::now();
    cancelled.retain(|_, at| now.duration_since(*at) < SMART_CUT_TOMBSTONE_TTL);
}

/// Recover the mutex payload even when a previous holder panicked — the
/// child slot is still valid state and must not be abandoned (a poisoned
/// lock would otherwise leak the ffmpeg process it holds).
fn child_slot(job: &SmartCutJob) -> MutexGuard<'_, Option<std::process::Child>> {
    job.child.lock().unwrap_or_else(|err| err.into_inner())
}

/// One running scan: its scan id, a cancel flag, and (once spawned) the
/// ffmpeg child handle used for `kill()`. Drop reaps the child so a leaked
/// ffmpeg process is impossible on every exit path.
#[derive(Debug)]
pub struct SmartCutJob {
    scan_id: String,
    cancelled: AtomicBool,
    child: Mutex<Option<std::process::Child>>,
}

/// RAII handle that keeps a job registered; dropping it frees the admission
/// slot on every exit path — success, error, cancel, or panic — but only if
/// the registered job is still THIS one.
#[derive(Debug)]
pub struct SmartCutRegistration {
    registry: Arc<SmartCutRegistry>,
    recording_id: String,
    job: Arc<SmartCutJob>,
}

impl SmartCutRegistry {
    /// Register scan `scan_id` for `recording_id`. A second scan for the same
    /// recording is rejected while one is registered — scans for different
    /// recordings may run in parallel.
    pub fn begin(
        self: &Arc<Self>,
        recording_id: &str,
        scan_id: &str,
    ) -> Result<SmartCutRegistration> {
        if scan_id.is_empty() {
            return Err(InternalError::Media("smart-cut scan id is required".into()).into());
        }
        // Lock order is always jobs → cancelled so the tombstone consume and
        // the insert are atomic against a racing cancel: a cancel can never
        // land between the check and the registration.
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| InternalError::Media("smart-cut registry unavailable".into()))?;
        let mut cancelled = self
            .cancelled
            .lock()
            .map_err(|_| InternalError::Media("smart-cut registry unavailable".into()))?;
        prune_tombstones(&mut cancelled);
        // A cancel recorded while this id was still queued — consume it and
        // reject the begin so no dead scan ever starts.
        if cancelled
            .remove(&(recording_id.to_string(), scan_id.to_string()))
            .is_some()
        {
            return Err(smart_cut_cancelled());
        }
        if jobs.contains_key(recording_id) {
            return Err(AppError::new(
                ErrorCategory::Media,
                "smart_cut_busy",
                "A Smart Cut scan is already running for this recording. Wait for it to finish, or cancel it first.",
            ));
        }
        let job = Arc::new(SmartCutJob {
            scan_id: scan_id.to_string(),
            cancelled: AtomicBool::new(false),
            child: Mutex::new(None),
        });
        jobs.insert(recording_id.to_string(), Arc::clone(&job));
        Ok(SmartCutRegistration {
            registry: Arc::clone(self),
            recording_id: recording_id.to_string(),
            job,
        })
    }

    /// Cancel the scan registered as `scan_id` for `recording_id`: remove it
    /// from admission and kill its ffmpeg child. A mismatched scan id is a
    /// no-op, so a superseded run's cleanup can never kill the newer scan
    /// that replaced it. When nothing is registered yet (the scan is still
    /// queued inside its spawn) the cancel is tombstoned — a matching later
    /// `begin` is rejected instead of starting dead work.
    pub fn cancel(&self, recording_id: &str, scan_id: &str) {
        if scan_id.is_empty() {
            return;
        }
        // Same lock order as `begin` — atomic miss→tombstone.
        let (job, mut cancelled) = {
            let mut jobs = match self.jobs.lock() {
                Ok(jobs) => jobs,
                Err(_) => return,
            };
            let cancelled = match self.cancelled.lock() {
                Ok(cancelled) => cancelled,
                Err(_) => return,
            };
            (
                match jobs.get(recording_id) {
                    Some(job) if job.scan_id == scan_id => jobs.remove(recording_id),
                    _ => None,
                },
                cancelled,
            )
        };
        if let Some(job) = job {
            job.cancel();
            return;
        }
        // Not registered — tombstone the id so a queued begin still honors
        // the cancel. Expire old entries first; then keep the map bounded.
        let now = Instant::now();
        prune_tombstones(&mut cancelled);
        if cancelled.len() >= SMART_CUT_TOMBSTONE_MAX {
            if let Some(oldest) = cancelled
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| key.clone())
            {
                cancelled.remove(&oldest);
            }
        }
        cancelled.insert((recording_id.to_string(), scan_id.to_string()), now);
    }

    /// Free the admission slot — only when the registered job is still this
    /// one. A stale registration must not evict a newer scan's job.
    fn finish(&self, recording_id: &str, job: &Arc<SmartCutJob>) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if matches!(jobs.get(recording_id), Some(registered) if Arc::ptr_eq(registered, job)) {
                jobs.remove(recording_id);
            }
        }
    }
}

impl SmartCutJob {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        let mut slot = child_slot(self);
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
        }
    }

    /// Hand the spawned ffmpeg child to the job. If `cancel` raced the spawn,
    /// the child is killed immediately so the wait loop cannot block on an
    /// already-cancelled job.
    pub fn set_child(&self, child: std::process::Child) {
        let mut slot = child_slot(self);
        *slot = Some(child);
        if self.is_cancelled() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }

    /// Poll the child without holding the lock — `cancel` must always be able
    /// to reach `kill()` between polls.
    pub fn try_wait(&self) -> Result<Option<std::process::ExitStatus>> {
        let mut slot = child_slot(self);
        match slot.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|e| InternalError::Media(format!("analysis wait: {e}")).into()),
            None => Err(InternalError::Media("analysis process was not started".into()).into()),
        }
    }
}

impl SmartCutRegistration {
    pub fn job(&self) -> &Arc<SmartCutJob> {
        &self.job
    }
}

impl Drop for SmartCutRegistration {
    fn drop(&mut self) {
        self.registry.finish(&self.recording_id, &self.job);
    }
}

impl Drop for SmartCutJob {
    fn drop(&mut self) {
        // Poisoned or not, the slot is recovered — a leaked ffmpeg process is
        // impossible on every exit path.
        let mut slot = self.child.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Parse FFmpeg `silencedetect` stderr into millisecond ranges. Scientific
/// notation parses through `f64`; negative starts (decoder priming) clamp to
/// zero and every emitted bound clamps to `duration_ms`. An unterminated
/// trailing `silence_start` (file ends mid-silence) is clamped to
/// `duration_ms`; non-finite values drop the pair instead of corrupting output.
pub(crate) fn parse_silence_ranges(stderr: &str, duration_ms: u64) -> Vec<SilenceRange> {
    let mut ranges = Vec::new();
    let mut open_start_ms: Option<u64> = None;
    for line in stderr.lines() {
        if let Some(pos) = line.find("silence_start:") {
            let value = line[pos + "silence_start:".len()..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim();
            if let Ok(seconds_value) = value.parse::<f64>() {
                if seconds_value.is_finite() {
                    open_start_ms = Some((seconds_value.max(0.0) * 1000.0).round() as u64);
                }
            }
        } else if let Some(pos) = line.find("silence_end:") {
            let value = line[pos + "silence_end:".len()..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim();
            if let Ok(seconds_value) = value.parse::<f64>() {
                if let Some(start_ms) = open_start_ms.take() {
                    if seconds_value.is_finite() {
                        let start_ms = start_ms.min(duration_ms);
                        let end_ms =
                            ((seconds_value.max(0.0) * 1000.0).round() as u64).min(duration_ms);
                        if end_ms > start_ms {
                            ranges.push(SilenceRange { start_ms, end_ms });
                        }
                    }
                }
            }
        }
    }
    if let Some(start_ms) = open_start_ms {
        let start_ms = start_ms.min(duration_ms);
        if duration_ms > start_ms {
            ranges.push(SilenceRange {
                start_ms,
                end_ms: duration_ms,
            });
        }
    }
    ranges
}

/// The settled RMS analysis stage: resample to 48 kHz (also re-anchoring
/// initial timestamps the `atempo`/`adelay` combination can drop), bucket
/// into 960-sample (20 ms) frames, then print each frame's RMS level as
/// metadata to stdout. Rebuild frame timestamps from the actual sample count:
/// buffered `atempo`/`asetnsamples` frames can otherwise carry NOPTS. This fixes
/// the measurement clock upstream rather than guessing timestamps in the parser.
/// No gain or channel-layout change.
fn analysis_stage() -> &'static str {
    "[aout]aresample=48000:async=1:first_pts=0,asetnsamples=n=960:p=0,asetpts=N/SR/TB,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-[detected]"
}

/// Width of one analysis window: 960 samples at 48 kHz.
const WINDOW_MS: u64 = 20;
/// Join tolerance when tiling check compares adjacent window bounds — float
/// pts rounding can land a hair off the exact 20 ms grid.
const WINDOW_JOIN_EPS_MS: u64 = 2;
/// Digital silence reports `-inf`; it is pinned to the noise floor minimum.
const RMS_FLOOR_DB: f64 = -120.0;
const THRESHOLD_MIN_DB: f64 = -75.0;
const THRESHOLD_MAX_DB: f64 = -10.0;

/// One measured window on the output timeline. Compact by design — a long
/// scan keeps ~3k windows per minute of timeline, never raw text or audio.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RmsWindow {
    pub start_ms: u64,
    pub end_ms: u64,
    pub rms_db: f64,
}

/// Smart Cut scan result: the proposed ranges plus the calibration context
/// the review UI shows. This is RMS silence detection — not speech
/// recognition.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SilenceScanResult {
    pub ranges: Vec<SilenceRange>,
    /// Threshold actually applied — calibrated (`adaptive`) or the supplied
    /// manual value (`manual`), both dB RMS.
    pub threshold_db: f64,
    /// Measured 20th-percentile RMS of the scanned audio (dB), when windows
    /// exist — the effective noise floor the calibration observed.
    pub noise_floor_db: Option<f64>,
    /// `"adaptive"` | `"manual"`.
    pub calibration: String,
}

/// Sorted percentile per the settled formula: `sorted[floor((n-1)*q)]`.
fn percentile(sorted: &[f64], q: f64) -> f64 {
    debug_assert!(!sorted.is_empty());
    sorted[((sorted.len() - 1) as f64 * q).floor() as usize]
}

/// Lead-settled calibration: `clamp(min(p20 + 6, p90 - 9), -75, -10)` dB RMS.
/// A manual threshold is finite-validated and clamped to the same range.
pub(crate) fn calibrate_threshold(rms_levels: &[f64], manual: Option<f64>) -> Result<f64> {
    if let Some(manual) = manual {
        if !manual.is_finite() {
            return Err(
                InternalError::Media("silence threshold must be a finite dB value".into()).into(),
            );
        }
        return Ok(manual.clamp(THRESHOLD_MIN_DB, THRESHOLD_MAX_DB));
    }
    if rms_levels.is_empty() {
        return Err(InternalError::Media("audio analysis produced no measurements".into()).into());
    }
    let mut sorted = rms_levels.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p20 = percentile(&sorted, 0.2);
    let p90 = percentile(&sorted, 0.9);
    Ok((p20 + 6.0)
        .min(p90 - 9.0)
        .clamp(THRESHOLD_MIN_DB, THRESHOLD_MAX_DB))
}

/// The measured noise floor shown to the user — the p20 RMS level.
fn noise_floor(rms_levels: &[f64]) -> Option<f64> {
    if rms_levels.is_empty() {
        return None;
    }
    let mut sorted = rms_levels.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(percentile(&sorted, 0.2))
}

/// Join contiguous silent windows into raw ranges. A window with
/// `rms_db <= threshold` is a candidate; a run closes on the first audible
/// window and a timestamp gap never bridges silence (missing coverage is not
/// inferred silent). Ranges shorter than `min_duration_ms` are dropped and
/// every bound stays inside `duration_ms`.
pub(crate) fn collect_silent_ranges(
    windows: &[RmsWindow],
    threshold_db: f64,
    min_duration_ms: u64,
    duration_ms: u64,
) -> Vec<SilenceRange> {
    let mut ranges = Vec::new();
    let mut open: Option<SilenceRange> = None;
    let flush = |open: &mut Option<SilenceRange>, ranges: &mut Vec<SilenceRange>| {
        if let Some(range) = open.take() {
            if range.end_ms.saturating_sub(range.start_ms) >= min_duration_ms {
                ranges.push(range);
            }
        }
    };
    for window in windows {
        let start = window.start_ms.min(duration_ms);
        let end = window.end_ms.min(duration_ms);
        if window.rms_db <= threshold_db {
            match open.as_mut() {
                Some(range) if start <= range.end_ms.saturating_add(WINDOW_JOIN_EPS_MS) => {
                    range.end_ms = range.end_ms.max(end);
                }
                _ => {
                    flush(&mut open, &mut ranges);
                    open = Some(SilenceRange {
                        start_ms: start,
                        end_ms: end,
                    });
                }
            }
        } else {
            flush(&mut open, &mut ranges);
        }
    }
    flush(&mut open, &mut ranges);
    ranges
}

/// Parse one `ametadata` stdout line into the pending measurement stream.
/// `frame:` lines carry `pts_time:` and set the current window start; the
/// `RMS_level=` line that follows completes the window.
///
/// NOPTS is unplaceable coverage at ANY position: emit no window, so the next
/// real timestamp leaves a gap rather than fabricating silence. The analysis
/// graph supplies a sample-count clock; invalid or backwards times fail closed.
/// A `frame:` line without an `RMS_level=` line likewise leaves a hole.
struct MetadataParser {
    /// `None` = no frame pending; `Some(Some(t))` = timestamped frame;
    /// `Some(None)` = a frame with unknown time, which must not become a cut.
    pending: Option<Option<f64>>,
    windows: Vec<RmsWindow>,
    malformed: bool,
}

impl MetadataParser {
    fn new() -> Self {
        Self {
            pending: None,
            windows: Vec::new(),
            malformed: false,
        }
    }

    fn feed(&mut self, line: &str, duration_ms: u64) {
        if self.malformed {
            return;
        }
        if line.starts_with("frame:") {
            let timestamp = line
                .split_whitespace()
                .find_map(|token| token.strip_prefix("pts_time:"));
            self.pending = match timestamp {
                Some("NOPTS") => Some(None),
                Some(value) => match value.parse::<f64>() {
                    Ok(t) if t.is_finite() && t >= 0.0 => Some(Some(t)),
                    _ => {
                        self.malformed = true;
                        return;
                    }
                },
                None => {
                    self.malformed = true;
                    return;
                }
            };
        } else if let Some(value) = line.strip_prefix("lavfi.astats.Overall.RMS_level=") {
            let Some(pending) = self.pending.take() else {
                // A level line with no owning frame is malformed metadata.
                self.malformed = true;
                return;
            };
            let value = value.trim();
            let rms_db = if value == "-inf" {
                RMS_FLOOR_DB
            } else {
                match value.parse::<f64>() {
                    // +inf and NaN are sensor garbage, never a floor.
                    Ok(v) if v.is_finite() => v.clamp(RMS_FLOOR_DB, 0.0),
                    _ => {
                        self.malformed = true;
                        return;
                    }
                }
            };
            let start_ms = match pending {
                Some(start_s) => (start_s * 1000.0).round() as u64,
                None => return,
            };
            // Overlapping windows cannot represent independent measurements.
            if self
                .windows
                .last()
                .is_some_and(|previous| start_ms < previous.end_ms)
            {
                self.malformed = true;
                return;
            }
            if start_ms >= duration_ms {
                return;
            }
            self.windows.push(RmsWindow {
                start_ms,
                end_ms: start_ms.saturating_add(WINDOW_MS).min(duration_ms),
                rms_db,
            });
        }
    }
}

/// Clone of the plan restricted to what the audio mixer reads. Input
/// collection must match the exact track set `append_audio_graph` selects —
/// otherwise scanning probes/reads (and fails on) unrelated video, camera,
/// cursor, or muted assets that never reach the audio graph.
fn audio_only_plan(plan: &RenderPlan) -> RenderPlan {
    let mut plan = plan.clone();
    plan.segments.clear();
    plan.gaps.clear();
    plan.overlays.clear();
    plan.cursor_effects.clear();
    plan.annotations.clear();
    plan.texts.clear();
    plan.images.clear();
    plan.masks.clear();
    plan.zoom_segments.clear();
    plan.keystrokes.clear();
    plan.captions.clear();
    plan.chapters.clear();
    plan.overlay_render_plan = None;
    if let Some(tracks) = &mut plan.audio_tracks {
        tracks.retain(|track| !track.muted);
    }
    if plan.audio.as_ref().is_some_and(|audio| audio.muted) {
        plan.audio = None;
    }
    plan
}

/// Analyze the edited timeline's mixed audio and return a calibrated
/// silence scan in output-timeline milliseconds. `asset_paths` must already
/// be resolved through the project's path policy — this never touches
/// caller-supplied filesystem paths. `threshold_db: None` selects the
/// adaptive RMS calibration; a supplied value is a manual dB floor. `job`
/// carries the cancel flag and child handle; `resource_gate` serializes the
/// heavy decode/mix work with capture and media jobs (waiting is
/// cooperative and cancellable).
#[allow(clippy::too_many_arguments)]
pub(crate) fn analyze_timeline_silences(
    ffmpeg_path: &Path,
    ffprobe_path: Option<&Path>,
    plan: &RenderPlan,
    asset_paths: &HashMap<String, PathBuf>,
    threshold_db: Option<f64>,
    min_duration_ms: u64,
    resource_gate: &Arc<CaptureWorkGate>,
    job: &SmartCutJob,
) -> Result<SilenceScanResult> {
    if job.is_cancelled() {
        return Err(smart_cut_cancelled());
    }
    // Wait off the async runtime for capture/export work to drain before
    // competing for decode CPU; a cancel during the wait returns promptly.
    let _resource_permit = match resource_gate.wait_for_job(&job.cancelled)? {
        Some(permit) => permit,
        None => return Err(smart_cut_cancelled()),
    };

    let analysis_plan = audio_only_plan(plan);
    let inputs = collect_input_assets(&analysis_plan, asset_paths)?;
    let input_indices: HashMap<String, usize> = inputs
        .iter()
        .enumerate()
        .map(|(index, (asset_id, _))| (asset_id.clone(), index))
        .collect();
    let probe = ProbeCache::new(ffprobe_path);

    let mut filters = Vec::new();
    let has_audio = append_audio_graph(
        &mut filters,
        &analysis_plan,
        &plan.project_id,
        &input_indices,
        asset_paths,
        &probe,
        plan.duration_ms.max(1),
        &job.cancelled,
    )?;
    if job.is_cancelled() {
        return Err(smart_cut_cancelled());
    }
    if !has_audio {
        return Err(InternalError::Media(
            "The edited timeline has no audible audio — unmute a track or add audio, then scan again."
                .into(),
        )
        .into());
    }
    filters.push(analysis_stage().to_string());

    // The `-/filter_complex` script file matches the export path's quoting
    // rules and avoids command-line length limits on long graphs.
    let script_path = std::env::temp_dir().join(format!(
        "rf-filter-complex-smartcut-{}.txt",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&script_path, filters.join(";\n")).map_err(|error| {
        InternalError::Storage(format!("write smart-cut filter graph: {error}"))
    })?;
    let _script_guard = TempMaskFile(script_path.clone());

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-loglevel")
        .arg("info")
        .arg("-filter_complex_threads")
        .arg("1");
    for (_, path) in &inputs {
        // Decoder threads stay bounded per input so a scan never competes
        // with an ongoing preview or export for CPU.
        command.arg("-threads").arg("2").arg("-i").arg(path);
    }
    command.arg("-/filter_complex").arg(&script_path).args([
        "-map",
        "[detected]",
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "null",
        "-",
    ]);
    // ametadata prints measurements on stdout; stderr carries diagnostics.
    // Both pipes drain on helper threads so neither fills and stalls ffmpeg
    // while the main thread polls the child for cancellation.
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| InternalError::Media(format!("silence analysis spawn: {error}")))?;
    let stderr_pipe = child.stderr.take();
    let stderr_drainer = stderr_pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut pipe, &mut std::io::sink());
        })
    });
    // stdout is the measurement channel — stream it into compact windows as
    // lines arrive; the pipe never buffers the whole report in memory.
    let duration_ms = plan.duration_ms;
    let stdout_pipe = child.stdout.take();
    let stdout_drainer = stdout_pipe.map(|pipe| {
        std::thread::spawn(move || {
            let mut parser = MetadataParser::new();
            let mut reader = std::io::BufReader::new(pipe);
            let mut line = String::new();
            loop {
                line.clear();
                match std::io::BufRead::read_line(&mut reader, &mut line) {
                    Ok(0) => break,
                    Err(_) => {
                        parser.malformed = true;
                        break;
                    }
                    Ok(_) => parser.feed(&line, duration_ms),
                }
            }
            parser
        })
    });
    job.set_child(child);

    let status = loop {
        match job.try_wait()? {
            Some(status) => break status,
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    };
    if let Some(thread) = stderr_drainer {
        let _ = thread.join();
    }
    let parser = stdout_drainer
        .map(|thread| thread.join().unwrap_or_else(|_| MetadataParser::new()))
        .unwrap_or_else(MetadataParser::new);
    // A killed child can exit with any status — report cancellation first.
    if job.is_cancelled() {
        return Err(smart_cut_cancelled());
    }
    if !status.success() {
        // Never parse partial output on failure — a crashed scan is not
        // "zero silences". Stderr may carry media paths, so it is not
        // surfaced or logged raw.
        return Err(InternalError::Media(format!(
            "silence analysis failed (audio engine exited with status {status})"
        ))
        .into());
    }
    if parser.malformed {
        return Err(
            InternalError::Media("audio analysis produced malformed measurements".into()).into(),
        );
    }
    let windows = parser.windows;
    if windows.is_empty() {
        return Err(InternalError::Media("audio analysis produced no measurements".into()).into());
    }

    let levels: Vec<f64> = windows.iter().map(|window| window.rms_db).collect();
    let calibration = if threshold_db.is_some() {
        "manual"
    } else {
        "adaptive"
    };
    let applied_db = calibrate_threshold(&levels, threshold_db)?;
    let ranges = collect_silent_ranges(&windows, applied_db, min_duration_ms, duration_ms);
    Ok(SilenceScanResult {
        ranges,
        threshold_db: applied_db,
        noise_floor_db: noise_floor(&levels),
        calibration: calibration.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::{RenderPlanAudio, RenderSegment};
    use std::process::Command;

    fn sidecar(name: &str) -> Option<PathBuf> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let binary_dir = manifest.join("binaries");
        let triple = env!("TARGET_TRIPLE");
        let file = if cfg!(windows) {
            format!("{name}-{triple}.exe")
        } else {
            format!("{name}-{triple}")
        };
        let candidate = binary_dir.join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
        crate::media::resolve_executable(name).ok()
    }

    /// An ffmpeg that actually carries the analysis filters — dev boxes can
    /// expose shimgen stubs that spawn then exit 127, so `-filters` output is
    /// checked rather than spawnability.
    fn real_ffmpeg() -> Option<PathBuf> {
        let ffmpeg = sidecar("ffmpeg")?;
        let output = Command::new(&ffmpeg)
            .args(["-hide_banner", "-filters"])
            .output()
            .ok()?;
        let filters = String::from_utf8_lossy(&output.stdout);
        if output.status.success()
            && filters.contains("astats")
            && filters.contains("ametadata")
            && filters.contains("amerge")
            && filters.contains("atempo")
            && filters.contains("aresample")
        {
            Some(ffmpeg)
        } else {
            None
        }
    }

    fn real_ffprobe() -> Option<PathBuf> {
        let ffprobe = sidecar("ffprobe")?;
        Command::new(&ffprobe)
            .arg("-version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|_| ffprobe)
    }

    /// Registered scan job + free resource gate for analysis calls. The
    /// registration drops at setup exit — fine for tests that never re-admit.
    fn scan_setup() -> (
        Arc<SmartCutRegistry>,
        Arc<SmartCutJob>,
        Arc<CaptureWorkGate>,
    ) {
        let registry = Arc::new(SmartCutRegistry::default());
        let job = {
            let registration = registry
                .begin("rec-scan", &format!("scan-{}", uuid::Uuid::new_v4()))
                .expect("register scan");
            Arc::clone(registration.job())
        };
        (registry, job, Arc::new(CaptureWorkGate::default()))
    }

    fn analyze(
        ffmpeg: &Path,
        plan: &RenderPlan,
        assets: &HashMap<String, PathBuf>,
        threshold_db: Option<f64>,
        min_duration_ms: u64,
    ) -> Result<SilenceScanResult> {
        let (_registry, job, gate) = scan_setup();
        analyze_timeline_silences(
            ffmpeg,
            real_ffprobe().as_deref(),
            plan,
            assets,
            threshold_db,
            min_duration_ms,
            &gate,
            &job,
        )
    }

    /// 3s WAV: 440Hz tone with a forced-silent window via `volume=0` between
    /// `from_s` and `to_s` (omitted bounds mean fully tone).
    fn generate_wav(
        ffmpeg: &Path,
        dir: &Path,
        name: &str,
        mute_window: Option<(f64, f64)>,
    ) -> PathBuf {
        let path = dir.join(name);
        let mut command = Command::new(ffmpeg);
        command
            .args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=3",
            ]);
        if let Some((from_s, to_s)) = mute_window {
            command.args([
                "-af",
                &format!("volume=0:enable='between(t,{from_s},{to_s})'"),
            ]);
        }
        command.args(["-c:a", "pcm_s16le"]).arg(&path);
        let status = command.status().expect("spawn fixture ffmpeg");
        assert!(status.success(), "fixture generation failed for {name}");
        path
    }

    fn generate_wav_volume(ffmpeg: &Path, dir: &Path, name: &str, volume: f64) -> PathBuf {
        let path = dir.join(name);
        let status = Command::new(ffmpeg)
            .args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=3",
                "-af",
                &format!("volume={volume}"),
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&path)
            .status()
            .expect("spawn fixture ffmpeg");
        assert!(status.success(), "fixture generation failed for {name}");
        path
    }

    fn silent_wav(ffmpeg: &Path, dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        let status = Command::new(ffmpeg)
            .args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"])
            .args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=3"])
            .args(["-c:a", "pcm_s16le"])
            .arg(&path)
            .status()
            .expect("spawn fixture ffmpeg");
        assert!(status.success(), "fixture generation failed for {name}");
        path
    }

    fn audio_track(asset_id: &str, muted: bool, segments: Vec<RenderSegment>) -> RenderPlanAudio {
        RenderPlanAudio {
            asset_id: asset_id.to_string(),
            stream_index: None,
            role: Some("microphone".into()),
            muted,
            volume: 1.0,
            segments,
        }
    }

    fn audio_segment(
        asset_id: &str,
        source_in_ms: u64,
        source_out_ms: u64,
        output_start_ms: u64,
        output_end_ms: u64,
        speed: f64,
    ) -> RenderSegment {
        RenderSegment {
            asset_id: asset_id.to_string(),
            stream_index: None,
            volume: None,
            fade_in_ms: None,
            fade_out_ms: None,
            volume_keyframes: None,
            audio_filter: None,
            speed,
            source_in_ms,
            source_out_ms,
            output_start_ms,
            output_end_ms,
            source_width: None,
            source_height: None,
        }
    }

    fn plan_with_tracks(duration_ms: u64, tracks: Vec<RenderPlanAudio>) -> RenderPlan {
        RenderPlan {
            reframe: None,
            project_id: "project-smart-cut".into(),
            duration_ms,
            segments: Vec::new(),
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "none".into(),
            chapters: Vec::new(),
            chapter_mode: "none".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: None,
            audio: None,
            audio_tracks: Some(tracks),
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            keystrokes: Vec::new(),
        }
    }

    fn assert_near(actual: u64, expected: u64, tolerance_ms: u64, what: &str) {
        let diff = actual.abs_diff(expected);
        assert!(
            diff <= tolerance_ms,
            "{what}: expected ~{expected}ms, got {actual}ms"
        );
    }

    #[test]
    fn detects_silence_in_single_edited_track() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let tone = generate_wav(&ffmpeg, dir.path(), "tone.wav", Some((1.0, 2.0)));
        let mut assets = HashMap::new();
        assets.insert("asset-tone".to_string(), tone);
        let plan = plan_with_tracks(
            3_000,
            vec![audio_track(
                "asset-tone",
                false,
                vec![audio_segment("asset-tone", 0, 3_000, 0, 3_000, 1.0)],
            )],
        );

        let result = analyze(&ffmpeg, &plan, &assets, Some(-35.0), 500).expect("analysis succeeds");
        let ranges = &result.ranges;
        assert_eq!(result.calibration, "manual");
        assert_eq!(ranges.len(), 1, "one silence window expected: {ranges:?}");
        assert_near(ranges[0].start_ms, 1_000, 35, "silence start");
        assert_near(ranges[0].end_ms, 2_000, 35, "silence end");
    }

    #[test]
    fn mixed_tracks_require_all_streams_silent() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let tone = generate_wav(&ffmpeg, dir.path(), "tone.wav", None);
        let silence = silent_wav(&ffmpeg, dir.path(), "silence.wav");
        let mut assets = HashMap::new();
        assets.insert("asset-tone".to_string(), tone.clone());
        assets.insert("asset-silent".to_string(), silence);

        // One still-audible track keeps the whole mix audible.
        let plan = plan_with_tracks(
            3_000,
            vec![
                audio_track(
                    "asset-tone",
                    false,
                    vec![audio_segment("asset-tone", 0, 3_000, 0, 3_000, 1.0)],
                ),
                audio_track(
                    "asset-silent",
                    false,
                    vec![audio_segment("asset-silent", 0, 3_000, 0, 3_000, 1.0)],
                ),
            ],
        );
        let ranges = analyze(&ffmpeg, &plan, &assets, Some(-35.0), 500)
            .expect("analysis succeeds")
            .ranges;
        assert!(
            ranges.is_empty(),
            "tone must keep the mix audible: {ranges:?}"
        );

        // A muted track is dropped from the graph entirely — the remaining
        // all-silent mix reports one range covering the timeline.
        let plan = plan_with_tracks(
            3_000,
            vec![
                audio_track(
                    "asset-silent",
                    false,
                    vec![audio_segment("asset-silent", 0, 3_000, 0, 3_000, 1.0)],
                ),
                audio_track(
                    "asset-tone",
                    true,
                    vec![audio_segment("asset-tone", 0, 3_000, 0, 3_000, 1.0)],
                ),
            ],
        );
        let ranges = analyze(&ffmpeg, &plan, &assets, Some(-35.0), 500)
            .expect("analysis succeeds")
            .ranges;
        assert_eq!(ranges.len(), 1, "silent mix reports one range: {ranges:?}");
        assert_near(ranges[0].start_ms, 0, 35, "silence start");
        assert_near(ranges[0].end_ms, 3_000, 35, "silence end");
    }

    #[test]
    fn trim_move_and_speed_shift_silence_to_output_time() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let tone = generate_wav(&ffmpeg, dir.path(), "tone.wav", Some((1.0, 2.0)));
        let mut assets = HashMap::new();
        assets.insert("asset-tone".to_string(), tone);

        // Source 0..3000 at 2x lands on output 500..2000. The ~[1002,2005]ms
        // source silence lands near [1001,1503]ms output; the 0..500 adelay
        // head pad and the 2000..3000 tail pad read as silence too — the
        // aresample reanchor keeps the head silence visible to silencedetect.
        let plan = plan_with_tracks(
            3_000,
            vec![audio_track(
                "asset-tone",
                false,
                vec![audio_segment("asset-tone", 0, 3_000, 500, 2_000, 2.0)],
            )],
        );
        let ranges = analyze(&ffmpeg, &plan, &assets, Some(-35.0), 300)
            .expect("analysis succeeds")
            .ranges;

        assert_eq!(
            ranges.len(),
            3,
            "head pad, source gap, tail pad: {ranges:?}"
        );
        assert_near(ranges[0].start_ms, 0, 35, "adelay silence start");
        assert_near(ranges[0].end_ms, 500, 35, "adelay silence end");
        assert_near(
            ranges[1].start_ms,
            1_001,
            50,
            "source gap start (output time)",
        );
        assert_near(ranges[1].end_ms, 1_503, 50, "source gap end (output time)");
        assert_near(ranges[2].start_ms, 2_000, 35, "tail pad start");
        assert_near(ranges[2].end_ms, 3_000, 35, "tail pad end");
    }

    #[test]
    fn aresample_reanchor_does_not_shift_gain() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        // Bracket a manual -35 dB floor: on the pinned build a full-scale
        // sine reads ≈-21.05 dB RMS, so volume 0.25 ≈-33.1 dB (audible) and
        // 0.16 ≈-37.0 dB (silent). If the aresample stage shifted gain by
        // even ~1 dB, one side of the bracket flips.
        let quiet = generate_wav_volume(&ffmpeg, dir.path(), "quiet.wav", 0.25);
        let muted = generate_wav_volume(&ffmpeg, dir.path(), "near-silent.wav", 0.16);
        let mut assets = HashMap::new();
        assets.insert("asset-quiet".to_string(), quiet);
        assets.insert("asset-near-silent".to_string(), muted);
        let audible_plan = plan_with_tracks(
            3_000,
            vec![audio_track(
                "asset-quiet",
                false,
                vec![audio_segment("asset-quiet", 0, 3_000, 0, 3_000, 1.0)],
            )],
        );
        let ranges = analyze(&ffmpeg, &audible_plan, &assets, Some(-35.0), 500)
            .expect("analysis succeeds")
            .ranges;
        assert!(
            ranges.is_empty(),
            "just-above-floor tone must stay audible after aresample: {ranges:?}"
        );

        let silent_plan = plan_with_tracks(
            3_000,
            vec![audio_track(
                "asset-near-silent",
                false,
                vec![audio_segment("asset-near-silent", 0, 3_000, 0, 3_000, 1.0)],
            )],
        );
        let ranges = analyze(&ffmpeg, &silent_plan, &assets, Some(-35.0), 500)
            .expect("analysis succeeds")
            .ranges;
        assert!(
            !ranges.is_empty(),
            "just-below-floor tone must read as silence (no gain boost): {ranges:?}"
        );
    }

    #[test]
    fn no_audible_audio_is_an_error_not_empty() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let tone = generate_wav(&ffmpeg, dir.path(), "tone.wav", None);
        let mut assets = HashMap::new();
        assets.insert("asset-tone".to_string(), tone);

        // All tracks muted → the export graph emits no [aout] at all.
        let plan = plan_with_tracks(
            3_000,
            vec![audio_track(
                "asset-tone",
                true,
                vec![audio_segment("asset-tone", 0, 3_000, 0, 3_000, 1.0)],
            )],
        );
        let result = analyze(&ffmpeg, &plan, &assets, Some(-35.0), 500);
        assert!(
            result.is_err(),
            "muted-only timeline must error, not report []"
        );

        // Unplayable assets fail loudly rather than disguising a crashed
        // ffmpeg run as zero silences.
        let plan = plan_with_tracks(
            3_000,
            vec![audio_track(
                "asset-tone",
                false,
                vec![audio_segment("asset-tone", 0, 3_000, 0, 3_000, 1.0)],
            )],
        );
        let (_registry, job, gate) = scan_setup();
        let result = analyze_timeline_silences(
            Path::new("definitely-not-ffmpeg"),
            None,
            &plan,
            &assets,
            Some(-35.0),
            500,
            &gate,
            &job,
        );
        assert!(result.is_err(), "missing ffmpeg must error, not report []");
    }

    #[test]
    fn inputs_come_from_audio_tracks_not_visuals() {
        // An unrelated screen/camera asset that is missing must not gate the
        // scan — inputs are collected from the audio-only clone of the plan.
        // collect_input_assets stats each path, so the audio asset is a real
        // file while the visuals stay dangling.
        let dir = tempfile::tempdir().expect("fixture dir");
        let tone_path = dir.path().join("tone.wav");
        std::fs::write(&tone_path, b"RIFF....WAVEfmt ").expect("fixture file");
        let mut assets = HashMap::new();
        assets.insert("asset-tone".to_string(), tone_path);
        let mut plan = plan_with_tracks(
            3_000,
            vec![audio_track(
                "asset-tone",
                false,
                vec![audio_segment("asset-tone", 0, 3_000, 0, 3_000, 1.0)],
            )],
        );
        plan.segments
            .push(audio_segment("asset-screen", 0, 3_000, 0, 3_000, 1.0));
        plan.cursor_effects
            .push(crate::exports::RenderPlanCursorEffect {
                id: "effect-1".to_string(),
                asset_id: "asset-cursor".to_string(),
                start_ms: 0,
                end_ms: 3_000,
                enabled: true,
                preset_id: "preset".to_string(),
                scale: 1.0,
                smoothing: "smooth".to_string(),
                settings: serde_json::json!({}),
            });

        let audio_plan = audio_only_plan(&plan);
        let collected = collect_input_assets(&audio_plan, &assets).expect("audio inputs");
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].0, "asset-tone");
        // The full plan would fail — asset-screen/asset-cursor are missing.
        assert!(collect_input_assets(&plan, &assets).is_err());
    }

    #[test]
    fn registry_admits_one_scan_per_recording() {
        let registry = Arc::new(SmartCutRegistry::default());
        let first = registry
            .begin("rec-1", "scan-a")
            .expect("first scan admitted");
        let busy = registry
            .begin("rec-1", "scan-b")
            .expect_err("duplicate rejected");
        assert_eq!(busy.code, "smart_cut_busy");
        // A different recording scans in parallel.
        let _other = registry
            .begin("rec-2", "scan-c")
            .expect("other recording admitted");
        drop(first);
        let _again = registry
            .begin("rec-1", "scan-d")
            .expect("slot freed after drop");
    }

    #[test]
    fn cancel_marks_job_and_kills_child() {
        let registry = Arc::new(SmartCutRegistry::default());
        let registration = registry.begin("rec-1", "scan-a").expect("register scan");
        registry.cancel("rec-1", "scan-a");
        assert!(registration.job().is_cancelled());
        // Unknown recordings and mismatched scan ids are harmless no-ops.
        registry.cancel("nobody", "scan-a");
        registry.cancel("rec-1", "scan-z");
        assert!(registry.jobs.lock().expect("jobs").is_empty());
    }

    #[test]
    fn stale_cancel_and_drop_cannot_touch_a_newer_scan() {
        let registry = Arc::new(SmartCutRegistry::default());
        // Superseded run A: its cancel must not kill run B that took the slot.
        let a = registry.begin("rec-1", "scan-a").expect("run A");
        drop(a); // A finished; slot freed by its own drop.
        let b = registry.begin("rec-1", "scan-b").expect("run B admitted");
        registry.cancel("rec-1", "scan-a");
        assert!(!b.job().is_cancelled(), "stale cancel touched run B");
        registry.cancel("rec-1", "scan-b");
        assert!(b.job().is_cancelled());
        // A cancelled slot admits run C; B's registration dropping late must
        // not evict C's job from the registry.
        let c = registry
            .begin("rec-1", "scan-c")
            .expect("run C admitted after cancel");
        drop(b);
        assert!(
            registry
                .begin("rec-1", "scan-d")
                .expect_err("C still holds the slot")
                .code
                == "smart_cut_busy"
        );
        drop(c);
    }

    #[test]
    fn cancel_before_begin_tombstones_the_scan() {
        let registry = Arc::new(SmartCutRegistry::default());
        // The cancel lands while the scan is only queued — nothing is
        // registered yet, so it is tombstoned and the eventual begin is
        // rejected rather than starting dead work.
        registry.cancel("rec-1", "scan-a");
        let err = registry
            .begin("rec-1", "scan-a")
            .expect_err("tombstoned begin is cancelled");
        assert_eq!(err.code, "smart_cut_cancelled");
        // The tombstone is consumed once — it must not poison a genuinely
        // new scan that reuses the id later.
        let _retry = registry
            .begin("rec-1", "scan-a")
            .expect("consumed tombstone does not reject again");
    }

    #[test]
    fn cancel_while_queued_does_not_block_other_ids() {
        let registry = Arc::new(SmartCutRegistry::default());
        registry.cancel("rec-1", "scan-a");
        // Different scan id for the same recording begins fine.
        let _b = registry.begin("rec-1", "scan-b").expect("other scan id ok");
        // And a tombstone for one recording never cancels another's run.
        registry.cancel("rec-1", "scan-c");
        let _c = registry
            .begin("rec-2", "scan-c")
            .expect("other recording unaffected");
    }

    #[test]
    fn tombstones_expire_and_stay_bounded() {
        let registry = Arc::new(SmartCutRegistry::default());
        // Insert an already-expired tombstone directly — a matching begin is
        // admitted because the cancel is no longer meaningful.
        {
            let mut cancelled = registry.cancelled.lock().expect("cancelled lock");
            cancelled.insert(
                ("rec-1".to_string(), "scan-old".to_string()),
                Instant::now() - SMART_CUT_TOMBSTONE_TTL - Duration::from_secs(1),
            );
        }
        let _old = registry
            .begin("rec-1", "scan-old")
            .expect("expired tombstone ignored");
        drop(_old);
        // The map never grows past the cap regardless of cancel churn.
        for i in 0..(SMART_CUT_TOMBSTONE_MAX + 32) {
            registry.cancel("rec-x", &format!("scan-{i}"));
        }
        let cancelled = registry.cancelled.lock().expect("cancelled lock");
        assert!(cancelled.len() <= SMART_CUT_TOMBSTONE_MAX);
    }

    #[test]
    fn poisoned_child_mutex_is_recovered_not_leaked() {
        let job = Arc::new(SmartCutJob {
            scan_id: "scan-p".to_string(),
            cancelled: AtomicBool::new(false),
            child: Mutex::new(None),
        });
        let poisoned = Arc::clone(&job);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _slot = poisoned.child.lock().expect("lock");
            panic!("poison the child mutex");
        }));
        // Recovered lock: `cancel` and `try_wait` still reach the slot
        // instead of abandoning a possibly-held child.
        job.cancel();
        assert!(job.is_cancelled());
        assert!(job.try_wait().is_err());
        drop(job); // Drop must recover and reap without panicking.
    }

    #[test]
    fn parser_handles_eof_tail_clamps_and_scientific_notation() {
        let stderr = r#"
[silencedetect @ 0] silence_start: 1.5
[silencedetect @ 0] silence_end: 3.25 | silence_duration: 1.75
[silencedetect @ 0] silence_start: 4e0
[silencedetect @ 0] silence_end: 5.5e0 | silence_duration: 1.5e0
[silencedetect @ 0] silence_start: 11
[silencedetect @ 0] silence_end: 99 | silence_duration: 88
[silencedetect @ 0] silence_start: nan
[silencedetect @ 0] silence_end: inf | silence_duration: inf
[silencedetect @ 0] silence_start: -0.02
"#;
        let ranges = parse_silence_ranges(stderr, 12_000);
        assert_eq!(
            ranges,
            vec![
                SilenceRange {
                    start_ms: 1_500,
                    end_ms: 3_250
                },
                SilenceRange {
                    start_ms: 4_000,
                    end_ms: 5_500
                },
                // End past duration clamps to duration.
                SilenceRange {
                    start_ms: 11_000,
                    end_ms: 12_000
                },
                // NaN pair drops; the negative-primed open start clamps to
                // 0 and runs unterminated to duration.
                SilenceRange {
                    start_ms: 0,
                    end_ms: 12_000
                },
            ]
        );
    }

    #[test]
    fn parser_ignores_zero_length_and_unpaired_end() {
        let stderr = "silence_end: 2.0 | silence_duration: 1.0\nsilence_start: 5.0\nsilence_end: 5.0 | silence_duration: 0\n";
        let ranges = parse_silence_ranges(stderr, 10_000);
        assert!(ranges.is_empty());
    }

    /// The lead-frozen 6s fixture: a white-noise floor + gated 440Hz tone at
    /// unity gain, identical to the lavfi recipe the calibration numbers
    /// were measured on (seeded for reproducibility).
    fn generate_noisy_gate_wav(
        ffmpeg: &Path,
        dir: &Path,
        name: &str,
        noise_amplitude: f64,
        tone_gain: f64,
        gated: bool,
    ) -> PathBuf {
        let path = dir.join(name);
        let tone_filter = if gated {
            format!("volume='if(between(t,1,2)+between(t,4,5),{tone_gain},0)':eval=frame")
        } else {
            format!("volume={tone_gain}")
        };
        let status = Command::new(ffmpeg)
            .args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error"])
            .args([
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "anoisesrc=color=white:amplitude={noise_amplitude}:sample_rate=48000:duration=6:seed=777"
                ),
            ])
            .args([
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency=440:sample_rate=48000:duration=6,{tone_filter}"),
            ])
            .args([
                "-filter_complex",
                "[0:a][1:a]amix=inputs=2:normalize=0:duration=longest,aresample=48000:async=1:first_pts=0,atrim=duration=6",
            ])
            .args(["-c:a", "pcm_s16le"])
            .arg(&path)
            .status()
            .expect("spawn fixture ffmpeg");
        assert!(status.success(), "fixture generation failed for {name}");
        path
    }

    fn six_second_plan(asset_id: &str) -> RenderPlan {
        plan_with_tracks(
            6_000,
            vec![audio_track(
                asset_id,
                false,
                vec![audio_segment(asset_id, 0, 6_000, 0, 6_000, 1.0)],
            )],
        )
    }

    fn assert_db_near(actual: f64, expected: f64, tolerance_db: f64, what: &str) {
        assert!(
            (actual - expected).abs() <= tolerance_db,
            "{what}: expected ~{expected} dB, got {actual} dB"
        );
    }

    /// Frozen evidence 1: A=.06 G=2 — auto threshold −23.86 dB finds the three
    /// gated silences; a fixed −35 dB finds NONE (the user's noisy-room
    /// false-negative case).
    #[test]
    fn adaptive_calibration_loud_room_gated_tone() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let wav = generate_noisy_gate_wav(&ffmpeg, dir.path(), "loud.wav", 0.06, 2.0, true);
        let mut assets = HashMap::new();
        assets.insert("asset-loud".to_string(), wav);

        let auto = analyze(&ffmpeg, &six_second_plan("asset-loud"), &assets, None, 300)
            .expect("analysis succeeds");
        assert_eq!(auto.calibration, "adaptive");
        assert_db_near(auto.threshold_db, -23.858, 0.1, "auto threshold");
        assert_db_near(
            auto.noise_floor_db.expect("noise floor measured"),
            -29.289,
            0.1,
            "noise floor (p20)",
        );
        let expected = [(0u64, 1_000u64), (2_020, 4_000), (5_020, 6_000)];
        assert_eq!(auto.ranges.len(), 3, "auto ranges: {:?}", auto.ranges);
        for (range, (start, end)) in auto.ranges.iter().zip(expected) {
            assert_near(range.start_ms, start, 35, "auto range start");
            assert_near(range.end_ms, end, 35, "auto range end");
        }

        // The same audio under a fixed -35 dB floor reads as fully audible —
        // a fixed threshold fails exactly the case calibration was added for.
        let manual = analyze(
            &ffmpeg,
            &six_second_plan("asset-loud"),
            &assets,
            Some(-35.0),
            300,
        )
        .expect("analysis succeeds");
        assert!(
            manual.ranges.is_empty(),
            "fixed -35 dB must miss the loud-room gaps: {:?}",
            manual.ranges
        );
    }

    /// Frozen evidence 2: A=.006 G=.2 — auto −43.86 dB still finds all three
    /// gaps; fixed −35 dB reports less-conservative bounds.
    #[test]
    fn adaptive_calibration_quiet_room_gated_tone() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let wav = generate_noisy_gate_wav(&ffmpeg, dir.path(), "quiet.wav", 0.006, 0.2, true);
        let mut assets = HashMap::new();
        assets.insert("asset-quiet".to_string(), wav);

        let auto = analyze(&ffmpeg, &six_second_plan("asset-quiet"), &assets, None, 300)
            .expect("analysis succeeds");
        assert_eq!(auto.calibration, "adaptive");
        assert_db_near(auto.threshold_db, -43.858, 0.1, "auto threshold");
        assert_db_near(
            auto.noise_floor_db.expect("noise floor measured"),
            -49.290,
            0.1,
            "noise floor (p20)",
        );
        let expected = [(0u64, 1_000u64), (2_020, 4_000), (5_020, 6_000)];
        assert_eq!(auto.ranges.len(), 3, "auto ranges: {:?}", auto.ranges);
        for (range, (start, end)) in auto.ranges.iter().zip(expected) {
            assert_near(range.start_ms, start, 35, "auto range start");
            assert_near(range.end_ms, end, 35, "auto range end");
        }

        let manual = analyze(
            &ffmpeg,
            &six_second_plan("asset-quiet"),
            &assets,
            Some(-35.0),
            300,
        )
        .expect("analysis succeeds");
        let expected_manual = [(0u64, 1_020u64), (2_000, 4_020), (5_000, 6_000)];
        assert_eq!(
            manual.ranges.len(),
            3,
            "manual -35 ranges: {:?}",
            manual.ranges
        );
        for (range, (start, end)) in manual.ranges.iter().zip(expected_manual) {
            assert_near(range.start_ms, start, 35, "manual range start");
            assert_near(range.end_ms, end, 35, "manual range end");
        }
    }

    /// Frozen evidence 3: continuous noise + tone (no gating) — the auto
    /// threshold sits inside the signal, so NOTHING is proposed for removal.
    #[test]
    fn adaptive_calibration_never_cuts_continuous_sound() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let wav = generate_noisy_gate_wav(&ffmpeg, dir.path(), "steady.wav", 0.06, 2.0, false);
        let mut assets = HashMap::new();
        assets.insert("asset-steady".to_string(), wav);

        let auto = analyze(
            &ffmpeg,
            &six_second_plan("asset-steady"),
            &assets,
            None,
            300,
        )
        .expect("analysis succeeds");
        assert_db_near(auto.threshold_db, -23.788, 0.1, "auto threshold");
        assert!(
            auto.ranges.is_empty(),
            "continuous sound must not be falsely cut: {:?}",
            auto.ranges
        );
    }

    /// Frozen evidence 4: true digital silence — every window pins to the
    /// -120 dB floor, the auto threshold hits the -75 clamp, and the whole
    /// timeline reports as one raw range (editor-core then refuses to delete
    /// the entire timeline with the explicit no-safe-cuts reason).
    #[test]
    fn adaptive_calibration_digital_silence_reports_whole_timeline() {
        let Some(ffmpeg) = real_ffmpeg() else {
            eprintln!("skipping: no ffmpeg with analysis filters");
            return;
        };
        let dir = tempfile::tempdir().expect("fixture dir");
        let wav = generate_noisy_gate_wav(&ffmpeg, dir.path(), "silent.wav", 0.0, 0.0, false);
        let mut assets = HashMap::new();
        assets.insert("asset-silent".to_string(), wav);

        let auto = analyze(
            &ffmpeg,
            &six_second_plan("asset-silent"),
            &assets,
            None,
            300,
        )
        .expect("analysis succeeds");
        assert_db_near(
            auto.threshold_db,
            -75.0,
            0.1,
            "auto threshold clamps to floor",
        );
        assert_db_near(
            auto.noise_floor_db.expect("noise floor measured"),
            -120.0,
            0.1,
            "noise floor (p20)",
        );
        assert_eq!(auto.ranges.len(), 1, "one raw range: {:?}", auto.ranges);
        assert_near(auto.ranges[0].start_ms, 0, 35, "raw range start");
        assert_near(auto.ranges[0].end_ms, 6_000, 35, "raw range end");
    }

    #[test]
    fn calibration_uses_settled_percentile_formula() {
        // 11 levels → p20 = sorted[floor(10*0.2)] = sorted[2],
        // p90 = sorted[floor(10*0.9)] = sorted[9].
        let levels = [
            -50.0, -48.0, -46.0, -44.0, -42.0, -40.0, -30.0, -25.0, -22.0, -20.0, -15.0,
        ];
        // p20=-46, p90=-20 → min(-40, -29) = -40.
        assert_db_near(
            calibrate_threshold(&levels, None).expect("auto threshold"),
            -40.0,
            1e-9,
            "auto threshold",
        );
        // Manual passes through finite values and clamps out-of-range ones.
        assert_db_near(
            calibrate_threshold(&levels, Some(-40.0)).expect("manual"),
            -40.0,
            1e-9,
            "manual passthrough",
        );
        assert_db_near(
            calibrate_threshold(&levels, Some(-200.0)).expect("manual clamp"),
            THRESHOLD_MIN_DB,
            1e-9,
            "manual clamp low",
        );
        assert!(calibrate_threshold(&levels, Some(f64::NAN)).is_err());
        assert!(calibrate_threshold(&levels, Some(f64::INFINITY)).is_err());
        assert!(calibrate_threshold(&[], None).is_err());
        // All-floor measurement: threshold bottoms out at the -75 clamp.
        assert_db_near(
            calibrate_threshold(&[RMS_FLOOR_DB; 300], None).expect("floor clamp"),
            THRESHOLD_MIN_DB,
            1e-9,
            "floor clamp",
        );
    }

    #[test]
    fn silent_range_joining_respects_gaps_and_min_duration() {
        let windows = [
            RmsWindow {
                start_ms: 0,
                end_ms: 20,
                rms_db: -50.0,
            },
            RmsWindow {
                start_ms: 20,
                end_ms: 40,
                rms_db: -50.0,
            },
            // Missing window at [40,60) — a timestamp gap, not silence.
            RmsWindow {
                start_ms: 60,
                end_ms: 80,
                rms_db: -50.0,
            },
            RmsWindow {
                start_ms: 80,
                end_ms: 100,
                rms_db: -10.0,
            },
            RmsWindow {
                start_ms: 100,
                end_ms: 120,
                rms_db: -50.0,
            },
        ];
        let ranges = collect_silent_ranges(&windows, -35.0, 15, 6_000);
        // [0,40), [60,80), and [100,120) are three separate runs — the gap
        // at [40,60) and the audible window at [80,100) must not bridge.
        assert_eq!(
            ranges,
            vec![
                SilenceRange {
                    start_ms: 0,
                    end_ms: 40
                },
                SilenceRange {
                    start_ms: 60,
                    end_ms: 80
                },
                SilenceRange {
                    start_ms: 100,
                    end_ms: 120
                },
            ]
        );
        // A longer minimum duration drops the short run.
        let ranges = collect_silent_ranges(&windows, -35.0, 45, 6_000);
        assert!(ranges.is_empty());
        // Bounds never exceed the timeline.
        let ranges = collect_silent_ranges(&windows, -35.0, 15, 30);
        assert_eq!(
            ranges,
            vec![SilenceRange {
                start_ms: 0,
                end_ms: 30
            }]
        );
    }

    #[test]
    fn metadata_parser_tolerates_partial_tail_and_rejects_bad_input() {
        // A partial final window still emits — end clamps to duration.
        let mut parser = MetadataParser::new();
        for line in [
            "frame:    0 pts:        0 pts_time:0",
            "lavfi.astats.Overall.RMS_level=-34.5",
            "frame:    1 pts:     960 pts_time:0.02",
            "lavfi.astats.Overall.RMS_level=-inf",
            "frame:    2 pts:    1920 pts_time:0.04",
            "lavfi.astats.Overall.RMS_level=+inf",
        ] {
            parser.feed(line, 41);
        }
        assert!(parser.malformed, "+inf must fail the scan");

        let mut parser = MetadataParser::new();
        parser.feed("frame:    0 pts:        0 pts_time:0", 50);
        parser.feed("lavfi.astats.Overall.RMS_level=-34.5", 50);
        parser.feed("frame:    1 pts:     960 pts_time:0.02", 50);
        parser.feed("lavfi.astats.Overall.RMS_level=-inf", 50);
        parser.feed("frame:    2 pts:    1920 pts_time:0.04", 50);
        parser.feed("lavfi.astats.Overall.RMS_level=-20.0", 50);
        assert!(!parser.malformed);
        assert_eq!(parser.windows.len(), 3);
        assert_eq!(parser.windows[0].rms_db, -34.5);
        assert_eq!(parser.windows[1].rms_db, RMS_FLOOR_DB);
        // Partial tail: last window's end clamps to the 50ms duration.
        assert_eq!(parser.windows[2].end_ms, 50);

        let mut parser = MetadataParser::new();
        parser.feed("lavfi.astats.Overall.RMS_level=-30", 1_000);
        assert!(parser.malformed, "RMS without a frame is malformed");

        let mut parser = MetadataParser::new();
        parser.feed("frame:    1 pts:     960 pts_time:0.02", 1_000);
        parser.feed("lavfi.astats.Overall.RMS_level=-30", 1_000);
        parser.feed("frame:    0 pts:        0 pts_time:0", 1_000);
        parser.feed("lavfi.astats.Overall.RMS_level=-30", 1_000);
        assert!(parser.malformed, "non-monotonic timestamps are malformed");

        let mut parser = MetadataParser::new();
        parser.feed("frame:    0 pts:        0 pts_time:0", 1_000);
        parser.feed("lavfi.astats.Overall.RMS_level=NaN", 1_000);
        assert!(parser.malformed, "NaN level is malformed");
    }

    #[test]
    fn metadata_parser_rejects_non_finite_or_garbage_timestamps() {
        for timestamp in ["NaN", "inf", "-inf", "-1", "not-a-timestamp"] {
            let mut parser = MetadataParser::new();
            parser.feed(&format!("frame:0 pts:0 pts_time:{timestamp}"), 1_000);
            parser.feed("lavfi.astats.Overall.RMS_level=-inf", 1_000);
            assert!(parser.malformed, "invalid timestamp accepted: {timestamp}");
            assert!(
                parser.windows.is_empty(),
                "invalid time must not create silence"
            );
        }
    }

    #[test]
    fn metadata_parser_does_not_invent_time_for_unstamped_audio() {
        let mut parser = MetadataParser::new();
        for line in [
            "frame:0 pts:NOPTS pts_time:NOPTS",
            "lavfi.astats.Overall.RMS_level=-inf",
            "frame:1 pts:24000 pts_time:0.5",
            "lavfi.astats.Overall.RMS_level=-inf",
        ] {
            parser.feed(line, 1_000);
        }
        assert!(!parser.malformed);
        assert_eq!(
            parser.windows,
            vec![RmsWindow {
                start_ms: 500,
                end_ms: 520,
                rms_db: RMS_FLOOR_DB,
            }],
            "an unknown clock must not fabricate a cut at the timeline start"
        );
    }

    #[test]
    fn unplaced_frames_are_always_coverage_holes() {
        // The next real timestamp cannot establish where unknown earlier
        // frames belong. Never turn those frames into a guessed leading cut.
        let mut parser = MetadataParser::new();
        for line in [
            "frame:0    pts:NOPTS   pts_time:NOPTS",
            "lavfi.astats.Overall.RMS_level=-inf",
            "frame:1    pts:NOPTS   pts_time:NOPTS",
            "lavfi.astats.Overall.RMS_level=-inf",
            "frame:2    pts:2880    pts_time:0.06",
            "lavfi.astats.Overall.RMS_level=-inf",
        ] {
            parser.feed(line, 6_000);
        }
        assert!(!parser.malformed);
        assert_eq!(
            parser.windows,
            vec![RmsWindow {
                start_ms: 60,
                end_ms: 80,
                rms_db: RMS_FLOOR_DB
            }]
        );

        // Mid-stream NOPTS is unmeasured coverage — no window, and the next
        // timestamp lands as a gap that breaks an open silent run.
        let mut parser = MetadataParser::new();
        for line in [
            "frame:0    pts:0       pts_time:0",
            "lavfi.astats.Overall.RMS_level=-inf",
            "frame:1    pts:NOPTS   pts_time:NOPTS",
            "lavfi.astats.Overall.RMS_level=-inf",
            "frame:2    pts:2880    pts_time:0.06",
            "lavfi.astats.Overall.RMS_level=-inf",
        ] {
            parser.feed(line, 6_000);
        }
        assert!(!parser.malformed);
        let ranges = collect_silent_ranges(&parser.windows, -35.0, 15, 6_000);
        assert_eq!(
            ranges,
            vec![
                SilenceRange {
                    start_ms: 0,
                    end_ms: 20
                },
                SilenceRange {
                    start_ms: 60,
                    end_ms: 80
                },
            ],
            "the NOPTS hole must split the silent run"
        );
    }

    #[test]
    fn metadata_parser_missing_measurements_do_not_bridge_silence() {
        let mut parser = MetadataParser::new();
        for line in [
            "frame:0 pts:0 pts_time:0",
            "lavfi.astats.Overall.RMS_level=-inf",
            "frame:1 pts:960 pts_time:0.02",
            "frame:2 pts:1920 pts_time:0.04",
            "lavfi.astats.Overall.RMS_level=-inf",
        ] {
            parser.feed(line, 100);
        }
        assert!(!parser.malformed);
        assert_eq!(
            collect_silent_ranges(&parser.windows, -35.0, 15, 100),
            vec![
                SilenceRange {
                    start_ms: 0,
                    end_ms: 20
                },
                SilenceRange {
                    start_ms: 40,
                    end_ms: 60
                },
            ]
        );

        parser.feed("frame:3 pts:1920 pts_time:0.04", 100);
        parser.feed("lavfi.astats.Overall.RMS_level=-inf", 100);
        assert!(
            parser.malformed,
            "duplicate coverage must not be counted twice"
        );
    }

    #[test]
    fn metadata_parser_without_any_clock_never_proposes_a_cut() {
        let mut parser = MetadataParser::new();
        parser.feed("frame:0 pts:NOPTS pts_time:NOPTS", 1_000);
        parser.feed("lavfi.astats.Overall.RMS_level=-inf", 1_000);
        assert!(parser.windows.is_empty());
        assert!(collect_silent_ranges(&parser.windows, -35.0, 15, 1_000).is_empty());
    }

    #[test]
    fn cancelled_scan_returns_cancel_error() {
        let registry = Arc::new(SmartCutRegistry::default());
        let job = {
            let registration = registry.begin("rec-cancel", "scan-x").expect("register");
            let job = Arc::clone(registration.job());
            registry.cancel("rec-cancel", "scan-x");
            job
        };
        let gate = Arc::new(CaptureWorkGate::default());
        let plan = six_second_plan("asset-x");
        let assets = HashMap::new();
        let result = analyze_timeline_silences(
            Path::new("unused-ffmpeg"),
            None,
            &plan,
            &assets,
            None,
            300,
            &gate,
            &job,
        );
        let error = result.expect_err("cancelled scan errors");
        assert_eq!(error.code, "smart_cut_cancelled");
    }
}
