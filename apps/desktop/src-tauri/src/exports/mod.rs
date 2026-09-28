use crate::database::library::get_recording;
use crate::database::media::MediaJob;
use crate::errors::{InternalError, Result};
use crate::events::EventPublisher;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::Manager;
use tracing::{info, instrument, warn};

use tiny_skia::{
    Color, FillRule, Paint, Path as SkiaPath, PathBuilder, Pixmap, PixmapPaint, Rect, Transform,
};

mod annotations;
mod camera;
mod captions;
mod cursor;
mod encoding;

pub(crate) use camera::build_zoompan_expressions;
// Re-exported for tests and sibling modules that validate against the shared
// camera geometry helpers.
#[allow(unused_imports)]
pub(crate) use camera::{
    clamped_zoom_crop, clamped_zoom_target, effective_zoom_scale, zoom_easing_expression,
};

pub use annotations::{RenderPlanAnnotation, RenderPlanImage, RenderPlanText};

/// Auto-cleanup guard for temporary mask PNG files and filter complex scripts generated during timeline compositing.
struct TempMaskFile(PathBuf);

impl Drop for TempMaskFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Removes a whole temp directory (caption script + embedded font) on drop.
struct TempExportDir(PathBuf);

impl Drop for TempExportDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Temp artifacts an export leaves behind when the process dies mid-job.
const STALE_EXPORT_TEMP_PREFIXES: [&str; 9] = [
    "recordforge_chunks_",
    "recordforge_bg_",
    "recordforge_cam_shadow_",
    "rf-filter-complex-",
    "rf-mask-",
    "rf-border-cam-",
    "rf-chapters-",
    "rf-captions-",
    "rf-encoder-probe-",
];

/// Remove stale export temp artifacts that are direct children of `root`
/// (the OS temp dir) and older than `max_age`. Prefix-matched so unrelated
/// temp files survive; per-entry failures are ignored.
pub(crate) fn sweep_stale_temp_files(root: &Path, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let cutoff = SystemTime::now().checked_sub(max_age);
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !STALE_EXPORT_TEMP_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let is_stale = cutoff.is_none_or(|cutoff| {
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|modified| modified < cutoff)
        });
        if !is_stale {
            continue;
        }
        let path = entry.path();
        let removed_entry = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if removed_entry {
            removed += 1;
        }
    }
    removed
}

/// What one composition run actually emitted — returned to the caller so
/// output validation checks the rendered result instead of re-deriving the
/// expectation from the plan.
#[derive(Debug)]
pub(crate) struct RenderOutcome {
    /// `[aout]` was emitted (single/standalone pass) or the dedicated audio
    /// job ran (chunked export).
    pub has_audio: bool,
}

type MediaProber =
    Box<dyn Fn(&Path, &str) -> Result<crate::database::media::MediaMetadata> + Send + Sync>;

/// FFprobe metadata memoized across the passes of one export. A `None` prober
/// disables probing entirely — callers then behave exactly like the legacy
/// `ffprobe_path: None` path (no probe, specifier guesses only).
pub(crate) struct ProbeCache {
    prober: Option<MediaProber>,
    entries: Mutex<HashMap<PathBuf, Arc<crate::database::media::MediaMetadata>>>,
}

impl ProbeCache {
    fn new(ffprobe_path: Option<&Path>) -> Self {
        let prober = ffprobe_path.map(|path| {
            let path = path.to_string_lossy().to_string();
            Box::new(move |input: &Path, asset_id: &str| {
                crate::media::probe::probe_media(&path, input, asset_id)
            }) as MediaProber
        });
        Self {
            prober,
            entries: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn with_prober(
        prober: impl Fn(&Path, &str) -> Result<crate::database::media::MediaMetadata>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            prober: Some(Box::new(prober)),
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Probe `path` once per export, memoized under the path. `None` when
    /// probing is disabled.
    fn metadata(
        &self,
        path: &Path,
        asset_id: &str,
    ) -> Option<Result<Arc<crate::database::media::MediaMetadata>>> {
        let prober = self.prober.as_ref()?;
        // The lock is held across the probe call so parallel chunk passes
        // probe each path exactly once.
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(hit) = entries.get(path) {
            return Some(Ok(Arc::clone(hit)));
        }
        let metadata = match prober(path, asset_id) {
            Ok(metadata) => Arc::new(metadata),
            Err(error) => return Some(Err(error)),
        };
        entries.insert(path.to_path_buf(), Arc::clone(&metadata));
        Some(Ok(metadata))
    }

    /// `video stream start − earliest stream start`, in seconds: the offset a
    /// B-frame-delayed video stream carries into `STARTPTS` re-anchoring. 0
    /// when unknown or probing is disabled.
    fn video_start_delay_s(&self, path: &Path, asset_id: &str) -> f64 {
        let Some(Ok(metadata)) = self.metadata(path, asset_id) else {
            return 0.0;
        };
        let first_start = metadata
            .streams
            .iter()
            .filter_map(|stream| stream.start_ms)
            .min()
            .unwrap_or(0);
        metadata
            .streams
            .iter()
            .filter(|stream| stream.kind == "video")
            .filter_map(|stream| stream.start_ms)
            .min()
            .map(|start| start.saturating_sub(first_start) as f64 / 1000.0)
            .unwrap_or(0.0)
    }
}

/// Generated image inputs (canvas plates, camera masks/borders/shadows)
/// memoized across the passes of one export. Cache-owned temp files are
/// guarded until the cache drops so every chunk pass sees the same path.
pub(crate) struct PlateCache {
    entries: Mutex<HashMap<String, Option<PathBuf>>>,
    guards: Mutex<Vec<TempMaskFile>>,
}

impl PlateCache {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            guards: Mutex::new(Vec::new()),
        }
    }

    /// Return the plate for `key`, generating it once per export. `create`
    /// yields the path plus whether it is a cache-owned temp file (owned
    /// files are deleted when the export ends). `None` — "no plate" — is
    /// memoized too.
    fn get_or_create(
        &self,
        key: &str,
        create: impl FnOnce() -> Result<Option<(PathBuf, bool)>>,
    ) -> Result<Option<PathBuf>> {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = entries.get(key) {
            return Ok(entry.clone());
        }
        let created = create()?;
        if let Some((path, true)) = &created {
            self.guards
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(TempMaskFile(path.clone()));
        }
        let path = created.map(|(path, _)| path);
        entries.insert(key.to_string(), path.clone());
        Ok(path)
    }
}

/// Per-export state shared by every composition pass: one probe memoization
/// and one generated-plate memoization, so chunk passes stop redoing the same
/// ffprobe/raster work and a hardware→software retry reuses both.
pub(crate) struct CompositionShared {
    probe: ProbeCache,
    plates: PlateCache,
}

impl CompositionShared {
    pub(crate) fn new(ffprobe_path: Option<&Path>) -> Self {
        Self {
            probe: ProbeCache::new(ffprobe_path),
            plates: PlateCache::new(),
        }
    }
}

/// A single trimmed segment in the final export.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderSegment {
    pub asset_id: String,
    pub stream_index: Option<i32>,
    pub volume: Option<f64>,
    pub fade_in_ms: Option<f64>,
    pub fade_out_ms: Option<f64>,
    #[serde(default)]
    pub volume_keyframes: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub audio_filter: Option<String>,
    pub speed: f64,
    pub source_in_ms: u64,
    pub source_out_ms: u64,
    pub output_start_ms: u64,
    pub output_end_ms: u64,
    pub source_width: Option<u32>,
    pub source_height: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanGap {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// A single chapter span in the final export.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanChapter {
    pub id: String,
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Render plan sent from the TypeScript timeline editor.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlan {
    pub project_id: String,
    pub duration_ms: u64,
    pub segments: Vec<RenderSegment>,
    #[serde(default)]
    pub gaps: Vec<RenderPlanGap>,
    #[serde(default)]
    pub overlays: Vec<RenderPlanOverlay>,
    #[serde(default)]
    pub captions: Vec<RenderPlanCaption>,
    #[serde(default = "default_caption_mode")]
    pub caption_mode: String,
    #[serde(default)]
    pub chapters: Vec<RenderPlanChapter>,
    #[serde(default = "default_chapter_mode")]
    pub chapter_mode: String,
    #[serde(default)]
    pub masks: Vec<RenderPlanMask>,
    #[serde(default)]
    pub zoom_segments: Vec<RenderPlanZoomSegment>,
    #[serde(default)]
    pub cursor_effects: Vec<RenderPlanCursorEffect>,
    #[serde(default)]
    pub overlay_render_plan: Option<serde_json::Value>,
    #[serde(default)]
    pub canvas: Option<cursor::RenderCanvas>,
    #[serde(default)]
    pub audio: Option<RenderPlanAudio>,
    // `Some(empty)` means the current editor intentionally has no audio tracks.
    #[serde(default)]
    pub audio_tracks: Option<Vec<RenderPlanAudio>>,
    #[serde(default)]
    pub annotations: Vec<RenderPlanAnnotation>,
    #[serde(default)]
    pub texts: Vec<RenderPlanText>,
    #[serde(default)]
    pub images: Vec<RenderPlanImage>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanCaption {
    pub id: String,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default = "default_caption_style")]
    pub style: String,
    #[serde(default = "default_caption_placement")]
    pub placement: String,
    #[serde(default = "default_caption_margin")]
    pub safe_area_margin: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanMask {
    pub id: String,
    pub asset_id: Option<String>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub mode: String,
    pub rect: RenderCropFloat,
    #[serde(default = "default_mask_blur_radius")]
    pub blur_radius: f64,
    #[serde(default = "default_mask_pixel_size")]
    pub pixel_size: u64,
    #[serde(default = "default_mask_color")]
    pub redact_color: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanOverlay {
    pub asset_id: String,
    pub stream_index: Option<i32>,
    pub source_in_ms: u64,
    pub source_out_ms: u64,
    pub output_start_ms: u64,
    pub output_end_ms: u64,
    #[serde(default = "default_overlay_speed")]
    pub speed: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub crop: Option<RenderCrop>,
    #[serde(default = "default_overlay_opacity")]
    pub opacity: f64,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default = "default_overlay_shape")]
    pub shape: String,
    pub border_width: Option<f64>,
    pub border_color: Option<String>,
    pub border_opacity: Option<f64>,
    pub shadow_enabled: Option<bool>,
    pub shadow_color: Option<String>,
    pub shadow_blur: Option<f64>,
    pub shadow_offset_x: Option<f64>,
    pub shadow_offset_y: Option<f64>,
    pub preset: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderCrop {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanZoomKeyframe {
    pub time_ms: u64,
    pub target: RenderCropFloat,
}

pub use cursor_engine::{
    CubicBezierMotionPlan as RenderPlanZoomMotionPlan,
    CubicBezierMotionPoint as RenderPlanZoomMotionPoint,
    CubicBezierMotionSegment as RenderPlanZoomMotionSegment,
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanZoomSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub target: RenderCropFloat,
    #[serde(default = "default_zoom_scale")]
    pub scale: f64,
    #[serde(default = "default_zoom_easing")]
    pub easing: String,
    #[serde(default = "default_transition_ms")]
    pub transition_in_ms: u64,
    #[serde(default = "default_transition_ms")]
    pub transition_out_ms: u64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_zoom_mode")]
    pub mode: String,
    #[serde(default = "default_zoom_source")]
    pub source: String,
    #[serde(default = "default_zoom_preset")]
    pub preset: String,
    #[serde(default)]
    pub follow_deadzone_percent: Option<f64>,
    #[serde(default)]
    pub follow_smoothing_alpha: Option<f64>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub from_target: Option<RenderCropFloat>,
    #[serde(default)]
    pub from_scale: Option<f64>,
    #[serde(default)]
    pub keyframes: Option<Vec<RenderPlanZoomKeyframe>>,
    #[serde(default)]
    pub motion_plan: Option<RenderPlanZoomMotionPlan>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderCropFloat {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn default_caption_mode() -> String {
    "burn-in".into()
}

fn default_caption_style() -> String {
    "default".into()
}

fn default_caption_placement() -> String {
    "bottom".into()
}

fn default_caption_margin() -> u64 {
    48
}

fn default_mask_blur_radius() -> f64 {
    24.0
}

fn default_mask_pixel_size() -> u64 {
    12
}

fn default_mask_color() -> String {
    "black".into()
}

fn default_overlay_opacity() -> f64 {
    1.0
}

fn default_overlay_speed() -> f64 {
    1.0
}

fn default_true() -> bool {
    true
}

fn default_overlay_shape() -> String {
    "rectangle".into()
}

fn default_transition_ms() -> u64 {
    400
}

fn default_zoom_scale() -> f64 {
    1.5
}

fn default_zoom_easing() -> String {
    "smooth".into()
}

fn default_zoom_mode() -> String {
    "follow-cursor".into()
}

fn default_zoom_source() -> String {
    "manual".into()
}

fn default_zoom_preset() -> String {
    "product-demo".into()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanAudio {
    pub asset_id: String,
    pub stream_index: Option<i32>,
    pub role: Option<String>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default = "default_audio_volume")]
    pub volume: f64,
    #[serde(default)]
    pub segments: Vec<RenderSegment>,
}

fn default_audio_volume() -> f64 {
    1.0
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSettings {
    #[serde(default = "default_export_preset")]
    pub preset: String,
    #[serde(default = "default_export_codec")]
    pub codec: String,
    #[serde(default = "default_export_encoder")]
    pub encoder: String,
    #[serde(default = "default_export_container")]
    pub container: String,
    #[serde(default = "default_caption_mode")]
    pub caption_mode: String,
    #[serde(default = "default_chapter_mode")]
    pub chapter_mode: String,
    #[serde(default)]
    pub range: Option<ExportRange>,
}

fn default_export_preset() -> String {
    "default-mp4".into()
}

fn default_export_codec() -> String {
    "h264".into()
}

fn default_export_encoder() -> String {
    "auto".into()
}

fn default_export_container() -> String {
    "mp4".into()
}

fn default_chapter_mode() -> String {
    "embed".into()
}

pub fn escape_ffmetadata_value(val: &str) -> String {
    let mut escaped = String::with_capacity(val.len());
    for ch in val.chars() {
        match ch {
            '=' | ';' | '#' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            '\n' => {
                escaped.push_str("\\\n");
            }
            '\r' => {}
            _ => escaped.push(ch),
        }
    }
    escaped
}

pub fn generate_ffmetadata(project_name: &str, chapters: &[RenderPlanChapter]) -> String {
    let mut meta = String::from(";FFMETADATA1\n");
    if !project_name.trim().is_empty() {
        meta.push_str(&format!(
            "title={}\n",
            escape_ffmetadata_value(project_name)
        ));
    }
    for chapter in chapters {
        if chapter.end_ms <= chapter.start_ms {
            continue;
        }
        meta.push_str("\n[CHAPTER]\n");
        meta.push_str("TIMEBASE=1/1000\n");
        meta.push_str(&format!("START={}\n", chapter.start_ms));
        meta.push_str(&format!("END={}\n", chapter.end_ms));
        meta.push_str(&format!(
            "title={}\n",
            escape_ffmetadata_value(&chapter.title)
        ));
    }
    meta
}

pub fn generate_youtube_chapters(chapters: &[RenderPlanChapter]) -> String {
    let max_time = chapters.iter().map(|c| c.end_ms).max().unwrap_or(0);
    let force_hours = max_time >= 3_600_000;
    let mut lines = Vec::with_capacity(chapters.len());
    for chapter in chapters {
        let total_seconds = chapter.start_ms / 1000;
        let hours = total_seconds / 3600;
        let minutes = (total_seconds % 3600) / 60;
        let seconds = total_seconds % 60;
        let stamp = if hours > 0 || force_hours {
            format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
        } else {
            format!("{:02}:{:02}", minutes, seconds)
        };
        let sanitized_title = chapter.title.replace(['\r', '\n'], " ");
        lines.push(format!("{} {}", stamp, sanitized_title.trim()));
    }
    lines.join("\n")
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RenderPlanCursorEffect {
    pub id: String,
    pub asset_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub enabled: bool,
    pub preset_id: String,
    pub scale: f64,
    pub smoothing: String,
    pub settings: serde_json::Value,
}

/// Render one persisted project request into a validated, atomically published file.
#[allow(clippy::too_many_arguments)]
#[instrument(skip(
    ffmpeg_path,
    ffprobe_path,
    db,
    plan,
    app,
    cancel,
    output_path,
    settings,
    available_encoders
))]
pub fn run_render_plan(
    job_id: &str,
    project_id: &str,
    output_path: &Path,
    plan: RenderPlan,
    settings: ExportSettings,
    ffmpeg_path: &Path,
    ffprobe_path: &Path,
    db: Arc<Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    available_encoders: &[String],
) -> Result<()> {
    plan.validate()?;
    if plan.project_id != project_id {
        return Err(
            InternalError::Project("render plan project does not match the job".into()).into(),
        );
    }
    validate_export_settings(&settings, &plan)?;
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(InternalError::Media("export cancelled".into()).into());
    }

    let work_dir = {
        let conn = db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let project = crate::database::projects::get_project(&conn, project_id)?
            .ok_or_else(|| InternalError::Project("export project was not found".into()))?;
        let recording = get_recording(&conn, &project.recording_id)?;
        PathBuf::from(recording.work_dir)
    };
    let policy = crate::path_policy::PathPolicy::new(work_dir.clone(), work_dir.clone());
    let loaded = crate::projects::load_project(&work_dir, &policy)?
        .ok_or_else(|| InternalError::Project("project file is required for export".into()))?;
    if loaded.project.id != project_id {
        return Err(InternalError::Project(
            "project identity does not match the export request".into(),
        )
        .into());
    }
    let asset_paths = crate::projects::load_asset_path_map(&work_dir)?;
    let managed_paths = managed_export_paths(output_path, &plan);
    if asset_paths.values().any(|asset_path| {
        managed_paths
            .iter()
            .any(|managed_path| paths_refer_to_same_file(asset_path, managed_path))
    }) {
        return Err(InternalError::Permissions(
            "export files cannot overwrite a project asset".into(),
        )
        .into());
    }
    let partial_path = partial_output_path(output_path);
    cleanup_export_files(output_path);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| InternalError::Storage(format!("create export directory: {error}")))?;
    }
    ensure_export_disk_space(output_path, &plan, &settings)?;

    update_progress(
        &db,
        app,
        job_id,
        0.02,
        "resolving-assets",
        Some("resolving project assets"),
    )?;
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        cleanup_export_files(output_path);
        return Err(InternalError::Media("export cancelled".into()).into());
    }

    // The startup probe covers h264 hardware encoders only (shared with the
    // capture path), so hevc exports verify the vendor's hevc variant with a
    // one-second test encode before committing the job to it.
    let ffmpeg = ffmpeg_path.to_string_lossy().to_string();
    let encoder = encoding::resolve_export_encoder(
        &settings.encoder,
        &settings.codec,
        available_encoders,
        |candidate| crate::capture::encoder::probe_encoder(&ffmpeg, candidate.hevc_id()),
    );
    info!(
        project_id = %project_id,
        encoder = encoder.display_name(),
        "selected export encoder"
    );

    // Composition is the primary export workload (0.05..0.96 of the job); FFmpeg reports elapsed time.
    let progress_reporter = {
        let db = Arc::clone(&db);
        let app_handle = app.clone();
        let job = job_id.to_string();
        let last_emit = Arc::new(Mutex::new(None::<std::time::Instant>));
        move |ratio: f64| {
            let mut last = last_emit
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if last.is_some_and(|value| value.elapsed() < Duration::from_millis(250)) {
                return;
            }
            *last = Some(std::time::Instant::now());
            drop(last);
            let progress = 0.05 + ratio.clamp(0.0, 1.0) * 0.91;
            let _ = update_progress(&db, &app_handle, &job, progress, "rendering", None);
        }
    };

    update_progress(
        &db,
        app,
        job_id,
        0.05,
        "rendering",
        Some("compositing timeline tracks"),
    )?;
    let resource_dir = app.path().resource_dir().ok();
    // One probe/plate cache serves both the primary render and the software
    // retry so the fallback does not re-run the same ffprobe/plate work.
    let shared = CompositionShared::new(Some(ffprobe_path));
    let composition = render_timeline_composition_shared(
        &ffmpeg,
        &partial_path,
        &plan,
        project_id,
        &asset_paths,
        &settings,
        encoder,
        cancel.clone(),
        &progress_reporter,
        resource_dir.as_deref(),
        &shared,
    );
    // A hardware encoder can fail to initialize even after a passing probe
    // (driver capabilities differ by resolution and pixel format), so retry
    // once on software instead of failing the export outright. Cancelled jobs
    // propagate unchanged.
    let outcome = match composition {
        Ok(outcome) => outcome,
        Err(error) => {
            if cancel.load(std::sync::atomic::Ordering::Relaxed)
                || encoder == encoding::ExportEncoder::Software
            {
                cleanup_export_files(output_path);
                return Err(error);
            }
            warn!(
                project_id = %project_id,
                encoder = encoder.display_name(),
                error = %error,
                "hardware export encoder failed; retrying with software"
            );
            let retry_detail = format!(
                "Hardware encoder ({}) failed: {}; retrying with software",
                encoder.display_name(),
                error
            );
            update_progress(&db, app, job_id, 0.05, "rendering", Some(&retry_detail))?;
            render_timeline_composition_shared(
                &ffmpeg,
                &partial_path,
                &plan,
                project_id,
                &asset_paths,
                &settings,
                encoding::ExportEncoder::Software,
                cancel.clone(),
                &progress_reporter,
                resource_dir.as_deref(),
                &shared,
            )?
        }
    };

    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        cleanup_export_files(output_path);
        return Err(InternalError::Media("export cancelled".into()).into());
    }

    if plan.caption_mode == "sidecar" {
        update_progress(
            &db,
            app,
            job_id,
            0.97,
            "captions",
            Some("writing caption sidecar"),
        )?;
        write_caption_sidecar(&partial_path, &plan.captions)?;
    }

    if (plan.chapter_mode == "sidecar" || plan.chapter_mode == "both") && !plan.chapters.is_empty()
    {
        update_progress(
            &db,
            app,
            job_id,
            0.98,
            "chapters",
            Some("writing chapter sidecar"),
        )?;
        let sidecar_content = generate_youtube_chapters(&plan.chapters);
        let sidecar_path = partial_path.with_extension("chapters.txt");
        std::fs::write(&sidecar_path, sidecar_content.as_bytes())
            .map_err(|err| InternalError::Storage(format!("write chapter sidecar: {err}")))?;
    }

    update_progress(
        &db,
        app,
        job_id,
        0.99,
        "validating",
        Some("validating rendered media"),
    )?;
    validate_export_output(
        ffprobe_path,
        &partial_path,
        &plan,
        &settings,
        outcome.has_audio,
    )?;
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        cleanup_export_files(output_path);
        return Err(InternalError::Media("export cancelled".into()).into());
    }

    crate::capture::disk::atomic_replace(&partial_path, output_path)?;
    if plan.caption_mode == "sidecar" {
        let partial_sidecar = partial_path.with_extension("srt");
        let final_sidecar = output_path.with_extension("srt");
        if let Err(error) = crate::capture::disk::atomic_replace(&partial_sidecar, &final_sidecar) {
            let _ = std::fs::remove_file(output_path);
            let _ = std::fs::remove_file(&final_sidecar);
            return Err(error);
        }
    }
    if (plan.chapter_mode == "sidecar" || plan.chapter_mode == "both") && !plan.chapters.is_empty()
    {
        let partial_sidecar = partial_path.with_extension("chapters.txt");
        let final_sidecar = output_path.with_extension("chapters.txt");
        if let Err(error) = crate::capture::disk::atomic_replace(&partial_sidecar, &final_sidecar) {
            let _ = std::fs::remove_file(output_path);
            let _ = std::fs::remove_file(&final_sidecar);
            return Err(error);
        }
    }
    info!(project_id = %project_id, "timeline export rendered");
    Ok(())
}

// ---------------------------------------------------------------------------
// Dev-only spec harness used by `src/bin/export_harness.rs` (built with
// `--features export-harness`) to drive the real composition entry points
// with a JSON spec — the same serde types `export_timeline` receives — so
// export behavior can be reproduced end-to-end on a dev box without the
// Tauri UI. Not compiled into the app.
// ---------------------------------------------------------------------------

#[cfg(feature = "export-harness")]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportHarnessSpec {
    pub plan: RenderPlan,
    pub settings: ExportSettings,
    pub asset_paths: HashMap<String, PathBuf>,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub output_path: String,
    #[serde(default)]
    pub force_single_pass: bool,
}

/// Render a JSON `ExportHarnessSpec` through the real export path.
/// Returns 0 on success, 2 on spec parse failure, 1 on render or output
/// validation failure.
#[cfg(feature = "export-harness")]
pub fn run_export_harness_spec(spec_json: &[u8]) -> i32 {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .try_init();

    let spec: ExportHarnessSpec = match serde_json::from_slice(spec_json) {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("export_harness: spec parse failed: {error}");
            return 2;
        }
    };

    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let on_progress = |ratio: f64| {
        eprintln!("[progress] {:.1}%", ratio.clamp(0.0, 1.0) * 100.0);
    };
    let shared = CompositionShared::new(Some(Path::new(&spec.ffprobe_path)));
    let result = if spec.force_single_pass {
        render_composition_window(
            &spec.ffmpeg_path,
            Path::new(&spec.output_path),
            &spec.plan,
            "export-harness",
            &spec.asset_paths,
            &spec.settings,
            encoding::ExportEncoder::Software,
            cancel,
            None,
            &on_progress,
            None,
            &shared,
            &CompositionWindow::full(&spec.plan),
            &CompositionPass::standalone(),
        )
    } else {
        render_timeline_composition_shared(
            &spec.ffmpeg_path,
            Path::new(&spec.output_path),
            &spec.plan,
            "export-harness",
            &spec.asset_paths,
            &spec.settings,
            encoding::ExportEncoder::Software,
            cancel,
            &on_progress,
            None,
            &shared,
        )
    };

    let outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => {
            eprintln!("export_harness: render failed: {error}");
            return 1;
        }
    };
    if let Err(error) = validate_export_output(
        Path::new(&spec.ffprobe_path),
        Path::new(&spec.output_path),
        &spec.plan,
        &spec.settings,
        outcome.has_audio,
    ) {
        eprintln!("export_harness: output validation failed: {error}");
        return 1;
    }
    0
}

/// Returns a source size shared by every screen segment, or `None` when the
/// segments are missing dimensions or have mixed source sizes.
fn common_screen_source(
    segments: &[RenderSegment],
    asset_paths: &HashMap<String, PathBuf>,
    probe: &ProbeCache,
) -> Option<(u32, u32)> {
    let mut common: Option<(u32, u32)> = None;
    for segment in segments {
        let dimensions = if let (Some(w), Some(h)) = (segment.source_width, segment.source_height) {
            Some((w, h))
        } else if let Some(path) = asset_paths.get(&segment.asset_id) {
            match probe.metadata(path, &segment.asset_id) {
                Some(Ok(metadata)) => match (metadata.width, metadata.height) {
                    (Some(w), Some(h)) => Some((w as u32, h as u32)),
                    _ => None,
                },
                _ => None,
            }
        } else {
            None
        };

        let (width, height) = dimensions?;
        match common {
            None => common = Some((width, height)),
            Some((w, h)) if w == width && h == height => {}
            _ => return None,
        }
    }
    common
}

/// True when a camera overlay uses the side-by-side layout — either the
/// explicit preset or legacy coordinates that land on the generated slot.
/// `visible` overlays only: a hidden clip never drives the layout.
fn overlay_is_side_by_side(overlay: &RenderPlanOverlay, canvas: &cursor::RenderCanvas) -> bool {
    if !overlay.visible {
        return false;
    }
    if overlay.preset.as_deref() == Some("side-by-side") {
        return true;
    }
    let usable_w = (canvas.width as f64 - (canvas.padding as f64) * 2.0).max(1.0);
    let target_camera_x =
        (canvas.padding as f64) + (usable_w * 0.76).round() + (usable_w * 0.02).round();
    let legacy_camera_x =
        (canvas.padding as f64) + (usable_w * 0.68).round() + (usable_w * 0.02).round();
    (overlay.x - target_camera_x).abs() <= 3.0 || (overlay.x - legacy_camera_x).abs() <= 3.0
}

/// Merge `[start_ms, end_ms)` windows, sorted by start. Unlike
/// `plate_enable_expr` this never collapses dense windows into one wide span —
/// layout switching must follow the exact overlay edges, not a widened union.
fn merge_ms_windows(windows: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    let mut windows: Vec<(u64, u64)> = windows
        .into_iter()
        .filter(|(start, end)| end > start)
        .collect();
    windows.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(windows.len());
    for (start, end) in windows {
        match merged.last_mut() {
            Some((_, prev_end)) if start <= *prev_end => *prev_end = (*prev_end).max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

fn video_screen_rect(
    canvas: &cursor::RenderCanvas,
    source: Option<(u32, u32)>,
    is_side_by_side: bool,
) -> (f64, f64, f64, f64) {
    let padding = canvas.padding as f64;
    let content_width = (canvas.width as f64 - padding * 2.0).max(1.0);
    let content_height = (canvas.height as f64 - padding * 2.0).max(1.0);
    let position_y = if canvas.aspect_ratio.as_deref() == Some("16:9") {
        0.5
    } else {
        canvas.video_position_y.unwrap_or(0.5).clamp(0.0, 1.0)
    };
    if is_side_by_side {
        let target_w = ((content_width * 0.76).round() as u32 / 2 * 2).max(2) as f64;
        let target_h =
            (((target_w / canvas.width as f64) * canvas.height as f64).round() as u32 / 2 * 2)
                .max(2) as f64;
        let (source_w, source_h) = match source {
            Some((w, h)) => (w as f64, h as f64),
            None => (target_w, target_h),
        };
        let fit_scale = (target_w / source_w).min(target_h / source_h);
        // Video dimensions and coordinates must be even integers for YUV420 chroma alignment
        // and hardware encoder macroblock requirements.
        let fit_width = ((source_w * fit_scale).round() as u32 / 2 * 2).max(2) as f64;
        let fit_height = ((source_h * fit_scale).round() as u32 / 2 * 2).max(2) as f64;
        let x = (((padding + (target_w - fit_width) / 2.0).round() as u32 / 2 * 2) as f64)
            .min(canvas.width as f64);
        let y =
            (((padding + (content_height - target_h) / 2.0 + (target_h - fit_height) * position_y)
                .round() as u32
                / 2
                * 2) as f64)
                .min(canvas.height as f64);
        (x, y, fit_width, fit_height)
    } else {
        let (source_w, source_h) = match source {
            Some((w, h)) => (w as f64, h as f64),
            None => (content_width, content_height),
        };
        let fit_scale = (content_width / source_w).min(content_height / source_h);
        // Video dimensions and coordinates must be even integers for YUV420 chroma alignment
        // and hardware encoder macroblock requirements.
        let fit_width = ((source_w * fit_scale).round() as u32 / 2 * 2).max(2) as f64;
        let fit_height = ((source_h * fit_scale).round() as u32 / 2 * 2).max(2) as f64;
        let x = (((padding + (content_width - fit_width) / 2.0).round() as u32 / 2 * 2) as f64)
            .min(canvas.width as f64);
        let y = (((padding + (content_height - fit_height) * position_y).round() as u32 / 2 * 2)
            as f64)
            .min(canvas.height as f64);
        (x, y, fit_width, fit_height)
    }
}

/// Compose screen, manual zoom, camera overlays, canvas framing, cursor
/// telemetry, overlay items, and semantic audio tracks in one FFmpeg graph.
/// The generated layers are rendered frame by frame in Rust and streamed over
/// stdin as a rawvideo input — packed side by side when cursor and overlay
/// items coexist so the graph can composite each at its own stack position —
/// keeping the whole export a single encode. Keeping the graph here makes the
/// export path authoritative for every control exposed by the editor.
// Tests drive this entry point directly; production callers hold a
// `CompositionShared` and use `render_timeline_composition_shared`.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn render_timeline_composition(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    encoder: encoding::ExportEncoder,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    on_progress: &(dyn Fn(f64) + Sync),
    resource_dir: Option<&Path>,
    ffprobe_path: Option<&Path>,
) -> Result<RenderOutcome> {
    let shared = CompositionShared::new(ffprobe_path);
    render_timeline_composition_shared(
        ffmpeg_path,
        output_path,
        plan,
        project_id,
        asset_paths,
        settings,
        encoder,
        cancel,
        on_progress,
        resource_dir,
        &shared,
    )
}

/// `render_timeline_composition` with caller-owned per-export state so all
/// passes of one export (chunks, hardware→software retry) share probe results
/// and generated plates.
#[allow(clippy::too_many_arguments)]
fn render_timeline_composition_shared(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    encoder: encoding::ExportEncoder,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    on_progress: &(dyn Fn(f64) + Sync),
    resource_dir: Option<&Path>,
    shared: &CompositionShared,
) -> Result<RenderOutcome> {
    if should_render_chunked(plan, settings) && chunk_temp_space_ok(plan, settings) {
        return render_timeline_chunked(
            ffmpeg_path,
            output_path,
            plan,
            project_id,
            asset_paths,
            settings,
            encoder,
            cancel,
            on_progress,
            resource_dir,
            shared,
        );
    }
    render_composition_window(
        ffmpeg_path,
        output_path,
        plan,
        project_id,
        asset_paths,
        settings,
        encoder,
        cancel,
        None,
        on_progress,
        resource_dir,
        shared,
        &CompositionWindow::full(plan),
        &CompositionPass::standalone(),
    )
}

/// Output-time window one composition pass renders, in absolute timeline
/// coordinates. A full render uses `CompositionWindow::full` — `start_s` = 0
/// keeps every generated filter identical to an unchunked export. Chunked
/// passes shift the composed stream by `start_s`, so `between(t,…)`, zoompan
/// `it`, timed camera `setpts` offsets and libass cue times all evaluate in
/// absolute timeline seconds.
struct CompositionWindow {
    /// Absolute index of the first frame this pass emits (0 for a full pass).
    first_frame: u64,
    /// Number of CFR frames this pass emits.
    frame_count: u64,
    /// Absolute output time of `first_frame`, seconds.
    start_s: f64,
    /// Absolute output time of `first_frame + frame_count`, seconds.
    end_s: f64,
    /// Stream length for `-t` and progress reporting, ms.
    duration_ms: u64,
}

impl CompositionWindow {
    fn full(plan: &RenderPlan) -> Self {
        let fps = plan
            .canvas
            .as_ref()
            .map(|canvas| canvas.fps)
            .unwrap_or(1)
            .max(1) as u64;
        let frame_count = plan
            .duration_ms
            .saturating_mul(fps)
            .saturating_add(999)
            .checked_div(1000)
            .unwrap_or(1)
            .max(1);
        Self {
            first_frame: 0,
            frame_count,
            start_s: 0.0,
            end_s: plan.duration_ms as f64 / 1000.0,
            duration_ms: plan.duration_ms,
        }
    }

    fn from_frames(first_frame: u64, frame_count: u64, fps: u64) -> Self {
        let start_s = first_frame as f64 / fps as f64;
        let end_s = (first_frame + frame_count) as f64 / fps as f64;
        Self {
            first_frame,
            frame_count,
            start_s,
            end_s,
            duration_ms: ((end_s - start_s) * 1000.0).round() as u64,
        }
    }

    fn start_ms(&self) -> f64 {
        self.start_s * 1000.0
    }

    fn end_ms(&self) -> f64 {
        self.end_s * 1000.0
    }
}

/// Per-pass switches for `render_composition_window`. `standalone` emits a
/// finished deliverable (chapter mapping + faststart); chunk passes write
/// intermediate slices and let the mux stage own both. `include_audio`
/// controls the audio graph — chunk passes stay video-only because the mux
/// splices in one continuous audio render, which also avoids per-chunk AAC
/// priming at the seams.
struct CompositionPass {
    standalone: bool,
    include_audio: bool,
    /// Share of the machine the overlay producer may use (see CursorFramePlan).
    plate_divisor: usize,
    /// Filter-graph/encoder thread cap; 0 leaves FFmpeg's default (standalone
    /// passes). Chunk passes cap threads so `workers` parallel FFmpeg
    /// processes share the machine instead of oversubscribing it.
    threads: usize,
}

impl CompositionPass {
    fn standalone() -> Self {
        Self {
            standalone: true,
            include_audio: true,
            plate_divisor: 1,
            threads: 0,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn render_composition_window(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    encoder: encoding::ExportEncoder,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    halt: Option<&Arc<std::sync::atomic::AtomicBool>>,
    on_progress: &(dyn Fn(f64) + Sync),
    resource_dir: Option<&Path>,
    shared: &CompositionShared,
    window: &CompositionWindow,
    pass: &CompositionPass,
) -> Result<RenderOutcome> {
    if plan.segments.is_empty() {
        return Err(InternalError::Media("timeline has no video segments".into()).into());
    }
    captions::validate_captions(&plan.captions)?;
    let video_duration_ms = plan
        .segments
        .iter()
        .map(|segment| segment.output_end_ms)
        .max()
        .unwrap_or(0);
    if plan
        .captions
        .iter()
        .any(|caption| caption.end_ms > video_duration_ms)
    {
        return Err(
            InternalError::Media("caption extends beyond the rendered timeline".into()).into(),
        );
    }
    if plan
        .masks
        .iter()
        .any(|mask| mask.end_ms > video_duration_ms)
    {
        return Err(InternalError::Media(
            "privacy mask extends beyond the rendered timeline".into(),
        )
        .into());
    }
    let canvas = plan
        .canvas
        .as_ref()
        .ok_or_else(|| InternalError::Media("timeline has no render canvas".into()))?;
    validate_canvas(canvas)?;
    // Side-by-side layout follows the overlay's timeline windows, matching
    // preview: when the camera clip is absent (deleted or not yet started) the
    // screen expands over the freed slot. Computing it once for the whole
    // render leaves a dead static region wherever the camera was removed.
    let sbs_windows = merge_ms_windows(
        plan.overlays
            .iter()
            .filter(|overlay| overlay_is_side_by_side(overlay, canvas))
            .map(|overlay| (overlay.output_start_ms, overlay.output_end_ms))
            .collect(),
    );
    let uniform_sbs =
        sbs_windows.len() == 1 && sbs_windows[0].0 == 0 && sbs_windows[0].1 >= plan.duration_ms;
    let layout_varies = !sbs_windows.is_empty() && !uniform_sbs;
    let is_side_by_side = uniform_sbs;
    // Absolute-time expression evaluating to true inside side-by-side windows;
    // every timestamped construct in the graph (scale/overlay eval=frame,
    // gated shadow plate) shares this one gate.
    let sbs_expr = if layout_varies {
        sbs_windows
            .iter()
            .map(|(start, end)| format!("between(t,{},{})", seconds(*start), seconds(*end)))
            .collect::<Vec<_>>()
            .join("+")
    } else {
        String::new()
    };

    let screen_source = common_screen_source(&plan.segments, asset_paths, &shared.probe);
    let full_screen_rect = video_screen_rect(canvas, screen_source, false);
    // `screen_*` is the fitted stream's base geometry: the side-by-side rect
    // when the layout is uniformly so, otherwise the full rect — for a
    // varying layout the stream is rendered at the larger full geometry and
    // eval-scaled down inside side-by-side windows.
    let (screen_x, screen_y, screen_w, screen_h) = if uniform_sbs {
        video_screen_rect(canvas, screen_source, true)
    } else {
        full_screen_rect
    };
    let sbs_screen_rect = if layout_varies {
        Some(video_screen_rect(canvas, screen_source, true))
    } else {
        None
    };

    let mut temp_mask_guards = Vec::new();
    let mut temp_dir_guards: Vec<TempExportDir> = Vec::new();
    let win_start_ms = window.start_ms();
    let win_end_ms = window.end_ms();

    // Per-pass source planning: each intersecting segment becomes a
    // `SourceRequest` already cut to the window, and `plan_segment_inputs`
    // coalesces forward-adjacent requests on the same asset into one
    // `-ss`-seeked input so a chunk pass never decodes the whole file.
    let mut segment_jobs: Vec<SegmentJob> = Vec::new();
    let mut segment_requests: Vec<SourceRequest> = Vec::new();
    for (index, segment) in plan.segments.iter().enumerate() {
        let segment_start = segment.output_start_ms as f64;
        let segment_end = segment.output_end_ms as f64;
        let clamped_start = segment_start.clamp(win_start_ms, win_end_ms);
        let clamped_end = segment_end.clamp(win_start_ms, win_end_ms);
        if clamped_end <= clamped_start {
            continue;
        }
        let cut_in_s = (clamped_start - segment_start) / 1000.0;
        // A mid-segment cut re-anchors the sub-clip to the cut offset instead
        // of zero so the fps resampler lands on the same absolute frame grid
        // the unchunked render produces — chunk seams stay sample-identical.
        // When the video stream starts late (B-frame delay) that first frame
        // sits at `video_delay_s`, so a mid-segment cut aims past the delay.
        let video_delay_s = asset_paths
            .get(&segment.asset_id)
            .map(|path| shared.probe.video_start_delay_s(path, &segment.asset_id))
            .unwrap_or(0.0);
        let source_in_s =
            corrected_source_in_s(segment.source_in_ms, cut_in_s, segment.speed, video_delay_s);
        // The exclusive trim end must keep every source frame that maps to
        // an output inside the window: the stream's first frame sits
        // `delay_s` into the file (B-frame start offset) and the resample
        // anchor can overshoot the target by up to one source frame — both
        // push the last needed frame past the naive end, and the chain's
        // tpad would silently clone the last frame over the gap instead.
        // Extra frames past the need are dropped by the trailing
        // trim=duration anyway. Capping at the segment's raw source end
        // keeps a window ending on the segment boundary identical to the
        // single pass.
        let base_s = segment.source_in_ms as f64 / 1000.0;
        let delay_s = (video_delay_s - base_s).max(0.0);
        let source_out_s = (base_s
            + delay_s
            + (cut_in_s + (clamped_end - clamped_start) / 1000.0) * segment.speed
            + 1.0 / (canvas.fps.max(1) as f64))
            .min(segment.source_out_ms as f64 / 1000.0);
        segment_jobs.push(SegmentJob {
            segment_index: index,
            request_index: segment_requests.len(),
            clamped_start,
            clamped_end,
            cut_in_s,
        });
        segment_requests.push(SourceRequest {
            asset_id: segment.asset_id.clone(),
            stream_index: segment.stream_index,
            source_in_s,
            source_out_s,
        });
    }

    // Each camera overlay visible in this window gets a dedicated seek input
    // clamped to ~1 s of decode padding around the window.
    let mut camera_jobs: Vec<CameraJob> = Vec::new();
    for (index, overlay) in plan.overlays.iter().enumerate() {
        if !overlay.visible || overlay.output_end_ms <= overlay.output_start_ms {
            continue;
        }
        if (overlay.output_end_ms as f64) <= win_start_ms
            || (overlay.output_start_ms as f64) >= win_end_ms
        {
            continue;
        }
        if !overlay.speed.is_finite() || overlay.speed <= 0.0 {
            return Err(InternalError::Media("camera overlay speed is invalid".into()).into());
        }
        let video_delay_s = asset_paths
            .get(&overlay.asset_id)
            .map(|path| shared.probe.video_start_delay_s(path, &overlay.asset_id))
            .unwrap_or(0.0);
        if let Some(clamp) = camera_window_clamp(
            overlay.output_start_ms,
            overlay.output_end_ms,
            overlay.source_in_ms,
            overlay.source_out_ms,
            overlay.speed,
            canvas.fps as f64,
            win_start_ms,
            win_end_ms,
            video_delay_s,
        ) {
            camera_jobs.push(CameraJob {
                overlay_index: index,
                clamp,
            });
        }
    }

    // Beyond MAX_SEEK_INPUTS the legacy one-input-per-asset layout wins:
    // every extra input costs a demuxer/decoder, and wide fan-out is worse
    // than decoding each file once.
    let seek_plan = plan_segment_inputs(&segment_requests)
        .filter(|planned| planned.inputs.len() + camera_jobs.len() <= MAX_SEEK_INPUTS);

    let asset_inputs = collect_input_assets(plan, asset_paths)?;
    let hwaccel_inputs = encoder != encoding::ExportEncoder::Software;
    let mut input_specs: Vec<InputSpec> = Vec::new();
    // asset_id → input index. Holds every asset in the legacy layout, only
    // audio-referenced assets in the seeked layout — segments and camera
    // overlays consume their dedicated window inputs instead.
    let mut input_indices: HashMap<String, usize> = HashMap::new();
    // overlay index → (clamp, input index, input seek) for the camera loop.
    let mut camera_inputs: HashMap<usize, (CameraClamp, usize, f64)> = HashMap::new();
    // window index in `planned.inputs` → input_specs index.
    let mut window_input_indices: Vec<usize> = Vec::new();
    match &seek_plan {
        Some(planned) => {
            for window in &planned.inputs {
                let path = asset_paths.get(&window.asset_id).cloned().ok_or_else(|| {
                    InternalError::Media("render plan references an unknown asset".into())
                })?;
                window_input_indices.push(input_specs.len());
                input_specs.push(InputSpec {
                    key: format!("src:{}:{}", window.asset_id, window_input_indices.len() - 1),
                    path,
                    seek_s: Some(window.seek_s),
                    duration_s: Some(window.end_s - window.seek_s + SEEK_TAIL_MARGIN_S),
                    hwaccel: hwaccel_inputs,
                });
            }
            for job in &camera_jobs {
                let overlay = &plan.overlays[job.overlay_index];
                let path = asset_paths.get(&overlay.asset_id).cloned().ok_or_else(|| {
                    InternalError::Media("camera overlay references an unknown asset".into())
                })?;
                let seek_s = floor_to_ms(job.clamp.src_in_s - SEEK_PREROLL_S).max(0.0);
                camera_inputs.insert(job.overlay_index, (job.clamp, input_specs.len(), seek_s));
                input_specs.push(InputSpec {
                    key: format!("cam:{}:{}", overlay.asset_id, job.overlay_index),
                    path,
                    seek_s: Some(seek_s),
                    duration_s: Some(job.clamp.src_out_s - seek_s + SEEK_TAIL_MARGIN_S),
                    hwaccel: hwaccel_inputs,
                });
            }
            if pass.include_audio {
                // Audio chains read asset-level (unseeked) inputs — atrim
                // applies its own source offsets.
                let mut audio_asset_ids = std::collections::BTreeSet::new();
                if let Some(tracks) = &plan.audio_tracks {
                    for track in tracks {
                        audio_asset_ids.insert(&track.asset_id);
                        audio_asset_ids
                            .extend(track.segments.iter().map(|segment| &segment.asset_id));
                    }
                }
                if let Some(track) = &plan.audio {
                    audio_asset_ids.insert(&track.asset_id);
                    audio_asset_ids.extend(track.segments.iter().map(|segment| &segment.asset_id));
                }
                for (asset_id, path) in &asset_inputs {
                    if !audio_asset_ids.contains(asset_id) {
                        continue;
                    }
                    input_indices.insert(asset_id.clone(), input_specs.len());
                    input_specs.push(InputSpec {
                        key: asset_id.clone(),
                        path: path.clone(),
                        seek_s: None,
                        duration_s: None,
                        hwaccel: false,
                    });
                }
            }
        }
        None => {
            for (asset_id, path) in &asset_inputs {
                input_indices.insert(asset_id.clone(), input_specs.len());
                input_specs.push(InputSpec {
                    key: asset_id.clone(),
                    path: path.clone(),
                    seek_s: None,
                    duration_s: None,
                    hwaccel: hwaccel_inputs,
                });
            }
            for job in &camera_jobs {
                let overlay = &plan.overlays[job.overlay_index];
                let input_index = *input_indices.get(&overlay.asset_id).ok_or_else(|| {
                    InternalError::Media("camera overlay references an unknown asset".into())
                })?;
                // The legacy chain consumes the overlay's full source range.
                let clamp = CameraClamp {
                    cut_out_s: 0.0,
                    chain_dur_s: (overlay.output_end_ms - overlay.output_start_ms) as f64 / 1000.0,
                    src_in_s: overlay.source_in_ms as f64 / 1000.0,
                    src_out_s: overlay.source_out_ms as f64 / 1000.0,
                };
                camera_inputs.insert(job.overlay_index, (clamp, input_index, 0.0));
            }
        }
    }

    // Plates are cached across the export's passes: the file is generated
    // once and the same path is reused as an input in every chunk pass.
    let bg_key = format!(
        "bg:{}:{}:{}:{}",
        screen_x.round() as i64,
        screen_y.round() as i64,
        screen_w.round() as i64,
        screen_h.round() as i64
    );
    let bg_image_path = shared.plates.get_or_create(&bg_key, || {
        Ok(prepare_canvas_background_plate(
            canvas,
            (screen_x, screen_y, screen_w, screen_h),
            asset_paths,
            resource_dir,
        )
        .map(|path| {
            let owned = is_owned_bg_plate(&path);
            (path, owned)
        }))
    })?;
    // A baked canvas shadow tracks the video rect; when the rect moves with
    // the layout a second plate — composited only inside side-by-side
    // windows — keeps the shadow pinned to the smaller slot.
    let bg_sbs_image_path = if layout_varies && canvas.shadow {
        match sbs_screen_rect {
            Some(rect) => {
                let key = format!(
                    "bg_sbs:{}:{}:{}:{}",
                    rect.0.round() as i64,
                    rect.1.round() as i64,
                    rect.2.round() as i64,
                    rect.3.round() as i64
                );
                shared.plates.get_or_create(&key, || {
                    Ok(
                        prepare_canvas_background_plate(canvas, rect, asset_paths, resource_dir)
                            .map(|path| {
                                let owned = is_owned_bg_plate(&path);
                                (path, owned)
                            }),
                    )
                })?
            }
            None => None,
        }
    } else {
        None
    };
    let push_generated = |input_specs: &mut Vec<InputSpec>, key: &str, path: &Path| -> usize {
        input_specs.push(InputSpec {
            key: key.to_string(),
            path: path.to_path_buf(),
            seek_s: None,
            duration_s: None,
            hwaccel: false,
        });
        input_specs.len() - 1
    };
    let bg_input_index = bg_image_path
        .as_ref()
        .map(|path| push_generated(&mut input_specs, "canvas:background", path));
    let bg_sbs_input_index = bg_sbs_image_path
        .as_ref()
        .map(|path| push_generated(&mut input_specs, "canvas:background_sbs", path));
    let chapters_input_index = if (settings.chapter_mode == "embed"
        || settings.chapter_mode == "both")
        && !plan.chapters.is_empty()
    {
        // The ffmeta file stays per pass — it is near-free to write and the
        // standalone pass maps it while chunk passes never do.
        let meta_content = generate_ffmetadata(project_id, &plan.chapters);
        let meta_path = std::env::temp_dir().join(format!(
            "rf-chapters-{}-{}.ffmeta",
            project_id,
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&meta_path, meta_content.as_bytes())
            .map_err(|err| InternalError::Storage(format!("write ffmetadata: {err}")))?;
        let idx = push_generated(&mut input_specs, "meta:chapters", &meta_path);
        temp_mask_guards.push(TempMaskFile(meta_path));
        Some(idx)
    } else {
        None
    };

    let canvas_mask_idx = if canvas.border_radius > 0 {
        let radius = (canvas.border_radius as f32)
            .min(screen_w as f32 / 2.0)
            .min(screen_h as f32 / 2.0);
        let mask_w = screen_w.round().max(1.0) as u32;
        let mask_h = screen_h.round().max(1.0) as u32;
        let key = format!("mask:canvas:{mask_w}:{mask_h}:{radius:.2}");
        let mask_path = shared.plates.get_or_create(&key, || {
            let mask_bytes = cursor::generate_rounded_rect_mask_png(mask_w, mask_h, radius)
                .map_err(|err| {
                    InternalError::Media(format!("generate canvas border mask: {err}"))
                })?;
            let mask_path = std::env::temp_dir().join(format!(
                "rf-mask-canvas-{}-{}-{}-{}.png",
                project_id,
                mask_w,
                mask_h,
                uuid::Uuid::new_v4()
            ));
            std::fs::write(&mask_path, &mask_bytes).map_err(|err| {
                InternalError::Storage(format!("write canvas border mask: {err}"))
            })?;
            Ok(Some((mask_path, true)))
        })?;
        mask_path.map(|path| push_generated(&mut input_specs, "mask:canvas", &path))
    } else {
        None
    };

    let mut camera_mask_indices = HashMap::new();
    let mut camera_border_indices = HashMap::new();
    let mut camera_shadow_indices = HashMap::new();
    for job in &camera_jobs {
        let index = job.overlay_index;
        let overlay = &plan.overlays[index];
        // Snap camera overlay dimensions and coordinates to even integers to prevent
        // YUV420 chroma subsampling misalignment and encoder EINVAL errors.
        let overlay_w = ((overlay.width.round() as u32) / 2 * 2).max(2);
        let overlay_h = ((overlay.height.round() as u32) / 2 * 2).max(2);
        let overlay_x = (overlay.x.round() as i32) / 2 * 2;
        let overlay_y = (overlay.y.round() as i32) / 2 * 2;

        if overlay.shadow_enabled.unwrap_or(false) {
            let key = format!("cam_shadow:{index}:{overlay_x}:{overlay_y}:{overlay_w}:{overlay_h}");
            if let Some(sp) = shared.plates.get_or_create(&key, || {
                Ok(generate_camera_shadow_plate_png(
                    canvas.width,
                    canvas.height,
                    overlay_x as f64,
                    overlay_y as f64,
                    overlay_w as f64,
                    overlay_h as f64,
                    &overlay.shape,
                    overlay.shadow_color.as_deref(),
                    overlay.shadow_blur,
                    overlay.shadow_offset_x,
                    overlay.shadow_offset_y,
                )
                .map(|path| (path, true)))
            })? {
                camera_shadow_indices.insert(
                    index,
                    push_generated(&mut input_specs, &format!("shadow:cam:{index}"), &sp),
                );
            }
        }

        if overlay.shape == "circle" || overlay.shape == "rounded" {
            let shape = overlay.shape.as_str();
            let key = format!("cam_mask:{index}:{shape}:{overlay_w}:{overlay_h}");
            let mask_path = shared.plates.get_or_create(&key, || {
                let mask_bytes = if overlay.shape == "circle" {
                    cursor::generate_circle_mask_png(overlay_w, overlay_h).map_err(|err| {
                        InternalError::Media(format!("generate circle mask: {err}"))
                    })?
                } else {
                    let radius = (overlay.width.min(overlay.height) * 0.12).max(4.0) as f32;
                    cursor::generate_rounded_rect_mask_png(overlay_w, overlay_h, radius).map_err(
                        |err| InternalError::Media(format!("generate rounded mask: {err}")),
                    )?
                };
                let mask_path = std::env::temp_dir().join(format!(
                    "rf-mask-cam-{shape}-{}-{}-{}-{}-{}.png",
                    project_id,
                    index,
                    overlay_w,
                    overlay_h,
                    uuid::Uuid::new_v4()
                ));
                std::fs::write(&mask_path, &mask_bytes)
                    .map_err(|err| InternalError::Storage(format!("write {shape} mask: {err}")))?;
                Ok(Some((mask_path, true)))
            })?;
            if let Some(path) = mask_path {
                camera_mask_indices.insert(
                    index,
                    push_generated(
                        &mut input_specs,
                        &format!("mask:cam_{shape}:{index}"),
                        &path,
                    ),
                );
            }
        }

        if let Some(border_width) = overlay.border_width.filter(|value| *value > 0.0) {
            let key = format!("cam_border:{index}:{overlay_w}:{overlay_h}");
            let border_path = shared.plates.get_or_create(&key, || {
                let border_bytes = generate_camera_border_png(
                    overlay_w,
                    overlay_h,
                    &overlay.shape,
                    border_width,
                    overlay.border_color.as_deref(),
                    overlay.border_opacity,
                )
                .map_err(|err| InternalError::Media(format!("generate camera border: {err}")))?;
                let border_path = std::env::temp_dir().join(format!(
                    "rf-border-cam-{}-{}-{}-{}-{}.png",
                    project_id,
                    index,
                    overlay_w,
                    overlay_h,
                    uuid::Uuid::new_v4()
                ));
                std::fs::write(&border_path, &border_bytes)
                    .map_err(|err| InternalError::Storage(format!("write camera border: {err}")))?;
                Ok(Some((border_path, true)))
            })?;
            if let Some(path) = border_path {
                camera_border_indices.insert(
                    index,
                    push_generated(&mut input_specs, &format!("border:cam:{index}"), &path),
                );
            }
        }
    }
    let has_zoom = plan.zoom_segments.iter().any(|segment| segment.enabled);
    let can_pad_canvas = bg_input_index.is_none()
        && canvas.border_radius == 0
        && !canvas.shadow
        && !is_side_by_side
        && !layout_varies
        && canvas.background_dim.unwrap_or(0.0) <= 0.0;
    let can_direct_pad = can_pad_canvas && !has_zoom;

    // When direct padding is enabled, each segment is scaled to screen dimensions
    // and padded directly onto the full canvas at (screen_x, screen_y), avoiding
    // synthetic background generation, cropping, and software overlay blending.
    let (target_seg_w, target_seg_h) = if can_direct_pad {
        (canvas.width, canvas.height)
    } else {
        (screen_w.round() as u32, screen_h.round() as u32)
    };

    let background = safe_filter_color(&canvas.background);
    let mut filters = Vec::new();
    let mut video_labels = Vec::new();
    // Suffix re-anchoring a fresh stream to this window's absolute start: every
    // timestamped construct downstream (enable windows, zoompan `it`, timed
    // camera offsets, libass cue times) then evaluates in absolute plan
    // seconds, which is what makes chunk boundaries seamless.
    let abs_pts = if window.start_s > 1e-9 {
        format!("+{:.6}/TB", window.start_s)
    } else {
        String::new()
    };
    let win_len_s = fmt_secs(window.end_s - window.start_s);
    let mut filled_ms = win_start_ms;
    for job in &segment_jobs {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(InternalError::Media("export cancelled".into()).into());
        }
        let index = job.segment_index;
        let segment = &plan.segments[index];
        let clamped_start = job.clamped_start;
        let clamped_end = job.clamped_end;
        if clamped_start > filled_ms {
            let gap_label = format!("gap{index}");
            let gap_color = if bg_input_index.is_some() {
                "black@0".to_string()
            } else {
                background.clone()
            };
            filters.push(format!(
                "color=c={gap_color}:s={target_seg_w}x{target_seg_h}:r={}:d={}[{gap_label}]",
                canvas.fps,
                fmt_secs((clamped_start - filled_ms) / 1000.0),
            ));
            video_labels.push(format!("[{gap_label}]"));
        }
        validate_segment_known(segment, project_id, asset_paths)?;
        let (input_index, seek_s) = match &seek_plan {
            Some(planned) => {
                let window_index = planned.assignment[job.request_index];
                (
                    window_input_indices[window_index],
                    planned.inputs[window_index].seek_s,
                )
            }
            None => (
                *input_indices.get(&segment.asset_id).ok_or_else(|| {
                    InternalError::Media("render plan references an unknown asset".into())
                })?,
                0.0,
            ),
        };
        let asset_path = asset_paths.get(&segment.asset_id).ok_or_else(|| {
            InternalError::Media("render plan references an unknown asset".into())
        })?;
        let input = resolve_video_stream_specifier(
            &shared.probe,
            asset_path,
            &segment.asset_id,
            input_index,
            segment.stream_index,
        )?;
        let label = format!("screen{index}");
        // The request's source range is absolute; with a `-ss` input the
        // in-graph timestamps are shifted by the seek, so the trim subtracts
        // it (a legacy input keeps the absolute range).
        let speed = segment.speed;
        let request = &segment_requests[job.request_index];
        let source_in_s = request.source_in_s - seek_s;
        let source_out_s = request.source_out_s - seek_s;
        let phase = if job.cut_in_s > 1e-9 {
            format!("+{:.6}/TB", job.cut_in_s * speed)
        } else {
            String::new()
        };
        let mut filter = format!(
            "{input}trim=start={}:end={},setpts=PTS-STARTPTS{phase}",
            fmt_secs(source_in_s),
            fmt_secs(source_out_s),
        );
        if (speed - 1.0).abs() > f64::EPSILON {
            filter.push_str(&format!(",setpts=PTS/{:.6}", speed));
        }
        let pad_color = if bg_input_index.is_some() {
            "black@0".to_string()
        } else {
            background.clone()
        };
        let segment_duration = fmt_secs((clamped_end - clamped_start) / 1000.0);
        let canvas_w = canvas.width;
        let canvas_h = canvas.height;
        // scale runs per source frame at full canvas resolution and defaults
        // to a single swscale thread; `threads=auto` slices it across cores —
        // measured +7% export throughput on 1080p60 with the pinned FFmpeg.
        if can_direct_pad {
            filter.push_str(&format!(
                ",scale={screen_w:.0}:{screen_h:.0}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,pad={canvas_w}:{canvas_h}:{screen_x:.0}:{screen_y:.0}:color={pad_color},fps={},setsar=1,tpad=stop_mode=clone:stop_duration={segment_duration},tpad=stop_mode=add:stop_duration={segment_duration}:color={pad_color},trim=duration={segment_duration},setpts=PTS-STARTPTS[{label}]",
                canvas.fps,
            ));
        } else {
            filter.push_str(&format!(
                ",scale={screen_w:.0}:{screen_h:.0}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,pad={screen_w:.0}:{screen_h:.0}:(ow-iw)/2:(oh-ih)/2:color={pad_color},fps={},setsar=1,tpad=stop_mode=clone:stop_duration={segment_duration},tpad=stop_mode=add:stop_duration={segment_duration}:color={pad_color},trim=duration={segment_duration},setpts=PTS-STARTPTS[{label}]",
                canvas.fps,
            ));
        }
        filters.push(filter);
        video_labels.push(format!("[{label}]"));
        filled_ms = clamped_end;
    }
    if filled_ms < win_end_ms {
        let gap_label = "gap_trailing";
        let gap_color = if bg_input_index.is_some() {
            "black@0".to_string()
        } else {
            background.clone()
        };
        filters.push(format!(
            "color=c={gap_color}:s={target_seg_w}x{target_seg_h}:r={}:d={}[{gap_label}]",
            canvas.fps,
            fmt_secs((win_end_ms - filled_ms) / 1000.0),
        ));
        video_labels.push(format!("[{gap_label}]"));
    }

    let video_input = if video_labels.len() == 1 {
        video_labels[0].clone()
    } else {
        let label = "screen_concat";
        filters.push(format!(
            "{}concat=n={}:v=1:a=0[{label}]",
            video_labels.join(""),
            video_labels.len()
        ));
        format!("[{label}]")
    };

    // Pin the video to the plan duration: recordings can end their video
    // stream slightly before the audio (encoder tail lag), which trims would
    // otherwise silently shorten. tpad clones the last frame across any
    // shortfall and trim caps the stream at the exact planned duration.
    // Filters are pull-based, so the oversized stop_duration only materializes
    // frames up to the trim cutoff.
    let plan_duration = win_len_s.clone();

    let is_fullscreen_canvas = bg_input_index.is_none()
        && canvas.border_radius == 0
        && !canvas.shadow
        && !is_side_by_side
        && !layout_varies
        && canvas.background_dim.unwrap_or(0.0) <= 0.0
        && screen_w >= (canvas.width as f64 - 0.5)
        && screen_h >= (canvas.height as f64 - 0.5)
        && screen_x.abs() < 0.5
        && screen_y.abs() < 0.5;

    let base_label = "canvas_base";
    // zoompan emits output timestamps on its own 0-based grid, so a shifted
    // pass must restore absolute pts for downstream pairing (overlays, plate,
    // masks) after it runs.
    let post_zoom_reabs = if abs_pts.is_empty() {
        String::new()
    } else {
        format!(",setpts=PTS{abs_pts}")
    };
    if can_direct_pad {
        filters.push(format!(
            "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS{abs_pts},setsar=1[{base_label}]"
        ));
    } else if is_fullscreen_canvas && has_zoom {
        let (z_expr, x_expr, y_expr) =
            build_zoompan_expressions(plan, canvas, canvas.width as f64, canvas.height as f64);
        // Pin the zoompan input to yuv420p so its chroma-subsample origin snap
        // is always 2px and the cursor registration model stays exact.
        filters.push(format!(
            "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS{abs_pts},format=yuv420p,zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={}x{}:fps={},setsar=1{post_zoom_reabs}[{base_label}]",
            canvas.width, canvas.height, canvas.fps
        ));
    } else if can_pad_canvas && has_zoom {
        let (z_expr, x_expr, y_expr) = build_zoompan_expressions(plan, canvas, screen_w, screen_h);
        let canvas_w = canvas.width;
        let canvas_h = canvas.height;
        let canvas_fps = canvas.fps;
        filters.push(format!(
            "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS{abs_pts},format=yuv420p,zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={screen_w:.0}x{screen_h:.0}:fps={canvas_fps},pad={canvas_w}:{canvas_h}:{screen_x:.0}:{screen_y:.0}:color={background},setsar=1{post_zoom_reabs}[{base_label}]"
        ));
    } else {
        // 1. Generate the background plate [bg_plate]
        if let Some(bg_idx) = bg_input_index {
            filters.push(format!(
                "[{bg_idx}:v]format=yuv420p,setsar=1,loop=loop=-1:size=1:start=0,fps={},trim=duration={plan_duration},setpts=PTS-STARTPTS{abs_pts}[bg_plate]",
                canvas.fps
            ));
        } else {
            let mut solid_filter = format!(
                "color=c={background}:s={}x{}:r={}:d={}",
                canvas.width, canvas.height, canvas.fps, plan_duration
            );
            if !abs_pts.is_empty() {
                solid_filter.push_str(&format!(",setpts=PTS{abs_pts}"));
            }
            let bg_dim = canvas.background_dim.unwrap_or(0.0).clamp(0.0, 1.0);
            if bg_dim > 0.0 {
                solid_filter.push_str(&format!(
                    ",drawbox=x=0:y=0:w={}:h={}:color=black@{:.3}:t=fill",
                    canvas.width, canvas.height, bg_dim
                ));
            }
            solid_filter.push_str("[bg_plate]");
            filters.push(solid_filter);
        }
        let mut bg_label = "bg_plate";
        if let Some(bg_sbs_idx) = bg_sbs_input_index {
            // The plate carrying the side-by-side-positioned canvas shadow is
            // composited only inside side-by-side windows, so the baked shadow
            // follows the video slot as the layout changes.
            filters.push(format!(
                "[{bg_sbs_idx}:v]format=yuv420p,setsar=1,loop=loop=-1:size=1:start=0,fps={},trim=duration={plan_duration},setpts=PTS-STARTPTS{abs_pts}[bg_sbs_plate];\
                 [bg_plate][bg_sbs_plate]overlay=x=0:y=0:eof_action=repeat:enable='{sbs_expr}':format=auto[bg_shaded]",
                canvas.fps
            ));
            bg_label = "bg_shaded";
        }

        // 2. Format the fitted video layer [screen_fitted]
        let mut screen_filter = if has_zoom {
            let (z_expr, x_expr, y_expr) =
                build_zoompan_expressions(plan, canvas, screen_w, screen_h);
            format!(
                "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS{abs_pts},format=yuv420p,zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={screen_w:.0}x{screen_h:.0}:fps={},setsar=1{post_zoom_reabs}",
                canvas.fps
            )
        } else {
            format!(
                "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS{abs_pts},setsar=1"
            )
        };
        if let Some(mask_idx) = canvas_mask_idx {
            let raw_label = "screen_unmasked";
            let mask_label = "screen_mask_loop";
            screen_filter.push_str(&format!(",format=rgba[{raw_label}]"));
            filters.push(screen_filter);
            filters.push(format!(
                "[{mask_idx}:v]format=gray,scale={screen_w:.0}:{screen_h:.0},setsar=1,loop=loop=-1:size=1:start=0,fps={},trim=duration={plan_duration},setpts=PTS-STARTPTS[{mask_label}];\
                 [{raw_label}][{mask_label}]alphamerge[screen_fitted]",
                canvas.fps
            ));
        } else {
            screen_filter.push_str("[screen_fitted]");
            filters.push(screen_filter);
        }

        // The fitted stream is rendered at the full-area geometry; inside
        // side-by-side windows an eval=frame scale resizes it to the smaller
        // rect and the overlay position exprs re-anchor it — the same
        // per-frame layout switch the preview performs on the playhead.
        let (fitted_label, overlay_args) = if let Some((sbs_x, sbs_y, sbs_w, sbs_h)) =
            sbs_screen_rect
        {
            filters.push(format!(
                "[screen_fitted]scale=w='if({sbs_expr},{sbs_w:.0},{screen_w:.0})':h='if({sbs_expr},{sbs_h:.0},{screen_h:.0})':eval=frame,setsar=1[screen_fitted_dyn]"
            ));
            (
                "screen_fitted_dyn",
                format!(
                    "x='if({sbs_expr},{sbs_x:.0},{screen_x:.0})':y='if({sbs_expr},{sbs_y:.0},{screen_y:.0})':eval=frame"
                ),
            )
        } else {
            ("screen_fitted", format!("x={screen_x:.0}:y={screen_y:.0}"))
        };

        // 3. Composite screen layer onto background plate [canvas_base]
        let overlay_format = if canvas_mask_idx.is_some() {
            "format=auto"
        } else {
            "format=yuv420"
        };
        filters.push(format!(
            "[{bg_label}][{fitted_label}]overlay={overlay_args}:shortest=1:{overlay_format}[{base_label}]"
        ));
    }

    let composed_label = base_label.to_string();

    let mut current_label = composed_label;

    // The generated overlay stream packs two canvas-sized RGBA planes side by
    // side into one rawvideo input: the cursor plane on the left and the
    // annotation/text/image plane on the right. Compositing them at different
    // points of the graph matches the editor preview stacking order — cursor
    // below camera bubbles and privacy masks, overlay items above both, and
    // burned-in captions on top.
    // Layout windows the cursor maps through: the full rect outside
    // side-by-side windows, the smaller slot inside them. The streamed plate
    // crop is the union of all window rects, so every drawn pixel is covered.
    let (cursor_screen_windows, cursor_plane_rect) = if let Some(sbs_rect) = sbs_screen_rect {
        let mut windows: Vec<cursor::ScreenRectWindow> = Vec::new();
        let mut cursor = 0u64;
        for &(start, end) in &sbs_windows {
            if start > cursor {
                windows.push(cursor::ScreenRectWindow {
                    start_ms: cursor,
                    end_ms: start,
                    rect: (screen_x, screen_y, screen_w, screen_h),
                });
            }
            windows.push(cursor::ScreenRectWindow {
                start_ms: start,
                end_ms: end,
                rect: sbs_rect,
            });
            cursor = end;
        }
        if cursor < plan.duration_ms {
            windows.push(cursor::ScreenRectWindow {
                start_ms: cursor,
                end_ms: plan.duration_ms,
                rect: (screen_x, screen_y, screen_w, screen_h),
            });
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for window in &windows {
            let (rx, ry, rw, rh) = window.rect;
            x0 = x0.min(rx);
            y0 = y0.min(ry);
            x1 = x1.max(rx + rw);
            y1 = y1.max(ry + rh);
        }
        (Some(windows), (x0, y0, x1 - x0, y1 - y0))
    } else {
        (None, (screen_x, screen_y, screen_w, screen_h))
    };
    let mut cursor_renderers = build_cursor_renderers(
        plan,
        project_id,
        asset_paths,
        canvas,
        (screen_x, screen_y, screen_w, screen_h),
        cursor_screen_windows,
    )?;
    // Renderers whose window never intersects this pass can never produce a
    // visible frame; dropping them lets a cursor-free chunk skip the plate
    // input and its stdin feed entirely.
    cursor_renderers.retain(|(start_ms, end_ms, _)| {
        (*end_ms as f64) > win_start_ms && (*start_ms as f64) < win_end_ms
    });
    let cursor_windows: Vec<(u64, u64)> = cursor_renderers
        .iter()
        .map(|(start_ms, end_ms, _)| (*start_ms, *end_ms))
        .collect();
    // An overlay render plan that parses to zero items is treated as "no
    // items": it lets us skip the generated plate input (and its stdin feed)
    // entirely instead of streaming transparent frames for the whole export.
    // Chunked passes additionally require the items to overlap the window.
    let overlay_item_windows = collect_overlay_item_windows(plan);
    let overlaps_window = |start_ms: u64, end_ms: u64| {
        (end_ms as f64) > win_start_ms && (start_ms as f64) < win_end_ms
    };
    let legacy_items_in_window = plan
        .annotations
        .iter()
        .map(|item| (item.start_ms, item.end_ms))
        .chain(plan.texts.iter().map(|item| (item.start_ms, item.end_ms)))
        .chain(plan.images.iter().map(|item| (item.start_ms, item.end_ms)))
        .any(|(start_ms, end_ms)| overlaps_window(start_ms, end_ms));
    let has_overlay_items = legacy_items_in_window
        || overlay_item_windows
            .as_ref()
            .map(|windows| {
                windows
                    .iter()
                    .any(|(start_ms, end_ms)| overlaps_window(*start_ms, *end_ms))
            })
            .unwrap_or_else(|| plan.overlay_render_plan.is_some());
    let mut cursor_plan = None;
    // Label of the overlay-items plate (already bracketed), composited after
    // the camera and privacy-mask passes so titles render above them.
    let mut items_plate_label: Option<String> = None;
    let mut items_enable: Option<String> = None;
    if !cursor_renderers.is_empty() || has_overlay_items {
        let plate_input_index = input_specs.len();
        let plate_source = format!("[{plate_input_index}:v]");
        // Shift the generated stream into absolute time so it framesyncs with
        // the shifted canvas stream (a full pass keeps the zero-shifted form).
        let plate_source = if abs_pts.is_empty() {
            plate_source
        } else {
            filters.push(format!("{plate_source}setpts=PTS{abs_pts}[plate_shifted]"));
            "[plate_shifted]".to_string()
        };
        let mut prepared = prepare_cursor_frame_plan(
            canvas,
            plan.duration_ms,
            cursor_renderers,
            plan,
            asset_paths,
            cursor_plane_rect,
        )?;
        // This pass emits only its window of plate frames; renderer
        // timestamps are absolute, so the feed offsets by `first_frame_index`.
        prepared.first_frame_index = window.first_frame;
        prepared.frame_count = window.frame_count;
        prepared.parallel_divisor = pass.plate_divisor;
        // Gate each plate overlay to the time windows where its content can be
        // visible; outside them the blend is skipped and the base passes
        // through untouched, which keeps the CPU cost of an idle plate near
        // zero (the plate input itself is still consumed at CFR rate).
        let cursor_enable = plate_enable_expr(cursor_windows, plan.duration_ms)
            .map(|expr| format!(":enable='{expr}'"))
            .unwrap_or_default();
        if prepared.dual_plane {
            filters.push(format!(
                "{plate_source}split=2[plate_cursor_src][plate_items_src];\
                 [plate_cursor_src]crop={}:{}:0:0[cursor_plate];\
                 [plate_items_src]crop={}:{}:{}:0[items_plate]",
                canvas.width, canvas.height, canvas.width, canvas.height, canvas.width
            ));
            filters.push(format!(
                "[{current_label}][cursor_plate]overlay=shortest=1:format=yuv420{cursor_enable}[with_cursor]"
            ));
            current_label = "with_cursor".to_string();
            items_plate_label = Some("[items_plate]".to_string());
        } else if !prepared.renderers.is_empty() {
            // Cursor-only stream: composite directly below the camera layer.
            // The plate is the fitted screen rect, not the full canvas, when
            // `cursor_rect` is set — overlay it at that rect's origin.
            let (plate_x, plate_y) = prepared
                .cursor_rect
                .map(|(x, y, _, _)| (x, y))
                .unwrap_or((0, 0));
            filters.push(format!(
                "[{current_label}]{plate_source}overlay=x={plate_x}:y={plate_y}:shortest=1:format=yuv420{cursor_enable}[with_cursor]"
            ));
            current_label = "with_cursor".to_string();
        } else if prepared.overlay_engine.is_some() {
            // Items-only stream: held until after the camera/mask passes.
            items_plate_label = Some(plate_source);
        }
        if items_plate_label.is_some() {
            items_enable = overlay_item_windows
                .and_then(|windows| plate_enable_expr(windows, plan.duration_ms))
                .map(|expr| format!(":enable='{expr}'"));
        }
        cursor_plan = Some(prepared);
    }

    for (index, overlay) in plan.overlays.iter().enumerate() {
        if !overlay.visible || overlay.output_end_ms <= overlay.output_start_ms {
            continue;
        }
        validate_overlay(overlay, project_id, asset_paths, canvas)?;
        // Camera chains are timestamped absolutely, so a window-disjoint
        // overlay would render nothing — it got no input, skip it entirely.
        let Some((clamp, input_index, seek_s)) = camera_inputs.get(&index).copied() else {
            continue;
        };
        let asset_path = asset_paths.get(&overlay.asset_id).ok_or_else(|| {
            InternalError::Media("camera overlay references an unknown asset".into())
        })?;
        let input = resolve_video_stream_specifier(
            &shared.probe,
            asset_path,
            &overlay.asset_id,
            input_index,
            overlay.stream_index,
        )?;

        let enable = format!(
            "between(t,{},{})",
            seconds(overlay.output_start_ms),
            seconds(overlay.output_end_ms)
        );

        // 1. Composite shadow underlay if present
        if let Some(&shadow_idx) = camera_shadow_indices.get(&index) {
            let after_shadow_label = format!("cam_with_shadow{index}");
            let shadow_loop_label = format!("cam_shadow_loop{index}");
            filters.push(format!(
                "[{shadow_idx}:v]format=rgba,setsar=1,loop=loop=-1:size=1:start=0[{shadow_loop_label}];\
                 [{current_label}][{shadow_loop_label}]overlay=x=0:y=0:eof_action=repeat:enable='{enable}':format=auto[{after_shadow_label}]"
            ));
            current_label = after_shadow_label;
        }

        // 2. Format camera video stream (trim, speed, crop/cover, scale, opacity).
        // `clamp` bounds the decode to this pass's window (plus padding); the
        // `+cut/TB` term in setpts keeps the speed-normalized pts continuous
        // with the un-clamped chain so downstream overlay timing is unchanged.
        let mut camera_filter = format!(
            "{input}trim=start={}:end={},setpts=(PTS-STARTPTS+{:.6}/TB)/{:.6}",
            fmt_secs(clamp.src_in_s - seek_s),
            fmt_secs(clamp.src_out_s - seek_s),
            clamp.cut_out_s * overlay.speed,
            overlay.speed,
        );
        let overlay_w = ((overlay.width.round() as u32) / 2 * 2).max(2);
        let overlay_h = ((overlay.height.round() as u32) / 2 * 2).max(2);
        let overlay_x = (overlay.x.round() as i32) / 2 * 2;
        let overlay_y = (overlay.y.round() as i32) / 2 * 2;
        let overlay_duration = fmt_secs(clamp.chain_dur_s);

        if let Some(crop) = &overlay.crop {
            camera_filter.push_str(&format!(
                ",crop={}:{}:{}:{}",
                crop.width, crop.height, crop.x, crop.y
            ));
            camera_filter.push_str(&format!(
                ",scale={overlay_w}:{overlay_h}:force_original_aspect_ratio=decrease:force_divisible_by=2:threads=auto,pad={overlay_w}:{overlay_h}:(ow-iw)/2:(oh-ih)/2:color=black@0"
            ));
        } else {
            camera_filter.push_str(&format!(
                ",scale={overlay_w}:{overlay_h}:force_original_aspect_ratio=increase:force_divisible_by=2:threads=auto,crop={overlay_w}:{overlay_h}:(iw-ow)/2:(ih-oh)/2"
            ));
        }
        if overlay.opacity < 1.0 {
            camera_filter.push_str(&format!(",colorchannelmixer=aa={:.4}", overlay.opacity));
        }
        camera_filter.push_str(&format!(
            ",fps={},setsar=1,tpad=stop_mode=clone:stop_duration={overlay_duration},trim=duration={overlay_duration},setpts=PTS-STARTPTS,format=rgba",
            canvas.fps
        ));

        // 3. Mask camera video stream (for circle and rounded shapes)
        let masked_camera_label = if let Some(&cam_mask_idx) = camera_mask_indices.get(&index) {
            let raw_label = format!("camera_unmasked{index}");
            let mask_label = format!("cam_mask_loop{index}");
            let masked_label = format!("camera_masked{index}");
            camera_filter.push_str(&format!("[{raw_label}]"));
            filters.push(camera_filter);
            filters.push(format!(
                "[{cam_mask_idx}:v]format=gray,scale={overlay_w}:{overlay_h},setsar=1,loop=loop=-1:size=1:start=0,fps={},trim=duration={overlay_duration},setpts=PTS-STARTPTS[{mask_label}];\
                 [{raw_label}][{mask_label}]alphamerge[{masked_label}]",
                canvas.fps
            ));
            masked_label
        } else {
            let raw_label = format!("camera_raw{index}");
            camera_filter.push_str(&format!("[{raw_label}]"));
            filters.push(camera_filter);
            raw_label
        };

        // 4. Shift timestamps to the overlay's output start plus whatever the
        // window clamp cut from the head, then composite on the canvas.
        let timed_offset_s = overlay.output_start_ms as f64 / 1000.0 + clamp.cut_out_s;
        let timed_camera_label = if timed_offset_s > 1e-9 {
            let label = format!("camera_timed{index}");
            filters.push(format!(
                "[{masked_camera_label}]setpts=PTS+{:.6}/TB[{label}]",
                timed_offset_s
            ));
            label
        } else {
            masked_camera_label
        };

        let after_camera_label = format!("cam_composite{index}");
        filters.push(format!(
            "[{current_label}][{timed_camera_label}]overlay=x={overlay_x}:y={overlay_y}:eof_action=pass:enable='{enable}':format=auto[{after_camera_label}]"
        ));
        current_label = after_camera_label;

        // 5. Overlay border stroke directly on top of canvas if present
        if let Some(&border_idx) = camera_border_indices.get(&index) {
            let border_loop_label = format!("cam_border_loop{index}");
            let after_border_label = format!("cam_with_border{index}");
            filters.push(format!(
                "[{border_idx}:v]format=rgba,scale={overlay_w}:{overlay_h},setsar=1,loop=loop=-1:size=1:start=0[{border_loop_label}];\
                 [{current_label}][{border_loop_label}]overlay=x={overlay_x}:y={overlay_y}:eof_action=repeat:enable='{enable}':format=auto[{after_border_label}]"
            ));
            current_label = after_border_label;
        }
    }

    for (index, mask) in plan.masks.iter().enumerate() {
        if !mask.enabled || mask.end_ms <= mask.start_ms {
            continue;
        }
        validate_mask(mask, project_id, asset_paths, canvas)?;
        // Same absolute-time rule as the camera chains: a mask outside this
        // pass's window can never trigger, so its split/crop branch is dead
        // work — skip building it.
        if (mask.end_ms as f64) <= win_start_ms || (mask.start_ms as f64) >= win_end_ms {
            continue;
        }
        let x_raw = mask
            .rect
            .x
            .round()
            .clamp(0.0, canvas.width.saturating_sub(1) as f64) as u32;
        let y_raw = mask
            .rect
            .y
            .round()
            .clamp(0.0, canvas.height.saturating_sub(1) as f64) as u32;
        let right_raw = (mask.rect.x + mask.rect.width)
            .round()
            .clamp(1.0, canvas.width as f64) as u32;
        let bottom_raw = (mask.rect.y + mask.rect.height)
            .round()
            .clamp(1.0, canvas.height as f64) as u32;

        // Snap outward to even coordinates and dimensions within canvas bounds
        // to prevent YUV420 chroma subsampling truncation from leaving 1px unmasked gaps.
        let x = (x_raw / 2 * 2).min(canvas.width.saturating_sub(2));
        let y = (y_raw / 2 * 2).min(canvas.height.saturating_sub(2));
        let right = (right_raw.div_ceil(2) * 2).min(canvas.width);
        let bottom = (bottom_raw.div_ceil(2) * 2).min(canvas.height);
        let width = right.saturating_sub(x).max(2);
        let height = bottom.saturating_sub(y).max(2);

        let enable = format!(
            "between(t,{},{})",
            seconds(mask.start_ms),
            seconds(mask.end_ms)
        );
        let next_label = format!("mask_composite{index}");
        match mask.mode.as_str() {
            "redact" => {
                let color = safe_filter_color(&mask.redact_color);
                filters.push(format!(
                    "[{current_label}]drawbox=x={x}:y={y}:w={width}:h={height}:color={color}:t=fill:enable='{enable}'[{next_label}]"
                ));
            }
            "blur" | "pixelate" => {
                let base_label = format!("mask_base{index}");
                let source_label = format!("mask_source{index}");
                let filtered_label = format!("mask_filtered{index}");
                filters.push(format!(
                    "[{current_label}]split=2[{base_label}][{source_label}]"
                ));
                let mut region_filter =
                    format!("[{source_label}]crop=w={width}:h={height}:x={x}:y={y}");
                if mask.mode == "blur" {
                    let radius = mask.blur_radius.clamp(1.0, 128.0);
                    if radius > 3.0 {
                        // Multi-scale fast blur approximation: downscale, average blur, upscale.
                        // Up to 100x faster than software gblur and avoids starving hardware encoders.
                        let factor = ((radius / 4.0).round() as u32).clamp(2, 16);
                        let small_w = ((width / factor) / 2 * 2).max(2);
                        let small_h = ((height / factor) / 2 * 2).max(2);
                        region_filter.push_str(&format!(
                            ",scale=w={small_w}:h={small_h}:flags=bilinear,avgblur=sizeX=3:sizeY=3,scale=w={width}:h={height}:flags=bilinear"
                        ));
                    } else {
                        let r = (radius.round() as u32).max(1);
                        region_filter.push_str(&format!(",avgblur=sizeX={r}:sizeY={r}"));
                    }
                } else {
                    let pixel_size = mask.pixel_size.clamp(2, 128) as f64;
                    let small_width = (((width as f64) / pixel_size).round() as u32 / 2 * 2).max(2);
                    let small_height =
                        (((height as f64) / pixel_size).round() as u32 / 2 * 2).max(2);
                    region_filter.push_str(&format!(
                        ",scale=w={small_width}:h={small_height}:flags=neighbor,scale=w={width}:h={height}:flags=neighbor"
                    ));
                }
                region_filter.push_str(&format!("[{filtered_label}]"));
                filters.push(region_filter);
                filters.push(format!(
                    "[{base_label}][{filtered_label}]overlay=x={x}:y={y}:eof_action=pass:enable='{enable}':format=yuv420[{next_label}]"
                ));
            }
            _ => {
                return Err(InternalError::Media("mask mode is unsupported".into()).into());
            }
        }
        current_label = next_label;
    }

    // Overlay items (titles, annotations, images) composite above the camera
    // bubbles and privacy masks but below burned-in captions, matching the
    // editor preview stacking (z-35 above masks at z-30, below captions z-40).
    if let Some(items_plate) = items_plate_label {
        let enable_suffix = items_enable.unwrap_or_default();
        filters.push(format!(
            "[{current_label}]{items_plate}overlay=shortest=1:format=auto{enable_suffix}[with_items]"
        ));
        current_label = "with_items".to_string();
    }

    // Burned-in captions go through a single libass pass: one `subtitles`
    // filter over a generated .ass script instead of a drawtext chain per cue.
    if plan.caption_mode == "burn-in"
        && !plan.captions.is_empty()
        && plan
            .captions
            .iter()
            .any(|caption| overlaps_window(caption.start_ms, caption.end_ms))
    {
        let caption_dir = std::env::temp_dir().join(format!(
            "rf-captions-{}-{}",
            project_id,
            uuid::Uuid::new_v4()
        ));
        let script_path = captions::write_burn_in_assets(
            &caption_dir,
            &plan.captions,
            canvas.width,
            canvas.height,
        )?;
        // The script and embedded font share the directory, so one guard
        // removes everything once the encode finishes.
        temp_dir_guards.push(TempExportDir(caption_dir));
        filters.push(captions::subtitles_filter(
            &current_label,
            "with_captions",
            &script_path,
        ));
        current_label = "with_captions".to_string();
    }

    let final_pix_fmt = match encoder {
        encoding::ExportEncoder::Qsv => "nv12",
        _ => "yuv420p",
    };
    let final_label = "export_output";
    // Re-anchor to zero after the absolute-time window so each emitted file
    // is a normal 0-based stream (no-op suffix for a full pass).
    let reanchor = if abs_pts.is_empty() {
        ""
    } else {
        "setpts=PTS-STARTPTS,"
    };
    // `eof_action=repeat` overlays fed by infinite secondary loops keep
    // emitting clones of the last frame past the main stream's end; `-t` trims
    // them approximately, so a repeat landing exactly on a millisecond
    // boundary can leak through as a duplicated seam frame. Cap the windowed
    // pass at its exact frame count.
    let frame_cap = if pass.standalone {
        String::new()
    } else {
        format!("trim=end_frame={},", window.frame_count)
    };
    filters.push(format!(
        "[{current_label}]{reanchor}{frame_cap}format={final_pix_fmt}[{final_label}]"
    ));
    current_label = final_label.to_string();

    let duration_ms = plan.duration_ms.max(1);
    let is_gif = settings.container == "gif" || settings.preset.starts_with("gif-");
    let is_webp = settings.container == "webp" || settings.preset.starts_with("webp-");
    // Chunk passes render video-only: the mux stage splices in one continuous
    // audio render so no AAC priming discontinuity ever reaches a seam.
    let has_audio = pass.include_audio
        && !is_gif
        && !is_webp
        && append_audio_graph(
            &mut filters,
            plan,
            project_id,
            &input_indices,
            asset_paths,
            &shared.probe,
            duration_ms,
            &cancel,
        )?;

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error", "-threads", "0"])
        // Machine-readable progress blocks on stderr; the runner parses
        // `out_time=` from them and keeps them out of failure diagnostics.
        .args(["-progress", "pipe:2"]);
    // Hardware decode keeps compressed frames off the CPU-side demux/decode
    // path when a hardware encoder is in use. `auto` picks any working
    // backend (D3D11VA/DXVA2/NVDEC on Windows, VideoToolbox on macOS, VAAPI on
    // Linux) and silently falls back to software when none applies, so it is
    // also safe on image/metadata inputs and GPU-less machines. Software
    // encodes keep a clean software command — including the hardware-retry
    // path, which re-enters here with `ExportEncoder::Software`.
    // Chunk passes cap the filter graph's thread pool so `workers` parallel
    // FFmpeg processes share the machine; standalone passes keep FFmpeg's
    // default threading.
    if pass.threads > 0 {
        command
            .arg("-filter_complex_threads")
            .arg(pass.threads.to_string());
    }
    tracing::debug!(
        project_id = %project_id,
        inputs = %input_specs
            .iter()
            .map(|spec| {
                let seeked = spec
                    .seek_s
                    .map(|seek| format!("@{seek:.3}+{}", spec.duration_s.unwrap_or(0.0)))
                    .unwrap_or_default();
                format!("{}{}", spec.key, seeked)
            })
            .collect::<Vec<_>>()
            .join(","),
        "export: composition pass inputs"
    );
    for spec in &input_specs {
        if let Some(seek_s) = spec.seek_s {
            command.args(["-ss", &fmt_secs(seek_s)]);
        }
        if let Some(duration_s) = spec.duration_s {
            command.args(["-t", &fmt_secs(duration_s)]);
        }
        if spec.hwaccel {
            command.args(["-hwaccel", "auto"]);
        }
        command
            .args(["-thread_queue_size", "128"])
            .arg("-i")
            .arg(&spec.path);
    }
    if let Some(frame_plan) = &cursor_plan {
        // The generated overlay stream is a transparent RGBA rawvideo feed over
        // stdin; frame timestamps come from the declared rate. When cursor and
        // overlay items coexist the stream packs both planes side by side, so
        // the declared width doubles. A cursor-only stream is the fitted screen
        // rect, not the full canvas.
        let plate_width = frame_plan.width * if frame_plan.dual_plane { 2 } else { 1 };
        let queue_size =
            stdin_thread_queue_size(plate_width as usize * frame_plan.height as usize * 4);
        command
            .args(["-f", "rawvideo", "-pix_fmt", "rgba"])
            .args(["-s", &format!("{}x{}", plate_width, frame_plan.height)])
            .args(["-r", &canvas.fps.to_string()])
            .args(["-thread_queue_size", &queue_size.to_string()])
            .arg("-i")
            .arg("-");
    }
    if is_gif {
        let (gif_fps, dither_opt, max_width) = match settings.preset.as_str() {
            "gif-fast" => (15, "bayer:bayer_scale=4", Some(640)),
            "gif-high-quality" => (30, "floyd_steinberg", None),
            _ => (20, "bayer:bayer_scale=3", Some(960)),
        };
        let scale_filter = if let Some(max_w) = max_width {
            format!("scale='trunc(min(iw,{max_w})/2)*2':-2:flags=lanczos:threads=auto,")
        } else {
            String::new()
        };
        filters.push(format!(
            "[{current_label}]fps={gif_fps},{scale_filter}split[gif_v1][gif_v2];[gif_v1]palettegen=stats_mode=diff:reserve_transparent=0[gif_pal];[gif_v2][gif_pal]paletteuse=dither={dither_opt}[gif_out]"
        ));
        current_label = "gif_out".to_string();
    } else if is_webp {
        let (webp_fps, max_width) = match settings.preset.as_str() {
            "webp-fast" => (15, Some(800)),
            "webp-high-quality" | "webp-lossless" => (30, None),
            _ => (24, Some(1280)),
        };
        let scale_filter = if let Some(max_w) = max_width {
            format!("scale='trunc(min(iw,{max_w})/2)*2':-2:flags=lanczos:threads=auto,")
        } else {
            String::new()
        };
        filters.push(format!(
            "[{current_label}]fps={webp_fps},{scale_filter}format=yuv420p[webp_out]"
        ));
        current_label = "webp_out".to_string();
    }

    let filter_script_content = filters.join(";\n");
    let filter_script_path = std::env::temp_dir().join(format!(
        "rf-filter-complex-{}-{}.txt",
        project_id,
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&filter_script_path, filter_script_content.as_bytes())
        .map_err(|err| InternalError::Storage(format!("write filter complex script: {err}")))?;
    temp_mask_guards.push(TempMaskFile(filter_script_path.clone()));

    command
        .arg("-/filter_complex")
        .arg(&filter_script_path)
        .args(["-map", &format!("[{current_label}]")]);
    if is_gif || is_webp || !has_audio {
        command.arg("-an");
    } else {
        command.args(["-map", "[aout]"]);
    }
    if is_gif {
        command.args(["-c:v", "gif", "-loop", "0", "-f", "gif"]);
    } else if is_webp {
        let (lossless, quality, compression_level) = match settings.preset.as_str() {
            "webp-lossless" => ("1", "100", "4"),
            "webp-high-quality" => ("0", "90", "4"),
            "webp-fast" => ("0", "60", "2"),
            _ => ("0", "75", "4"),
        };
        command.args([
            "-c:v",
            "libwebp_anim",
            "-loop",
            "0",
            "-lossless",
            lossless,
            "-q:v",
            quality,
            "-compression_level",
            compression_level,
            "-f",
            "webp",
        ]);
    } else {
        encoding::append_export_video_args(
            &mut command,
            settings,
            encoder,
            canvas.fps,
            canvas.width,
            canvas.height,
        );
        if has_audio {
            command.args(["-c:a", "aac", "-b:a", audio_bitrate(settings)]);
        }
        // Embedded chapters and faststart belong to the finished file only —
        // chunk intermediates defer both to the concat mux stage. `hvc1`
        // tags HEVC as Apple-player-compatible; chunk passes stay untagged
        // (mpegts has no brand concept) and the mux stage tags the result.
        if pass.standalone {
            command.args(hvc1_tag_args(settings));
            if let Some(idx) = chapters_input_index {
                command.args(["-map_chapters", &idx.to_string()]);
            }
            command.args(["-movflags", "+faststart"]);
        }
    }
    // Chunk intermediates are mpegts slices — stream-copy concat needs no
    // per-slice global headers, and the concat list pins each slice's exact
    // frame-count duration.
    if !pass.standalone && !is_gif && !is_webp {
        command.args(["-f", "mpegts"]);
    }
    command.args(["-t", &win_len_s]);
    if pass.threads > 0 && encoder == encoding::ExportEncoder::Software {
        command.arg("-threads").arg(pass.threads.to_string());
    }
    command.arg(output_path);

    run_export_ffmpeg(
        &mut command,
        &cancel,
        halt,
        output_path,
        "timeline composition",
        Some(window.duration_ms),
        cursor_plan,
        Some(on_progress),
    )?;
    Ok(RenderOutcome { has_audio })
}

/// Append the audio graph — per-segment `atrim`/speed/volume chains padded to
/// the full export duration and mixed into `[aout]` — to `filters`. Returns
/// whether `[aout]` was emitted. Called by the standalone pass directly and,
/// for chunked exports, by the dedicated audio render in `render_timeline_chunked`.
#[allow(clippy::too_many_arguments)]
fn append_audio_graph(
    filters: &mut Vec<String>,
    plan: &RenderPlan,
    project_id: &str,
    input_indices: &HashMap<String, usize>,
    asset_paths: &HashMap<String, PathBuf>,
    probe: &ProbeCache,
    duration_ms: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<bool> {
    let audio_tracks = plan
        .audio_tracks
        .as_ref()
        .map(|tracks| tracks.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| plan.audio.iter().collect::<Vec<_>>());
    let mut audio_labels = Vec::new();
    let mut audio_segment_index = 0usize;
    for track in audio_tracks {
        if track.muted {
            continue;
        }
        let fallback = RenderSegment {
            asset_id: track.asset_id.clone(),
            stream_index: track.stream_index,
            volume: Some(track.volume),
            speed: 1.0,
            fade_in_ms: None,
            fade_out_ms: None,
            volume_keyframes: None,
            audio_filter: None,
            source_in_ms: 0,
            source_out_ms: duration_ms,
            output_start_ms: 0,
            output_end_ms: duration_ms,
            source_width: None,
            source_height: None,
        };
        let uses_legacy_fallback = track.segments.is_empty();
        let segments = if uses_legacy_fallback {
            vec![fallback]
        } else {
            track.segments.clone()
        };
        for segment in segments {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(InternalError::Media("export cancelled".into()).into());
            }
            validate_segment_known(&segment, project_id, asset_paths)?;
            let volume = segment.volume.unwrap_or(track.volume).clamp(0.0, 2.0);
            let input_index = *input_indices.get(&segment.asset_id).ok_or_else(|| {
                InternalError::Media("audio track references an unknown asset".into())
            })?;
            let asset_path = asset_paths.get(&segment.asset_id).ok_or_else(|| {
                InternalError::Media("audio track references an unknown asset".into())
            })?;
            let stream_index = if uses_legacy_fallback {
                segment.stream_index.or(track.stream_index)
            } else {
                segment.stream_index
            };
            let Some(input) = resolve_audio_stream_specifier(
                probe,
                asset_path,
                &segment.asset_id,
                input_index,
                stream_index,
            )?
            else {
                continue;
            };
            let label = format!("audio{audio_segment_index}");
            let clip_duration_ms = segment
                .output_end_ms
                .saturating_sub(segment.output_start_ms)
                .max(1);
            let mut audio_filter = format!(
                "{input}atrim=start={}:end={},asetpts=PTS-STARTPTS",
                seconds(segment.source_in_ms),
                seconds(segment.source_out_ms),
            );
            if (segment.speed - 1.0).abs() > f64::EPSILON {
                audio_filter.push_str(&atempo_filter(segment.speed));
            }
            if let Some(custom_filter) = &segment.audio_filter {
                audio_filter.push_str(&format!(",{custom_filter}"));
            } else {
                audio_filter.push_str(&format!(",volume={volume:.4}"));
                if let Some(fade_in_ms) = segment.fade_in_ms.filter(|value| *value > 0.0) {
                    audio_filter.push_str(&format!(
                        ",afade=t=in:st=0:d={}",
                        seconds(fade_in_ms as u64)
                    ));
                }
                if let Some(fade_out_ms) = segment.fade_out_ms.filter(|value| *value > 0.0) {
                    let fade_duration = fade_out_ms.min(clip_duration_ms as f64);
                    let fade_start = (clip_duration_ms as f64 - fade_duration).max(0.0);
                    audio_filter.push_str(&format!(
                        ",afade=t=out:st={:.3}:d={:.3}",
                        fade_start / 1000.0,
                        fade_duration / 1000.0
                    ));
                }
            }
            if segment.output_start_ms > 0 {
                audio_filter.push_str(&format!(",adelay={}:all=1", segment.output_start_ms));
            }
            audio_filter.push_str(&format!(",apad=pad_dur={}[{label}]", seconds(duration_ms)));
            filters.push(audio_filter);
            audio_labels.push(format!("[{label}]"));
            audio_segment_index += 1;
        }
    }

    if audio_labels.len() == 1 {
        let label = "aout";
        filters.push(format!(
            "{}atrim=duration={}[{label}]",
            audio_labels[0],
            seconds(duration_ms)
        ));
    } else if !audio_labels.is_empty() {
        filters.push(format!(
            "{}amix=inputs={}:duration=longest:normalize=0,atrim=duration={}[aout]",
            audio_labels.join(""),
            audio_labels.len(),
            seconds(duration_ms),
        ));
    }
    Ok(!audio_labels.is_empty())
}

/// One `-i` argument for the composition command: the file plus an optional
/// `-ss`/`-t` decode window and whether hardware decode applies.
struct InputSpec {
    key: String,
    path: PathBuf,
    seek_s: Option<f64>,
    duration_s: Option<f64>,
    hwaccel: bool,
}

/// One segment's demand on a source file, already cut to the pass window.
struct SourceRequest {
    asset_id: String,
    stream_index: Option<i32>,
    source_in_s: f64,
    source_out_s: f64,
}

/// Decode window of one `-ss`/`-t -i` input.
struct SourceWindow {
    asset_id: String,
    stream_index: Option<i32>,
    seek_s: f64,
    end_s: f64,
}

struct SegmentInputPlan {
    inputs: Vec<SourceWindow>,
    /// request index → `inputs` index.
    assignment: Vec<usize>,
}

/// Decode starts this far before the first needed frame so `-ss` always has
/// keyframe slack, and runs this far past the last one for decoder flush.
const SEEK_PREROLL_S: f64 = 0.5;
const SEEK_TAIL_MARGIN_S: f64 = 1.0;
/// Two requests on the same source fuse when the later one starts within this
/// gap of the earlier one's end — replaying a small span beats a second
/// demuxer/decoder on the file.
const COALESCE_GAP_S: f64 = 2.0;
/// Beyond this many seeked inputs the per-input demuxer/decoder cost loses to
/// simply decoding the whole asset once, so the caller falls back to the
/// legacy one-input-per-asset layout.
const MAX_SEEK_INPUTS: usize = 24;

/// Palette-quantized GIF encodes grow quadratically and browsers struggle with
/// long loops; anything past this needs a Selected range export.
const MAX_GIF_DURATION_MS: u64 = 60_000;

fn floor_to_ms(value: f64) -> f64 {
    (value * 1000.0).floor() / 1000.0
}

/// Group segment requests into `-ss`-seeked inputs. A request reuses the most
/// recently opened window of the same (asset, stream) only when it continues
/// forward within `COALESCE_GAP_S` — backward or reordered playback gets its
/// own input rather than in-graph buffering of a rewound stream. `None` when
/// the segment windows alone reach `MAX_SEEK_INPUTS` (the caller adds the
/// camera overlay count before deciding).
fn plan_segment_inputs(requests: &[SourceRequest]) -> Option<SegmentInputPlan> {
    let mut inputs: Vec<SourceWindow> = Vec::new();
    let mut assignment = Vec::with_capacity(requests.len());
    for request in requests {
        let reuse = inputs
            .iter()
            .rposition(|window| {
                window.asset_id == request.asset_id && window.stream_index == request.stream_index
            })
            .filter(|&index| {
                let gap = request.source_in_s - inputs[index].end_s;
                (-1e-6..=COALESCE_GAP_S).contains(&gap)
            });
        let window_index = match reuse {
            Some(index) => {
                inputs[index].end_s = inputs[index].end_s.max(request.source_out_s);
                index
            }
            None => {
                if inputs.len() >= MAX_SEEK_INPUTS {
                    return None;
                }
                inputs.push(SourceWindow {
                    asset_id: request.asset_id.clone(),
                    stream_index: request.stream_index,
                    seek_s: floor_to_ms(request.source_in_s - SEEK_PREROLL_S).max(0.0),
                    end_s: request.source_out_s,
                });
                inputs.len() - 1
            }
        };
        assignment.push(window_index);
    }
    Some(SegmentInputPlan { inputs, assignment })
}

/// Where a camera overlay's filter chain cuts into its source when the pass
/// window slices it: how much output time to drop from the head, how long the
/// clamped chain runs, and the source range it decodes.
#[derive(Clone, Copy)]
struct CameraClamp {
    /// Output-time seconds dropped from the overlay head (frame-grid aligned).
    cut_out_s: f64,
    /// Length of the clamped overlay chain, output seconds.
    chain_dur_s: f64,
    /// Source-second range the chain trims to (delay-corrected when cut).
    src_in_s: f64,
    src_out_s: f64,
}

/// Clamp a camera overlay to a composition window with ~1 s of decode padding
/// on both sides so boundary chunks still composite the bubble. `None` when
/// the overlay never intersects the window. `video_delay_s` is the asset's
/// `ProbeCache::video_start_delay_s`; like the segment rule it only applies
/// when the overlay's source_in precedes the first video frame, and only to a
/// real cut (a fresh STARTPTS anchor). A full-window pass yields
/// `cut_out_s = 0` and the overlay's whole duration — identical to the legacy
/// chain apart from the `-ss` input.
#[allow(clippy::too_many_arguments)]
fn camera_window_clamp(
    out_start_ms: u64,
    out_end_ms: u64,
    source_in_ms: u64,
    source_out_ms: u64,
    speed: f64,
    fps: f64,
    win_start_ms: f64,
    win_end_ms: f64,
    video_delay_s: f64,
) -> Option<CameraClamp> {
    if (out_end_ms as f64) <= win_start_ms || (out_start_ms as f64) >= win_end_ms {
        return None;
    }
    let rel = ((win_start_ms - 1000.0 - out_start_ms as f64) / 1000.0).max(0.0);
    let cut_out_s = (rel * fps).floor() / fps;
    let clamped_end_ms = (out_end_ms as f64).min(win_end_ms + 1000.0);
    let chain_dur_s = (clamped_end_ms - out_start_ms as f64) / 1000.0 - cut_out_s;
    if chain_dur_s <= 0.0 {
        return None;
    }
    let mut src_in_s = source_in_ms as f64 / 1000.0 + cut_out_s * speed;
    if cut_out_s > 0.0 {
        src_in_s += (video_delay_s - source_in_ms as f64 / 1000.0).max(0.0);
    }
    let src_out_s = (source_out_ms as f64 / 1000.0).min(src_in_s + chain_dur_s * speed);
    Some(CameraClamp {
        cut_out_s,
        chain_dur_s,
        src_in_s,
        src_out_s,
    })
}

/// `source_in` for a segment cut mid-way into the pass window. When the
/// segment began before the video stream's first frame (B-frame delay), the
/// standalone pass's `STARTPTS` anchor seats that first frame at
/// `video_delay_s`, so a mid-segment cut must aim past the offset to land on
/// the same frame the unchunked render emits.
fn corrected_source_in_s(source_in_ms: u64, cut_in_s: f64, speed: f64, video_delay_s: f64) -> f64 {
    let base = source_in_ms as f64 / 1000.0;
    if cut_in_s <= 1e-9 {
        return base;
    }
    base + cut_in_s * speed + (video_delay_s - base).max(0.0)
}

/// Stdin queue depth for the rawvideo plate feed: keep ~96 MiB of frames in
/// flight so producer stalls don't starve the encoder, bounded so a 4K
/// dual-plane feed stays reasonable.
fn stdin_thread_queue_size(frame_bytes: usize) -> usize {
    (96 * 1024 * 1024 / frame_bytes.max(1)).clamp(4, 32)
}

/// An intersecting segment within the pass window, in plan order.
struct SegmentJob {
    segment_index: usize,
    /// Index into the `SourceRequest`/`SegmentInputPlan::assignment` vectors.
    request_index: usize,
    clamped_start: f64,
    clamped_end: f64,
    cut_in_s: f64,
}

/// A camera overlay intersecting the pass window with its clamped source
/// range. Its input index and seek offset are bound once the input list is
/// built (`camera_inputs` in the render function).
#[derive(Clone, Copy)]
struct CameraJob {
    overlay_index: usize,
    clamp: CameraClamp,
}

/// True when a background plate path is one of ours (temp-dir +
/// `recordforge_bg_` name) rather than a user asset resolved into the plate —
/// only owned files get a cleanup guard.
fn is_owned_bg_plate(path: &Path) -> bool {
    path.starts_with(std::env::temp_dir())
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("recordforge_bg_"))
}

/// Sub-millisecond seconds used by windowed (chunked) filters, where cut
/// boundaries fall between millisecond marks.
fn fmt_secs(value: f64) -> String {
    format!("{:.6}", value)
}

/// Escape a path for the concat demuxer list file: the demuxer treats `\`
/// (escape char) and `'` (quoting) as special, so paths go in as forward-
/// slashes with embedded quotes escaped.
fn escape_concat_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "\\'")
}

/// `-tag:v hvc1` marks HEVC output as compatible with players that reject the
/// `hev1` brand — applied to finished MP4 files only (the standalone pass and
/// the concat mux), never to chunk intermediates (mpegts has no brand).
fn hvc1_tag_args(settings: &ExportSettings) -> &'static [&'static str] {
    if settings.codec == "hevc" {
        &["-tag:v", "hvc1"]
    } else {
        &[]
    }
}

/// Concat list for chunk intermediates. `.ts` slices carry no reliable
/// duration metadata, so each entry pins `frames/fps` — keeps the demuxer's
/// timeline (and the muxed duration) exact across seams.
fn chunk_concat_list(entries: &[(PathBuf, u64)], fps: u64) -> String {
    entries
        .iter()
        .map(|(path, frames)| {
            format!(
                "file '{}'\nduration {:.6}",
                escape_concat_path(path),
                *frames as f64 / fps.max(1) as f64
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Frame-exact `[first_frame, end_frame)` ranges covering `total_frames`.
/// Every chunk except the last is exactly `chunk_frames` long, so the concat
/// reproduces the single-pass frame count precisely.
fn chunk_boundaries(total_frames: u64, chunk_frames: u64) -> Vec<(u64, u64)> {
    let mut boundaries = Vec::new();
    let mut start = 0;
    while start < total_frames {
        let end = (start + chunk_frames).min(total_frames);
        boundaries.push((start, end));
        start = end;
    }
    boundaries
}

/// Chunked rendering pays a fixed per-chunk cost — an extra FFmpeg process
/// and a re-decoded source prefix — and only wins when slices run side by
/// side. Short exports and low-core machines keep the single pass; GIF/WebP
/// presets stay single-pass because they stream through special muxer-level
/// filters that don't slice cleanly.
fn should_render_chunked(plan: &RenderPlan, settings: &ExportSettings) -> bool {
    if settings.container == "gif" || settings.preset.starts_with("gif-") {
        return false;
    }
    if settings.container == "webp" || settings.preset.starts_with("webp-") {
        return false;
    }
    let Some(canvas) = plan.canvas.as_ref() else {
        return false;
    };
    if canvas.fps == 0 {
        return false;
    }
    if plan.duration_ms < 20_000 {
        return false;
    }
    std::thread::available_parallelism()
        .map(|count| count.get() >= 4)
        .unwrap_or(false)
}

/// Render the composition as parallel frame-exact chunks: each chunk runs its
/// own FFmpeg process with a `window`-shifted filter graph, audio renders
/// once as a single continuous track, and the slices are joined by a
/// stream-copying concat mux. The single pass is bottlenecked on serial
/// stages (zoompan, the overlay composites), so it leaves a hardware encoder
/// mostly idle — N chunk pipelines multiply throughput up to the worker
/// count without changing the emitted frames.
#[allow(clippy::too_many_arguments)]
fn render_timeline_chunked(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    encoder: encoding::ExportEncoder,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    on_progress: &(dyn Fn(f64) + Sync),
    resource_dir: Option<&Path>,
    shared: &CompositionShared,
) -> Result<RenderOutcome> {
    let canvas = plan
        .canvas
        .as_ref()
        .ok_or_else(|| InternalError::Media("render plan has no canvas".into()))?;
    let fps = canvas.fps.max(1) as u64;
    let total_frames = plan
        .duration_ms
        .saturating_mul(fps)
        .saturating_add(999)
        .checked_div(1000)
        .unwrap_or(1)
        .max(1);
    // Half the cores per pass keeps each process's encode/decode thread pools
    // from drowning the serial filter stages; ~2 chunks per worker absorbs
    // uneven slice costs.
    let workers = std::thread::available_parallelism()
        .map(|count| (count.get() / 2).clamp(2, 4))
        .unwrap_or(2);
    // Each pass caps its filter-graph and software-encoder threads to a fair
    // share of the machine; without it N parallel FFmpeg processes oversubscribe.
    let pass_threads = std::thread::available_parallelism()
        .map(|count| (count.get() / workers).max(2))
        .unwrap_or(2);
    let chunk_frames = total_frames
        .div_ceil((workers * 2) as u64)
        .max(fps.saturating_mul(2));
    let boundaries = chunk_boundaries(total_frames, chunk_frames);
    if boundaries.len() <= 1 {
        return render_composition_window(
            ffmpeg_path,
            output_path,
            plan,
            project_id,
            asset_paths,
            settings,
            encoder,
            cancel,
            None,
            on_progress,
            resource_dir,
            shared,
            &CompositionWindow::full(plan),
            &CompositionPass::standalone(),
        );
    }
    info!(
        %project_id,
        chunks = boundaries.len(),
        workers,
        total_frames,
        "export: rendering timeline in parallel chunks"
    );

    // Intermediates live in their own temp dir; the guard removes everything
    // on both the success and failure paths.
    let chunk_dir = std::env::temp_dir().join(format!(
        "recordforge_chunks_{}_{}",
        project_id,
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&chunk_dir)
        .map_err(|error| InternalError::Storage(format!("create chunk dir: {error}")))?;
    let _chunk_guard = TempExportDir(chunk_dir.clone());

    // Audio renders once as a single pass: muxing an intact AAC track avoids
    // the per-chunk priming gaps chunked audio would introduce at each seam.
    let audio_inputs = collect_input_assets(plan, asset_paths)?;
    let audio_input_indices: HashMap<String, usize> = audio_inputs
        .iter()
        .enumerate()
        .map(|(index, (asset_id, _))| (asset_id.clone(), index))
        .collect();
    let mut audio_filters = Vec::new();
    let has_audio = append_audio_graph(
        &mut audio_filters,
        plan,
        project_id,
        &audio_input_indices,
        asset_paths,
        &shared.probe,
        plan.duration_ms.max(1),
        &cancel,
    )?;
    let audio_path = chunk_dir.join("audio.m4a");
    let audio_filter_path = chunk_dir.join("audio-filter.txt");
    if has_audio {
        std::fs::write(&audio_filter_path, audio_filters.join(";\n"))
            .map_err(|error| InternalError::Storage(format!("write audio filters: {error}")))?;
    }
    // Embedded chapters are injected by the mux stage so they land exactly
    // once on the finished container.
    let chapters_path = chunk_dir.join("chapters.ffmeta");
    let has_chapters = (settings.chapter_mode == "embed" || settings.chapter_mode == "both")
        && !plan.chapters.is_empty();
    if has_chapters {
        std::fs::write(
            &chapters_path,
            generate_ffmetadata(project_id, &plan.chapters),
        )
        .map_err(|error| InternalError::Storage(format!("write chapters metadata: {error}")))?;
    }

    // Job queue: job 0 is the audio render when present, then one job per
    // chunk. Workers share `halt` — a failure or cancel stops every sibling
    // pass immediately rather than finishing dead work.
    let audio_job = has_audio;
    let job_count = boundaries.len() + usize::from(audio_job);
    let weights: Vec<f64> = boundaries
        .iter()
        .map(|(first, end)| (end - first) as f64)
        .collect();
    // The audio pass is a fraction of a video slice's work; give it a small
    // weight so progress stays roughly linear.
    let audio_weight = (total_frames as f64 * 0.05).max(1.0);
    let total_weight: f64 =
        weights.iter().sum::<f64>() + if audio_job { audio_weight } else { 0.0 };
    let next_job = std::sync::atomic::AtomicUsize::new(0);
    let halt = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let progress_parts = Mutex::new(vec![0f64; job_count]);
    let first_error: Mutex<Option<crate::errors::AppError>> = Mutex::new(None);

    let run_job = |job: usize| -> Result<()> {
        let report = |ratio: f64| {
            if let Ok(mut parts) = progress_parts.lock() {
                parts[job] = ratio;
                let mut sum = 0.0;
                for (index, weight) in weights.iter().enumerate() {
                    sum += parts[usize::from(audio_job) + index] * weight;
                }
                if audio_job {
                    sum += parts[0] * audio_weight;
                }
                on_progress(sum / total_weight);
            }
        };
        if audio_job && job == 0 {
            let mut command = crate::process::create_command(ffmpeg_path);
            command
                .arg("-y")
                .arg("-hide_banner")
                .arg("-loglevel")
                .arg("error")
                .arg("-threads")
                .arg("0")
                .arg("-progress")
                .arg("pipe:2")
                .arg("-thread_queue_size")
                .arg("128");
            for (_, path) in &audio_inputs {
                command.arg("-i").arg(path);
            }
            command
                .arg("-/filter_complex")
                .arg(&audio_filter_path)
                .args(["-map", "[aout]"])
                .args(["-c:a", "aac", "-b:a", audio_bitrate(settings)])
                .args(["-f", "mp4"])
                .args(["-t", &seconds(plan.duration_ms)])
                .arg(&audio_path);
            run_export_ffmpeg(
                &mut command,
                &cancel,
                Some(&halt),
                &audio_path,
                "audio render",
                Some(plan.duration_ms),
                None,
                Some(&report),
            )
        } else {
            let chunk_index = job - usize::from(audio_job);
            let (first_frame, end_frame) = boundaries[chunk_index];
            let chunk_path = chunk_dir.join(format!("chunk_{chunk_index:05}.ts"));
            let window = CompositionWindow::from_frames(first_frame, end_frame - first_frame, fps);
            let pass = CompositionPass {
                standalone: false,
                include_audio: false,
                plate_divisor: workers,
                threads: pass_threads,
            };
            render_composition_window(
                ffmpeg_path,
                &chunk_path,
                plan,
                project_id,
                asset_paths,
                settings,
                encoder,
                cancel.clone(),
                Some(&halt),
                &report,
                resource_dir,
                shared,
                &window,
                &pass,
            )
            // Chunk pass outcomes are all video-only; the audio job's own
            // result decides `has_audio` for the mux stage.
            .map(|_| ())
        }
    };

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if cancel.load(std::sync::atomic::Ordering::Relaxed)
                    || halt.load(std::sync::atomic::Ordering::Relaxed)
                {
                    return;
                }
                let job = next_job.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if job >= job_count {
                    return;
                }
                if let Err(error) = run_job(job) {
                    let mut guard = first_error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if guard.is_none() {
                        *guard = Some(error);
                    }
                    drop(guard);
                    halt.store(true, std::sync::atomic::Ordering::Relaxed);
                    return;
                }
            });
        }
    });

    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(InternalError::Media("export cancelled".into()).into());
    }
    if let Some(error) = first_error
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        return Err(error);
    }

    let list_path = chunk_dir.join("chunks.txt");
    let entries: Vec<(PathBuf, u64)> = boundaries
        .iter()
        .enumerate()
        .map(|(index, (first, end))| (chunk_dir.join(format!("chunk_{index:05}.ts")), end - first))
        .collect();
    std::fs::write(&list_path, chunk_concat_list(&entries, fps))
        .map_err(|error| InternalError::Storage(format!("write concat list: {error}")))?;

    let mut mux = crate::process::create_command(ffmpeg_path);
    mux.arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path);
    let mut mux_input_index = 1;
    if has_audio {
        mux.arg("-i").arg(&audio_path);
        mux_input_index += 1;
    }
    if has_chapters {
        mux.args(["-f", "ffmetadata", "-i"]).arg(&chapters_path);
    }
    mux.args(["-map", "0:v"]);
    if has_audio {
        mux.args(["-map", "1:a"]);
    }
    if has_chapters {
        mux.args(["-map_chapters", &mux_input_index.to_string()]);
    }
    mux.args(["-c", "copy", "-movflags", "+faststart"]);
    mux.args(hvc1_tag_args(settings));
    mux.args(["-t", &seconds(plan.duration_ms)])
        .arg(output_path);
    on_progress(0.98);
    run_export_ffmpeg(
        &mut mux,
        &cancel,
        None,
        output_path,
        "concat mux",
        Some(plan.duration_ms),
        None,
        Some(&|_| on_progress(0.98)),
    )?;

    info!(
        %project_id,
        chunks = boundaries.len(),
        "export: chunked render muxed"
    );
    Ok(RenderOutcome { has_audio })
}

/// Build one cursor renderer per enabled effect. Renderers are pure functions
/// of the output timestamp and the plan — they never read rendered video, which
/// is what allows the cursor layer to be composited in the same FFmpeg pass.
fn build_cursor_renderers(
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    canvas: &cursor::RenderCanvas,
    screen_rect: (f64, f64, f64, f64),
    screen_windows: Option<Vec<cursor::ScreenRectWindow>>,
) -> Result<Vec<(u64, u64, cursor::CursorRenderer)>> {
    // One shared engine per telemetry asset — cursor ranges of the same
    // capture reuse a single smoothed event pipeline.
    let mut engines: HashMap<String, Option<Arc<Mutex<cursor_engine::CursorEngine>>>> =
        HashMap::new();
    let mut renderers = Vec::new();
    for effect in plan
        .cursor_effects
        .iter()
        .filter(|effect| effect.enabled && effect.end_ms > effect.start_ms)
    {
        let engine = match engines.entry(effect.asset_id.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => {
                // A previously-diagnosed asset stays skipped (`None`).
                entry.get().clone()
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                let engine = load_cursor_engine(project_id, &effect.asset_id, asset_paths)?;
                entry.insert(engine.clone());
                engine
            }
        };
        let Some(engine) = engine else {
            continue;
        };
        if engine
            .lock()
            .expect("cursor engine")
            .telemetry()
            .events
            .is_empty()
        {
            continue;
        }
        let settings = cursor_settings_for_effect(&canvas.cursor_settings, effect);
        let renderer = cursor::CursorRenderer::new_with_engine(
            settings,
            engine,
            &plan.segments,
            &plan.zoom_segments,
            canvas,
            Some(screen_rect),
            screen_windows.clone(),
        )
        .map_err(|error| InternalError::Media(format!("prepare cursor overlay: {error}")))?;
        renderers.push((effect.start_ms, effect.end_ms, renderer));
    }
    if renderers.is_empty() {
        tracing::warn!(%project_id, "cursor telemetry is unavailable; exporting without a cursor overlay");
    }
    Ok(renderers)
}

/// Load cursor telemetry once and build the shared engine for it.
/// `Ok(None)` means the asset is degraded enough to skip cursor rendering.
fn load_cursor_engine(
    project_id: &str,
    asset_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
) -> Result<Option<Arc<Mutex<cursor_engine::CursorEngine>>>> {
    let telemetry_path = asset_paths.get(asset_id).ok_or_else(|| {
        InternalError::Permissions("cursor effect references a missing asset".into())
    })?;
    let work_dir = telemetry_path
        .parent()
        .ok_or_else(|| InternalError::Storage("cursor telemetry path has no parent".into()))?;
    let v2 = crate::capture::cursor::read_any_telemetry(work_dir).ok_or_else(|| {
        InternalError::Storage("cursor telemetry asset is missing or corrupt".into())
    })?;

    // Degraded telemetry should not crash the export. Position loss means
    // there is nothing to render; missing shapes/topology still allow the
    // configured preset cursor to be drawn.
    match v2.metadata.health {
        crate::capture::cursor::CursorTelemetryHealth::PositionUnavailable => {
            tracing::warn!(
                %project_id,
                %asset_id,
                "cursor position unavailable; exporting without cursor overlay"
            );
            return Ok(None);
        }
        crate::capture::cursor::CursorTelemetryHealth::ShapesUnavailable => {
            tracing::info!(
                %project_id,
                %asset_id,
                "cursor shape metadata unavailable; using preset fallback"
            );
        }
        _ => {}
    }

    let telemetry = cursor_engine::CursorTelemetryFile::from(&v2);
    if telemetry.events.is_empty() {
        return Ok(None);
    }
    let engine =
        cursor_engine::CursorEngine::new(telemetry, cursor_engine::CursorEngineOptions::default())
            .map_err(|error| InternalError::Media(format!("prepare cursor engine: {error}")))?;
    Ok(Some(Arc::new(Mutex::new(engine))))
}

/// Preallocated state for streaming generated overlay frames into FFmpeg's
/// stdin. When `dual_plane` is set each frame packs two canvas-sized planes
/// side by side — cursor on the left, overlay items on the right — so the
/// filter graph can composite them at different stack positions.
#[allow(dead_code)]
struct CursorFramePlan {
    fps: u32,
    /// Dimensions of each plane written to FFmpeg's stdin. Equal to the canvas
    /// size except for a cursor-only stream, where the plane is the fitted
    /// screen rect — the cursor is clipped to that rect, so shipping the
    /// smaller plane cuts rasterization, pipe, and composite work by the
    /// padding fraction for free.
    width: u32,
    height: u32,
    /// Canvas size the cursor renderer draws into before the cursor rect is
    /// cropped out. Only differs from `width`/`height` for cursor-only plans.
    canvas_width: u32,
    canvas_height: u32,
    /// Canvas-space rect the cursor plane is cropped to before streaming, and
    /// where the graph composites it back (`overlay=x:y`). `None` keeps the
    /// plane at full canvas size.
    cursor_rect: Option<(u32, u32, u32, u32)>,
    frame_count: u64,
    /// Absolute output index of the first frame this plan emits. Nonzero only
    /// for chunked renders, where each pass feeds the plate frames
    /// `[first_frame_index, first_frame_index + frame_count)` — renderer
    /// timestamps are absolute, so the offset is applied at render time.
    first_frame_index: u64,
    /// Share of the machine this feed may use for producer workers and memory
    /// budgets. Chunked renders run several FFmpeg processes concurrently, so
    /// each divides its budgets by this factor; 1 is the single-pass default.
    parallel_divisor: usize,
    dual_plane: bool,
    renderers: Vec<(u64, u64, cursor::CursorRenderer)>,
    overlay_engine: Option<overlay_engine::OverlayEngine>,
}

fn prepare_cursor_frame_plan(
    canvas: &cursor::RenderCanvas,
    duration_ms: u64,
    renderers: Vec<(u64, u64, cursor::CursorRenderer)>,
    plan: &RenderPlan,
    asset_paths: &HashMap<String, PathBuf>,
    screen_rect: (f64, f64, f64, f64),
) -> Result<CursorFramePlan> {
    // Validate the canvas pixmap can be allocated up front; each producer
    // worker allocates its own copy when feeding starts.
    if resvg::tiny_skia::Pixmap::new(canvas.width, canvas.height).is_none() {
        return Err(InternalError::Media("overlay frame is too large".into()).into());
    }
    let frame_count = duration_ms
        .saturating_mul(canvas.fps as u64)
        .saturating_add(999)
        .checked_div(1000)
        .unwrap_or(1)
        .max(1);

    let overlay_plan: Option<overlay_engine::OverlayRenderPlan> = if let Some(value) =
        &plan.overlay_render_plan
    {
        Some(serde_json::from_value(value.clone()).map_err(|error| {
            InternalError::Media(format!("overlay render plan is invalid: {error}"))
        })?)
    } else if !plan.annotations.is_empty() || !plan.texts.is_empty() || !plan.images.is_empty() {
        Some(annotations::build_overlay_render_plan_from_legacy(
            canvas.width,
            canvas.height,
            &plan.annotations,
            &plan.texts,
            &plan.images,
        ))
    } else {
        None
    };

    let overlay_engine = if let Some(mut parsed_plan) = overlay_plan {
        if parsed_plan.items.is_empty() {
            // An empty items list would only force the dual-plane stream to
            // carry a permanently transparent half, so skip the engine too.
            None
        } else {
            parsed_plan.canvas = overlay_engine::OverlayCanvas {
                width: canvas.width,
                height: canvas.height,
            };
            let mut image_asset_ids = std::collections::BTreeSet::new();
            image_asset_ids.extend(plan.images.iter().map(|image| image.asset_id.clone()));
            image_asset_ids.extend(parsed_plan.assets.iter().map(|asset| asset.id.clone()));
            let mut engine =
                overlay_engine::OverlayEngine::from_render_plan(parsed_plan).map_err(|error| {
                    InternalError::Media(format!("build overlay render plan: {error}"))
                })?;
            for asset_id in image_asset_ids {
                let path = asset_paths.get(&asset_id).ok_or_else(|| {
                    InternalError::Permissions("overlay references a missing image asset".into())
                })?;
                register_overlay_image_asset(&mut engine, &asset_id, path)?;
            }
            Some(engine)
        }
    } else {
        None
    };

    let dual_plane = !renderers.is_empty() && overlay_engine.is_some();
    // Only a pure cursor stream can shrink to the fitted screen rect: overlay
    // items draw in canvas coordinates, and the dual-plane stream needs both
    // halves at the same size.
    let cursor_rect = if overlay_engine.is_none() && !renderers.is_empty() {
        let (sx, sy, sw, sh) = screen_rect;
        // The renderers clip every draw to this rect (rounded ints, matching
        // `ClipRect` construction in cursor.rs), so the crop covers all drawn
        // pixels exactly; clamp to the canvas for degenerate rect inputs.
        let x = sx.round().clamp(0.0, canvas.width.saturating_sub(1) as f64) as u32;
        let y = sy
            .round()
            .clamp(0.0, canvas.height.saturating_sub(1) as f64) as u32;
        let w = (sw.round().max(1.0) as u32).min(canvas.width - x);
        let h = (sh.round().max(1.0) as u32).min(canvas.height - y);
        Some((x, y, w, h))
    } else {
        None
    };
    let (plane_w, plane_h) = cursor_rect
        .map(|(_, _, w, h)| (w, h))
        .unwrap_or((canvas.width, canvas.height));
    Ok(CursorFramePlan {
        fps: canvas.fps,
        width: plane_w,
        height: plane_h,
        canvas_width: canvas.width,
        canvas_height: canvas.height,
        cursor_rect,
        frame_count,
        first_frame_index: 0,
        parallel_divisor: 1,
        dual_plane,
        renderers,
        overlay_engine,
    })
}

fn register_overlay_image_asset(
    engine: &mut overlay_engine::OverlayEngine,
    asset_id: &str,
    path: &Path,
) -> Result<()> {
    if crate::media::svg::is_svg_path(path) {
        let svg_bytes = crate::media::svg::read_safe_svg(path)
            .map_err(|error| InternalError::Media(format!("read overlay SVG: {error}")))?;
        engine
            .register_image_svg(asset_id, &svg_bytes)
            .map_err(|error| InternalError::Media(format!("decode overlay SVG: {error}")))?;
    } else {
        let bytes = std::fs::read(path)
            .map_err(|error| InternalError::Media(format!("read overlay image: {error}")))?;
        let png_bytes = if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        {
            bytes
        } else {
            let image = image::load_from_memory(&bytes)
                .map_err(|error| InternalError::Media(format!("decode overlay image: {error}")))?;
            let mut encoded = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut encoded, image::ImageFormat::Png)
                .map_err(|error| InternalError::Media(format!("convert overlay image: {error}")))?;
            encoded.into_inner()
        };
        engine
            .register_image_png(asset_id, &png_bytes)
            .map_err(|error| InternalError::Media(format!("decode overlay image: {error}")))?;
    }
    Ok(())
}

/// Pack two `plane_w`×`plane_h` RGBA planes into one side-by-side
/// `2*plane_w`×`plane_h` frame. A missing plane contributes transparent
/// pixels so the corresponding filter-graph composite becomes a no-op.
fn pack_overlay_planes(
    dst: &mut [u8],
    plane_w: usize,
    plane_h: usize,
    left: Option<&[u8]>,
    right: Option<&[u8]>,
) {
    let plane_row_bytes = plane_w * 4;
    let frame_row_bytes = plane_row_bytes * 2;
    debug_assert_eq!(dst.len(), frame_row_bytes * plane_h);
    for row in 0..plane_h {
        let src_rows = row * plane_row_bytes..(row + 1) * plane_row_bytes;
        let dst_row = &mut dst[row * frame_row_bytes..(row + 1) * frame_row_bytes];
        match left {
            Some(plane) => dst_row[..plane_row_bytes].copy_from_slice(&plane[src_rows.clone()]),
            None => dst_row[..plane_row_bytes].fill(0),
        }
        match right {
            Some(plane) => dst_row[plane_row_bytes..].copy_from_slice(&plane[src_rows]),
            None => dst_row[plane_row_bytes..].fill(0),
        }
    }
}

/// Copy the `x,y,w,h` rect out of an RGBA buffer whose rows are `stride_w`
/// pixels wide into a tightly packed `w`×`h` plane.
fn crop_rgba_region(
    src: &[u8],
    stride_w: usize,
    x: usize,
    y: usize,
    w: usize,
    h: usize,
) -> Vec<u8> {
    let row_bytes = w * 4;
    let mut out = vec![0u8; row_bytes * h];
    let src_stride = stride_w * 4;
    for row in 0..h {
        let src_start = (y + row) * src_stride + x * 4;
        out[row * row_bytes..(row + 1) * row_bytes]
            .copy_from_slice(&src[src_start..src_start + row_bytes]);
    }
    out
}

/// One produced overlay frame: rasterized bytes, a fully transparent frame
/// (the writer holds a shared zero buffer), or a worker failure.
enum ProducedFrame {
    Bytes(Vec<u8>),
    Zero,
    Failed(String),
}

/// (cursor plane, items plane) for one output frame. The items plane is `Arc`
/// because the cached render is shared across frames while the evaluated
/// display list is unchanged.
type FramePlanes = (Option<Vec<u8>>, Option<Arc<Vec<u8>>>);

/// Per-worker raster state. Cursor and overlay engines are cloned per worker
/// because `CursorEngine` keeps a `RefCell` smoothing cache and tiny-skia
/// pixmaps are single-owner; the engines are pure functions of the frame
/// timestamp, so per-worker copies produce identical output.
struct OverlayWorkerState {
    renderers: Vec<(u64, u64, cursor::CursorRenderer)>,
    overlay_engine: Option<overlay_engine::OverlayEngine>,
    cursor_pixmap: resvg::tiny_skia::Pixmap,
    /// Canvas-space rect the finished cursor plane is cropped to before it is
    /// written to FFmpeg. `None` ships the full canvas (items planes and the
    /// halves of a dual-plane frame are always full-canvas).
    cursor_rect: Option<(u32, u32, u32, u32)>,
    items_layer: Option<resvg::tiny_skia::Pixmap>,
    last_display_items: Option<Vec<overlay_engine::DisplayItem>>,
    cached_unpremultiplied_frame: Option<Arc<Vec<u8>>>,
}

impl OverlayWorkerState {
    fn new(
        renderers: Vec<(u64, u64, cursor::CursorRenderer)>,
        overlay_engine: Option<overlay_engine::OverlayEngine>,
        width: u32,
        height: u32,
        cursor_rect: Option<(u32, u32, u32, u32)>,
    ) -> std::result::Result<Self, String> {
        let cursor_pixmap = resvg::tiny_skia::Pixmap::new(width, height)
            .ok_or_else(|| "allocate cursor pixmap failed".to_string())?;
        Ok(Self {
            renderers,
            overlay_engine,
            cursor_pixmap,
            cursor_rect,
            items_layer: None,
            last_display_items: None,
            cached_unpremultiplied_frame: None,
        })
    }

    /// Render the logical frame planes for `frame_index`, reusing the cached
    /// items plane while the evaluated display list is unchanged. The cursor
    /// plane is per-frame telemetry and is re-rendered whenever an effect is
    /// active at the frame's exact CFR timestamp.
    fn render_planes(
        &mut self,
        frame_index: u64,
        fps: u32,
    ) -> std::result::Result<FramePlanes, String> {
        let output_time_ms = cursor::frame_time_ms(frame_index, fps);
        let overlay_time_ms = output_time_ms.floor().max(0.0) as u64;

        if let Some(engine) = &self.overlay_engine {
            let display_list = engine.evaluate(overlay_time_ms);
            if display_list.items.is_empty() {
                self.last_display_items = Some(Vec::new());
                self.cached_unpremultiplied_frame = None;
            } else if self.last_display_items.as_ref() != Some(&display_list.items) {
                let layer = match &mut self.items_layer {
                    Some(layer) => layer,
                    None => {
                        self.items_layer = Some(
                            resvg::tiny_skia::Pixmap::new(
                                self.cursor_pixmap.width(),
                                self.cursor_pixmap.height(),
                            )
                            .ok_or_else(|| "allocate overlay pixmap failed".to_string())?,
                        );
                        self.items_layer
                            .as_mut()
                            .expect("items layer just assigned")
                    }
                };
                layer.fill(resvg::tiny_skia::Color::TRANSPARENT);
                engine
                    .render_to_pixmap(overlay_time_ms, layer)
                    .map_err(|error| format!("render overlay frame: {error}"))?;
                let mut unprem = layer.data().to_vec();
                cursor::unpremultiply_rgba_bounded(
                    &mut unprem,
                    self.cursor_pixmap.width() as usize,
                );
                self.cached_unpremultiplied_frame = Some(Arc::new(unprem));
                self.last_display_items = Some(display_list.items);
            }
        }
        let items_plane = self.cached_unpremultiplied_frame.clone();

        let cursor_plane = match self.renderers.iter_mut().find(|(start_ms, end_ms, _)| {
            output_time_ms >= *start_ms as f64 && output_time_ms < *end_ms as f64
        }) {
            Some((_, _, renderer)) => {
                self.cursor_pixmap
                    .fill(resvg::tiny_skia::Color::TRANSPARENT);
                renderer.render_frame_at(output_time_ms, self.cursor_pixmap.data_mut());
                match self.cursor_rect {
                    // Crop to the fitted screen rect first — every drawn pixel
                    // is clipped to it — then unpremultiply only the drawn
                    // bounding box inside the smaller plane.
                    Some((rx, ry, rw, rh)) => {
                        let mut plane = crop_rgba_region(
                            self.cursor_pixmap.data(),
                            self.cursor_pixmap.width() as usize,
                            rx as usize,
                            ry as usize,
                            rw as usize,
                            rh as usize,
                        );
                        cursor::unpremultiply_rgba_bounded(&mut plane, rw as usize);
                        Some(plane)
                    }
                    None => {
                        let stride = self.cursor_pixmap.width() as usize;
                        cursor::unpremultiply_rgba_bounded(self.cursor_pixmap.data_mut(), stride);
                        Some(self.cursor_pixmap.data().to_vec())
                    }
                }
            }
            None => None,
        };

        Ok((cursor_plane, items_plane))
    }
}

/// How many overlay raster workers to run beside the writer. Rendering is the
/// dominant producer cost (tiny-skia + full-canvas unpremultiply + pack), so
/// half the cores keeps the pipe fed without starving the FFmpeg filter graph.
fn producer_worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|count| (count.get() / 2).clamp(2, 8))
        .unwrap_or(2)
}

/// Stream every composited overlay frame into FFmpeg's stdin.
///
/// In dual-plane mode each frame is `2*width`×`height`: the left half carries
/// the cursor plane composited below camera overlays, the right half carries
/// the annotation/text/image plane composited above them. The overlay graph
/// uses shortest=1, so FFmpeg stops reading stdin as soon as the composed
/// video ends. Feeding ceil(duration*fps) frames can exceed that by one frame;
/// a closed pipe here means the consumer finished, and the exit-status check
/// in the runner decides whether the render actually failed.
///
/// Frames are rasterized on a bounded worker pool — a serial producer
/// (rasterize + unpremultiply + pack + pipe write per frame) is the export
/// pipeline's slowest stage and leaves the hardware encoder idle. The writer
/// reorders worker output so the rawvideo stream stays strictly CFR.
fn feed_cursor_frames(
    stdin: &mut std::process::ChildStdin,
    cursor: &mut CursorFramePlan,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    halt: Option<&Arc<std::sync::atomic::AtomicBool>>,
) -> Result<()> {
    let mut writer = std::io::BufWriter::with_capacity(256 * 1024, stdin);
    let plane_w = cursor.width as usize;
    let plane_h = cursor.height as usize;
    let plane_byte_len = plane_w * plane_h * 4;
    let frame_byte_len = if cursor.dual_plane {
        plane_byte_len * 2
    } else {
        plane_byte_len
    };
    let zero_frame = vec![0u8; frame_byte_len];
    let frame_count = cursor.frame_count;

    // Each worker keeps roughly five live frames (two pixmaps, the cursor
    // copy, the shared items plane, and the packed buffer); cap the pool so a
    // 4K dual-plane canvas stays near ~768 MiB of producer state. Chunked
    // renders share the machine across passes, so both budgets divide by the
    // plan's parallel factor.
    let divisor = cursor.parallel_divisor.max(1);
    let workers = (producer_worker_count() / divisor)
        .max(1)
        .min(((768usize * 1024 * 1024) / divisor / (frame_byte_len.max(1) * 5)).max(2));
    // Bounded in-flight window caps peak memory at ~256 MiB of finished frames
    // while keeping enough work queued to hide render-time variance.
    let window = ((256usize * 1024 * 1024) / divisor / frame_byte_len.max(1))
        .clamp(workers + 2, 64)
        .min(frame_count.max(1) as usize) as u64;
    if workers <= 1 || frame_count <= 1 {
        return feed_cursor_frames_sequential(
            &mut writer,
            cursor,
            cancel,
            halt,
            frame_byte_len,
            &zero_frame,
        );
    }

    struct Dispatch {
        next: u64,
        limit: u64,
    }
    let dispatch = Mutex::new(Dispatch {
        next: 0,
        limit: window,
    });
    let dispatch_changed = std::sync::Condvar::new();
    let abort = std::sync::atomic::AtomicBool::new(false);
    let (frame_tx, frame_rx) = std::sync::mpsc::channel::<(u64, ProducedFrame)>();
    // Finished buffers are recycled back to workers to avoid an 8-33 MiB
    // allocation + zeroing on every frame. Only the dual-plane branch below
    // pops them — on a single-plane stream pushing every finished frame
    // would grow the pool by one plate per frame until memory is exhausted.
    let free_buffers = Mutex::new(Vec::<Vec<u8>>::new());
    let dual_plane = cursor.dual_plane;
    let halted = || halt.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));

    let result = std::thread::scope(|scope| -> Result<()> {
        for _ in 0..workers {
            let dispatch = &dispatch;
            let dispatch_changed = &dispatch_changed;
            let abort = &abort;
            let cancel = &*cancel;
            let frame_tx = frame_tx.clone();
            let free_buffers = &free_buffers;
            // The renderers/engine are cloned per worker here so the spawned
            // closure only moves owned `Send` state; `CursorEngine` is `!Sync`.
            let renderers = cursor.renderers.clone();
            let overlay_engine = cursor.overlay_engine.clone();
            let width = cursor.canvas_width;
            let height = cursor.canvas_height;
            let cursor_rect = cursor.cursor_rect;
            let fps = cursor.fps;
            let first_frame_index = cursor.first_frame_index;
            scope.spawn(move || {
                let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut state = match OverlayWorkerState::new(
                        renderers,
                        overlay_engine,
                        width,
                        height,
                        cursor_rect,
                    ) {
                        Ok(state) => state,
                        Err(error) => {
                            let _ = frame_tx.send((0, ProducedFrame::Failed(error)));
                            return;
                        }
                    };
                    loop {
                        if cancel.load(std::sync::atomic::Ordering::Relaxed)
                            || abort.load(std::sync::atomic::Ordering::Relaxed)
                            || halt
                                .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
                        {
                            return;
                        }
                        let frame_index = {
                            let mut guard = dispatch
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            loop {
                                if abort.load(std::sync::atomic::Ordering::Relaxed)
                                    || halt.is_some_and(|flag| {
                                        flag.load(std::sync::atomic::Ordering::Relaxed)
                                    })
                                    || guard.next >= frame_count
                                {
                                    return;
                                }
                                if guard.next < guard.limit {
                                    let index = guard.next;
                                    guard.next += 1;
                                    break index;
                                }
                                guard = dispatch_changed
                                    .wait(guard)
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                            }
                        };

                        let produced = state
                            .render_planes(frame_index + first_frame_index, fps)
                            .map(|(cursor_plane, items_plane)| {
                                if dual_plane {
                                    if cursor_plane.is_none() && items_plane.is_none() {
                                        return ProducedFrame::Zero;
                                    }
                                    let mut buffer = free_buffers
                                        .lock()
                                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                                        .pop()
                                        .unwrap_or_else(|| vec![0u8; frame_byte_len]);
                                    buffer.resize(frame_byte_len, 0);
                                    pack_overlay_planes(
                                        &mut buffer,
                                        plane_w,
                                        plane_h,
                                        cursor_plane.as_deref(),
                                        items_plane.as_ref().map(|plane| plane.as_slice()),
                                    );
                                    ProducedFrame::Bytes(buffer)
                                } else {
                                    match cursor_plane.or_else(|| items_plane.map(arc_into_vec)) {
                                        Some(plane) => ProducedFrame::Bytes(plane),
                                        None => ProducedFrame::Zero,
                                    }
                                }
                            })
                            .unwrap_or_else(ProducedFrame::Failed);

                        let is_failure = matches!(produced, ProducedFrame::Failed(_));
                        if frame_tx.send((frame_index, produced)).is_err() {
                            return;
                        }
                        if is_failure {
                            abort.store(true, std::sync::atomic::Ordering::Relaxed);
                            dispatch_changed.notify_all();
                            return;
                        }
                    }
                }));
                if run.is_err() {
                    let _ = frame_tx.send((
                        u64::MAX,
                        ProducedFrame::Failed("overlay worker panicked".to_string()),
                    ));
                }
            });
        }
        // The scope owns the receiver side; dropping our sender clone lets the
        // channel close once every worker exits. recycle_tx stays alive for the
        // writer loop below.
        drop(frame_tx);

        let mut expected = 0u64;
        let mut pending = std::collections::BTreeMap::new();
        let result: Result<()> = (|| {
            while expected < frame_count {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) || halted() {
                    return Err(InternalError::Media("export cancelled".into()).into());
                }
                let (frame_index, produced) = match frame_rx.recv() {
                    Ok(message) => message,
                    Err(_) => {
                        // Every sender is gone before all frames arrived: only
                        // an unreported worker exit can leave a permanent gap.
                        if expected < frame_count
                            && !cancel.load(std::sync::atomic::Ordering::Relaxed)
                            && !halted()
                        {
                            return Err(InternalError::Media(
                                "overlay frame producer terminated early".into(),
                            )
                            .into());
                        }
                        break;
                    }
                };
                match produced {
                    ProducedFrame::Failed(error) => {
                        abort.store(true, std::sync::atomic::Ordering::Relaxed);
                        dispatch_changed.notify_all();
                        return Err(InternalError::Media(error).into());
                    }
                    produced => {
                        pending.insert(frame_index, produced);
                    }
                }
                while let Some(produced) = pending.remove(&expected) {
                    let written = match &produced {
                        ProducedFrame::Zero => writer.write_all(&zero_frame),
                        ProducedFrame::Bytes(bytes) => writer.write_all(bytes),
                        ProducedFrame::Failed(_) => unreachable!("failures return early"),
                    };
                    if let Err(error) = written {
                        if is_pipe_closed(&error) {
                            return Ok(());
                        }
                        return Err(
                            InternalError::Media(format!("write overlay frame: {error}")).into(),
                        );
                    }
                    if let ProducedFrame::Bytes(bytes) = produced {
                        if dual_plane {
                            free_buffers
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .push(bytes);
                        }
                    }
                    expected += 1;
                    let mut guard = dispatch
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    guard.limit = expected + window;
                    drop(guard);
                    dispatch_changed.notify_all();
                }
            }
            Ok(())
        })();
        // Wake waiting workers so the scope can join even on early exits
        // (cancel, pipe close, or failure).
        abort.store(true, std::sync::atomic::Ordering::Relaxed);
        dispatch_changed.notify_all();
        result
    });
    let _ = writer.flush();
    result
}

fn arc_into_vec(plane: Arc<Vec<u8>>) -> Vec<u8> {
    match Arc::try_unwrap(plane) {
        Ok(bytes) => bytes,
        Err(shared) => (*shared).clone(),
    }
}

/// Serial producer used when the worker pool degenerates to a single thread.
fn feed_cursor_frames_sequential(
    writer: &mut std::io::BufWriter<&mut std::process::ChildStdin>,
    cursor: &mut CursorFramePlan,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    halt: Option<&Arc<std::sync::atomic::AtomicBool>>,
    frame_byte_len: usize,
    zero_frame: &[u8],
) -> Result<()> {
    let plane_w = cursor.width as usize;
    let plane_h = cursor.height as usize;
    let mut packed_frame = if cursor.dual_plane {
        vec![0u8; frame_byte_len]
    } else {
        Vec::new()
    };
    let mut state = OverlayWorkerState::new(
        cursor.renderers.clone(),
        cursor.overlay_engine.clone(),
        cursor.canvas_width,
        cursor.canvas_height,
        cursor.cursor_rect,
    )
    .map_err(InternalError::Media)?;

    for frame_index in 0..cursor.frame_count {
        if cancel.load(std::sync::atomic::Ordering::Relaxed)
            || halt.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
        {
            return Err(InternalError::Media("export cancelled".into()).into());
        }
        let (cursor_plane, items_plane) = state
            .render_planes(frame_index + cursor.first_frame_index, cursor.fps)
            .map_err(InternalError::Media)?;

        let frame: &[u8] = if cursor.dual_plane {
            if cursor_plane.is_none() && items_plane.is_none() {
                zero_frame
            } else {
                pack_overlay_planes(
                    &mut packed_frame,
                    plane_w,
                    plane_h,
                    cursor_plane.as_deref(),
                    items_plane.as_ref().map(|plane| plane.as_slice()),
                );
                packed_frame.as_slice()
            }
        } else {
            cursor_plane
                .as_deref()
                .or(items_plane.as_deref().map(|plane| plane.as_slice()))
                .unwrap_or(zero_frame)
        };

        if let Err(error) = writer.write_all(frame) {
            if is_pipe_closed(&error) {
                return Ok(());
            }
            return Err(InternalError::Media(format!("write overlay frame: {error}")).into());
        }
    }
    let _ = writer.flush();
    Ok(())
}

fn cursor_settings_for_effect(
    base: &cursor::CursorSettings,
    effect: &RenderPlanCursorEffect,
) -> cursor::CursorSettings {
    let mut value = serde_json::to_value(base).unwrap_or_else(|_| serde_json::json!({}));
    if let (Some(base_object), Some(effect_object)) =
        (value.as_object_mut(), effect.settings.as_object())
    {
        for (key, setting) in effect_object {
            base_object.insert(key.clone(), setting.clone());
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("enabled".into(), serde_json::Value::Bool(effect.enabled));
        object.insert(
            "preset".into(),
            serde_json::Value::String(effect.preset_id.clone()),
        );
        object.insert("scale".into(), serde_json::Value::from(effect.scale));
        if effect.smoothing == "off" {
            object.insert("smoothMovement".into(), serde_json::Value::Bool(false));
        } else {
            object.insert("smoothMovement".into(), serde_json::Value::Bool(true));
            if effect.smoothing == "strong" {
                object.insert("smoothFactor".into(), serde_json::Value::from(0.12));
            }
        }
    }
    serde_json::from_value(value).unwrap_or_else(|_| base.clone())
}

/// Legacy intermediate path from the retired two-pass cursor render, kept only
/// so cleanup removes files left behind by older app versions.
fn cursor_partial_output_path(output_path: &Path) -> PathBuf {
    let stem = output_path
        .file_stem()
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|| "export".into());
    output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.cursor.partial.mp4"))
}

fn collect_input_assets(
    plan: &RenderPlan,
    asset_paths: &HashMap<String, PathBuf>,
) -> Result<Vec<(String, PathBuf)>> {
    let mut asset_ids = std::collections::BTreeSet::new();
    asset_ids.extend(plan.segments.iter().map(|segment| segment.asset_id.clone()));
    asset_ids.extend(plan.overlays.iter().map(|overlay| overlay.asset_id.clone()));
    if let Some(tracks) = &plan.audio_tracks {
        for track in tracks {
            asset_ids.insert(track.asset_id.clone());
            asset_ids.extend(
                track
                    .segments
                    .iter()
                    .map(|segment| segment.asset_id.clone()),
            );
        }
    }
    if let Some(track) = &plan.audio {
        asset_ids.insert(track.asset_id.clone());
        asset_ids.extend(
            track
                .segments
                .iter()
                .map(|segment| segment.asset_id.clone()),
        );
    }
    for effect in plan.cursor_effects.iter().filter(|effect| effect.enabled) {
        let path = asset_paths.get(&effect.asset_id).ok_or_else(|| {
            InternalError::Permissions("cursor effect references a missing asset".into())
        })?;
        if !path.is_file() {
            return Err(InternalError::Storage("cursor effect asset is not a file".into()).into());
        }
    }

    asset_ids.retain(|id| {
        !id.starts_with("synth:") && !id.starts_with("synthetic:") && !id.starts_with("color:")
    });

    asset_ids
        .into_iter()
        .map(|asset_id| {
            let path = asset_paths.get(&asset_id).cloned().ok_or_else(|| {
                InternalError::Permissions(
                    "render plan references a missing or unauthorized asset".into(),
                )
            })?;
            if !path.is_file() {
                return Err(InternalError::Storage("render asset is not a file".into()).into());
            }
            Ok((asset_id, path))
        })
        .collect()
}

impl RenderPlan {
    pub fn validate(&self) -> Result<()> {
        if self.project_id.trim().is_empty() || self.duration_ms == 0 || self.segments.is_empty() {
            return Err(InternalError::Media(
                "render plan identity, duration, and segments are required".into(),
            )
            .into());
        }
        let canvas = self
            .canvas
            .as_ref()
            .ok_or_else(|| InternalError::Media("render plan canvas is required".into()))?;
        validate_canvas(canvas)?;

        let mut previous_end = 0;
        for segment in &self.segments {
            validate_segment(segment, &self.project_id)?;
            if segment.output_start_ms < previous_end {
                return Err(
                    InternalError::Media("render segments overlap in output time".into()).into(),
                );
            }
            previous_end = segment.output_end_ms;
            if !segment.speed.is_finite() || segment.speed <= 0.0 {
                return Err(InternalError::Media("render segment speed is invalid".into()).into());
            }
        }
        if previous_end > self.duration_ms {
            return Err(InternalError::Media("render segment exceeds plan duration".into()).into());
        }
        let mut expected_gaps = Vec::new();
        let mut cursor_ms = 0;
        for segment in &self.segments {
            if segment.output_start_ms > cursor_ms {
                expected_gaps.push((cursor_ms, segment.output_start_ms));
            }
            cursor_ms = segment.output_end_ms;
        }
        if cursor_ms < self.duration_ms {
            expected_gaps.push((cursor_ms, self.duration_ms));
        }
        if expected_gaps.len() != self.gaps.len()
            || expected_gaps
                .iter()
                .zip(&self.gaps)
                .any(|((start, end), gap)| *start != gap.start_ms || *end != gap.end_ms)
        {
            return Err(
                InternalError::Media("render gaps do not match output timing".into()).into(),
            );
        }
        for gap in &self.gaps {
            if gap.start_ms >= gap.end_ms || gap.end_ms > self.duration_ms {
                return Err(InternalError::Media("render gap range is invalid".into()).into());
            }
        }
        if self.caption_mode != "burn-in"
            && self.caption_mode != "sidecar"
            && self.caption_mode != "none"
        {
            return Err(InternalError::Media("caption export mode is unsupported".into()).into());
        }
        if self
            .overlays
            .iter()
            .any(|overlay| !overlay_values_are_finite(overlay))
            || self.masks.iter().any(|mask| !mask_values_are_finite(mask))
            || self
                .zoom_segments
                .iter()
                .any(|segment| !zoom_values_are_finite(segment))
        {
            return Err(
                InternalError::Media("render effect contains a non-finite value".into()).into(),
            );
        }
        for effect in self.cursor_effects.iter().filter(|effect| effect.enabled) {
            if !effect.scale.is_finite() || effect.scale <= 0.0 || effect.start_ms >= effect.end_ms
            {
                return Err(
                    InternalError::Media("cursor effect settings are invalid".into()).into(),
                );
            }
        }
        let audio_tracks = self
            .audio_tracks
            .as_ref()
            .into_iter()
            .flatten()
            .chain(self.audio.iter());
        for track in audio_tracks {
            if !track.volume.is_finite() || !(0.0..=2.0).contains(&track.volume) {
                return Err(InternalError::Media("audio track volume is invalid".into()).into());
            }
            for segment in &track.segments {
                validate_segment(segment, &self.project_id)?;
            }
        }
        if self
            .captions
            .iter()
            .any(|caption| caption.start_ms >= caption.end_ms || caption.end_ms > self.duration_ms)
            || self.chapters.iter().any(|chapter| {
                chapter.start_ms >= chapter.end_ms || chapter.end_ms > self.duration_ms
            })
            || self
                .masks
                .iter()
                .any(|mask| mask.start_ms >= mask.end_ms || mask.end_ms > self.duration_ms)
            || self.overlays.iter().any(|overlay| {
                overlay.source_in_ms >= overlay.source_out_ms
                    || overlay.output_start_ms >= overlay.output_end_ms
                    || overlay.output_end_ms > self.duration_ms
            })
            || self.zoom_segments.iter().any(|segment| {
                segment.start_ms >= segment.end_ms || segment.end_ms > self.duration_ms
            })
            || self
                .cursor_effects
                .iter()
                .any(|effect| effect.start_ms >= effect.end_ms || effect.end_ms > self.duration_ms)
        {
            return Err(
                InternalError::Media("render effect range exceeds plan duration".into()).into(),
            );
        }
        Ok(())
    }
}

pub(crate) fn validate_export_settings(settings: &ExportSettings, plan: &RenderPlan) -> Result<()> {
    let valid_container_codec = if settings.container == "mp4" {
        matches!(settings.codec.as_str(), "h264" | "hevc")
    } else if settings.container == "gif" {
        matches!(settings.codec.as_str(), "gif" | "h264" | "hevc")
    } else if settings.container == "webp" {
        matches!(settings.codec.as_str(), "webp" | "h264" | "hevc")
    } else {
        false
    };
    if !valid_container_codec {
        return Err(InternalError::Media("export codec or container is unsupported".into()).into());
    }
    if !matches!(settings.encoder.as_str(), "auto" | "software") {
        return Err(InternalError::Media("export encoder preference is unsupported".into()).into());
    }
    if !matches!(
        settings.preset.as_str(),
        "default-mp4"
            | "fast-share"
            | "balanced"
            | "high-quality"
            | "smooth-60fps"
            | "ultra-4k"
            | "ultra-4k-60"
            | "vertical"
            | "square"
            | "selected-range"
            | "gif-balanced"
            | "gif-high-quality"
            | "gif-fast"
            | "webp-balanced"
            | "webp-high-quality"
            | "webp-fast"
            | "webp-lossless"
    ) {
        return Err(InternalError::Media("export preset is unsupported".into()).into());
    }
    if settings.caption_mode != plan.caption_mode {
        return Err(InternalError::Media(
            "export caption settings do not match the render plan".into(),
        )
        .into());
    }
    if !matches!(
        settings.chapter_mode.as_str(),
        "embed" | "sidecar" | "both" | "none"
    ) {
        return Err(InternalError::Media("export chapter mode is unsupported".into()).into());
    }
    let is_animation = settings.container == "gif"
        || settings.container == "webp"
        || settings.preset.starts_with("gif-")
        || settings.preset.starts_with("webp-");
    if !is_animation && settings.chapter_mode != plan.chapter_mode {
        return Err(InternalError::Media(
            "export chapter settings do not match the render plan".into(),
        )
        .into());
    }
    if let Some(range) = &settings.range {
        if range.end_ms <= range.start_ms {
            return Err(InternalError::Media("export range is invalid".into()).into());
        }
    }
    if settings.preset == "selected-range" && settings.range.is_none() {
        return Err(InternalError::Media("selected-range export requires a range".into()).into());
    }
    if (settings.container == "gif" || settings.preset.starts_with("gif-"))
        && plan.duration_ms > MAX_GIF_DURATION_MS
    {
        return Err(InternalError::Media(
            "GIF exports are limited to 60 seconds. Use Selected range to export a shorter clip."
                .into(),
        )
        .into());
    }
    if settings.preset == "vertical"
        && plan
            .canvas
            .as_ref()
            .is_some_and(|canvas| canvas.width >= canvas.height)
    {
        return Err(InternalError::Media(
            "vertical export requires a vertical project canvas".into(),
        )
        .into());
    }
    if settings.preset == "square"
        && plan
            .canvas
            .as_ref()
            .is_some_and(|canvas| canvas.width != canvas.height)
    {
        return Err(
            InternalError::Media("square export requires a square project canvas".into()).into(),
        );
    }
    Ok(())
}

fn audio_bitrate(settings: &ExportSettings) -> &'static str {
    if matches!(
        settings.preset.as_str(),
        "high-quality" | "ultra-4k" | "ultra-4k-60"
    ) {
        "192k"
    } else {
        "128k"
    }
}

/// Rough output-size bound for the disk preflight: canvas pixels × fps ×
/// bits-per-pixel, plus the muxed audio stream. `bits_per_pixel` is chosen by
/// the caller for the artifact being sized (final MP4 vs MPEG-TS chunks).
fn estimate_export_bytes(plan: &RenderPlan, settings: &ExportSettings, bits_per_pixel: f64) -> u64 {
    let duration_s = plan.duration_ms as f64 / 1000.0;
    let (width, height, fps) = plan
        .canvas
        .as_ref()
        .map(|canvas| {
            (
                canvas.width as f64,
                canvas.height as f64,
                canvas.fps.max(1) as f64,
            )
        })
        .unwrap_or((1920.0, 1080.0, 30.0));
    let video_bytes = width * height * fps * bits_per_pixel * duration_s / 8.0;
    let audio_bps = if settings.container == "gif" || settings.container == "webp" {
        0.0
    } else if audio_bitrate(settings) == "192k" {
        192_000.0
    } else {
        128_000.0
    };
    (video_bytes + audio_bps / 8.0 * duration_s) as u64
}

/// Preflight the output drive. The estimate is deliberately a low bound, so
/// this only ever trips when the disk is plainly too small.
fn ensure_export_disk_space(
    output_path: &Path,
    plan: &RenderPlan,
    settings: &ExportSettings,
) -> Result<()> {
    const MARGIN_BYTES: u64 = 64 * 1024 * 1024;
    let required = estimate_export_bytes(plan, settings, 0.01) + MARGIN_BYTES;
    match crate::media::disk::available_space(output_path) {
        Ok(free) if free < required => Err(InternalError::Storage(format!(
            "Not enough free disk space for this export: about {:.1} GB needed, {:.1} GB free.",
            required as f64 / 1024.0_f64.powi(3),
            free as f64 / 1024.0_f64.powi(3)
        ))
        .into()),
        Ok(_) => Ok(()),
        Err(error) => {
            warn!(error = %error, "could not check free disk space before export");
            Ok(())
        }
    }
}

/// Chunked mode writes one MPEG-TS intermediate per pass to the temp drive,
/// which may be a different volume than the output — check it can hold a more
/// generous estimate and fall back to a single pass when it cannot.
fn chunk_temp_space_ok(plan: &RenderPlan, settings: &ExportSettings) -> bool {
    let probe = std::env::temp_dir().join("recordforge-space-probe");
    match crate::media::disk::available_space(&probe) {
        Ok(free) => {
            let required = estimate_export_bytes(plan, settings, 0.05) + 256 * 1024 * 1024;
            if free >= required {
                return true;
            }
            info!(
                free,
                required, "insufficient temp space for chunked export, using single pass"
            );
            false
        }
        Err(error) => {
            warn!(error = %error, "could not check temp disk space for chunked export");
            true
        }
    }
}

fn atempo_filter(speed: f64) -> String {
    let mut remaining = speed;
    let mut filters = Vec::new();
    while remaining > 2.0 {
        filters.push("atempo=2.0".to_string());
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        filters.push("atempo=0.5".to_string());
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() > f64::EPSILON {
        filters.push(format!("atempo={remaining:.6}"));
    }
    if filters.is_empty() {
        String::new()
    } else {
        format!(",{}", filters.join(","))
    }
}

/// True when a stdin write failed because the reader already exited. Windows
/// reports this as ERROR_BROKEN_PIPE (109) or ERROR_NO_DATA (232).
fn is_pipe_closed(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::BrokenPipe
        || matches!(error.raw_os_error(), Some(109) | Some(232))
}

/// Scrub filesystem paths out of an FFmpeg diagnostic line. Media paths must
/// never reach logs or user-facing errors, but the surrounding reason (for
/// example "Invalid argument" or "No such file or directory") is safe to keep.
fn redact_paths(line: &str) -> String {
    line.split_whitespace()
        .map(|token| {
            let cleaned = token.trim_matches(|c| c == '\'' || c == '"' || c == ',' || c == ')');
            let looks_like_path = cleaned.contains(":\\")
                || cleaned.contains(":/")
                || cleaned.starts_with('\\')
                || (cleaned.starts_with('/') && cleaned.len() > 1);
            if looks_like_path {
                "<path>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// FFmpeg reports ENOSPC in a few phrasings depending on which writer or muxer
/// trips over it — recognize them all so the user gets an actionable error.
fn is_disk_full_diagnostic(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("no space left on device")
        || lower.contains("not enough space on the disk")
        || lower.contains("disk full")
}

/// Extract the most actionable FFmpeg error detail from raw stderr with all
/// paths redacted, falling back to a generic message when stderr is empty.
fn ffmpeg_failure_detail(stderr: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stderr);
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(redact_paths)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    // Filter out trailing generic muxer/conversion status lines to reveal the root cause line
    let meaningful_lines = lines
        .iter()
        .filter(|line| {
            !line.contains("Conversion failed")
                && !line.contains("Nothing was written into output file")
                && !line.starts_with("Error closing file")
        })
        .collect::<Vec<_>>();

    if let Some(&last_meaningful) = meaningful_lines.last() {
        return Some(last_meaningful.chars().take(300).collect());
    }

    lines.last().map(|line| line.chars().take(300).collect())
}

/// True when a stderr line belongs to a `-progress` block rather than a
/// diagnostic message.
fn is_progress_line(line: &str) -> bool {
    const PROGRESS_KEYS: [&str; 10] = [
        "frame=",
        "fps=",
        "stream_",
        "bitrate=",
        "total_size=",
        "out_time",
        "dup_frames=",
        "drop_frames=",
        "speed=",
        "progress=",
    ];
    PROGRESS_KEYS.iter().any(|key| line.starts_with(key))
}

/// Run one FFmpeg export command.
///
/// Stderr is drained on a dedicated thread because `-progress pipe:2` emits a
/// continuous block stream that would otherwise fill the pipe and deadlock the
/// child; progress lines are reported through `on_progress` (as a 0..1 ratio
/// of expected duration) and non-progress lines are kept as diagnostics.
/// `halt` is an optional cooperative stop shared across sibling renders: a
/// chunked export sets it when any pass fails so the other FFmpeg processes
/// die immediately instead of finishing their slices.
#[allow(clippy::too_many_arguments)]
fn run_export_ffmpeg(
    command: &mut Command,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    halt: Option<&Arc<std::sync::atomic::AtomicBool>>,
    partial_path: &Path,
    stage: &str,
    expected_duration_ms: Option<u64>,
    mut cursor: Option<CursorFramePlan>,
    on_progress: Option<&(dyn Fn(f64) + Sync)>,
) -> Result<()> {
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    if cursor.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|error| InternalError::Media(format!("start {stage}: {error}")))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| InternalError::Media(format!("{stage} stderr unavailable")))?;

    // A scoped thread lets the drain borrow the progress callback while
    // guaranteeing it is joined before this function returns.
    std::thread::scope(|scope| -> Result<()> {
        let diagnostics = scope.spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            let mut diagnostic = Vec::new();
            for line in reader.lines().map_while(|result| result.ok()) {
                let trimmed = line.trim_end();
                if is_progress_line(trimmed) {
                    if let (Some(report), Some(duration_ms)) = (on_progress, expected_duration_ms) {
                        if let Some(time_ms) = crate::media::parse_ffmpeg_time(trimmed) {
                            if duration_ms > 0 {
                                report((time_ms as f64 / duration_ms as f64).clamp(0.0, 1.0));
                            }
                        }
                    }
                } else if !trimmed.is_empty() {
                    diagnostic.extend_from_slice(trimmed.as_bytes());
                    diagnostic.push(b'\n');
                }
            }
            diagnostic
        });

        let fed = match cursor.as_mut() {
            Some(cursor_plan) => match child.stdin.take() {
                Some(mut stdin) => feed_cursor_frames(&mut stdin, cursor_plan, cancel, halt),
                None => Err(InternalError::Media("cursor overlay stdin unavailable".into()).into()),
            },
            None => Ok(()),
        };
        if let Err(error) = fed {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(partial_path);
            return Err(error);
        }
        drop(child.stdin.take());

        loop {
            let stopped = cancel.load(std::sync::atomic::Ordering::Relaxed)
                || halt.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
            if stopped {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(partial_path);
                return Err(InternalError::Media("export cancelled".into()).into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let diagnostic = diagnostics.join().unwrap_or_default();
                    if status.success() {
                        return Ok(());
                    }
                    let _ = std::fs::remove_file(partial_path);
                    let detail = ffmpeg_failure_detail(&diagnostic)
                        .unwrap_or_else(|| "no diagnostic output".into());
                    let stderr_text = String::from_utf8_lossy(&diagnostic);
                    // Media paths must never reach logs (AGENTS.md security rules).
                    let redacted_stderr = stderr_text
                        .lines()
                        .map(redact_paths)
                        .collect::<Vec<_>>()
                        .join("\n");
                    tracing::error!(stage, detail = %detail, stderr = %redacted_stderr, "ffmpeg export process failed");
                    if is_disk_full_diagnostic(&stderr_text) {
                        return Err(InternalError::Storage(
                            "The disk ran out of space during export. Free up space and retry."
                                .into(),
                        )
                        .into());
                    }
                    return Err(InternalError::Media(format!("{stage} failed: {detail}")).into());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(partial_path);
                    return Err(InternalError::Media(format!("wait for {stage}: {error}")).into());
                }
            }
        }
    })
}

fn validate_export_output(
    ffprobe_path: &Path,
    path: &Path,
    plan: &RenderPlan,
    settings: &ExportSettings,
    expect_audio: bool,
) -> Result<()> {
    let metadata =
        crate::media::probe::probe_media(&ffprobe_path.to_string_lossy(), path, &plan.project_id)
            .map_err(|_| InternalError::Media("probe rendered export failed".into()))?;
    let duration_delta = metadata.duration_ms.abs_diff(plan.duration_ms);
    if metadata.duration_ms > 0 && duration_delta > 250 {
        return Err(InternalError::Media(format!(
            "export duration failed validation (expected {} ms, rendered {} ms)",
            plan.duration_ms, metadata.duration_ms
        ))
        .into());
    }
    let video = metadata
        .streams
        .iter()
        .find(|stream| stream.kind == "video")
        .ok_or_else(|| InternalError::Media("export has no video stream".into()))?;
    let canvas = plan
        .canvas
        .as_ref()
        .ok_or_else(|| InternalError::Media("render canvas is required".into()))?;
    let is_gif = settings.container == "gif" || settings.preset.starts_with("gif-");
    let is_webp = settings.container == "webp" || settings.preset.starts_with("webp-");
    if is_gif {
        let max_width = match settings.preset.as_str() {
            "gif-fast" => Some(640),
            "gif-high-quality" => None,
            _ => Some(960),
        };
        let expected_w = max_width
            .map(|m| (canvas.width.min(m) / 2) * 2)
            .unwrap_or(canvas.width);
        if video.width != Some(expected_w as i32)
            || video.height.is_none()
            || video.height.unwrap_or(0) <= 0
        {
            return Err(InternalError::Media("export dimensions failed validation".into()).into());
        }
    } else if is_webp {
        let max_width = match settings.preset.as_str() {
            "webp-fast" => Some(800),
            "webp-high-quality" | "webp-lossless" => None,
            _ => Some(1280),
        };
        let expected_w = max_width
            .map(|m| (canvas.width.min(m) / 2) * 2)
            .unwrap_or(canvas.width);
        if video.width != Some(expected_w as i32)
            || video.height.is_none()
            || video.height.unwrap_or(0) <= 0
        {
            return Err(InternalError::Media("export dimensions failed validation".into()).into());
        }
    } else if video.width != Some(canvas.width as i32) || video.height != Some(canvas.height as i32)
    {
        return Err(InternalError::Media("export dimensions failed validation".into()).into());
    }
    let expected_video_codec = if settings.container == "gif" || settings.codec == "gif" {
        "gif"
    } else if settings.container == "webp" || settings.codec == "webp" {
        "webp"
    } else if settings.codec == "hevc" {
        "hevc"
    } else {
        "h264"
    };
    if is_webp {
        if video.codec != "webp" && video.codec != "webp_anim" {
            return Err(InternalError::Media("export video codec failed validation".into()).into());
        }
    } else if video.codec != expected_video_codec {
        return Err(InternalError::Media("export video codec failed validation".into()).into());
    }
    if settings.container == "gif" || settings.container == "webp" {
        if metadata.has_audio {
            return Err(InternalError::Media(format!(
                "{} export must not contain audio",
                settings.container
            ))
            .into());
        }
        return Ok(());
    }
    if expect_audio != metadata.has_audio {
        return Err(InternalError::Media("export audio stream failed validation".into()).into());
    }
    for stream in metadata
        .streams
        .iter()
        .filter(|stream| stream.kind == "audio")
    {
        if stream.codec != "aac" {
            return Err(InternalError::Media("export audio codec failed validation".into()).into());
        }
        if let Some(duration_ms) = stream.duration_ms {
            if duration_ms.abs_diff(plan.duration_ms) > 250 {
                return Err(
                    InternalError::Media("audio and video duration are misaligned".into()).into(),
                );
            }
        }
    }
    Ok(())
}

fn temporary_export_paths(output_path: &Path) -> Vec<PathBuf> {
    let partial = partial_output_path(output_path);
    vec![
        partial.clone(),
        cursor_partial_output_path(output_path),
        partial.with_extension("srt"),
        partial.with_extension("chapters.txt"),
        cursor_partial_output_path(&partial),
    ]
}

fn managed_export_paths(output_path: &Path, plan: &RenderPlan) -> Vec<PathBuf> {
    let mut paths = temporary_export_paths(output_path);
    paths.push(output_path.to_path_buf());
    if plan.caption_mode == "sidecar" {
        paths.push(output_path.with_extension("srt"));
    }
    if matches!(plan.chapter_mode.as_str(), "sidecar" | "both") && !plan.chapters.is_empty() {
        paths.push(output_path.with_extension("chapters.txt"));
    }
    paths
}

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    let left = crate::path_policy::canonicalize_path(left)
        .unwrap_or_else(|_| crate::path_policy::normalize_path(left));
    let right = crate::path_policy::canonicalize_path(right)
        .unwrap_or_else(|_| crate::path_policy::normalize_path(right));
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(crate) fn cleanup_export_files(output_path: &Path) {
    for path in temporary_export_paths(output_path) {
        let _ = std::fs::remove_file(path);
    }
}

fn update_progress(
    db: &Arc<Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
    job_id: &str,
    progress: f64,
    stage: &str,
    message: Option<&str>,
) -> Result<()> {
    let conn = db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    crate::database::media::update_job_progress(&conn, job_id, progress, stage, message)?;
    let job = crate::database::media::get_job(&conn, job_id)?;
    drop(conn);
    emit_job_update(app, &job)
}

fn validate_canvas(canvas: &cursor::RenderCanvas) -> Result<()> {
    if canvas.width == 0
        || canvas.height == 0
        || canvas.fps == 0
        || canvas.width > 7_680
        || canvas.height > 4_320
        || canvas.fps > 240
    {
        return Err(InternalError::Media("render canvas dimensions are unsupported".into()).into());
    }
    if canvas.padding.saturating_mul(2) >= canvas.width.min(canvas.height) {
        return Err(
            InternalError::Media("render canvas padding leaves no content area".into()).into(),
        );
    }
    if canvas.border_radius > canvas.width.min(canvas.height) / 2 {
        return Err(InternalError::Media("render canvas border radius is too large".into()).into());
    }
    if canvas
        .background_blur
        .is_some_and(|b| !b.is_finite() || !(0.0..=200.0).contains(&b))
    {
        return Err(InternalError::Media("render canvas background blur is invalid".into()).into());
    }
    if canvas
        .background_dim
        .is_some_and(|d| !d.is_finite() || !(0.0..=1.0).contains(&d))
    {
        return Err(InternalError::Media("render canvas background dim is invalid".into()).into());
    }
    if let Some(ratio) = &canvas.aspect_ratio {
        if !matches!(ratio.as_str(), "16:9" | "9:16" | "1:1" | "5:4" | "4:5") {
            return Err(InternalError::Media(format!("unsupported aspect ratio: {ratio}")).into());
        }
    }
    if canvas
        .video_position_y
        .is_some_and(|y| !y.is_finite() || !(0.0..=1.0).contains(&y))
    {
        return Err(
            InternalError::Media("render canvas video position Y is invalid".into()).into(),
        );
    }
    Ok(())
}

fn safe_filter_color(value: &str) -> String {
    let trimmed = value.trim();
    let is_hex = (trimmed.len() == 7 || trimmed.len() == 9)
        && trimmed.starts_with('#')
        && trimmed[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if is_hex {
        return trimmed.to_string();
    }
    // If the value contains a hex color (e.g. from linear-gradient(#1e1b4b, ...)), extract the first 6-digit hex
    if let Some(pos) = trimmed.find('#') {
        let candidate = &trimmed[pos..];
        if candidate.len() >= 7 && candidate[1..7].chars().all(|c| c.is_ascii_hexdigit()) {
            return candidate[..7].to_string();
        }
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "black" => "#000000".into(),
        "white" => "#ffffff".into(),
        "red" => "#ef4444".into(),
        "blue" => "#3b82f6".into(),
        "green" => "#10b981".into(),
        "yellow" => "#f59e0b".into(),
        "gray" | "grey" => "#6b7280".into(),
        "transparent" => "#00000000".into(),
        _ => "#000000".into(),
    }
}
fn parse_color_hex(hex: &str, default_alpha: f32) -> Color {
    let raw = hex.trim().trim_start_matches('#');
    if raw.len() == 6 {
        let r = u8::from_str_radix(&raw[0..2], 16).unwrap_or(0);
        let g = u8::from_str_radix(&raw[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&raw[4..6], 16).unwrap_or(0);
        Color::from_rgba8(r, g, b, (default_alpha * 255.0).round() as u8)
    } else if raw.len() == 8 {
        let r = u8::from_str_radix(&raw[0..2], 16).unwrap_or(0);
        let g = u8::from_str_radix(&raw[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&raw[4..6], 16).unwrap_or(0);
        let a = u8::from_str_radix(&raw[6..8], 16).unwrap_or(255);
        Color::from_rgba8(
            r,
            g,
            b,
            ((a as f32 / 255.0) * default_alpha * 255.0).round() as u8,
        )
    } else if raw.len() == 3 {
        let r = u8::from_str_radix(&format!("{}{}", &raw[0..1], &raw[0..1]), 16).unwrap_or(0);
        let g = u8::from_str_radix(&format!("{}{}", &raw[1..2], &raw[1..2]), 16).unwrap_or(0);
        let b = u8::from_str_radix(&format!("{}{}", &raw[2..3], &raw[2..3]), 16).unwrap_or(0);
        Color::from_rgba8(r, g, b, (default_alpha * 255.0).round() as u8)
    } else {
        Color::from_rgba8(0, 0, 0, (default_alpha * 255.0).round() as u8)
    }
}

fn build_rounded_rect_path(x: f32, y: f32, w: f32, h: f32, radius: f32) -> Option<SkiaPath> {
    let r = radius.min(w / 2.0).min(h / 2.0).max(0.0);
    let mut pb = PathBuilder::new();
    if r <= 0.0 {
        pb.push_rect(Rect::from_xywh(x, y, w, h)?);
    } else {
        pb.move_to(x + r, y);
        pb.line_to(x + w - r, y);
        pb.quad_to(x + w, y, x + w, y + r);
        pb.line_to(x + w, y + h - r);
        pb.quad_to(x + w, y + h, x + w - r, y + h);
        pb.line_to(x + r, y + h);
        pb.quad_to(x, y + h, x, y + h - r);
        pb.line_to(x, y + r);
        pb.quad_to(x, y, x + r, y);
        pb.close();
    }
    pb.finish()
}

fn fast_blur_pixmap(pixmap: &mut Pixmap, radius: f32) {
    let r = radius.round().max(1.0) as usize;
    let w = pixmap.width() as usize;
    let h = pixmap.height() as usize;
    if w == 0 || h == 0 || r == 0 {
        return;
    }
    let data = pixmap.data_mut();
    for _ in 0..3 {
        let temp = data.to_vec();
        for y in 0..h {
            let row_offset = y * w * 4;
            for x in 0..w {
                let start_x = x.saturating_sub(r);
                let end_x = (x + r).min(w - 1);
                let count = (end_x - start_x + 1) as u32;
                let mut sum_r = 0u32;
                let mut sum_g = 0u32;
                let mut sum_b = 0u32;
                let mut sum_a = 0u32;
                for kx in start_x..=end_x {
                    let idx = row_offset + kx * 4;
                    sum_r += temp[idx] as u32;
                    sum_g += temp[idx + 1] as u32;
                    sum_b += temp[idx + 2] as u32;
                    sum_a += temp[idx + 3] as u32;
                }
                let out_idx = row_offset + x * 4;
                data[out_idx] = (sum_r / count) as u8;
                data[out_idx + 1] = (sum_g / count) as u8;
                data[out_idx + 2] = (sum_b / count) as u8;
                data[out_idx + 3] = (sum_a / count) as u8;
            }
        }
        let temp_v = data.to_vec();
        for x in 0..w {
            for y in 0..h {
                let start_y = y.saturating_sub(r);
                let end_y = (y + r).min(h - 1);
                let count = (end_y - start_y + 1) as u32;
                let mut sum_r = 0u32;
                let mut sum_g = 0u32;
                let mut sum_b = 0u32;
                let mut sum_a = 0u32;
                for ky in start_y..=end_y {
                    let idx = (ky * w + x) * 4;
                    sum_r += temp_v[idx] as u32;
                    sum_g += temp_v[idx + 1] as u32;
                    sum_b += temp_v[idx + 2] as u32;
                    sum_a += temp_v[idx + 3] as u32;
                }
                let out_idx = (y * w + x) * 4;
                data[out_idx] = (sum_r / count) as u8;
                data[out_idx + 1] = (sum_g / count) as u8;
                data[out_idx + 2] = (sum_b / count) as u8;
                data[out_idx + 3] = (sum_a / count) as u8;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn render_shadow_onto_pixmap(
    pixmap: &mut Pixmap,
    screen_x: f64,
    screen_y: f64,
    screen_w: f64,
    screen_h: f64,
    border_radius: u32,
    shadow_color: Option<&str>,
    shadow_blur: Option<f64>,
    shadow_offset_x: Option<f64>,
    shadow_offset_y: Option<f64>,
) {
    let canvas_w = pixmap.width();
    let canvas_h = pixmap.height();
    let blur = shadow_blur.unwrap_or(16.0).clamp(1.0, 64.0);
    let off_x = shadow_offset_x.unwrap_or(0.0);
    let off_y = shadow_offset_y.unwrap_or(blur / 2.0);
    let x = (screen_x + off_x) as f32;
    let y = (screen_y + off_y) as f32;
    let w = screen_w as f32;
    let h = screen_h as f32;
    let r = (border_radius as f32).min(w / 2.0).min(h / 2.0);

    let hex_color = shadow_color.unwrap_or("#000000");
    let color = parse_color_hex(hex_color, 0.4);

    let Some(path) = build_rounded_rect_path(x, y, w, h, r) else {
        return;
    };
    let Some(mut shadow_pixmap) = Pixmap::new(canvas_w, canvas_h) else {
        return;
    };
    let mut paint = Paint::default();
    paint.set_color(color);
    paint.anti_alias = true;
    shadow_pixmap.fill_path(
        &path,
        &paint,
        FillRule::Winding,
        Transform::identity(),
        None,
    );
    fast_blur_pixmap(&mut shadow_pixmap, (blur / 2.0).clamp(1.0, 32.0) as f32);

    pixmap.draw_pixmap(
        0,
        0,
        shadow_pixmap.as_ref(),
        &PixmapPaint::default(),
        Transform::identity(),
        None,
    );
}

#[allow(clippy::too_many_arguments, dead_code)]
pub(crate) fn generate_shadow_plate_png(
    canvas_w: u32,
    canvas_h: u32,
    screen_x: f64,
    screen_y: f64,
    screen_w: f64,
    screen_h: f64,
    border_radius: u32,
    shadow_color: Option<&str>,
    shadow_blur: Option<f64>,
    shadow_offset_x: Option<f64>,
    shadow_offset_y: Option<f64>,
) -> Option<PathBuf> {
    let mut pixmap = Pixmap::new(canvas_w, canvas_h)?;
    render_shadow_onto_pixmap(
        &mut pixmap,
        screen_x,
        screen_y,
        screen_w,
        screen_h,
        border_radius,
        shadow_color,
        shadow_blur,
        shadow_offset_x,
        shadow_offset_y,
    );
    let temp_path = std::env::temp_dir().join(format!(
        "recordforge_bg_shadow_{}.png",
        uuid::Uuid::new_v4()
    ));
    pixmap.save_png(&temp_path).ok()?;
    Some(temp_path)
}

pub(crate) fn generate_camera_border_png(
    width: u32,
    height: u32,
    shape: &str,
    border_width: f64,
    border_color: Option<&str>,
    border_opacity: Option<f64>,
) -> std::result::Result<Vec<u8>, String> {
    let mut pixmap = Pixmap::new(width.max(1), height.max(1))
        .ok_or_else(|| "failed to allocate camera border pixmap".to_string())?;

    let bw = (border_width.max(0.5) as f32)
        .min(width.max(1) as f32 / 2.0)
        .min(height.max(1) as f32 / 2.0);
    let opacity = border_opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32;
    let hex_color = safe_filter_color(border_color.unwrap_or("#ffffff"));
    let color = parse_color_hex(&hex_color, opacity);

    let w = width.max(1) as f32;
    let h = height.max(1) as f32;

    let mut paint = Paint::default();
    paint.set_color(color);
    paint.anti_alias = true;

    let stroke = tiny_skia::Stroke {
        width: bw,
        ..Default::default()
    };

    let half_bw = bw / 2.0;

    let path = match shape {
        "circle" => {
            let rx = (w / 2.0 - half_bw).max(0.1);
            let ry = (h / 2.0 - half_bw).max(0.1);
            let cx = w / 2.0;
            let cy = h / 2.0;
            let k = 0.552_284_8;
            let kx = rx * k;
            let ky = ry * k;
            let mut pb = PathBuilder::new();
            pb.move_to(cx, cy - ry);
            pb.cubic_to(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
            pb.cubic_to(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
            pb.cubic_to(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
            pb.cubic_to(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
            pb.close();
            pb.finish()
        }
        "rounded" => {
            let r = ((w.min(h) * 0.12).max(4.0) - half_bw).max(0.1);
            let x = half_bw;
            let y = half_bw;
            let inner_w = (w - bw).max(0.1);
            let inner_h = (h - bw).max(0.1);
            build_rounded_rect_path(x, y, inner_w, inner_h, r)
        }
        _ => {
            let mut pb = PathBuilder::new();
            pb.move_to(half_bw, half_bw);
            pb.line_to(w - half_bw, half_bw);
            pb.line_to(w - half_bw, h - half_bw);
            pb.line_to(half_bw, h - half_bw);
            pb.close();
            pb.finish()
        }
    };

    if let Some(p) = path {
        pixmap.stroke_path(&p, &paint, &stroke, Transform::identity(), None);
    }

    pixmap
        .encode_png()
        .map_err(|e| format!("encode camera border png: {e}"))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn generate_camera_shadow_plate_png(
    canvas_w: u32,
    canvas_h: u32,
    overlay_x: f64,
    overlay_y: f64,
    overlay_w: f64,
    overlay_h: f64,
    shape: &str,
    shadow_color: Option<&str>,
    shadow_blur: Option<f64>,
    shadow_offset_x: Option<f64>,
    shadow_offset_y: Option<f64>,
) -> Option<PathBuf> {
    let mut pixmap = Pixmap::new(canvas_w, canvas_h)?;
    let blur = shadow_blur.unwrap_or(16.0).clamp(1.0, 64.0);
    let off_x = shadow_offset_x.unwrap_or(0.0);
    let off_y = shadow_offset_y.unwrap_or(4.0);
    let x = (overlay_x + off_x) as f32;
    let y = (overlay_y + off_y) as f32;
    let w = overlay_w as f32;
    let h = overlay_h as f32;

    let hex_color = safe_filter_color(shadow_color.unwrap_or("#000000"));
    let color = parse_color_hex(&hex_color, 0.4);

    let path = match shape {
        "circle" => {
            let rx = (w / 2.0).min(h / 2.0);
            let ry = rx;
            let cx = x + w / 2.0;
            let cy = y + h / 2.0;
            let k = 0.552_284_8;
            let kx = rx * k;
            let ky = ry * k;
            let mut pb = PathBuilder::new();
            pb.move_to(cx, cy - ry);
            pb.cubic_to(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
            pb.cubic_to(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
            pb.cubic_to(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
            pb.cubic_to(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
            pb.close();
            pb.finish()
        }
        "rounded" => {
            let r = (w.min(h) * 0.12).max(4.0);
            build_rounded_rect_path(x, y, w, h, r)
        }
        _ => {
            let mut pb = PathBuilder::new();
            pb.move_to(x, y);
            pb.line_to(x + w, y);
            pb.line_to(x + w, y + h);
            pb.line_to(x, y + h);
            pb.close();
            pb.finish()
        }
    }?;

    let mut paint = Paint::default();
    paint.set_color(color);
    paint.anti_alias = true;
    pixmap.fill_path(
        &path,
        &paint,
        FillRule::Winding,
        Transform::identity(),
        None,
    );
    fast_blur_pixmap(&mut pixmap, (blur / 2.0).clamp(1.0, 32.0) as f32);

    let temp_path = std::env::temp_dir().join(format!(
        "recordforge_cam_shadow_{}.png",
        uuid::Uuid::new_v4()
    ));
    pixmap.save_png(&temp_path).ok()?;
    Some(temp_path)
}

fn parse_css_gradient_to_svg(gradient_str: &str, width: u32, height: u32) -> Option<String> {
    let trimmed = gradient_str.trim();
    if !trimmed.contains("-gradient(") {
        return None;
    }

    // Split top-level comma-separated gradient functions and base color
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut paren_depth: i32 = 0;
    for c in trimmed.chars() {
        match c {
            '(' => {
                paren_depth += 1;
                current.push(c);
            }
            ')' => {
                paren_depth = paren_depth.saturating_sub(1);
                current.push(c);
            }
            ',' if paren_depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }

    if parts.is_empty() {
        return None;
    }

    let mut defs_xml = String::new();
    let mut layers_xml = String::new();
    let mut base_fill: Option<String> = None;

    for (idx, part) in parts.iter().enumerate() {
        let p = part.trim();
        if p.starts_with("linear-gradient(") && p.ends_with(')') {
            let inner = &p[16..p.len() - 1].trim();
            if let Some((grad_def, rect_layer)) =
                parse_linear_gradient_layer(inner, &format!("grad_{idx}"))
            {
                defs_xml.push_str(&grad_def);
                layers_xml.push_str(&rect_layer);
            }
        } else if p.starts_with("radial-gradient(") && p.ends_with(')') {
            let inner = &p[16..p.len() - 1].trim();
            if let Some((grad_def, rect_layer)) =
                parse_radial_gradient_layer(inner, &format!("grad_{idx}"))
            {
                defs_xml.push_str(&grad_def);
                layers_xml.push_str(&rect_layer);
            }
        } else if p.starts_with('#') || p.starts_with("rgb(") || p.starts_with("rgba(") {
            base_fill = Some(p.to_string());
        }
    }

    if defs_xml.is_empty() && base_fill.is_none() {
        return None;
    }

    let base_rect = if let Some(fill) = base_fill {
        format!(r##"<rect width="100%" height="100%" fill="{fill}" />"##)
    } else {
        String::new()
    };

    Some(format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">
  <defs>
    {defs_xml}
  </defs>
  {base_rect}
  {layers_xml}
</svg>"##
    ))
}

fn parse_linear_gradient_layer(inner: &str, grad_id: &str) -> Option<(String, String)> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut paren_depth: i32 = 0;
    for c in inner.chars() {
        match c {
            '(' => {
                paren_depth += 1;
                current.push(c);
            }
            ')' => {
                paren_depth = paren_depth.saturating_sub(1);
                current.push(c);
            }
            ',' if paren_depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }

    if parts.is_empty() {
        return None;
    }

    let first = parts[0].trim().to_lowercase();
    let (angle_deg, stops_start_idx) = if first.ends_with("deg") {
        let deg: f64 = first
            .trim_end_matches("deg")
            .trim()
            .parse()
            .unwrap_or(180.0);
        (deg, 1)
    } else if first == "to bottom" {
        (180.0, 1)
    } else if first == "to top" {
        (0.0, 1)
    } else if first == "to right" {
        (90.0, 1)
    } else if first == "to left" {
        (270.0, 1)
    } else if first == "to bottom right" || first == "to right bottom" {
        (135.0, 1)
    } else if first == "to bottom left" || first == "to left bottom" {
        (225.0, 1)
    } else if first == "to top right" || first == "to right top" {
        (45.0, 1)
    } else if first == "to top left" || first == "to left top" {
        (315.0, 1)
    } else {
        (180.0, 0)
    };

    let rad = (angle_deg - 90.0) * std::f64::consts::PI / 180.0;
    let x1 = 50.0 - 50.0 * rad.cos();
    let y1 = 50.0 - 50.0 * rad.sin();
    let x2 = 50.0 + 50.0 * rad.cos();
    let y2 = 50.0 + 50.0 * rad.sin();

    let stop_parts = &parts[stops_start_idx..];
    if stop_parts.is_empty() {
        return None;
    }

    let stops_xml = parse_gradient_stops(stop_parts);
    let def = format!(
        r##"<linearGradient id="{grad_id}" x1="{x1:.2}%" y1="{y1:.2}%" x2="{x2:.2}%" y2="{y2:.2}%">{stops_xml}</linearGradient>"##
    );
    let rect = format!(r##"<rect width="100%" height="100%" fill="url(#{grad_id})" />"##);
    Some((def, rect))
}

fn parse_radial_gradient_layer(inner: &str, grad_id: &str) -> Option<(String, String)> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut paren_depth: i32 = 0;
    for c in inner.chars() {
        match c {
            '(' => {
                paren_depth += 1;
                current.push(c);
            }
            ')' => {
                paren_depth = paren_depth.saturating_sub(1);
                current.push(c);
            }
            ',' if paren_depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }

    if parts.is_empty() {
        return None;
    }

    let first = parts[0].trim().to_lowercase();
    let (cx, cy, r, stops_start_idx) = if first.starts_with("at ") || first.contains("at ") {
        let pos_str = if let Some((_, pos)) = first.split_once("at ") {
            pos.trim()
        } else {
            "50% 50%"
        };
        let coords: Vec<&str> = pos_str.split_whitespace().collect();
        let x_pct = coords.first().unwrap_or(&"50%").trim();
        let y_pct = coords.get(1).unwrap_or(&"50%").trim();
        (x_pct.to_string(), y_pct.to_string(), "65%".to_string(), 1)
    } else {
        ("50%".to_string(), "50%".to_string(), "65%".to_string(), 0)
    };

    let stop_parts = &parts[stops_start_idx..];
    if stop_parts.is_empty() {
        return None;
    }

    let stops_xml = parse_gradient_stops(stop_parts);
    let def = format!(
        r##"<radialGradient id="{grad_id}" cx="{cx}" cy="{cy}" r="{r}">{stops_xml}</radialGradient>"##
    );
    let rect = format!(r##"<rect width="100%" height="100%" fill="url(#{grad_id})" />"##);
    Some((def, rect))
}

fn parse_gradient_stops(stop_parts: &[String]) -> String {
    let mut stops_xml = String::new();
    let total_stops = stop_parts.len();
    for (i, stop_str) in stop_parts.iter().enumerate() {
        let stop_trimmed = stop_str.trim();
        let (color, offset) = if let Some((c, off)) = stop_trimmed.rsplit_once(' ') {
            if off.ends_with('%') {
                (c.trim(), off.trim().to_string())
            } else if off.ends_with("px") && off == "0px" {
                (c.trim(), "0%".to_string())
            } else {
                let pct = (i as f64 / (total_stops - 1).max(1) as f64) * 100.0;
                (stop_trimmed, format!("{pct:.1}%"))
            }
        } else {
            let pct = (i as f64 / (total_stops - 1).max(1) as f64) * 100.0;
            (stop_trimmed, format!("{pct:.1}%"))
        };

        let (hex_color, opacity) = if color == "transparent" {
            ("#000000".to_string(), 0.0)
        } else if color.starts_with("rgba(") && color.ends_with(')') {
            let inner = &color[5..color.len() - 1];
            let nums: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
            if nums.len() == 4 {
                let r: u8 = nums[0].parse().unwrap_or(0);
                let g: u8 = nums[1].parse().unwrap_or(0);
                let b: u8 = nums[2].parse().unwrap_or(0);
                let a: f64 = nums[3].parse().unwrap_or(1.0);
                (format!("#{r:02x}{g:02x}{b:02x}"), a)
            } else {
                (color.to_string(), 1.0)
            }
        } else if color.starts_with("rgb(") && color.ends_with(')') {
            let inner = &color[4..color.len() - 1];
            let nums: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
            if nums.len() == 3 {
                let r: u8 = nums[0].parse().unwrap_or(0);
                let g: u8 = nums[1].parse().unwrap_or(0);
                let b: u8 = nums[2].parse().unwrap_or(0);
                (format!("#{r:02x}{g:02x}{b:02x}"), 1.0)
            } else {
                (color.to_string(), 1.0)
            }
        } else {
            (color.to_string(), 1.0)
        };

        stops_xml.push_str(&format!(
            r##"<stop offset="{offset}" stop-color="{hex_color}" stop-opacity="{opacity}" />"##
        ));
    }
    stops_xml
}

pub(crate) fn generate_background_plate_png(
    background: &str,
    width: u32,
    height: u32,
) -> Option<PathBuf> {
    let svg = parse_css_gradient_to_svg(background, width, height)?;
    let options = resvg::usvg::Options {
        fontdb: overlay_engine::get_shared_font_database(),
        ..Default::default()
    };
    let tree = resvg::usvg::Tree::from_str(&svg, &options).ok()?;
    let mut pixmap = Pixmap::new(width, height)?;
    resvg::render(&tree, Transform::identity(), &mut pixmap.as_mut());
    let temp_path =
        std::env::temp_dir().join(format!("recordforge_bg_grad_{}.png", uuid::Uuid::new_v4()));
    pixmap.save_png(&temp_path).ok()?;
    Some(temp_path)
}

fn decode_percent_encoded(input: &str) -> String {
    let mut result = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    result.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}

fn normalize_file_path_str(input: &str) -> String {
    let mut path = input.trim();
    // Normalize Windows drive paths with leading slash, e.g. "/C:/Users" or "\C:\Users" -> "C:/Users"
    if path.len() >= 3
        && (path.starts_with('/') || path.starts_with('\\'))
        && path.as_bytes()[1].is_ascii_alphabetic()
        && path.as_bytes()[2] == b':'
    {
        path = &path[1..];
    }
    path.to_string()
}

fn rasterize_svg_bytes_to_png(svg_bytes: &[u8], width: u32, height: u32) -> Option<PathBuf> {
    let svg_str = std::str::from_utf8(svg_bytes).ok()?;
    let options = resvg::usvg::Options {
        fontdb: overlay_engine::get_shared_font_database(),
        ..Default::default()
    };
    let tree = resvg::usvg::Tree::from_str(svg_str, &options).ok()?;
    let mut pixmap = Pixmap::new(width, height)?;
    resvg::render(&tree, Transform::identity(), &mut pixmap.as_mut());
    let temp_path =
        std::env::temp_dir().join(format!("recordforge_bg_svg_{}.png", uuid::Uuid::new_v4()));
    pixmap.save_png(&temp_path).ok()?;
    Some(temp_path)
}

fn find_candidate_file_in_dir(
    dir: &Path,
    candidate_names: &[String],
    max_depth: usize,
) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    for name in candidate_names {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
    }
    if max_depth == 0 {
        return None;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(filename) = path.file_name().and_then(|f| f.to_str()) {
                    for candidate in candidate_names {
                        let cand_name = Path::new(candidate)
                            .file_name()
                            .and_then(|f| f.to_str())
                            .unwrap_or(candidate.as_str());
                        if filename.eq_ignore_ascii_case(cand_name) {
                            return Some(path);
                        }
                    }
                }
            } else if path.is_dir() {
                let dir_name = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
                if !dir_name.starts_with('.') && dir_name != "node_modules" && dir_name != "target"
                {
                    if let Some(found) =
                        find_candidate_file_in_dir(&path, candidate_names, max_depth - 1)
                    {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

#[allow(dead_code)]
pub(crate) fn resolve_background_image(
    background: &str,
    asset_paths: &HashMap<String, PathBuf>,
) -> Option<PathBuf> {
    resolve_background_image_with_resource_dir(background, asset_paths, None)
}

pub(crate) fn resolve_background_image_with_resource_dir(
    background: &str,
    asset_paths: &HashMap<String, PathBuf>,
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    resolve_background_image_with_dimensions(background, asset_paths, resource_dir, 1920, 1080)
}

pub(crate) fn resolve_background_image_with_dimensions(
    background: &str,
    asset_paths: &HashMap<String, PathBuf>,
    resource_dir: Option<&Path>,
    width: u32,
    height: u32,
) -> Option<PathBuf> {
    let trimmed = background.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('#')
        || trimmed.starts_with("rgb(")
        || trimmed.starts_with("rgba(")
        || trimmed.starts_with("hsl(")
        || trimmed.starts_with("hsla(")
    {
        return None;
    }

    let target_w = if width > 0 { width } else { 1920 };
    let target_h = if height > 0 { height } else { 1080 };

    // Try generating CSS gradients (linear, radial, mesh) to a temporary PNG
    if trimmed.contains("-gradient(") {
        if let Some(grad_path) = generate_background_plate_png(trimmed, target_w, target_h) {
            return Some(grad_path);
        }
        return None;
    }

    let mut path_str = if trimmed.starts_with("url(") && trimmed.ends_with(')') {
        let inner = &trimmed[4..trimmed.len() - 1].trim();
        inner.trim_matches(|c| c == '"' || c == '\'').trim()
    } else {
        trimmed
    };
    path_str = path_str.trim_matches(|c| c == '"' || c == '\'').trim();

    if path_str.starts_with("data:image/") {
        if let Some((mime, rest)) = path_str.split_once(',') {
            let is_base64 = mime.contains(";base64");
            let is_svg = mime.contains("svg") || path_str.contains("<svg");

            let bytes = if is_base64 {
                use base64::Engine;
                let trimmed_data = rest.trim();
                base64::engine::general_purpose::STANDARD
                    .decode(trimmed_data)
                    .or_else(|_| {
                        base64::engine::general_purpose::STANDARD_NO_PAD.decode(trimmed_data)
                    })
                    .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(trimmed_data))
                    .or_else(|_| {
                        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(trimmed_data)
                    })
                    .ok()
            } else {
                Some(rest.as_bytes().to_vec())
            };

            if let Some(bytes) = bytes {
                if is_svg || bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") {
                    return rasterize_svg_bytes_to_png(&bytes, target_w, target_h);
                } else {
                    let ext = if mime.contains("jpeg")
                        || mime.contains("jpg")
                        || bytes.starts_with(b"\xFF\xD8\xFF")
                    {
                        "jpg"
                    } else if mime.contains("webp")
                        || (bytes.len() >= 12
                            && &bytes[0..4] == b"RIFF"
                            && &bytes[8..12] == b"WEBP")
                    {
                        "webp"
                    } else if mime.contains("gif") || bytes.starts_with(b"GIF8") {
                        "gif"
                    } else {
                        "png"
                    };
                    let temp_path = std::env::temp_dir().join(format!(
                        "recordforge_bg_{}.{}",
                        uuid::Uuid::new_v4(),
                        ext
                    ));
                    if std::fs::write(&temp_path, bytes).is_ok() {
                        return Some(temp_path);
                    }
                }
            }
        }
    }

    if let Some(idx) = path_str.find("://") {
        let scheme = &path_str[..idx];
        let after_scheme = &path_str[idx + 3..];
        if scheme.eq_ignore_ascii_case("file") {
            let without_host = if let Some(slash_idx) = after_scheme.find('/') {
                &after_scheme[slash_idx..]
            } else {
                after_scheme
            };
            path_str = without_host;
        } else if let Some(slash_idx) = after_scheme.find('/') {
            path_str = &after_scheme[slash_idx..];
        }
    }
    if let Some(idx) = path_str.find('?') {
        path_str = &path_str[..idx];
    }
    if let Some(idx) = path_str.find('#') {
        path_str = &path_str[..idx];
    }

    let decoded = decode_percent_encoded(path_str);
    let normalized = normalize_file_path_str(&decoded);
    let clean_str = normalized.as_str();

    if let Some(path) = asset_paths.get(clean_str) {
        if path.is_file() {
            return Some(path.clone());
        }
    }
    if let Some(path) = asset_paths.get(path_str) {
        if path.is_file() {
            return Some(path.clone());
        }
    }
    if let Some(path) = asset_paths.get(trimmed) {
        if path.is_file() {
            return Some(path.clone());
        }
    }

    let direct = PathBuf::from(clean_str);
    if direct.is_file() {
        if direct
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
        {
            if let Ok(bytes) = std::fs::read(&direct) {
                if let Some(png_path) = rasterize_svg_bytes_to_png(&bytes, target_w, target_h) {
                    return Some(png_path);
                }
            }
        }
        return Some(direct);
    }

    let raw_direct = PathBuf::from(path_str);
    if raw_direct.is_file() {
        return Some(raw_direct);
    }

    let filename = direct
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(clean_str);
    let trimmed_leading = clean_str.trim_start_matches(['/', '\\']);

    let mut candidate_names = vec![filename.to_string(), trimmed_leading.to_string()];
    if !filename.contains('.') {
        candidate_names.push(format!("{filename}.jpg"));
        candidate_names.push(format!("{filename}.jpeg"));
        candidate_names.push(format!("{filename}.png"));
        candidate_names.push(format!("{filename}.webp"));
    }

    let mut search_dirs = Vec::new();
    if let Some(res) = resource_dir {
        search_dirs.push(res.join("backgrounds"));
        search_dirs.push(res.join("public").join("backgrounds"));
        search_dirs.push(res.join("assets").join("backgrounds"));
        search_dirs.push(res.join("dist").join("backgrounds"));
        search_dirs.push(res.join("_up_").join("public").join("backgrounds"));
        search_dirs.push(
            res.join("_up_")
                .join("_up_")
                .join("_up_")
                .join("assets")
                .join("backgrounds"),
        );
        search_dirs.push(res.join("_up_").join("assets").join("backgrounds"));
        search_dirs.push(res.join("_up_").join("dist").join("backgrounds"));
        search_dirs.push(res.to_path_buf());
    }

    let mut base_roots = Vec::new();
    if let Some(res) = resource_dir {
        base_roots.push(res.to_path_buf());
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur = Some(cwd.as_path());
        let mut depth = 0;
        while let Some(dir) = cur {
            base_roots.push(dir.to_path_buf());
            cur = dir.parent();
            depth += 1;
            if depth >= 5 {
                break;
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        let mut depth = 0;
        while let Some(dir) = cur {
            base_roots.push(dir.to_path_buf());
            cur = dir.parent();
            depth += 1;
            if depth >= 6 {
                break;
            }
        }
    }
    for asset_path in asset_paths.values() {
        if let Some(parent) = asset_path.parent() {
            base_roots.push(parent.to_path_buf());
        }
    }

    for root in &base_roots {
        search_dirs.push(root.join("public").join("backgrounds"));
        search_dirs.push(
            root.join("apps")
                .join("desktop")
                .join("public")
                .join("backgrounds"),
        );
        search_dirs.push(
            root.join("apps")
                .join("desktop")
                .join("dist")
                .join("backgrounds"),
        );
        search_dirs.push(root.join("dist").join("backgrounds"));
        search_dirs.push(root.join("assets").join("backgrounds"));
        search_dirs.push(root.join("resources").join("backgrounds"));
        search_dirs.push(root.join("backgrounds"));
        search_dirs.push(root.join("_up_").join("public").join("backgrounds"));
        search_dirs.push(
            root.join("_up_")
                .join("_up_")
                .join("_up_")
                .join("assets")
                .join("backgrounds"),
        );
        search_dirs.push(root.join("public"));
        search_dirs.push(root.join("dist"));
        search_dirs.push(root.join("assets"));
    }

    for dir in &search_dirs {
        for name in &candidate_names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                if candidate
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
                {
                    if let Ok(bytes) = std::fs::read(&candidate) {
                        if let Some(png_path) =
                            rasterize_svg_bytes_to_png(&bytes, target_w, target_h)
                        {
                            return Some(png_path);
                        }
                    }
                }
                return Some(candidate);
            }
        }
    }

    // Fallback: recursive directory scan in resource_dir and base_roots (up to depth 4)
    if let Some(res) = resource_dir {
        if let Some(candidate) = find_candidate_file_in_dir(res, &candidate_names, 4) {
            if candidate
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
            {
                if let Ok(bytes) = std::fs::read(&candidate) {
                    if let Some(png_path) = rasterize_svg_bytes_to_png(&bytes, target_w, target_h) {
                        return Some(png_path);
                    }
                }
            }
            return Some(candidate);
        }
    }

    for root in &base_roots {
        if let Some(candidate) = find_candidate_file_in_dir(root, &candidate_names, 4) {
            if candidate
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
            {
                if let Ok(bytes) = std::fs::read(&candidate) {
                    if let Some(png_path) = rasterize_svg_bytes_to_png(&bytes, target_w, target_h) {
                        return Some(png_path);
                    }
                }
            }
            return Some(candidate);
        }
    }

    None
}

/// Pre-render and composite the complete background canvas plate in Rust at exact
/// target dimensions (width x height), including fitting/cropping source images,
/// background blur, background dim, and screen drop shadow.
///
/// This completely eliminates:
/// 1. FFmpeg upscaling 16:9 background images to 3.4K/6.8K on vertical or square canvases.
/// 2. Redundant secondary 60-FPS RGBA video streams for shadows (`shadow_loop`).
/// 3. Multi-pass software overlay blending between background and shadow.
pub(crate) fn prepare_canvas_background_plate(
    canvas: &cursor::RenderCanvas,
    screen_rect: (f64, f64, f64, f64),
    asset_paths: &HashMap<String, PathBuf>,
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    let (screen_x, screen_y, screen_w, screen_h) = screen_rect;
    let width = canvas.width;
    let height = canvas.height;
    let trimmed = canvas.background.trim();

    let is_solid_color = trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with("rgb(")
        || trimmed.starts_with("rgba(")
        || trimmed.starts_with("hsl(")
        || trimmed.starts_with("hsla(");

    // If it's a solid color and there is no shadow, no border radius, and no dim/blur:
    // return None so direct padding can be used in FFmpeg without any plate files or overlays.
    if is_solid_color
        && !canvas.shadow
        && canvas.border_radius == 0
        && canvas.background_dim.unwrap_or(0.0) <= 0.0
        && canvas.background_blur.unwrap_or(0.0) <= 0.0
    {
        return None;
    }

    let mut pixmap = if is_solid_color {
        let mut p = Pixmap::new(width, height)?;
        let color_str = if trimmed.is_empty() {
            "#000000"
        } else {
            trimmed
        };
        let hex = safe_filter_color(color_str);
        let color = parse_color_hex(&hex, 1.0);
        p.fill(color);
        p
    } else if trimmed.contains("-gradient(") {
        let svg = parse_css_gradient_to_svg(trimmed, width, height)?;
        let options = resvg::usvg::Options {
            fontdb: overlay_engine::get_shared_font_database(),
            ..Default::default()
        };
        let tree = resvg::usvg::Tree::from_str(&svg, &options).ok()?;
        let mut p = Pixmap::new(width, height)?;
        resvg::render(&tree, Transform::identity(), &mut p.as_mut());
        p
    } else {
        let resolved_file = resolve_background_image_with_dimensions(
            trimmed,
            asset_paths,
            resource_dir,
            width,
            height,
        )?;
        let is_temp_svg = resolved_file
            .file_name()
            .and_then(|f| f.to_str())
            .is_some_and(|n| n.starts_with("recordforge_bg_svg_"));
        if is_temp_svg {
            let bytes = std::fs::read(&resolved_file).ok()?;
            Pixmap::decode_png(&bytes).ok()?
        } else {
            let dynamic_img = image::open(&resolved_file).ok().or_else(|| {
                let bytes = std::fs::read(&resolved_file).ok()?;
                image::load_from_memory(&bytes).ok()
            })?;
            let fit_mode = canvas.background_fit.as_deref().unwrap_or("cover");
            let resized = match fit_mode {
                "contain" | "fit" => {
                    let aspect_img = dynamic_img.width() as f64 / dynamic_img.height() as f64;
                    let aspect_canvas = width as f64 / height as f64;
                    let (new_w, new_h) = if aspect_img > aspect_canvas {
                        (width, ((width as f64 / aspect_img).round() as u32).max(1))
                    } else {
                        (((height as f64 * aspect_img).round() as u32).max(1), height)
                    };
                    let scaled =
                        dynamic_img.resize(new_w, new_h, image::imageops::FilterType::Triangle);
                    let mut base = image::RgbaImage::new(width, height);
                    let offset_x = (width.saturating_sub(new_w)) / 2;
                    let offset_y = (height.saturating_sub(new_h)) / 2;
                    image::imageops::overlay(
                        &mut base,
                        &scaled.to_rgba8(),
                        offset_x as i64,
                        offset_y as i64,
                    );
                    image::DynamicImage::ImageRgba8(base)
                }
                "fill" => {
                    dynamic_img.resize_exact(width, height, image::imageops::FilterType::Triangle)
                }
                _ => {
                    dynamic_img.resize_to_fill(width, height, image::imageops::FilterType::Triangle)
                }
            };
            let mut png_bytes = std::io::Cursor::new(Vec::new());
            resized
                .write_to(&mut png_bytes, image::ImageFormat::Png)
                .ok()?;
            Pixmap::decode_png(png_bytes.get_ref()).ok()?
        }
    };

    let bg_blur = canvas.background_blur.unwrap_or(0.0).clamp(0.0, 100.0);
    if bg_blur > 0.0 {
        fast_blur_pixmap(&mut pixmap, (bg_blur.round() as f32).clamp(1.0, 50.0));
    }

    let bg_dim = canvas.background_dim.unwrap_or(0.0).clamp(0.0, 1.0);
    if bg_dim > 0.0 {
        let dim_color = Color::from_rgba(0.0, 0.0, 0.0, bg_dim as f32).unwrap_or(Color::BLACK);
        let mut paint = Paint::default();
        paint.set_color(dim_color);
        paint.anti_alias = false;
        if let Some(rect) = Rect::from_xywh(0.0, 0.0, width as f32, height as f32) {
            pixmap.fill_rect(rect, &paint, Transform::identity(), None);
        }
    }

    if canvas.shadow {
        render_shadow_onto_pixmap(
            &mut pixmap,
            screen_x,
            screen_y,
            screen_w,
            screen_h,
            canvas.border_radius,
            canvas.shadow_color.as_deref(),
            canvas.shadow_blur,
            canvas.shadow_offset_x,
            canvas.shadow_offset_y,
        );
    }

    let temp_path =
        std::env::temp_dir().join(format!("recordforge_bg_plate_{}.png", uuid::Uuid::new_v4()));
    pixmap.save_png(&temp_path).ok()?;
    Some(temp_path)
}

fn validate_segment_known(
    segment: &RenderSegment,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
) -> Result<()> {
    if !asset_paths.contains_key(&segment.asset_id) {
        return Err(InternalError::Permissions(
            "render plan references a missing or unauthorized asset".into(),
        )
        .into());
    }
    validate_segment(segment, project_id)
}

fn validate_mask(
    mask: &RenderPlanMask,
    _project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    canvas: &cursor::RenderCanvas,
) -> Result<()> {
    if let Some(asset_id) = mask.asset_id.as_ref() {
        if !asset_paths.contains_key(asset_id) {
            return Err(InternalError::Permissions(
                "privacy mask references an unknown asset".into(),
            )
            .into());
        }
    }
    if !matches!(mask.mode.as_str(), "blur" | "pixelate" | "redact")
        || mask.rect.width <= 0.0
        || mask.rect.height <= 0.0
        || mask.rect.x < 0.0
        || mask.rect.y < 0.0
        || mask.rect.x >= canvas.width as f64
        || mask.rect.y >= canvas.height as f64
        || mask.rect.x + mask.rect.width > canvas.width as f64 + 0.5
        || mask.rect.y + mask.rect.height > canvas.height as f64 + 0.5
    {
        return Err(InternalError::Media("privacy mask rectangle is invalid".into()).into());
    }
    if !mask.blur_radius.is_finite() || !(1.0..=128.0).contains(&mask.blur_radius) {
        return Err(InternalError::Media("privacy mask blur radius is unsupported".into()).into());
    }
    if !(2..=128).contains(&mask.pixel_size) {
        return Err(InternalError::Media("privacy mask pixel size is unsupported".into()).into());
    }
    Ok(())
}

fn overlay_values_are_finite(overlay: &RenderPlanOverlay) -> bool {
    [
        overlay.source_in_ms as f64,
        overlay.source_out_ms as f64,
        overlay.output_start_ms as f64,
        overlay.output_end_ms as f64,
        overlay.speed,
        overlay.x,
        overlay.y,
        overlay.width,
        overlay.height,
        overlay.opacity,
    ]
    .iter()
    .all(|value| value.is_finite())
}

fn mask_values_are_finite(mask: &RenderPlanMask) -> bool {
    [
        mask.start_ms as f64,
        mask.end_ms as f64,
        mask.rect.x,
        mask.rect.y,
        mask.rect.width,
        mask.rect.height,
        mask.blur_radius,
        mask.pixel_size as f64,
    ]
    .iter()
    .all(|value| value.is_finite())
}

fn zoom_target_values_are_valid(target: &RenderCropFloat) -> bool {
    [target.x, target.y, target.width, target.height]
        .iter()
        .all(|value| value.is_finite())
        && target.width > 0.0
        && target.height > 0.0
}

fn zoom_motion_point_values_are_valid(point: &RenderPlanZoomMotionPoint) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

fn zoom_motion_plan_is_valid(
    motion_plan: &RenderPlanZoomMotionPlan,
    segment: &RenderPlanZoomSegment,
) -> bool {
    if motion_plan.version != cursor_engine::CUBIC_BEZIER_MOTION_PLAN_VERSION
        || motion_plan.kind != cursor_engine::CUBIC_BEZIER_MOTION_PLAN_KIND
        || motion_plan.segments.is_empty()
    {
        return false;
    }

    let mut previous_end = segment.start_ms;
    for motion_segment in &motion_plan.segments {
        if motion_segment.start_ms != previous_end
            || motion_segment.end_ms <= motion_segment.start_ms
            || motion_segment.end_ms > segment.end_ms
            || !zoom_motion_point_values_are_valid(&motion_segment.start)
            || !zoom_motion_point_values_are_valid(&motion_segment.control1)
            || !zoom_motion_point_values_are_valid(&motion_segment.control2)
            || !zoom_motion_point_values_are_valid(&motion_segment.end)
        {
            return false;
        }
        previous_end = motion_segment.end_ms;
    }

    previous_end == segment.end_ms
}

fn zoom_values_are_finite(segment: &RenderPlanZoomSegment) -> bool {
    let base_values_are_valid = [
        segment.start_ms as f64,
        segment.end_ms as f64,
        segment.scale,
    ]
    .iter()
    .all(|value| value.is_finite())
        && (1.0..=8.0).contains(&segment.scale)
        && zoom_target_values_are_valid(&segment.target);
    if !base_values_are_valid {
        return false;
    }

    if let Some(from_scale) = segment.from_scale {
        if !from_scale.is_finite() || !(1.0..=8.0).contains(&from_scale) {
            return false;
        }
    }
    if let Some(from_target) = &segment.from_target {
        if !zoom_target_values_are_valid(from_target) {
            return false;
        }
    }
    if let Some(motion_plan) = &segment.motion_plan {
        if !zoom_motion_plan_is_valid(motion_plan, segment) {
            return false;
        }
    }

    let Some(keyframes) = segment.keyframes.as_ref() else {
        return true;
    };
    keyframes.windows(2).all(|window| {
        let previous = &window[0];
        let current = &window[1];
        previous.time_ms < current.time_ms
            && previous.time_ms >= segment.start_ms
            && current.time_ms <= segment.end_ms
            && zoom_target_values_are_valid(&previous.target)
            && zoom_target_values_are_valid(&current.target)
    }) && keyframes.iter().all(|keyframe| {
        keyframe.time_ms >= segment.start_ms
            && keyframe.time_ms <= segment.end_ms
            && zoom_target_values_are_valid(&keyframe.target)
    })
}

fn validate_overlay(
    overlay: &RenderPlanOverlay,
    _project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    canvas: &cursor::RenderCanvas,
) -> Result<()> {
    if !asset_paths.contains_key(&overlay.asset_id) {
        return Err(InternalError::Permissions(
            "camera overlay references an unknown asset".into(),
        )
        .into());
    }
    if overlay.source_in_ms >= overlay.source_out_ms
        || overlay.output_start_ms >= overlay.output_end_ms
        || overlay.width <= 0.0
        || overlay.height <= 0.0
        || overlay.opacity < 0.0
        || overlay.opacity > 1.0
        || !overlay.speed.is_finite()
        || overlay.speed <= 0.0
        || overlay.x < 0.0
        || overlay.y < 0.0
        || overlay.x + overlay.width > canvas.width as f64 + 0.5
        || overlay.y + overlay.height > canvas.height as f64 + 0.5
    {
        return Err(InternalError::Media("camera overlay transform is invalid".into()).into());
    }
    if let Some(crop) = &overlay.crop {
        if crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 {
            return Err(InternalError::Media("camera overlay crop is invalid".into()).into());
        }
    }
    Ok(())
}

fn validate_asset(asset_id: &str) -> Result<()> {
    if asset_id.trim().is_empty() {
        return Err(InternalError::Media("render plan asset id is empty".into()).into());
    }
    Ok(())
}

fn validate_segment(segment: &RenderSegment, _project_id: &str) -> Result<()> {
    validate_asset(&segment.asset_id)?;
    if segment.source_in_ms >= segment.source_out_ms {
        return Err(
            InternalError::Media("render segment has an invalid source range".into()).into(),
        );
    }
    if segment.output_end_ms <= segment.output_start_ms {
        return Err(
            InternalError::Media("render segment has an invalid output range".into()).into(),
        );
    }
    if !segment.speed.is_finite() || segment.speed <= 0.0 {
        return Err(InternalError::Media("render segment has an invalid speed".into()).into());
    }
    if segment
        .volume
        .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
        || segment
            .fade_in_ms
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        || segment
            .fade_out_ms
            .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return Err(
            InternalError::Media("render segment audio settings are invalid".into()).into(),
        );
    }
    if let Some(stream_index) = segment.stream_index {
        if stream_index < 0 {
            return Err(
                InternalError::Media("render segment has an invalid stream index".into()).into(),
            );
        }
    }
    Ok(())
}

fn resolve_video_stream_specifier(
    probe: &ProbeCache,
    asset_path: &Path,
    asset_id: &str,
    input_index: usize,
    stream_index: Option<i32>,
) -> Result<String> {
    let Some(metadata) = probe.metadata(asset_path, asset_id) else {
        return Ok(stream_index.map_or_else(
            || format!("[{input_index}:v:0]"),
            |index| format!("[{input_index}:{index}]"),
        ));
    };
    let metadata = metadata.map_err(|_| {
        InternalError::Media("probe render asset for stream selection failed".into())
    })?;
    let video_streams = metadata
        .streams
        .iter()
        .filter(|stream| stream.kind == "video")
        .collect::<Vec<_>>();
    if let Some(index) = stream_index {
        if video_streams.iter().any(|stream| stream.index == index) {
            return Ok(format!("[{input_index}:{index}]"));
        }
        let is_webcam = asset_id.contains(":webcam:")
            || asset_path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("webcam.mp4"));
        if is_webcam && !video_streams.is_empty() {
            return Ok(format!("[{input_index}:{}]", video_streams[0].index));
        }
        return Err(InternalError::Media(
            "the selected video stream is missing from its asset".into(),
        )
        .into());
    }
    video_streams
        .first()
        .map(|stream| format!("[{input_index}:{}]", stream.index))
        .ok_or_else(|| InternalError::Media("render asset has no video stream".into()).into())
}

fn resolve_audio_stream_specifier(
    probe: &ProbeCache,
    asset_path: &Path,
    asset_id: &str,
    input_index: usize,
    stream_index: Option<i32>,
) -> Result<Option<String>> {
    let Some(metadata) = probe.metadata(asset_path, asset_id) else {
        return Ok(Some(stream_index.map_or_else(
            || format!("[{input_index}:a:0]"),
            |index| format!("[{input_index}:{index}]"),
        )));
    };
    let metadata = metadata.map_err(|_| {
        InternalError::Media("probe render asset for stream selection failed".into())
    })?;
    let audio_streams = metadata
        .streams
        .iter()
        .filter(|stream| stream.kind == "audio")
        .collect::<Vec<_>>();
    if let Some(index) = stream_index {
        if audio_streams.iter().any(|stream| stream.index == index) {
            return Ok(Some(format!("[{input_index}:{index}]")));
        }
        let is_standalone = asset_id.contains(":microphone:")
            || asset_id.contains(":system_audio:")
            || asset_id.contains(":audio:")
            || asset_path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".wav") || n.ends_with(".mp3") || n.ends_with(".m4a"));
        if is_standalone && !audio_streams.is_empty() {
            return Ok(Some(format!("[{input_index}:{}]", audio_streams[0].index)));
        }
        return Err(InternalError::Media(
            "the selected audio stream is missing from its asset".into(),
        )
        .into());
    }
    Ok(audio_streams
        .first()
        .map(|stream| format!("[{input_index}:{}]", stream.index)))
}

fn seconds(milliseconds: u64) -> String {
    format!("{:.3}", milliseconds as f64 / 1000.0)
}

/// Enumerate the `[start_ms, end_ms)` windows in which the generated overlay
/// items plane can contain visible content. Returns None when the typed render
/// plan cannot be parsed — the caller then leaves the plate ungated so unknown
/// content can never be clipped by a stale window.
fn collect_overlay_item_windows(plan: &RenderPlan) -> Option<Vec<(u64, u64)>> {
    if let Some(value) = &plan.overlay_render_plan {
        return serde_json::from_value::<overlay_engine::OverlayRenderPlan>(value.clone())
            .ok()
            .map(|overlay_plan| {
                overlay_plan
                    .items
                    .iter()
                    .map(|item| item.timing())
                    .collect()
            });
    }
    Some(
        plan.annotations
            .iter()
            .map(|item| (item.start_ms, item.end_ms))
            .chain(plan.texts.iter().map(|item| (item.start_ms, item.end_ms)))
            .chain(plan.images.iter().map(|item| (item.start_ms, item.end_ms)))
            .collect(),
    )
}

/// Merge `[start_ms, end_ms)` windows into a minimal `enable` expression for a
/// generated-plate `overlay` filter so FFmpeg skips blending while the plate
/// is fully transparent. Returns None when the union covers the whole export
/// (gating would add an expression for no benefit). An empty union yields the
/// constant `0`, which disables the blend for the entire stream.
fn plate_enable_expr(windows: Vec<(u64, u64)>, duration_ms: u64) -> Option<String> {
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(windows.len());
    let mut windows: Vec<(u64, u64)> = windows
        .into_iter()
        .filter(|(start, end)| end > start)
        .collect();
    windows.sort_unstable();
    for (start, end) in windows {
        match merged.last_mut() {
            Some((_, prev_end)) if start <= *prev_end => *prev_end = (*prev_end).max(end),
            _ => merged.push((start, end)),
        }
    }
    if merged.is_empty() {
        return Some("0".into());
    }
    // A long expression per frame costs more than it saves; collapse dense
    // timelines into a single wide window.
    const MAX_ENABLE_WINDOWS: usize = 8;
    if merged.len() > MAX_ENABLE_WINDOWS {
        merged = vec![(merged[0].0, merged[merged.len() - 1].1)];
    }
    if merged.len() == 1 && merged[0].0 == 0 && merged[0].1 >= duration_ms {
        return None;
    }
    Some(
        merged
            .iter()
            .map(|(start, end)| format!("between(t,{},{})", seconds(*start), seconds(*end)))
            .collect::<Vec<_>>()
            .join("+"),
    )
}

fn write_caption_sidecar(output_path: &Path, captions: &[RenderPlanCaption]) -> Result<PathBuf> {
    captions::write_sidecar(output_path, captions)
}

pub(crate) fn partial_output_path(output_path: &Path) -> PathBuf {
    let stem = output_path
        .file_stem()
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|| "export".into());
    output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.partial.mp4"))
}

fn emit_job_update(app: &tauri::AppHandle, job: &MediaJob) -> Result<()> {
    // Avoid emitting on a very tight loop by yielding briefly.
    std::thread::sleep(Duration::from_millis(1));
    EventPublisher::new(app).media_job_update(job)
}

#[allow(dead_code)]
fn emit_progress(
    app: &tauri::AppHandle,
    job: &MediaJob,
    progress: f64,
    stage: &str,
    message: Option<&str>,
) -> Result<()> {
    let updated = MediaJob {
        progress,
        stage: stage.into(),
        message: message.map(|s| s.into()),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..job.clone()
    };
    emit_job_update(app, &updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_pipe_closed_matches_broken_pipe_errors() {
        assert!(is_pipe_closed(&std::io::Error::from_raw_os_error(109)));
        assert!(is_pipe_closed(&std::io::Error::from_raw_os_error(232)));
        assert!(is_pipe_closed(&std::io::Error::from(
            std::io::ErrorKind::BrokenPipe
        )));
        assert!(!is_pipe_closed(&std::io::Error::from_raw_os_error(5)));
    }

    #[test]
    fn redact_paths_scrubs_windows_and_posix_paths() {
        let line =
            "No such file or directory: 'C:\\Users\\me\\Videos\\rec.mp4' (read from /tmp/out)";
        assert_eq!(
            redact_paths(line),
            "No such file or directory: <path> (read from <path>"
        );
        assert_eq!(redact_paths("Invalid argument"), "Invalid argument");
    }

    #[test]
    fn ffmpeg_failure_detail_returns_last_redacted_line() {
        let stderr = b"first line\n[mpeg4] something broke\n";
        assert_eq!(
            ffmpeg_failure_detail(stderr).as_deref(),
            Some("[mpeg4] something broke")
        );
        assert_eq!(ffmpeg_failure_detail(b"\n \n"), None);
    }

    #[test]
    fn chunk_boundaries_cover_all_frames_exactly() {
        let boundaries = chunk_boundaries(1000, 300);
        assert_eq!(
            boundaries,
            vec![(0, 300), (300, 600), (600, 900), (900, 1000)]
        );
        // Contiguous and non-overlapping: concatenating emits every frame once.
        for pair in boundaries.windows(2) {
            assert_eq!(pair[0].1, pair[1].0);
        }
        assert_eq!(
            boundaries
                .iter()
                .map(|(start, end)| end - start)
                .sum::<u64>(),
            1000
        );
        assert_eq!(chunk_boundaries(100, 500), vec![(0, 100)]);
        assert!(chunk_boundaries(0, 100).is_empty());
    }

    #[test]
    fn composition_window_from_frames_maps_to_absolute_seconds() {
        let window = CompositionWindow::from_frames(180, 180, 30);
        assert_eq!(window.first_frame, 180);
        assert!((window.start_s - 6.0).abs() < 1e-9);
        assert!((window.end_s - 12.0).abs() < 1e-9);
        assert_eq!(window.duration_ms, 6000);
    }

    fn source_request(asset: &str, stream: Option<i32>, in_s: f64, out_s: f64) -> SourceRequest {
        SourceRequest {
            asset_id: asset.to_string(),
            stream_index: stream,
            source_in_s: in_s,
            source_out_s: out_s,
        }
    }

    #[test]
    fn plan_segment_inputs_coalesces_forward_gaps() {
        let plan = plan_segment_inputs(&[
            source_request("screen", Some(0), 60.0, 120.0),
            // 1 s gap ≤ COALESCE_GAP_S: reuses the open window, extends its end.
            source_request("screen", Some(0), 121.0, 180.0),
        ])
        .expect("plan");
        assert_eq!(plan.inputs.len(), 1);
        assert_eq!(plan.assignment, vec![0, 0]);
        assert!((plan.inputs[0].seek_s - 59.5).abs() < 1e-9);
        assert!((plan.inputs[0].end_s - 180.0).abs() < 1e-9);
    }

    #[test]
    fn plan_segment_inputs_splits_on_gap_reorder_overlap_and_stream() {
        // Gap beyond COALESCE_GAP_S opens a new input.
        let plan = plan_segment_inputs(&[
            source_request("screen", None, 10.0, 20.0),
            source_request("screen", None, 25.0, 30.0),
        ])
        .expect("plan");
        assert_eq!(plan.inputs.len(), 2);
        assert_eq!(plan.assignment, vec![0, 1]);

        // Reordered (backward) playback gets its own input.
        let plan = plan_segment_inputs(&[
            source_request("screen", None, 100.0, 200.0),
            source_request("screen", None, 50.0, 60.0),
        ])
        .expect("plan");
        assert_eq!(plan.inputs.len(), 2);

        // Overlapping an open window's end also opens a new input.
        let plan = plan_segment_inputs(&[
            source_request("screen", None, 10.0, 20.0),
            source_request("screen", None, 15.0, 25.0),
        ])
        .expect("plan");
        assert_eq!(plan.inputs.len(), 2);

        // A different stream on the same asset never shares a window.
        let plan = plan_segment_inputs(&[
            source_request("screen", Some(0), 10.0, 20.0),
            source_request("screen", Some(1), 12.0, 18.0),
        ])
        .expect("plan");
        assert_eq!(plan.inputs.len(), 2);
    }

    #[test]
    fn plan_segment_inputs_clamps_seek_to_zero_and_caps_inputs() {
        // source_in below the preroll seeks from the file start.
        let plan = plan_segment_inputs(&[source_request("screen", None, 0.2, 5.0)]).expect("plan");
        assert_eq!(plan.inputs[0].seek_s, 0.0);

        let requests: Vec<SourceRequest> = (0..=MAX_SEEK_INPUTS)
            .map(|index| {
                source_request(
                    "screen",
                    None,
                    index as f64 * 10.0,
                    index as f64 * 10.0 + 5.0,
                )
            })
            .collect();
        assert!(plan_segment_inputs(&requests).is_none());
    }

    #[test]
    fn cut_segment_source_in_adds_video_start_delay() {
        // B-frame-delayed source (video starts 66.7 ms in): a cut at 15 s aims
        // 66.7 ms past so the chunk lands on the standalone pass's frame.
        assert!((corrected_source_in_s(0, 15.0, 1.0, 0.0667) - 15.0667).abs() < 1e-4);
        // An uncut segment is unchanged.
        assert_eq!(corrected_source_in_s(60_000, 0.0, 1.0, 0.0667), 60.0);
        // When the segment starts after the delay, nothing is added.
        assert!((corrected_source_in_s(1_000, 15.0, 1.0, 0.0667) - 16.0).abs() < 1e-9);
        // Speed scales the cut but not the delay term.
        assert!((corrected_source_in_s(0, 10.0, 2.0, 0.0667) - 20.0667).abs() < 1e-4);
    }

    #[test]
    fn camera_window_clamp_full_window_matches_the_unchanged_chain() {
        let clamp = camera_window_clamp(0, 120_000, 0, 120_000, 1.0, 30.0, 0.0, 120_000.0, 0.0)
            .expect("clamped");
        assert_eq!(clamp.cut_out_s, 0.0);
        assert!((clamp.chain_dur_s - 120.0).abs() < 1e-9);
        assert_eq!(clamp.src_in_s, 0.0);
        assert_eq!(clamp.src_out_s, 120.0);
    }

    #[test]
    fn camera_window_clamp_cuts_to_the_chunk_window() {
        // Window starts at 60 s, overlay begins at 1234 ms: rel = 57.766 s →
        // cut snaps down to the frame grid.
        let clamp = camera_window_clamp(
            1234, 120_000, 5_000, 125_000, 1.0, 30.0, 60_000.0, 90_000.0, 0.0667,
        )
        .expect("clamped");
        let expected_cut = (57.766_f64 * 30.0_f64).floor() / 30.0;
        assert!((clamp.cut_out_s - expected_cut).abs() < 1e-9);
        let cut_abs_s = 1.234 + clamp.cut_out_s;
        assert!(cut_abs_s <= 59.0 + 1e-9);
        assert!(cut_abs_s >= 58.0);
        // Chain covers from the cut through window end + 1 s.
        assert!((1.234 + clamp.cut_out_s + clamp.chain_dur_s - 91.0).abs() < 1e-9);
        // source_in starts well past the first video frame, so no delay
        // correction applies to the cut.
        assert!((clamp.src_in_s - (5.0 + expected_cut)).abs() < 1e-9);
        assert!((clamp.src_out_s - (clamp.src_in_s + clamp.chain_dur_s)).abs() < 1e-9);

        // A source_in at the stream start does absorb the B-frame delay:
        // the standalone chain's first frame sits at 0.0667 s, so a cut must
        // aim past it.
        let clamp = camera_window_clamp(
            1234, 120_000, 0, 125_000, 1.0, 30.0, 60_000.0, 90_000.0, 0.0667,
        )
        .expect("clamped");
        assert!((clamp.src_in_s - (expected_cut + 0.0667)).abs() < 1e-9);
    }

    #[test]
    fn camera_window_clamp_disjoint_window_returns_none() {
        assert!(
            camera_window_clamp(0, 10_000, 0, 10_000, 1.0, 30.0, 60_000.0, 90_000.0, 0.0).is_none()
        );
        assert!(camera_window_clamp(
            90_000, 120_000, 0, 30_000, 1.0, 30.0, 60_000.0, 90_000.0, 0.0
        )
        .is_none());
    }

    #[test]
    fn stdin_queue_sizing_scales_with_frame_bytes() {
        // 1080p single-plane RGBA.
        assert_eq!(stdin_thread_queue_size(1920 * 1080 * 4), 12);
        // 1080p dual-plane (cursor + items packed side by side).
        assert_eq!(stdin_thread_queue_size(3840 * 1080 * 4), 6);
        // 4K dual-plane clamps to the floor.
        assert_eq!(stdin_thread_queue_size(7680 * 2160 * 4), 4);
    }

    #[test]
    fn chunk_concat_list_writes_per_chunk_durations() {
        let list = chunk_concat_list(
            &[
                (PathBuf::from("C:/tmp/chunk_00000.ts"), 300),
                (PathBuf::from("C:/tmp/chunk_00001.ts"), 100),
            ],
            30,
        );
        assert_eq!(
            list,
            "file 'C:/tmp/chunk_00000.ts'\nduration 10.000000\nfile 'C:/tmp/chunk_00001.ts'\nduration 3.333333"
        );
    }

    #[test]
    fn hvc1_tag_applies_only_to_hevc() {
        let hevc = ExportSettings {
            preset: "balanced".into(),
            codec: "hevc".into(),
            encoder: "software".into(),
            container: "mp4".into(),
            caption_mode: "none".into(),
            chapter_mode: "none".into(),
            range: None,
        };
        assert_eq!(hvc1_tag_args(&hevc), &["-tag:v", "hvc1"]);
        let h264 = ExportSettings {
            codec: "h264".into(),
            ..hevc
        };
        assert!(hvc1_tag_args(&h264).is_empty());
    }

    fn test_media_metadata(
        streams: Vec<(&str, Option<u64>)>,
    ) -> crate::database::media::MediaMetadata {
        use crate::database::media::{MediaFormat, MediaMetadata, MediaStream};
        MediaMetadata {
            recording_id: "test".into(),
            path: "asset.mp4".into(),
            duration_ms: 0,
            width: Some(1920),
            height: Some(1080),
            fps: Some(30.0),
            has_audio: false,
            video_codec: None,
            audio_codec: None,
            bitrate_kbps: None,
            streams: streams
                .iter()
                .enumerate()
                .map(|(index, (kind, start_ms))| MediaStream {
                    index: index as i32,
                    kind: kind.to_string(),
                    codec: String::new(),
                    title: None,
                    start_ms: *start_ms,
                    duration_ms: None,
                    codec_long_name: None,
                    width: None,
                    height: None,
                    fps: None,
                    bitrate_kbps: None,
                    sample_rate: None,
                    channels: None,
                    channel_layout: None,
                    language: None,
                })
                .collect(),
            format: MediaFormat::default(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn probe_cache_probes_once_per_path_across_threads() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cache = ProbeCache::with_prober({
            let calls = Arc::clone(&calls);
            move |_, _| {
                calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(test_media_metadata(vec![
                    ("video", Some(0)),
                    ("audio", Some(0)),
                ]))
            }
        });
        let path = Path::new("C:/media/screen.mp4");
        for _ in 0..3 {
            assert!(cache.metadata(path, "screen").expect("enabled").is_ok());
        }
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    assert!(cache.metadata(path, "screen").expect("enabled").is_ok());
                });
            }
        });
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);

        let disabled = ProbeCache::new(None);
        assert!(disabled.metadata(path, "screen").is_none());
    }

    #[test]
    fn probe_cache_video_start_delay_from_stream_offsets() {
        let cache = ProbeCache::with_prober(|_, _| {
            Ok(test_media_metadata(vec![
                ("video", Some(67)),
                ("audio", Some(0)),
            ]))
        });
        let path = Path::new("C:/media/screen.mp4");
        assert!((cache.video_start_delay_s(path, "screen") - 0.067).abs() < 1e-3);
        let disabled = ProbeCache::new(None);
        assert_eq!(disabled.video_start_delay_s(path, "screen"), 0.0);
    }

    #[test]
    fn plate_cache_generates_once_and_guards_owned_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let owned_path = dir.path().join("owned.png");
        let kept_path = dir.path().join("kept.png");
        std::fs::write(&kept_path, b"plate").expect("write kept plate");
        let calls = std::sync::atomic::AtomicUsize::new(0);
        {
            let cache = PlateCache::new();
            for _ in 0..2 {
                let path = cache
                    .get_or_create("bg", || {
                        calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        std::fs::write(&owned_path, b"plate").expect("write owned plate");
                        Ok(Some((owned_path.clone(), true)))
                    })
                    .expect("create plate");
                assert_eq!(path.as_deref(), Some(owned_path.as_path()));
            }
            let kept = cache
                .get_or_create("asset", || Ok(Some((kept_path.clone(), false))))
                .expect("create plate");
            assert_eq!(kept.as_deref(), Some(kept_path.as_path()));
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(!owned_path.exists(), "owned plate deleted with the cache");
        assert!(kept_path.exists(), "non-owned plate survives the cache");
    }

    fn valid_plan() -> RenderPlan {
        RenderPlan {
            project_id: "project-1".into(),
            duration_ms: 3_000,
            segments: vec![
                RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(0),
                    volume: None,
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 1_000,
                    output_start_ms: 0,
                    output_end_ms: 1_000,
                    source_width: None,
                    source_height: None,
                },
                RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(0),
                    volume: None,
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 2.0,
                    source_in_ms: 2_000,
                    source_out_ms: 4_000,
                    output_start_ms: 2_000,
                    output_end_ms: 3_000,
                    source_width: None,
                    source_height: None,
                },
            ],
            gaps: vec![RenderPlanGap {
                start_ms: 1_000,
                end_ms: 2_000,
            }],
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 1_920,
                height: 1_080,
                fps: 30,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: Some(Vec::new()),
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        }
    }

    #[test]
    fn validates_project_scoped_timing_and_gaps() {
        assert!(valid_plan().validate().is_ok());
        let mut invalid = valid_plan();
        invalid.gaps[0].end_ms = 2_500;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn parses_the_shared_render_plan_fixture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tooling/golden-fixtures/render-plan.json");
        let json = std::fs::read_to_string(path).expect("shared render plan fixture");
        let plan: RenderPlan = serde_json::from_str(&json).expect("serde render plan fixture");
        assert_eq!(plan.project_id, "project-phase8");
        assert!(plan.validate().is_ok());
    }

    #[test]
    fn accepts_the_unified_overlay_render_plan_field() {
        let mut raw = serde_json::to_value(valid_plan()).expect("serialize render plan");
        raw["overlayRenderPlan"] = serde_json::json!({
            "version": 1,
            "canvas": { "width": 1920, "height": 1080 },
            "items": [],
            "assets": [],
            "fonts": []
        });

        let parsed: RenderPlan = serde_json::from_value(raw).expect("unified overlay plan");
        assert!(parsed.overlay_render_plan.is_some());
    }

    #[test]
    fn test_render_plan_deserialization_with_overlays_and_enabled_field() {
        let mut raw = serde_json::to_value(valid_plan()).expect("serialize render plan");
        raw["annotations"] = serde_json::json!([
            {
                "id": "ann-1",
                "startMs": 0,
                "endMs": 1000,
                "annotationType": "rounded-rect",
                "x": 10.0,
                "y": 20.0,
                "width": 100.0,
                "height": 50.0,
                "strokeColor": "#38bdf8",
                "strokeWidth": 2.0,
                "strokeStyle": "solid",
                "fillColor": "#38bdf8",
                "fillOpacity": 0.2,
                "cornerRadius": 8.0,
                "arrowEndHead": "arrow",
                "arrowStartHead": "none",
                "shadowEnabled": false,
                "shadowColor": "black",
                "shadowBlur": 0.0,
                "textColor": "#ffffff",
                "fontSize": 14.0,
                "animationIn": "fade",
                "animationOut": "fade",
                "enabled": true
            }
        ]);
        raw["texts"] = serde_json::json!([
            {
                "id": "txt-1",
                "startMs": 0,
                "endMs": 1000,
                "presetId": "title-modern",
                "category": "title",
                "primaryText": "Test Title",
                "x": 10.0,
                "y": 20.0,
                "width": 100.0,
                "height": 50.0,
                "alignment": "left",
                "fontFamily": "sans",
                "fontSize": 32.0,
                "fontWeight": "700",
                "textColor": "#ffffff",
                "secondaryTextColor": "#94a3b8",
                "accentColor": "#38bdf8",
                "backdropStyle": "glass",
                "backdropColor": "#0f172a",
                "backdropOpacity": 0.8,
                "backdropBlur": 16.0,
                "backdropBorderRadius": 12.0,
                "backdropPaddingX": 24.0,
                "backdropPaddingY": 16.0,
                "shadowEnabled": false,
                "shadowColor": "black",
                "shadowBlur": 0.0,
                "animationIn": "fade",
                "animationOut": "fade",
                "enabled": true
            }
        ]);
        raw["images"] = serde_json::json!([
            {
                "id": "img-1",
                "assetId": "asset-image-1",
                "startMs": 0,
                "endMs": 1000,
                "x": 10.0,
                "y": 20.0,
                "width": 100.0,
                "height": 50.0,
                "opacity": 1.0,
                "borderRadius": 4.0,
                "borderWidth": 1.0,
                "borderColor": "#ffffff",
                "shadowEnabled": false,
                "shadowColor": "black",
                "shadowBlur": 0.0,
                "fit": "contain",
                "animationIn": "fade",
                "animationOut": "fade",
                "enabled": true
            }
        ]);

        let parsed: RenderPlan =
            serde_json::from_value(raw).expect("deserialization of RenderPlan with overlays");
        assert_eq!(parsed.annotations.len(), 1);
        assert!(parsed.annotations[0].enabled);
        assert_eq!(parsed.texts.len(), 1);
        assert!(parsed.texts[0].enabled);
        assert_eq!(parsed.images.len(), 1);
        assert!(parsed.images[0].enabled);
    }

    #[test]
    fn uses_shared_zoom_easing_names_and_exclusive_segment_end() {
        let progress = zoom_easing_expression("p", "cinematic");
        assert!(progress.contains("3-2*"));
        let (z_expr, x_expr, y_expr) = build_zoompan_expressions(
            &RenderPlan {
                zoom_segments: vec![RenderPlanZoomSegment {
                    id: "zoom".into(),
                    start_ms: 0,
                    end_ms: 1_000,
                    target: RenderCropFloat {
                        x: 100.0,
                        y: 100.0,
                        width: 960.0,
                        height: 540.0,
                    },
                    scale: 1.5,
                    easing: "cinematic".into(),
                    transition_in_ms: 300,
                    transition_out_ms: 300,
                    enabled: true,
                    mode: "auto".into(),
                    source: "click".into(),
                    preset: "product-demo".into(),
                    follow_deadzone_percent: None,
                    follow_smoothing_alpha: None,
                    label: None,
                    from_target: None,
                    from_scale: None,
                    keyframes: None,
                    motion_plan: None,
                }],
                ..valid_plan()
            },
            &cursor::RenderCanvas {
                width: 1_920,
                height: 1_080,
                fps: 30,
                ..Default::default()
            },
            1920.0,
            1080.0,
        );
        assert!(z_expr.contains("lt(it,1)"));
        assert!(z_expr.contains("/max(1,("));
        assert!(x_expr.contains("max(0,min(iw-iw/zoom"));
        assert!(y_expr.contains("max(0,min(ih-ih/zoom"));
    }

    #[test]
    fn derives_video_zoom_scale_from_the_authoritative_crop() {
        let crop = RenderCropFloat {
            x: 320.0,
            y: 190.0,
            width: 960.0,
            height: 700.0,
        };

        assert!((effective_zoom_scale(1_920.0, &crop) - 2.0).abs() < 0.000_001);
        let canonical = clamped_zoom_crop(1_920, 1_080, 48, &crop, 1.5);
        assert!((canonical.height - 540.0).abs() < 0.000_001);
    }

    #[test]
    fn clamps_zoom_crop_to_padded_content_area() {
        let (z_expr, x_expr, y_expr) = build_zoompan_expressions(
            &RenderPlan {
                zoom_segments: vec![RenderPlanZoomSegment {
                    id: "zoom".into(),
                    start_ms: 0,
                    end_ms: 1_000,
                    target: RenderCropFloat {
                        x: 0.0,
                        y: 0.0,
                        width: 4_000.0,
                        height: 2_000.0,
                    },
                    scale: 1.5,
                    easing: "linear".into(),
                    transition_in_ms: 300,
                    transition_out_ms: 300,
                    enabled: true,
                    mode: "auto".into(),
                    source: "click".into(),
                    preset: "product-demo".into(),
                    follow_deadzone_percent: None,
                    follow_smoothing_alpha: None,
                    label: None,
                    from_target: None,
                    from_scale: None,
                    keyframes: None,
                    motion_plan: None,
                }],
                ..valid_plan()
            },
            &cursor::RenderCanvas {
                width: 1_920,
                height: 1_080,
                fps: 30,
                padding: 48,
                border_radius: 12,
                ..Default::default()
            },
            1824.0,
            984.0,
        );
        assert!(!z_expr.is_empty());
        assert!(!x_expr.is_empty());
        assert!(!y_expr.is_empty());
    }

    #[test]
    fn builds_atempo_chain_for_extreme_speed_changes() {
        let filter = atempo_filter(4.0);
        assert_eq!(filter, ",atempo=2.0,atempo=2.000000");
    }

    #[test]
    fn keeps_partial_paths_separate_from_published_paths() {
        let output = Path::new("C:/exports/demo.mp4");
        assert_ne!(partial_output_path(output), output);
        assert!(partial_output_path(output)
            .to_string_lossy()
            .contains("partial"));
    }

    #[test]
    fn cursor_partial_path_is_distinct_from_video_partial_path() {
        let output = Path::new("C:/exports/demo.mp4");
        let video_partial = partial_output_path(output);
        let cursor_partial = cursor_partial_output_path(output);
        assert_ne!(video_partial, cursor_partial);
        assert!(cursor_partial.to_string_lossy().contains("partial"));
        assert!(cursor_partial.to_string_lossy().contains("cursor"));
    }

    #[test]
    fn cleanup_export_files_removes_cursor_partial_output() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("demo.mp4");
        let cursor_partial = cursor_partial_output_path(&output);
        std::fs::write(&cursor_partial, b"partial").expect("write partial");
        assert!(cursor_partial.exists());

        cleanup_export_files(&output);

        assert!(!cursor_partial.exists());
    }

    #[test]
    fn detects_export_partial_path_collisions_with_project_assets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("demo.mp4");
        let asset = partial_output_path(&output);
        std::fs::write(&asset, b"project asset").expect("write project asset");

        assert!(managed_export_paths(&output, &valid_plan())
            .iter()
            .any(|path| paths_refer_to_same_file(&asset, path)));
        assert_eq!(std::fs::read(&asset).unwrap(), b"project asset");
    }

    #[test]
    fn validates_60fps_and_4k_export_presets() {
        let plan = valid_plan();
        for preset in ["smooth-60fps", "ultra-4k", "ultra-4k-60"] {
            let settings = ExportSettings {
                preset: preset.into(),
                codec: "h264".into(),
                encoder: "auto".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "embed".into(),
                range: None,
            };
            assert!(validate_export_settings(&settings, &plan).is_ok());
        }
        let settings_4k = ExportSettings {
            preset: "ultra-4k".into(),
            codec: "h264".into(),
            encoder: "software".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };
        assert_eq!(audio_bitrate(&settings_4k), "192k");
    }

    #[test]
    fn validates_encoder_preference_and_defaults_missing_fields() {
        let plan = valid_plan();
        let mut settings = ExportSettings {
            preset: "default-mp4".into(),
            codec: "h264".into(),
            encoder: "nvenc".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };
        assert!(validate_export_settings(&settings, &plan).is_err());
        settings.encoder = "auto".into();
        assert!(validate_export_settings(&settings, &plan).is_ok());

        // Settings persisted by older app versions deserialize with the auto
        // encoder preference applied.
        let legacy = serde_json::json!({
            "preset": "default-mp4",
            "codec": "h264",
            "container": "mp4",
            "captionMode": "burn-in"
        });
        let parsed: ExportSettings = serde_json::from_value(legacy).expect("legacy settings");
        assert_eq!(parsed.encoder, "auto");
    }

    #[test]
    fn progress_lines_are_recognized_and_parsed() {
        assert!(is_progress_line("out_time=00:00:01.500000"));
        assert!(is_progress_line("progress=continue"));
        assert!(!is_progress_line("[libx264] something failed"));
        assert!(!is_progress_line(
            "C:/recordings/demo.mp4: Invalid argument"
        ));
    }

    #[test]
    fn pack_overlay_planes_places_left_and_right_halves() {
        // 2x2 planes packed into a 4x2 frame: left=cursor, right=items.
        let left = vec![1u8; 2 * 2 * 4];
        let right = vec![2u8; 2 * 2 * 4];
        let mut dst = vec![0u8; 4 * 2 * 4];
        pack_overlay_planes(&mut dst, 2, 2, Some(&left), Some(&right));
        assert_eq!(
            dst,
            vec![
                1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, // row 0
                1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, // row 1
            ]
        );
    }

    #[test]
    fn pack_overlay_planes_fills_missing_side_with_transparency() {
        let right = vec![7u8; 2 * 1 * 4];
        let mut dst = vec![9u8; 4 * 1 * 4];
        pack_overlay_planes(&mut dst, 2, 1, None, Some(&right));
        assert_eq!(dst, vec![0, 0, 0, 0, 0, 0, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7]);
    }

    #[test]
    fn plate_enable_expr_merges_and_collapses_windows() {
        // Overlapping windows merge into a union expression.
        assert_eq!(
            plate_enable_expr(vec![(1_000, 2_000), (500, 1_200), (4_000, 5_000)], 10_000),
            Some("between(t,0.500,2.000)+between(t,4.000,5.000)".to_string())
        );
        // A union covering the whole export is left ungated.
        assert_eq!(plate_enable_expr(vec![(0, 10_000)], 10_000), None);
        // No visible content anywhere disables the blend entirely.
        assert_eq!(plate_enable_expr(Vec::new(), 10_000), Some("0".to_string()));
        // Dense timelines collapse into one wide window instead of a huge
        // per-frame expression.
        assert_eq!(
            plate_enable_expr(
                (0..12).map(|i| (i * 1_000, i * 1_000 + 500)).collect(),
                60_000,
            ),
            Some("between(t,0.000,11.500)".to_string())
        );
    }

    #[test]
    fn collect_overlay_item_windows_enumerates_typed_and_legacy_items() {
        // A typed render plan contributes its item windows.
        let mut plan = valid_plan();
        plan.overlay_render_plan = Some(serde_json::json!({
            "version": 1,
            "canvas": { "width": 1920, "height": 1080 },
            "items": [
                {
                    "kind": "annotation",
                    "id": "ann-rect",
                    "startMs": 500,
                    "endMs": 3000,
                    "transform": {
                        "x": 100.0, "y": 100.0, "width": 300.0, "height": 200.0,
                        "rotation": 0.0, "anchorX": 0.5, "anchorY": 0.5,
                        "zIndex": 10, "opacity": 1.0
                    },
                    "enabled": true,
                    "annotationType": "rounded-rect",
                    "strokeColor": "#38bdf8",
                    "strokeWidth": 4.0,
                    "strokeStyle": "solid",
                    "fillColor": "#38bdf8",
                    "fillOpacity": 0.2,
                    "cornerRadius": 16.0,
                    "arrowEndHead": "none",
                    "arrowStartHead": "none",
                    "shadowEnabled": false,
                    "shadowColor": "black",
                    "shadowBlur": 0.0,
                    "textColor": "#ffffff",
                    "fontSize": 16.0
                }
            ],
            "assets": [],
            "fonts": []
        }));
        assert_eq!(
            collect_overlay_item_windows(&plan),
            Some(vec![(500, 3_000)])
        );
        // Legacy items are enumerated when no typed plan exists.
        let mut legacy = valid_plan();
        legacy.texts = serde_json::from_value(serde_json::json!([
            {
                "id": "txt-1",
                "startMs": 200,
                "endMs": 800,
                "presetId": "title-modern",
                "category": "title",
                "primaryText": "Test",
                "x": 10.0,
                "y": 20.0,
                "width": 100.0,
                "height": 50.0,
                "alignment": "left",
                "fontFamily": "sans",
                "fontSize": 32.0,
                "fontWeight": "700",
                "textColor": "#ffffff",
                "secondaryTextColor": "#94a3b8",
                "accentColor": "#38bdf8",
                "backdropStyle": "glass",
                "backdropColor": "#0f172a",
                "backdropOpacity": 0.8,
                "backdropBlur": 16.0,
                "backdropBorderRadius": 12.0,
                "backdropPaddingX": 24.0,
                "backdropPaddingY": 16.0,
                "shadowEnabled": false,
                "shadowColor": "black",
                "shadowBlur": 0.0,
                "animationIn": "fade",
                "animationOut": "fade",
                "enabled": true
            }
        ]))
        .expect("legacy text");
        assert_eq!(
            collect_overlay_item_windows(&legacy),
            Some(vec![(200, 800)])
        );
        // An unparseable render plan reports unknown windows so callers do not
        // gate the plate behind a stale expression.
        let mut invalid = valid_plan();
        invalid.overlay_render_plan = Some(serde_json::json!({ "broken": true }));
        assert_eq!(collect_overlay_item_windows(&invalid), None);
    }

    #[test]
    fn prepare_cursor_frame_plan_initializes_overlay_engine_with_unified_plan() {
        let mut plan = valid_plan();
        plan.overlay_render_plan = Some(serde_json::json!({
            "version": 1,
            "canvas": { "width": 1920, "height": 1080 },
            "items": [
                {
                    "kind": "annotation",
                    "id": "ann-rect",
                    "startMs": 500,
                    "endMs": 3000,
                    "transform": {
                        "x": 100.0,
                        "y": 100.0,
                        "width": 300.0,
                        "height": 200.0,
                        "rotation": 0.0,
                        "anchorX": 0.5,
                        "anchorY": 0.5,
                        "zIndex": 10,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 300,
                        "outDurationMs": 300,
                        "easing": "expo-out"
                    },
                    "enabled": true,
                    "annotationType": "rounded-rect",
                    "strokeColor": "#38bdf8",
                    "strokeWidth": 4.0,
                    "strokeStyle": "solid",
                    "fillColor": "#38bdf8",
                    "fillOpacity": 0.2,
                    "cornerRadius": 16.0,
                    "arrowEndHead": "none",
                    "arrowStartHead": "none",
                    "shadowEnabled": true,
                    "shadowColor": "rgba(0,0,0,0.5)",
                    "shadowBlur": 10.0,
                    "textColor": "#ffffff",
                    "fontSize": 16.0
                },
                {
                    "kind": "text",
                    "id": "text-title",
                    "startMs": 1000,
                    "endMs": 4000,
                    "transform": {
                        "x": 200.0,
                        "y": 400.0,
                        "width": 500.0,
                        "height": 150.0,
                        "rotation": 0.0,
                        "anchorX": 0.5,
                        "anchorY": 0.5,
                        "zIndex": 20,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 300,
                        "outDurationMs": 300,
                        "easing": "expo-out"
                    },
                    "enabled": true,
                    "presetId": "glass-title",
                    "category": "title",
                    "primaryText": "Export Parity Title",
                    "secondaryText": "Rendered with overlay engine",
                    "tagText": "LIVE",
                    "alignment": "left",
                    "fontFamily": "sans",
                    "fontSize": 32.0,
                    "fontWeight": "700",
                    "textColor": "#ffffff",
                    "secondaryTextColor": "#94a3b8",
                    "accentColor": "#38bdf8",
                    "backdropStyle": "glass",
                    "backdropColor": "#0f172a",
                    "backdropOpacity": 0.8,
                    "backdropBlur": 16.0,
                    "backdropBorderRadius": 12.0,
                    "backdropPaddingX": 20.0,
                    "backdropPaddingY": 16.0,
                    "shadowEnabled": true,
                    "shadowColor": "rgba(0,0,0,0.5)",
                    "shadowBlur": 8.0
                }
            ],
            "assets": [],
            "fonts": []
        }));

        let canvas = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            ..Default::default()
        };
        let asset_paths = HashMap::new();
        let frame_plan = prepare_cursor_frame_plan(
            &canvas,
            5000,
            Vec::new(),
            &plan,
            &asset_paths,
            (0.0, 0.0, canvas.width as f64, canvas.height as f64),
        )
        .expect("prepare frame plan succeeds");

        assert!(frame_plan.overlay_engine.is_some());
        let engine = frame_plan.overlay_engine.unwrap();
        let mut pixmap = tiny_skia::Pixmap::new(1920, 1080).unwrap();
        engine
            .render_to_pixmap(1500, &mut pixmap)
            .expect("render overlay frame");
        let has_content = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
        assert!(
            has_content,
            "rendered frame contains active overlay content"
        );
    }

    #[test]
    fn prepare_cursor_frame_plan_loads_svg_and_png_image_assets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let svg_path = dir.path().join("logo.svg");
        let png_path = dir.path().join("badge.png");

        std::fs::write(
            &svg_path,
            br##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#38bdf8"/></svg>"##,
        )
        .expect("write SVG");

        // Generate minimal valid PNG
        let mut sample_pixmap = tiny_skia::Pixmap::new(60, 60).unwrap();
        sample_pixmap.fill(tiny_skia::Color::from_rgba8(255, 0, 0, 255));
        let png_bytes = sample_pixmap.encode_png().expect("encode PNG");
        std::fs::write(&png_path, png_bytes).expect("write PNG");

        let mut plan = valid_plan();
        plan.overlay_render_plan = Some(serde_json::json!({
            "version": 1,
            "canvas": { "width": 1920, "height": 1080 },
            "items": [
                {
                    "kind": "image",
                    "id": "img-svg",
                    "startMs": 0,
                    "endMs": 5000,
                    "transform": {
                        "x": 50.0,
                        "y": 50.0,
                        "width": 200.0,
                        "height": 100.0,
                        "rotation": 0.0,
                        "anchorX": 0.5,
                        "anchorY": 0.5,
                        "zIndex": 10,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 300,
                        "outDurationMs": 300,
                        "easing": "expo-out"
                    },
                    "enabled": true,
                    "assetId": "asset-svg",
                    "fit": "contain",
                    "borderRadius": 8.0,
                    "borderWidth": 2.0,
                    "borderColor": "#ffffff",
                    "shadowEnabled": false,
                    "shadowColor": "#000000",
                    "shadowBlur": 0.0
                },
                {
                    "kind": "image",
                    "id": "img-png",
                    "startMs": 0,
                    "endMs": 5000,
                    "transform": {
                        "x": 300.0,
                        "y": 50.0,
                        "width": 120.0,
                        "height": 120.0,
                        "rotation": 0.0,
                        "anchorX": 0.5,
                        "anchorY": 0.5,
                        "zIndex": 20,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 300,
                        "outDurationMs": 300,
                        "easing": "expo-out"
                    },
                    "enabled": true,
                    "assetId": "asset-png",
                    "fit": "cover",
                    "borderRadius": 12.0,
                    "borderWidth": 1.0,
                    "borderColor": "#38bdf8",
                    "shadowEnabled": true,
                    "shadowColor": "rgba(0,0,0,0.5)",
                    "shadowBlur": 8.0
                }
            ],
            "assets": [
                { "id": "asset-svg", "kind": "image" },
                { "id": "asset-png", "kind": "image" }
            ],
            "fonts": []
        }));

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-svg".into(), svg_path);
        asset_paths.insert("asset-png".into(), png_path);

        let canvas = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            ..Default::default()
        };
        let frame_plan = prepare_cursor_frame_plan(
            &canvas,
            5000,
            Vec::new(),
            &plan,
            &asset_paths,
            (0.0, 0.0, canvas.width as f64, canvas.height as f64),
        )
        .expect("prepare frame plan succeeds");

        assert!(frame_plan.overlay_engine.is_some());
        let engine = frame_plan.overlay_engine.unwrap();
        assert_eq!(engine.images().len(), 2);

        let mut pixmap = tiny_skia::Pixmap::new(1920, 1080).unwrap();
        engine
            .render_to_pixmap(1000, &mut pixmap)
            .expect("render image overlays");
        let has_content = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
        assert!(has_content, "rendered image overlay frame contains pixels");
    }

    #[test]
    fn test_resolve_background_image_formats() {
        let mut asset_paths = HashMap::new();
        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("custom-bg.jpg");
        std::fs::write(&file_path, b"fake jpg content").unwrap();
        asset_paths.insert("asset-bg-1".into(), file_path.clone());

        // Solid colors return None
        assert!(resolve_background_image("#1e1b4b", &asset_paths).is_none());

        // Radial gradients generate a rendered background plate file
        let resolved_radial =
            resolve_background_image("radial-gradient(circle, #fff, #000)", &asset_paths);
        assert!(resolved_radial.is_some());
        if let Some(path) = resolved_radial {
            assert!(path.is_file());
            let _ = std::fs::remove_file(path);
        }

        // Linear gradients generate a rendered background plate file
        let resolved_gradient =
            resolve_background_image("linear-gradient(135deg, #111 0%, #222 100%)", &asset_paths);
        assert!(resolved_gradient.is_some());
        if let Some(path) = resolved_gradient {
            assert!(path.is_file());
            let _ = std::fs::remove_file(path);
        }

        // Asset ID lookup returns file path
        let resolved_asset = resolve_background_image("asset-bg-1", &asset_paths);
        assert_eq!(resolved_asset, Some(file_path.clone()));

        // Direct file path returns file path
        let resolved_direct = resolve_background_image(file_path.to_str().unwrap(), &asset_paths);
        assert_eq!(resolved_direct, Some(file_path.clone()));

        // Windows drive path with leading slash, e.g. /C:/path
        let slash_path = format!("/{}", file_path.to_str().unwrap().replace('\\', "/"));
        let resolved_slash = resolve_background_image(&slash_path, &asset_paths);
        assert!(
            resolved_slash.is_some(),
            "Path with leading slash should resolve: {}",
            slash_path
        );

        // file:/// URI scheme
        let file_uri = format!("file:///{}", file_path.to_str().unwrap().replace('\\', "/"));
        let resolved_file_uri = resolve_background_image(&file_uri, &asset_paths);
        assert!(
            resolved_file_uri.is_some(),
            "file:/// URI scheme should resolve: {}",
            file_uri
        );

        // asset://localhost/ URI scheme
        let asset_uri = format!(
            "asset://localhost/{}",
            file_path.to_str().unwrap().replace('\\', "/")
        );
        let resolved_asset_uri = resolve_background_image(&asset_uri, &asset_paths);
        assert!(
            resolved_asset_uri.is_some(),
            "asset:// URI scheme should resolve: {}",
            asset_uri
        );

        // Percent-encoded URI scheme
        let encoded_path = format!(
            "file:///{}",
            file_path
                .to_str()
                .unwrap()
                .replace('\\', "/")
                .replace(':', "%3A")
                .replace(' ', "%20")
        );
        let resolved_encoded = resolve_background_image(&encoded_path, &asset_paths);
        assert!(
            resolved_encoded.is_some(),
            "Percent-encoded URI should resolve: {}",
            encoded_path
        );

        // Base64 data URL decodes to a file
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let resolved_data = resolve_background_image(data_url, &asset_paths);
        assert!(resolved_data.is_some());
        let written_path = resolved_data.unwrap();
        assert!(written_path.is_file());
        let _ = std::fs::remove_file(written_path);

        // SVG data URL rasterizes to a PNG
        let svg_data_url = "data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><rect width=\"100\" height=\"100\" fill=\"#6366f1\"/></svg>";
        let resolved_svg = resolve_background_image(svg_data_url, &asset_paths);
        assert!(
            resolved_svg.is_some(),
            "SVG data URL should rasterize to PNG"
        );
        if let Some(path) = resolved_svg {
            assert!(path.is_file());
            let _ = std::fs::remove_file(path);
        }

        // Custom resource_dir lookup (direct subfolder)
        let res_dir = tempfile::tempdir().unwrap();
        let res_bg = res_dir.path().join("backgrounds").join("packaged-bg.jpg");
        std::fs::create_dir_all(res_bg.parent().unwrap()).unwrap();
        std::fs::write(&res_bg, b"packaged bg content").unwrap();
        let resolved_res = resolve_background_image_with_resource_dir(
            "/backgrounds/packaged-bg.jpg",
            &asset_paths,
            Some(res_dir.path()),
        );
        assert_eq!(resolved_res, Some(res_bg));

        // Tauri v2 _up_ resource bundle lookup (e.g. _up_/public/backgrounds/bg-up.jpg)
        let res_up_dir = tempfile::tempdir().unwrap();
        let res_up_bg = res_up_dir
            .path()
            .join("_up_")
            .join("public")
            .join("backgrounds")
            .join("bg-up.jpg");
        std::fs::create_dir_all(res_up_bg.parent().unwrap()).unwrap();
        std::fs::write(&res_up_bg, b"tauri up bg content").unwrap();
        let resolved_up = resolve_background_image_with_resource_dir(
            "/backgrounds/bg-up.jpg",
            &asset_paths,
            Some(res_up_dir.path()),
        );
        assert_eq!(
            resolved_up,
            Some(res_up_bg),
            "Tauri _up_ packaged background should resolve"
        );

        // Deeply nested resource directory lookup
        let res_nested_dir = tempfile::tempdir().unwrap();
        let res_nested_bg = res_nested_dir
            .path()
            .join("deeply")
            .join("nested")
            .join("folder")
            .join("nested-bg.jpg");
        std::fs::create_dir_all(res_nested_bg.parent().unwrap()).unwrap();
        std::fs::write(&res_nested_bg, b"nested bg content").unwrap();
        let resolved_nested = resolve_background_image_with_resource_dir(
            "nested-bg.jpg",
            &asset_paths,
            Some(res_nested_dir.path()),
        );
        assert_eq!(
            resolved_nested,
            Some(res_nested_bg),
            "Nested packaged background should resolve via recursive scan"
        );

        // JPEG base64 data URL writes a file with .jpg extension
        let jpeg_data_url = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
        let resolved_jpeg = resolve_background_image(jpeg_data_url, &asset_paths);
        assert!(resolved_jpeg.is_some());
        let jpeg_file = resolved_jpeg.unwrap();
        assert!(jpeg_file.is_file());
        assert_eq!(jpeg_file.extension().and_then(|e| e.to_str()), Some("jpg"));
        let _ = std::fs::remove_file(jpeg_file);

        // Curated preset background paths and URLs resolve
        let resolved_preset = resolve_background_image("/backgrounds/bg-1.jpg", &asset_paths);
        assert!(
            resolved_preset.is_some(),
            "preset /backgrounds/bg-1.jpg should resolve to a valid file"
        );
        let resolved_url = resolve_background_image("url('/backgrounds/bg-1.jpg')", &asset_paths);
        assert!(
            resolved_url.is_some(),
            "url('/backgrounds/bg-1.jpg') should resolve to a valid file"
        );
        let resolved_quoted = resolve_background_image("\"/backgrounds/bg-1.jpg\"", &asset_paths);
        assert!(
            resolved_quoted.is_some(),
            "quoted \"/backgrounds/bg-1.jpg\" should resolve to a valid file"
        );
        let resolved_id = resolve_background_image("bg-1", &asset_paths);
        assert!(
            resolved_id.is_some(),
            "preset ID bg-1 should resolve to a valid file"
        );
    }

    #[test]
    fn test_video_screen_rect_aspect_ratios() {
        // 16:9 canvas (1920x1080) with 16:9 source (1920x1080) and 0 padding
        // For 16:9, video is always centered even if video_position_y is specified
        let canvas_16_9 = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            padding: 0,
            aspect_ratio: Some("16:9".into()),
            video_position_y: Some(0.0), // Ignored for 16:9
            ..Default::default()
        };
        let rect = video_screen_rect(&canvas_16_9, Some((1920, 1080)), false);
        assert_eq!(rect, (0.0, 0.0, 1920.0, 1080.0));

        // 9:16 vertical canvas (1080x1920) with 16:9 source (1920x1080)
        // Source 1920x1080 fit into 1080x1920: scale = 1080/1920 = 0.5625 -> snapped to even 1080 x 608
        // Slack = 1920 - 608 = 1312
        let mut canvas_9_16 = cursor::RenderCanvas {
            width: 1080,
            height: 1920,
            padding: 0,
            aspect_ratio: Some("9:16".into()),
            video_position_y: Some(0.5), // Center
            ..Default::default()
        };
        let rect_9_16_center = video_screen_rect(&canvas_9_16, Some((1920, 1080)), false);
        assert_eq!(rect_9_16_center, (0.0, 656.0, 1080.0, 608.0));

        canvas_9_16.video_position_y = Some(0.0); // Top
        let rect_9_16_top = video_screen_rect(&canvas_9_16, Some((1920, 1080)), false);
        assert_eq!(rect_9_16_top, (0.0, 0.0, 1080.0, 608.0));

        canvas_9_16.video_position_y = Some(1.0); // Bottom
        let rect_9_16_bottom = video_screen_rect(&canvas_9_16, Some((1920, 1080)), false);
        assert_eq!(rect_9_16_bottom, (0.0, 1312.0, 1080.0, 608.0));

        // 1:1 square canvas (1080x1080) with 16:9 source (1920x1080) and 40px padding
        // Content area: 1000 x 1000. Source fit: 1000 x 562. Slack = 1000 - 562 = 438
        let mut canvas_1_1 = cursor::RenderCanvas {
            width: 1080,
            height: 1080,
            padding: 40,
            aspect_ratio: Some("1:1".into()),
            video_position_y: Some(0.5),
            ..Default::default()
        };
        let rect_1_1 = video_screen_rect(&canvas_1_1, Some((1920, 1080)), false);
        assert_eq!(rect_1_1, (40.0, 258.0, 1000.0, 562.0));

        canvas_1_1.video_position_y = Some(0.0); // Top
        let rect_1_1_top = video_screen_rect(&canvas_1_1, Some((1920, 1080)), false);
        assert_eq!(rect_1_1_top, (40.0, 40.0, 1000.0, 562.0));

        canvas_1_1.video_position_y = Some(1.0); // Bottom
        let rect_1_1_bottom = video_screen_rect(&canvas_1_1, Some((1920, 1080)), false);
        assert_eq!(rect_1_1_bottom, (40.0, 478.0, 1000.0, 562.0));

        // 5:4 canvas (1350x1080) with 16:9 source (1920x1080) and 0 padding
        // Source fit: 1350 x 758. Slack = 1080 - 758 = 322
        let mut canvas_5_4 = cursor::RenderCanvas {
            width: 1350,
            height: 1080,
            padding: 0,
            aspect_ratio: Some("5:4".into()),
            video_position_y: Some(0.5),
            ..Default::default()
        };
        let rect_5_4_center = video_screen_rect(&canvas_5_4, Some((1920, 1080)), false);
        assert_eq!(rect_5_4_center, (0.0, 160.0, 1350.0, 758.0));

        canvas_5_4.video_position_y = Some(0.0); // Top
        let rect_5_4_top = video_screen_rect(&canvas_5_4, Some((1920, 1080)), false);
        assert_eq!(rect_5_4_top, (0.0, 0.0, 1350.0, 758.0));

        canvas_5_4.video_position_y = Some(1.0); // Bottom
        let rect_5_4_bottom = video_screen_rect(&canvas_5_4, Some((1920, 1080)), false);
        assert_eq!(rect_5_4_bottom, (0.0, 322.0, 1350.0, 758.0));

        // 4:5 canvas (1080x1350) with 16:9 source (1920x1080) and 0 padding
        // Source fit: 1080 x 608. Slack = 1350 - 608 = 742
        let mut canvas_4_5 = cursor::RenderCanvas {
            width: 1080,
            height: 1350,
            padding: 0,
            aspect_ratio: Some("4:5".into()),
            video_position_y: Some(0.5),
            ..Default::default()
        };
        let rect_4_5_center = video_screen_rect(&canvas_4_5, Some((1920, 1080)), false);
        assert_eq!(rect_4_5_center, (0.0, 370.0, 1080.0, 608.0));

        canvas_4_5.video_position_y = Some(0.0); // Top
        let rect_4_5_top = video_screen_rect(&canvas_4_5, Some((1920, 1080)), false);
        assert_eq!(rect_4_5_top, (0.0, 0.0, 1080.0, 608.0));

        canvas_4_5.video_position_y = Some(1.0); // Bottom
        let rect_4_5_bottom = video_screen_rect(&canvas_4_5, Some((1920, 1080)), false);
        assert_eq!(rect_4_5_bottom, (0.0, 742.0, 1080.0, 608.0));

        // 16:9 canvas (1920x1080) with 16:9 source in side-by-side mode (76% screen width)
        let rect_sbs = video_screen_rect(&canvas_16_9, Some((1920, 1080)), true);
        assert_eq!(rect_sbs.0, 0.0);
        assert_eq!(rect_sbs.2, 1458.0);
        assert_eq!(rect_sbs.3, 820.0);
        assert_eq!(rect_sbs.1, 130.0);
    }

    /// Regression: deleting a middle camera piece must not leave a static
    /// camera slot in the export. Preview expands the screen over the freed
    /// area for that window only; the export has to do the same — screen at
    /// the full-area rect inside the gap, side-by-side elsewhere.
    #[test]
    fn test_side_by_side_camera_gap_expands_screen_in_gap() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-sbs-gap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let camera_path = temp_dir.join("camera.mp4");
        let out_path = temp_dir.join("out_sbs_gap.mp4");

        for (args, path) in [
            (
                vec!["testsrc2=size=1280x720:rate=24:duration=6".to_string()],
                &screen_path,
            ),
            (
                vec!["testsrc=size=640x960:rate=24:duration=6".to_string()],
                &camera_path,
            ),
        ] {
            let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
                .args(["-y", "-f", "lavfi", "-i"])
                .args(&args)
                .args(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
                .arg(path)
                .status()
                .unwrap();
            assert!(status.success(), "generate test media");
        }

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);
        asset_paths.insert("asset-camera".to_string(), camera_path);

        // Camera present [0,2s) and [4,6s) — the [2,4s) window is the user's
        // deleted piece. Geometry mirrors the side-by-side preset for a
        // 1280x720 canvas with 40px padding (76% screen + 2% gap).
        let overlay = |source_in, source_out, out_start, out_end| RenderPlanOverlay {
            asset_id: "asset-camera".into(),
            stream_index: Some(0),
            source_in_ms: source_in,
            source_out_ms: source_out,
            output_start_ms: out_start,
            output_end_ms: out_end,
            speed: 1.0,
            x: 976.0,
            y: 175.0,
            width: 264.0,
            height: 370.0,
            crop: None,
            opacity: 1.0,
            visible: true,
            shape: "rectangle".into(),
            border_width: Some(0.0),
            border_color: None,
            border_opacity: None,
            shadow_enabled: Some(false),
            shadow_color: None,
            shadow_blur: None,
            shadow_offset_x: None,
            shadow_offset_y: None,
            preset: Some("side-by-side".into()),
        };

        let plan = RenderPlan {
            project_id: "test-sbs-gap".into(),
            duration_ms: 6000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 6000,
                output_start_ms: 0,
                output_end_ms: 6000,
                source_width: Some(1280),
                source_height: Some(720),
            }],
            gaps: Vec::new(),
            overlays: vec![overlay(0, 2000, 0, 2000), overlay(4000, 6000, 4000, 6000)],
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 1280,
                height: 720,
                fps: 24,
                padding: 40,
                background: "#ff0000".into(),
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-sbs-gap",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "side-by-side gap render failed: {:?}",
            res.err()
        );
        assert!(out_path.is_file());

        let frame_at = |at_s: &str| -> Vec<u8> {
            let output = crate::process::create_command(&*ffmpeg.to_string_lossy())
                .args(["-y", "-ss", at_s, "-i"])
                .arg(&out_path)
                .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
                .output()
                .unwrap();
            assert!(output.status.success(), "extract frame at {}", at_s);
            assert_eq!(output.stdout.len(), 1280 * 720 * 3);
            output.stdout
        };
        let px = |frame: &[u8], x: usize, y: usize| -> (u8, u8, u8) {
            let i = (y * 1280 + x) * 3;
            (frame[i], frame[i + 1], frame[i + 2])
        };
        let is_red_bg = |(r, g, b): (u8, u8, u8)| r > 200 && g < 70 && b < 70;

        let sbs_frame = frame_at("1");
        // Inside a side-by-side window the strip between the screen's right
        // edge (~952px) and the camera slot (~976px) stays background.
        assert!(
            is_red_bg(px(&sbs_frame, 962, 360)),
            "background strip between screen and camera expected during side-by-side"
        );

        let gap_frame = frame_at("3");
        // The deleted window: the former camera slot must now show video, not
        // the frozen-looking empty background the buggy export produced.
        assert!(
            !is_red_bg(px(&gap_frame, 1100, 360)),
            "screen video should cover the former camera slot during the gap"
        );
        assert!(
            !is_red_bg(px(&gap_frame, 962, 360)),
            "screen video should also cover the inter-slot strip during the gap"
        );

        // After the gap the side-by-side layout is restored.
        let after_frame = frame_at("5");
        assert!(
            is_red_bg(px(&after_frame, 962, 360)),
            "side-by-side layout should be restored after the gap"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_validate_canvas_aspect_ratio_and_video_position_y() {
        let mut canvas = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            ..Default::default()
        };
        for valid_ratio in &["16:9", "9:16", "1:1", "5:4", "4:5"] {
            canvas.aspect_ratio = Some((*valid_ratio).into());
            assert!(validate_canvas(&canvas).is_ok());
        }

        canvas.aspect_ratio = Some("4:3".into());
        assert!(validate_canvas(&canvas).is_err());
        canvas.aspect_ratio = Some("21:9".into());
        assert!(validate_canvas(&canvas).is_err());
        canvas.aspect_ratio = Some("custom".into());
        assert!(validate_canvas(&canvas).is_err());
        canvas.aspect_ratio = Some("16:9".into());

        canvas.video_position_y = Some(0.0);
        assert!(validate_canvas(&canvas).is_ok());
        canvas.video_position_y = Some(0.5);
        assert!(validate_canvas(&canvas).is_ok());
        canvas.video_position_y = Some(1.0);
        assert!(validate_canvas(&canvas).is_ok());

        canvas.video_position_y = Some(-0.1);
        assert!(validate_canvas(&canvas).is_err());
        canvas.video_position_y = Some(1.05);
        assert!(validate_canvas(&canvas).is_err());
        canvas.video_position_y = Some(f64::NAN);
        assert!(validate_canvas(&canvas).is_err());
    }

    #[test]
    fn test_validate_canvas_blur_and_dim() {
        let mut canvas = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            ..Default::default()
        };
        assert!(validate_canvas(&canvas).is_ok());

        canvas.background_blur = Some(24.0);
        canvas.background_dim = Some(0.35);
        assert!(validate_canvas(&canvas).is_ok());

        canvas.background_blur = Some(-5.0);
        assert!(validate_canvas(&canvas).is_err());

        canvas.background_blur = Some(250.0);
        assert!(validate_canvas(&canvas).is_err());

        canvas.background_blur = Some(20.0);
        canvas.background_dim = Some(1.5);
        assert!(validate_canvas(&canvas).is_err());
    }

    #[test]
    fn test_mask_generation_and_alphamerge() {
        // Rounded rectangle mask generation generates non-empty valid PNG bytes
        let mask_png = cursor::generate_rounded_rect_mask_png(1920, 1080, 24.0);
        assert!(mask_png.is_ok());
        let png_bytes = mask_png.unwrap();
        assert!(!png_bytes.is_empty());
        assert_eq!(&png_bytes[0..8], b"\x89PNG\r\n\x1a\n");

        // Circle mask generation generates non-empty valid PNG bytes
        let circle_png = cursor::generate_circle_mask_png(300, 300);
        assert!(circle_png.is_ok());
        let circle_bytes = circle_png.unwrap();
        assert!(!circle_bytes.is_empty());
        assert_eq!(&circle_bytes[0..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn test_generate_ffmetadata_and_escaping() {
        let chapters = vec![
            RenderPlanChapter {
                id: "c1".into(),
                title: "Intro = Section; #1 \\ Test".into(),
                start_ms: 0,
                end_ms: 5000,
            },
            RenderPlanChapter {
                id: "c2".into(),
                title: "Part 2\nDetails".into(),
                start_ms: 5000,
                end_ms: 15000,
            },
        ];
        let meta = generate_ffmetadata("My Project #1", &chapters);
        assert!(meta.starts_with(";FFMETADATA1\n"));
        assert!(meta.contains("title=My Project \\#1"));
        assert!(meta.contains("[CHAPTER]"));
        assert!(meta.contains("START=0\nEND=5000\ntitle=Intro \\= Section\\; \\#1 \\\\ Test"));
        assert!(meta.contains("START=5000\nEND=15000\ntitle=Part 2\\\nDetails"));
    }

    #[test]
    fn test_generate_youtube_chapters() {
        let chapters = vec![
            RenderPlanChapter {
                id: "c1".into(),
                title: "Intro".into(),
                start_ms: 0,
                end_ms: 75000,
            },
            RenderPlanChapter {
                id: "c2".into(),
                title: "Feature Demo".into(),
                start_ms: 75000,
                end_ms: 180000,
            },
        ];
        let yt = generate_youtube_chapters(&chapters);
        assert_eq!(yt, "00:00 Intro\n01:15 Feature Demo");

        let long_chapters = vec![
            RenderPlanChapter {
                id: "c1".into(),
                title: "Start".into(),
                start_ms: 0,
                end_ms: 3600000,
            },
            RenderPlanChapter {
                id: "c2".into(),
                title: "One hour in".into(),
                start_ms: 3725000,
                end_ms: 4000000,
            },
        ];
        let long_yt = generate_youtube_chapters(&long_chapters);
        assert_eq!(long_yt, "00:00:00 Start\n01:02:05 One hour in");
    }

    #[test]
    fn test_validate_plan_with_chapters() {
        let mut plan = valid_plan();
        plan.chapters = vec![
            RenderPlanChapter {
                id: "c1".into(),
                title: "Intro".into(),
                start_ms: 0,
                end_ms: 1500,
            },
            RenderPlanChapter {
                id: "c2".into(),
                title: "Outro".into(),
                start_ms: 1500,
                end_ms: 3000,
            },
        ];
        assert!(plan.validate().is_ok());

        // Invalid: end_ms > duration_ms
        plan.chapters[1].end_ms = 4000;
        assert!(plan.validate().is_err());

        // Invalid: start_ms >= end_ms
        plan.chapters[1].start_ms = 4000;
        plan.chapters[1].end_ms = 3000;
        assert!(plan.validate().is_err());
    }

    #[test]
    fn test_validate_export_settings_chapter_modes() {
        let plan = valid_plan();
        for mode in ["embed", "sidecar", "both", "none"] {
            let mut p = plan.clone();
            p.chapter_mode = mode.into();
            let settings = ExportSettings {
                preset: "default-mp4".into(),
                codec: "h264".into(),
                encoder: "auto".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: mode.into(),
                range: None,
            };
            assert!(validate_export_settings(&settings, &p).is_ok());
        }

        let mut p = plan.clone();
        p.chapter_mode = "embed".into();
        let settings = ExportSettings {
            preset: "default-mp4".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "invalid_mode".into(),
            range: None,
        };
        assert!(validate_export_settings(&settings, &p).is_err());
    }

    #[test]
    fn test_validate_export_settings_gif() {
        let plan = valid_plan();
        for preset in ["gif-balanced", "gif-high-quality", "gif-fast"] {
            let mut p = plan.clone();
            p.chapter_mode = "none".into();
            let settings = ExportSettings {
                preset: preset.into(),
                codec: "gif".into(),
                encoder: "auto".into(),
                container: "gif".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "none".into(),
                range: None,
            };
            assert!(validate_export_settings(&settings, &p).is_ok());
        }

        // GIF gracefully handles embed chapter mode without failing validation
        let mut p = plan.clone();
        p.chapter_mode = "none".into();
        let settings = ExportSettings {
            preset: "gif-balanced".into(),
            codec: "gif".into(),
            encoder: "auto".into(),
            container: "gif".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };
        assert!(validate_export_settings(&settings, &p).is_ok());

        // GIF can use sidecar chapter mode
        let mut p_sidecar = plan.clone();
        p_sidecar.chapter_mode = "sidecar".into();
        let settings_sidecar = ExportSettings {
            preset: "gif-balanced".into(),
            codec: "gif".into(),
            encoder: "auto".into(),
            container: "gif".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "sidecar".into(),
            range: None,
        };
        assert!(validate_export_settings(&settings_sidecar, &p_sidecar).is_ok());
    }

    #[test]
    fn test_validate_export_settings_webp() {
        let plan = valid_plan();
        for preset in [
            "webp-balanced",
            "webp-high-quality",
            "webp-fast",
            "webp-lossless",
        ] {
            let mut p = plan.clone();
            p.chapter_mode = "none".into();
            let settings = ExportSettings {
                preset: preset.into(),
                codec: "webp".into(),
                encoder: "auto".into(),
                container: "webp".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "none".into(),
                range: None,
            };
            assert!(validate_export_settings(&settings, &p).is_ok());
        }

        // WebP gracefully handles embed chapter mode without failing validation
        let mut p = plan.clone();
        p.chapter_mode = "none".into();
        let settings = ExportSettings {
            preset: "webp-balanced".into(),
            codec: "webp".into(),
            encoder: "auto".into(),
            container: "webp".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };
        assert!(validate_export_settings(&settings, &p).is_ok());

        // WebP can use sidecar chapter mode
        let mut p_sidecar = plan.clone();
        p_sidecar.chapter_mode = "sidecar".into();
        let settings_sidecar = ExportSettings {
            preset: "webp-balanced".into(),
            codec: "webp".into(),
            encoder: "auto".into(),
            container: "webp".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "sidecar".into(),
            range: None,
        };
        assert!(validate_export_settings(&settings_sidecar, &p_sidecar).is_ok());
    }

    #[test]
    fn test_validate_export_settings_gif_duration_cap() {
        let mut plan = valid_plan();
        plan.chapter_mode = "none".into();
        let gif_settings = ExportSettings {
            preset: "gif-balanced".into(),
            codec: "gif".into(),
            encoder: "auto".into(),
            container: "gif".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "none".into(),
            range: None,
        };
        plan.duration_ms = 60_000;
        assert!(validate_export_settings(&gif_settings, &plan).is_ok());
        plan.duration_ms = 60_001;
        assert!(validate_export_settings(&gif_settings, &plan).is_err());
        // The cap only applies to GIF — a long mp4 is unaffected.
        let mp4_settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };
        plan.duration_ms = 120_000;
        plan.chapter_mode = "embed".into();
        assert!(validate_export_settings(&mp4_settings, &plan).is_ok());
    }

    #[test]
    fn estimate_export_bytes_counts_pixels_and_audio() {
        let mut plan = valid_plan();
        plan.duration_ms = 60_000;
        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };
        // 1920*1080*30 * 0.01 bpp * 60 s / 8 + 128k/8 * 60 s.
        let expected = (1920.0 * 1080.0 * 30.0 * 0.01 * 60.0 / 8.0 + 128_000.0 / 8.0 * 60.0) as u64;
        assert_eq!(estimate_export_bytes(&plan, &settings, 0.01), expected);
        // Animations mux no audio.
        let gif_settings = ExportSettings {
            preset: "gif-balanced".into(),
            container: "gif".into(),
            ..settings
        };
        let video_only = (1920.0 * 1080.0 * 30.0 * 0.01 * 60.0 / 8.0) as u64;
        assert_eq!(
            estimate_export_bytes(&plan, &gif_settings, 0.01),
            video_only
        );
    }

    #[test]
    fn is_disk_full_diagnostic_matches_ffmpeg_phrasings() {
        assert!(is_disk_full_diagnostic(
            "av_interleaved_write_frame(): No space left on device"
        ));
        assert!(is_disk_full_diagnostic(
            "Error writing trailer: Not enough space on the disk"
        ));
        assert!(is_disk_full_diagnostic("write failed: DISK FULL"));
        assert!(!is_disk_full_diagnostic("Invalid argument"));
        assert!(!is_disk_full_diagnostic("Conversion failed!"));
    }

    #[test]
    fn sweep_stale_temp_files_removes_only_old_prefixed_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stale = dir.path().join("recordforge_chunks_abcd");
        let fresh = dir.path().join("rf-mask-xyz.png");
        let other = dir.path().join("unrelated-old-file.txt");
        std::fs::write(&stale, b"x").expect("write");
        std::fs::write(&fresh, b"x").expect("write");
        std::fs::write(&other, b"x").expect("write");
        let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        for path in [&stale, &other] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .expect("open")
                .set_modified(two_hours_ago)
                .expect("mtime");
        }

        assert_eq!(
            sweep_stale_temp_files(dir.path(), Duration::from_secs(60 * 60)),
            1
        );
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(other.exists());
    }

    #[test]
    fn sweep_stale_temp_files_removes_prefixed_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stale_dir = dir.path().join("recordforge_chunks_0123");
        std::fs::create_dir_all(&stale_dir).expect("mkdir");
        std::fs::write(stale_dir.join("chunk_00000.ts"), b"x").expect("write");
        assert_eq!(sweep_stale_temp_files(dir.path(), Duration::ZERO), 1);
        assert!(!stale_dir.exists());
    }

    #[test]
    fn test_temp_mask_file_cleanup() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let mask_path = temp_dir.path().join("rf-mask-test.png");

        std::fs::write(&mask_path, b"test-mask-data").expect("write temp mask file");
        assert!(mask_path.exists());

        {
            let _guard = TempMaskFile(mask_path.clone());
            assert!(mask_path.exists());
        }
        // Guard drop should remove the temp file
        assert!(!mask_path.exists());
    }

    #[test]
    fn test_zoompan_expressions_compactness_for_many_segments() {
        let mut zoom_segments = Vec::new();
        for i in 0..30 {
            zoom_segments.push(RenderPlanZoomSegment {
                id: format!("zoom-{i}"),
                start_ms: i * 2000,
                end_ms: i * 2000 + 1500,
                target: RenderCropFloat {
                    x: 100.0 + (i as f64 * 10.0),
                    y: 100.0 + (i as f64 * 5.0),
                    width: 960.0,
                    height: 540.0,
                },
                scale: 1.5,
                easing: "smooth".into(),
                transition_in_ms: 300,
                transition_out_ms: 300,
                enabled: true,
                mode: "auto".into(),
                source: "click".into(),
                preset: "product-demo".into(),
                follow_deadzone_percent: None,
                follow_smoothing_alpha: None,
                label: None,
                from_target: None,
                from_scale: None,
                keyframes: None,
                motion_plan: None,
            });
        }
        let plan = RenderPlan {
            zoom_segments,
            ..valid_plan()
        };
        let canvas = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            ..Default::default()
        };

        let (z_expr, x_expr, y_expr) = build_zoompan_expressions(&plan, &canvas, 1920.0, 1080.0);

        let total_filter_len = z_expr.len() + x_expr.len() + y_expr.len();
        // Ensure that 30 dynamic zoom segments total well under the Windows
        // 32,767 char limit.
        assert!(
            total_filter_len < 30_000,
            "Total zoompan expressions length ({total_filter_len}) must be well below 30KB"
        );
    }

    #[test]
    fn test_zoompan_motion_plan_keeps_all_adaptive_segments() {
        let motion_segments = (0..32)
            .map(|index| {
                let start = index as f64 * 20.0;
                let end = (index + 1) as f64 * 20.0;
                RenderPlanZoomMotionSegment {
                    start_ms: index * 100,
                    end_ms: (index + 1) * 100,
                    start: RenderPlanZoomMotionPoint { x: start, y: start },
                    control1: RenderPlanZoomMotionPoint {
                        x: start + 5.0,
                        y: start + 2.0,
                    },
                    control2: RenderPlanZoomMotionPoint {
                        x: end - 5.0,
                        y: end - 2.0,
                    },
                    end: RenderPlanZoomMotionPoint { x: end, y: end },
                }
            })
            .collect();
        let plan = RenderPlan {
            zoom_segments: vec![RenderPlanZoomSegment {
                id: "zoom-motion-plan".into(),
                start_ms: 0,
                end_ms: 3_200,
                target: RenderCropFloat {
                    x: 0.0,
                    y: 0.0,
                    width: 960.0,
                    height: 540.0,
                },
                scale: 2.0,
                easing: "linear".into(),
                transition_in_ms: 0,
                transition_out_ms: 0,
                enabled: true,
                mode: "follow-cursor".into(),
                source: "auto".into(),
                preset: "product-demo".into(),
                follow_deadzone_percent: None,
                follow_smoothing_alpha: None,
                label: None,
                from_target: None,
                from_scale: None,
                keyframes: None,
                motion_plan: Some(RenderPlanZoomMotionPlan {
                    version: 1,
                    kind: "cubic-bezier".into(),
                    segments: motion_segments,
                }),
            }],
            ..valid_plan()
        };
        let canvas = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            ..Default::default()
        };

        let (_, x_expr, y_expr) = build_zoompan_expressions(&plan, &canvas, 1920.0, 1080.0);

        assert_eq!(x_expr.matches("gte(it,").count(), 32);
        assert_eq!(y_expr.matches("gte(it,").count(), 32);
        assert!(x_expr.contains("lt(it,0.1)"));
    }

    #[test]
    fn test_zoompan_with_dense_keyframes_renders_successfully() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-zoom-dense-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let out_path = temp_dir.join("out_zoom_dense.mp4");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x480:rate=10",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate screen test video");

        let mut keyframes = Vec::new();
        for i in 0..100 {
            keyframes.push(RenderPlanZoomKeyframe {
                time_ms: i * 20,
                target: RenderCropFloat {
                    x: 50.0 + (i as f64 * 2.0),
                    y: 50.0 + (i as f64 * 1.5),
                    width: 320.0,
                    height: 240.0,
                },
            });
        }

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);

        let plan = RenderPlan {
            project_id: "test-zoom-dense-project".into(),
            duration_ms: 2000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 2000,
                output_start_ms: 0,
                output_end_ms: 2000,
                source_width: Some(640),
                source_height: Some(480),
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: vec![RenderPlanZoomSegment {
                id: "zoom-dense-1".into(),
                start_ms: 200,
                end_ms: 1800,
                target: RenderCropFloat {
                    x: 100.0,
                    y: 100.0,
                    width: 320.0,
                    height: 240.0,
                },
                scale: 1.5,
                easing: "smooth".into(),
                transition_in_ms: 200,
                transition_out_ms: 200,
                enabled: true,
                mode: "follow-cursor".into(),
                source: "auto".into(),
                preset: "product-demo".into(),
                follow_deadzone_percent: None,
                follow_smoothing_alpha: None,
                label: None,
                from_target: None,
                from_scale: None,
                keyframes: Some(keyframes),
                motion_plan: None,
            }],
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 640,
                height: 480,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-zoom-dense-project",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "zoompan with dense keyframes failed: {:?}",
            res.err()
        );
        assert!(out_path.is_file(), "exported composition should exist");
    }

    #[test]
    fn test_render_timeline_composition_gif_end_to_end() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir = std::env::temp_dir().join(format!("rf-test-gif-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let out_path = temp_dir.join("out_demo.gif");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate screen test video");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);

        let plan = RenderPlan {
            project_id: "test-gif-project".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "none".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 320,
                height: 240,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "gif-balanced".into(),
            codec: "gif".into(),
            encoder: "auto".into(),
            container: "gif".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "none".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-gif-project",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(res.is_ok(), "render gif failed: {:?}", res.err());
        assert!(out_path.is_file(), "exported gif should exist");

        let validation = validate_export_output(
            &ffprobe,
            &out_path,
            &plan,
            &settings,
            res.expect("rendered").has_audio,
        );
        assert!(
            validation.is_ok(),
            "validate gif failed: {:?}",
            validation.err()
        );
    }

    #[test]
    fn test_render_timeline_composition_aspect_ratios_end_to_end() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-aspect-ratios-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen_16_9.mp4");

        // Generate a 1-second 16:9 test video (320x180)
        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate 16:9 source test video");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);

        let test_cases = [
            ("9:16", 180, 320),
            ("1:1", 240, 240),
            ("5:4", 300, 240),
            ("4:5", 240, 300),
        ];

        for (ratio, w, h) in test_cases {
            let out_path = temp_dir.join(format!("out_{}.mp4", ratio.replace(':', "_")));
            let plan = RenderPlan {
                project_id: format!("test-ratio-{}", ratio),
                duration_ms: 500,
                segments: vec![RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(0),
                    volume: None,
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 500,
                    output_start_ms: 0,
                    output_end_ms: 500,
                    source_width: Some(320),
                    source_height: Some(180),
                }],
                overlays: Vec::new(),
                zoom_segments: Vec::new(),
                cursor_effects: Vec::new(),
                overlay_render_plan: None,
                canvas: Some(cursor::RenderCanvas {
                    width: w,
                    height: h,
                    fps: 10,
                    aspect_ratio: Some(ratio.into()),
                    background: "#070b14".into(),
                    video_position_y: Some(0.5),
                    ..Default::default()
                }),
                audio: None,
                audio_tracks: None,
                annotations: Vec::new(),
                texts: Vec::new(),
                images: Vec::new(),
                masks: Vec::new(),
                gaps: Vec::new(),
                captions: Vec::new(),
                caption_mode: "burn-in".into(),
                chapters: Vec::new(),
                chapter_mode: "none".into(),
            };

            let settings = ExportSettings {
                preset: "balanced".into(),
                codec: "h264".into(),
                encoder: "auto".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "none".into(),
                range: None,
            };

            let res = render_timeline_composition(
                &*ffmpeg.to_string_lossy(),
                &out_path,
                &plan,
                &plan.project_id,
                &asset_paths,
                &settings,
                encoding::ExportEncoder::Software,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                &|_| {},
                None,
                Some(&ffprobe),
            );
            assert!(
                res.is_ok(),
                "render aspect ratio {} failed: {:?}",
                ratio,
                res.err()
            );
            assert!(
                out_path.is_file(),
                "exported mp4 for {} should exist",
                ratio
            );

            let validation = validate_export_output(
                &ffprobe,
                &out_path,
                &plan,
                &settings,
                res.expect("rendered").has_audio,
            );
            assert!(
                validation.is_ok(),
                "validate mp4 for {} failed: {:?}",
                ratio,
                validation.err()
            );
        }

        // Also test non-16:9 with gradient background plate (tests resolution match & no infinite -loop 1 queue)
        {
            let out_path = temp_dir.join("out_9_16_gradient.mp4");
            let plan = RenderPlan {
                project_id: "test-ratio-9-16-gradient".into(),
                duration_ms: 500,
                segments: vec![RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(0),
                    volume: None,
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 500,
                    output_start_ms: 0,
                    output_end_ms: 500,
                    source_width: Some(320),
                    source_height: Some(180),
                }],
                overlays: Vec::new(),
                zoom_segments: Vec::new(),
                cursor_effects: Vec::new(),
                overlay_render_plan: None,
                canvas: Some(cursor::RenderCanvas {
                    width: 180,
                    height: 320,
                    fps: 10,
                    aspect_ratio: Some("9:16".into()),
                    background: "linear-gradient(135deg, #1e1e2f 0%, #2a2a40 100%)".into(),
                    video_position_y: Some(0.5),
                    ..Default::default()
                }),
                audio: None,
                audio_tracks: None,
                annotations: Vec::new(),
                texts: Vec::new(),
                images: Vec::new(),
                masks: Vec::new(),
                gaps: Vec::new(),
                captions: Vec::new(),
                caption_mode: "burn-in".into(),
                chapters: Vec::new(),
                chapter_mode: "none".into(),
            };

            let settings = ExportSettings {
                preset: "balanced".into(),
                codec: "h264".into(),
                encoder: "auto".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "none".into(),
                range: None,
            };

            let res = render_timeline_composition(
                &*ffmpeg.to_string_lossy(),
                &out_path,
                &plan,
                &plan.project_id,
                &asset_paths,
                &settings,
                encoding::ExportEncoder::Software,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                &|_| {},
                None,
                Some(&ffprobe),
            );
            assert!(
                res.is_ok(),
                "render aspect ratio 9:16 with gradient failed: {:?}",
                res.err()
            );
            assert!(
                out_path.is_file(),
                "exported mp4 for 9:16 gradient should exist"
            );
            let validation = validate_export_output(
                &ffprobe,
                &out_path,
                &plan,
                &settings,
                res.expect("rendered").has_audio,
            );
            assert!(
                validation.is_ok(),
                "validate mp4 for 9:16 gradient failed: {:?}",
                validation.err()
            );
        }

        // Also test non-16:9 with zoompan direct padding
        {
            let out_path = temp_dir.join("out_9_16_zoom.mp4");
            let plan = RenderPlan {
                project_id: "test-ratio-9-16-zoom".into(),
                duration_ms: 500,
                segments: vec![RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(0),
                    volume: None,
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 500,
                    output_start_ms: 0,
                    output_end_ms: 500,
                    source_width: Some(320),
                    source_height: Some(180),
                }],
                overlays: Vec::new(),
                zoom_segments: vec![RenderPlanZoomSegment {
                    id: "zoom-1".into(),
                    start_ms: 0,
                    end_ms: 500,
                    target: RenderCropFloat {
                        x: 0.0,
                        y: 0.0,
                        width: 160.0,
                        height: 90.0,
                    },
                    scale: 1.5,
                    from_scale: None,
                    from_target: None,
                    transition_in_ms: 100,
                    transition_out_ms: 100,
                    easing: "ease-in-out".into(),
                    enabled: true,
                    mode: "fixed".into(),
                    source: "manual".into(),
                    preset: "custom".into(),
                    follow_deadzone_percent: None,
                    follow_smoothing_alpha: None,
                    label: None,
                    keyframes: None,
                    motion_plan: None,
                }],
                cursor_effects: Vec::new(),
                overlay_render_plan: None,
                canvas: Some(cursor::RenderCanvas {
                    width: 180,
                    height: 320,
                    fps: 10,
                    aspect_ratio: Some("9:16".into()),
                    background: "#070b14".into(),
                    video_position_y: Some(0.5),
                    ..Default::default()
                }),
                audio: None,
                audio_tracks: None,
                annotations: Vec::new(),
                texts: Vec::new(),
                images: Vec::new(),
                masks: Vec::new(),
                gaps: Vec::new(),
                captions: Vec::new(),
                caption_mode: "burn-in".into(),
                chapters: Vec::new(),
                chapter_mode: "none".into(),
            };

            let settings = ExportSettings {
                preset: "balanced".into(),
                codec: "h264".into(),
                encoder: "auto".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "none".into(),
                range: None,
            };

            let res = render_timeline_composition(
                &*ffmpeg.to_string_lossy(),
                &out_path,
                &plan,
                &plan.project_id,
                &asset_paths,
                &settings,
                encoding::ExportEncoder::Software,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                &|_| {},
                None,
                Some(&ffprobe),
            );
            assert!(
                res.is_ok(),
                "render aspect ratio 9:16 with zoom failed: {:?}",
                res.err()
            );
            assert!(
                out_path.is_file(),
                "exported mp4 for 9:16 zoom should exist"
            );
            let validation = validate_export_output(
                &ffprobe,
                &out_path,
                &plan,
                &settings,
                res.expect("rendered").has_audio,
            );
            assert!(
                validation.is_ok(),
                "validate mp4 for 9:16 zoom failed: {:?}",
                validation.err()
            );
        }

        // Also test non-16:9 with canvas shadow and rounded border
        {
            let out_path = temp_dir.join("out_9_16_shadow_border.mp4");
            let plan = RenderPlan {
                project_id: "test-ratio-9-16-shadow-border".into(),
                duration_ms: 500,
                segments: vec![RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(0),
                    volume: None,
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 500,
                    output_start_ms: 0,
                    output_end_ms: 500,
                    source_width: Some(320),
                    source_height: Some(180),
                }],
                overlays: Vec::new(),
                zoom_segments: Vec::new(),
                cursor_effects: Vec::new(),
                overlay_render_plan: None,
                canvas: Some(cursor::RenderCanvas {
                    width: 180,
                    height: 320,
                    fps: 10,
                    aspect_ratio: Some("9:16".into()),
                    background: "#070b14".into(),
                    padding: 8,
                    border_radius: 6,
                    shadow: true,
                    shadow_color: Some("#000000".into()),
                    shadow_blur: Some(12.0),
                    shadow_offset_x: Some(0.0),
                    shadow_offset_y: Some(4.0),
                    video_position_y: Some(0.5),
                    ..Default::default()
                }),
                audio: None,
                audio_tracks: None,
                annotations: Vec::new(),
                texts: Vec::new(),
                images: Vec::new(),
                masks: Vec::new(),
                gaps: Vec::new(),
                captions: Vec::new(),
                caption_mode: "burn-in".into(),
                chapters: Vec::new(),
                chapter_mode: "none".into(),
            };

            let settings = ExportSettings {
                preset: "balanced".into(),
                codec: "h264".into(),
                encoder: "auto".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "none".into(),
                range: None,
            };

            let res = render_timeline_composition(
                &*ffmpeg.to_string_lossy(),
                &out_path,
                &plan,
                &plan.project_id,
                &asset_paths,
                &settings,
                encoding::ExportEncoder::Software,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                &|_| {},
                None,
                Some(&ffprobe),
            );
            assert!(
                res.is_ok(),
                "render aspect ratio 9:16 with shadow and border failed: {:?}",
                res.err()
            );
            assert!(
                out_path.is_file(),
                "exported mp4 for 9:16 shadow border should exist"
            );
            let validation = validate_export_output(
                &ffprobe,
                &out_path,
                &plan,
                &settings,
                res.expect("rendered").has_audio,
            );
            assert!(
                validation.is_ok(),
                "validate mp4 for 9:16 shadow border failed: {:?}",
                validation.err()
            );
        }

        // Also test non-16:9 with image background asset
        {
            let img_path = temp_dir.join("bg_wallpaper.png");
            let img_pixmap = tiny_skia::Pixmap::new(320, 180).unwrap();
            img_pixmap.save_png(&img_path).unwrap();
            let mut test_asset_paths = asset_paths.clone();
            test_asset_paths.insert("asset-bg-wall".to_string(), img_path.clone());

            let out_path = temp_dir.join("out_9_16_image_bg.mp4");
            let plan = RenderPlan {
                project_id: "test-ratio-9-16-image-bg".into(),
                duration_ms: 500,
                segments: vec![RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(0),
                    volume: None,
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 500,
                    output_start_ms: 0,
                    output_end_ms: 500,
                    source_width: Some(320),
                    source_height: Some(180),
                }],
                overlays: Vec::new(),
                zoom_segments: Vec::new(),
                cursor_effects: Vec::new(),
                overlay_render_plan: None,
                canvas: Some(cursor::RenderCanvas {
                    width: 180,
                    height: 320,
                    fps: 10,
                    aspect_ratio: Some("9:16".into()),
                    background: "asset-bg-wall".into(),
                    background_fit: Some("cover".into()),
                    background_blur: Some(10.0),
                    background_dim: Some(0.2),
                    video_position_y: Some(0.5),
                    ..Default::default()
                }),
                audio: None,
                audio_tracks: None,
                annotations: Vec::new(),
                texts: Vec::new(),
                images: Vec::new(),
                masks: Vec::new(),
                gaps: Vec::new(),
                captions: Vec::new(),
                caption_mode: "burn-in".into(),
                chapters: Vec::new(),
                chapter_mode: "none".into(),
            };

            let settings = ExportSettings {
                preset: "balanced".into(),
                codec: "h264".into(),
                encoder: "auto".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                chapter_mode: "none".into(),
                range: None,
            };

            let res = render_timeline_composition(
                &*ffmpeg.to_string_lossy(),
                &out_path,
                &plan,
                &plan.project_id,
                &test_asset_paths,
                &settings,
                encoding::ExportEncoder::Software,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                &|_| {},
                None,
                Some(&ffprobe),
            );
            assert!(
                res.is_ok(),
                "render aspect ratio 9:16 with image bg failed: {:?}",
                res.err()
            );
            assert!(
                out_path.is_file(),
                "exported mp4 for 9:16 image bg should exist"
            );
            let validation = validate_export_output(
                &ffprobe,
                &out_path,
                &plan,
                &settings,
                res.expect("rendered").has_audio,
            );
            assert!(
                validation.is_ok(),
                "validate mp4 for 9:16 image bg failed: {:?}",
                validation.err()
            );
        }

        // Also run camera overlay alignment with shadow to ensure camera shadow loop elimination works
        test_camera_overlay_odd_dimensions_alignment();

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_render_timeline_composition_webp_end_to_end() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir = std::env::temp_dir().join(format!("rf-test-webp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let out_path = temp_dir.join("out_demo.webp");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate screen test video");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);

        let plan = RenderPlan {
            project_id: "test-webp-project".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapter_mode: "none".into(),
            chapters: Vec::new(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 320,
                height: 240,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "webp-balanced".into(),
            codec: "webp".into(),
            encoder: "auto".into(),
            container: "webp".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "none".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-webp-project",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(res.is_ok(), "render webp failed: {:?}", res.err());
        assert!(out_path.is_file(), "exported webp should exist");

        let validation = validate_export_output(
            &ffprobe,
            &out_path,
            &plan,
            &settings,
            res.expect("rendered").has_audio,
        );
        assert!(
            validation.is_ok(),
            "validate webp failed: {:?}",
            validation.err()
        );
    }

    #[test]
    fn test_render_timeline_composition_gif_downscale_validation() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-gif-downscale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let out_path = temp_dir.join("output_downscaled.gif");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=1280x720:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate screen test video");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("screen-1".into(), screen_path);

        let plan = RenderPlan {
            project_id: "test-gif-downscale".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "screen-1".into(),
                stream_index: Some(0),
                volume: None,
                speed: 1.0,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(1280),
                source_height: Some(720),
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "none".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 1280,
                height: 720,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "gif-fast".into(),
            codec: "gif".into(),
            encoder: "auto".into(),
            container: "gif".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "none".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-gif-downscale",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(res.is_ok(), "render gif downscaled failed: {:?}", res.err());
        assert!(out_path.is_file(), "exported downscaled gif should exist");

        let validation = validate_export_output(
            &ffprobe,
            &out_path,
            &plan,
            &settings,
            res.expect("rendered").has_audio,
        );
        assert!(
            validation.is_ok(),
            "validate downscaled gif failed: {:?}",
            validation.err()
        );
    }

    #[test]
    fn test_temp_filter_complex_script_lifecycle() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let script_path = temp_dir.path().join("rf-filter-complex-test.txt");

        let large_filter_content = "color=c=black:s=1920x1080:r=30:d=10[v0];\n".repeat(2000);
        assert!(
            large_filter_content.len() > 32_767,
            "Filter content should exceed Windows 32KB command line limit"
        );

        std::fs::write(&script_path, large_filter_content.as_bytes())
            .expect("write filter complex script");
        assert!(script_path.exists());

        {
            let _guard = TempMaskFile(script_path.clone());
            assert!(script_path.exists());
        }
        // Guard drop should remove the temp filter complex script
        assert!(!script_path.exists());
    }

    #[test]
    fn test_camera_border_generation_all_shapes() {
        for shape in ["rectangle", "rounded", "circle"] {
            let border_bytes =
                generate_camera_border_png(320, 240, shape, 3.0, Some("#38bdf8"), Some(0.9));
            assert!(
                border_bytes.is_ok(),
                "Border generation failed for shape {shape}"
            );
            let png_bytes = border_bytes.unwrap();
            assert!(!png_bytes.is_empty());
            assert_eq!(&png_bytes[0..8], b"\x89PNG\r\n\x1a\n");
        }
    }

    #[test]
    fn test_camera_shadow_plate_generation_all_shapes() {
        for shape in ["rectangle", "rounded", "circle"] {
            let shadow_path = generate_camera_shadow_plate_png(
                1920,
                1080,
                100.0,
                100.0,
                320.0,
                240.0,
                shape,
                Some("#000000"),
                Some(16.0),
                Some(4.0),
                Some(8.0),
            );
            assert!(
                shadow_path.is_some(),
                "Shadow plate generation failed for shape {shape}"
            );
            let path = shadow_path.unwrap();
            assert!(path.exists());
            let _ = std::fs::remove_file(&path);
        }
    }

    #[test]
    fn test_render_timeline_composition_end_to_end() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let video_path = temp_dir.join("test_screen.mp4");
        let out_path = temp_dir.join("test_out.mp4");

        // Generate a 1-second test video with video stream 0 and audio stream 1
        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x240:r=10",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=mono",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
            ])
            .arg(&video_path)
            .status()
            .unwrap();
        assert!(status.success(), "failed to generate test video");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), video_path.clone());

        let plan = RenderPlan {
            project_id: "test-project-1".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 320,
                height: 240,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: Some(vec![RenderPlanAudio {
                asset_id: "asset-screen".into(),
                stream_index: Some(1),
                role: Some("primary".into()),
                muted: false,
                volume: 1.0,
                segments: vec![RenderSegment {
                    asset_id: "asset-screen".into(),
                    stream_index: Some(1),
                    volume: Some(1.0),
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 1000,
                    output_start_ms: 0,
                    output_end_ms: 1000,
                    source_width: None,
                    source_height: None,
                }],
            }]),
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };
        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-project-1",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "audio+video composition failed: {:?}",
            res.err()
        );

        let mut plan_with_missing_stream = plan.clone();
        plan_with_missing_stream.segments[0].stream_index = Some(99);
        let missing_stream_error = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &temp_dir.join("test_out_missing_stream.mp4"),
            &plan_with_missing_stream,
            "test-project-1",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        )
        .expect_err("missing explicit video stream should fail before FFmpeg");
        assert!(missing_stream_error
            .to_string()
            .contains("selected video stream is missing"));

        let mut plan_with_missing_audio_stream = plan.clone();
        plan_with_missing_audio_stream
            .audio_tracks
            .as_mut()
            .unwrap()[0]
            .segments[0]
            .stream_index = Some(99);
        let missing_audio_stream_error = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &temp_dir.join("test_out_missing_audio_stream.mp4"),
            &plan_with_missing_audio_stream,
            "test-project-1",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        )
        .expect_err("missing explicit audio stream should fail before FFmpeg");
        assert!(missing_audio_stream_error
            .to_string()
            .contains("selected audio stream is missing"));

        let mut plan_with_invalid_overlay = plan.clone();
        plan_with_invalid_overlay.overlay_render_plan =
            Some(serde_json::json!({ "invalid": true }));
        let invalid_overlay_error = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &temp_dir.join("test_out_invalid_overlay.mp4"),
            &plan_with_invalid_overlay,
            "test-project-1",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        )
        .expect_err("invalid overlay plans should not be silently dropped");
        assert!(invalid_overlay_error
            .to_string()
            .contains("overlay render plan is invalid"));

        let mut plan_with_empty_video_packets = plan.clone();
        plan_with_empty_video_packets.segments[0].source_in_ms = 2_000;
        plan_with_empty_video_packets.segments[0].source_out_ms = 3_000;
        let out_with_empty_video_packets = temp_dir.join("test_out_empty_video_packets.mp4");
        let res_with_empty_video_packets = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_with_empty_video_packets,
            &plan_with_empty_video_packets,
            "test-project-1",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res_with_empty_video_packets.is_ok(),
            "composition with an empty source range failed: {:?}",
            res_with_empty_video_packets.err()
        );
        assert!(
            out_with_empty_video_packets.is_file(),
            "composition with an empty source range should still publish video"
        );
        let empty_video_metadata = crate::media::probe::probe_media(
            &ffprobe.to_string_lossy(),
            &out_with_empty_video_packets,
            "test-project-1",
        )
        .expect("probe composition with an empty source range");
        assert_eq!(empty_video_metadata.duration_ms, 1_000);
        assert!(
            empty_video_metadata
                .streams
                .iter()
                .any(|stream| stream.kind == "video"),
            "composition with an empty source range should include video packets"
        );

        // Case 1: Video-only input with empty audio_tracks
        let video_only_path = temp_dir.join("test_screen_video_only.mp4");
        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=green:s=320x240:r=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-an",
            ])
            .arg(&video_only_path)
            .status()
            .unwrap();
        assert!(status.success(), "failed to generate video-only test video");

        let mut asset_paths_video_only = HashMap::new();
        asset_paths_video_only.insert("asset-screen".to_string(), video_only_path.clone());

        let mut plan_video_only = plan.clone();
        // Test with audio_tracks: Some(vec![])
        plan_video_only.audio_tracks = Some(Vec::new());
        plan_video_only.audio = None;
        let out_video_only = temp_dir.join("test_out_video_only.mp4");
        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_video_only,
            &plan_video_only,
            "test-project-1",
            &asset_paths_video_only,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "video-only with empty audio_tracks failed: {:?}",
            res.err()
        );

        // Test with audio fallback referencing video-only asset
        let mut plan_fallback = plan.clone();
        plan_fallback.audio_tracks = None;
        plan_fallback.audio = Some(RenderPlanAudio {
            asset_id: "asset-screen".into(),
            stream_index: None,
            role: None,
            muted: false,
            volume: 1.0,
            segments: Vec::new(),
        });
        let out_fallback = temp_dir.join("test_out_fallback.mp4");
        let _res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_fallback,
            &plan_fallback,
            "test-project-1",
            &asset_paths_video_only,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        // Case 2: Render with image background, padding, border radius, blur, dim, and shadow
        let bg_dir = temp_dir.join("_up_").join("public").join("backgrounds");
        std::fs::create_dir_all(&bg_dir).unwrap();
        let test_bg_file = bg_dir.join("bg-1.jpg");
        let bg_gen_status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=purple:s=640x480:r=1",
                "-vframes",
                "1",
            ])
            .arg(&test_bg_file)
            .status()
            .unwrap();
        assert!(
            bg_gen_status.success(),
            "failed to generate test background image"
        );

        let mut plan_bg = plan.clone();
        plan_bg.canvas = Some(cursor::RenderCanvas {
            width: 320,
            height: 240,
            fps: 10,
            background: "/backgrounds/bg-1.jpg".into(),
            padding: 16,
            border_radius: 8,
            shadow: true,
            shadow_color: Some("#000000".into()),
            shadow_blur: Some(6.0),
            shadow_offset_x: Some(2.0),
            shadow_offset_y: Some(4.0),
            background_blur: Some(4.0),
            background_dim: Some(0.15),
            ..Default::default()
        });
        let out_bg = temp_dir.join("test_out_image_bg.mp4");
        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_bg,
            &plan_bg,
            "test-project-1",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            Some(&temp_dir),
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "render with image background plate failed: {:?}",
            res.err()
        );
        assert!(
            out_bg.is_file(),
            "output video with background image exists"
        );
        assert!(
            std::fs::metadata(&out_bg).unwrap().len() > 0,
            "output video with background image is not empty"
        );

        // Case 3: Render with image background using contain fit mode (uncropped image with ambient blurred underlay)
        let mut plan_contain = plan_bg.clone();
        if let Some(canvas_mut) = plan_contain.canvas.as_mut() {
            canvas_mut.background_fit = Some("contain".into());
        }
        let out_contain = temp_dir.join("test_out_image_bg_contain.mp4");
        let res_contain = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_contain,
            &plan_contain,
            "test-project-1",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            Some(&temp_dir),
            Some(&ffprobe),
        );
        assert!(
            res_contain.is_ok(),
            "render with contain image background plate failed: {:?}",
            res_contain.err()
        );
        assert!(
            out_contain.is_file(),
            "output video with contain background image exists"
        );
        assert!(
            std::fs::metadata(&out_contain).unwrap().len() > 0,
            "output video with contain background image is not empty"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    /// Overlay items must composite ABOVE the camera layer in export, matching
    /// the editor preview stacking order (camera z-30, items z-35). Regresses
    /// the bug where the shared overlay plate sat under camera bubbles.
    #[test]
    fn test_render_timeline_composition_stacks_items_above_camera() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-layering-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let camera_path = temp_dir.join("camera.mp4");
        let out_path = temp_dir.join("test_out_layering.mp4");

        for (path, color) in [(&screen_path, "blue"), (&camera_path, "red")] {
            let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c={color}:s=320x240:r=10"),
                    "-t",
                    "1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-an",
                ])
                .arg(path)
                .status()
                .unwrap();
            assert!(status.success(), "failed to generate test video");
        }

        // Minimal V1 cursor telemetry so the overlay stream takes the packed
        // dual-plane path (cursor plane + items plane in one feed).
        std::fs::write(
            temp_dir.join("cursor_telemetry.json"),
            r#"{
                "schemaVersion": 1,
                "recordingId": "rec-layering",
                "sourceWidth": 320,
                "sourceHeight": 240,
                "sampleRateHz": 60,
                "events": [
                    {"tMs": 0, "x": 24.0, "y": 24.0, "clicked": false, "button": "none", "visible": true},
                    {"tMs": 500, "x": 40.0, "y": 40.0, "clicked": false, "button": "none", "visible": true},
                    {"tMs": 900, "x": 60.0, "y": 60.0, "clicked": false, "button": "none", "visible": true}
                ]
            }"#,
        )
        .unwrap();

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path.clone());
        asset_paths.insert("asset-camera".to_string(), camera_path.clone());
        asset_paths.insert("asset-cursor".to_string(), screen_path.clone());

        let plan = RenderPlan {
            project_id: "test-layering".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            gaps: Vec::new(),
            // Camera bubble covering the whole canvas: anything stacked under
            // it is invisible, anything above it wins the frame.
            overlays: vec![RenderPlanOverlay {
                asset_id: "asset-camera".into(),
                stream_index: None,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                speed: 1.0,
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 240.0,
                crop: None,
                opacity: 1.0,
                visible: true,
                shape: "rectangle".into(),
                border_width: Some(0.0),
                border_color: Some("#ffffff".into()),
                border_opacity: Some(1.0),
                shadow_enabled: Some(false),
                shadow_color: Some("#000000".into()),
                shadow_blur: Some(0.0),
                shadow_offset_x: Some(0.0),
                shadow_offset_y: Some(0.0),
                preset: None,
            }],
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: vec![RenderPlanCursorEffect {
                id: "cursor-fx".into(),
                asset_id: "asset-cursor".into(),
                start_ms: 0,
                end_ms: 1000,
                enabled: true,
                preset_id: "recorded-system".into(),
                scale: 1.0,
                smoothing: "off".into(),
                settings: serde_json::json!({}),
            }],
            // Opaque green annotation sitting inside the camera bubble.
            overlay_render_plan: Some(serde_json::json!({
                "version": 1,
                "canvas": { "width": 320, "height": 240 },
                "items": [
                    {
                        "kind": "annotation",
                        "id": "ann-block",
                        "startMs": 0,
                        "endMs": 1000,
                        "transform": {
                            "x": 120.0,
                            "y": 80.0,
                            "width": 80.0,
                            "height": 60.0,
                            "rotation": 0.0,
                            "anchorX": 0.5,
                            "anchorY": 0.5,
                            "zIndex": 10,
                            "opacity": 1.0
                        },
                        "animation": {
                            "inType": "none",
                            "outType": "none",
                            "inDurationMs": 0,
                            "outDurationMs": 0,
                            "easing": "linear"
                        },
                        "enabled": true,
                        "annotationType": "rect",
                        "strokeColor": "#00ff00",
                        "strokeWidth": 0.0,
                        "strokeStyle": "solid",
                        "fillColor": "#00ff00",
                        "fillOpacity": 1.0,
                        "cornerRadius": 0.0,
                        "arrowEndHead": "none",
                        "arrowStartHead": "none",
                        "shadowEnabled": false,
                        "shadowColor": "#000000",
                        "shadowBlur": 0.0,
                        "textColor": "#ffffff",
                        "fontSize": 16.0
                    }
                ],
                "assets": [],
                "fonts": []
            })),
            canvas: Some(cursor::RenderCanvas {
                width: 320,
                height: 240,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: Some(Vec::new()),
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-layering",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(res.is_ok(), "layered composition failed: {:?}", res.err());
        assert!(out_path.is_file(), "exported composition should exist");

        // Decode the middle frame and compare dominant channels: the
        // annotation region must be green (items above the red camera feed)
        // while a camera-only corner stays red (camera above the blue screen).
        let frame_path = temp_dir.join("frame.png");
        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-i",
                out_path.to_str().unwrap(),
                "-vf",
                "select=eq(n\\,5)",
                "-vframes",
                "1",
            ])
            .arg(&frame_path)
            .status()
            .unwrap();
        assert!(status.success(), "failed to extract frame");
        let frame = image::open(&frame_path).expect("open frame").to_rgba8();
        let annotation_px = frame.get_pixel(160, 110);
        assert!(
            annotation_px[1] > annotation_px[0] + 40 && annotation_px[1] > annotation_px[2] + 40,
            "overlay item should render above the camera layer, got {annotation_px:?}"
        );
        let camera_px = frame.get_pixel(300, 220);
        assert!(
            camera_px[0] > camera_px[1] + 40 && camera_px[0] > camera_px[2] + 40,
            "camera feed should still cover the screen layer, got {camera_px:?}"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn prepare_cursor_frame_plan_loads_jpeg_webp_gif_bmp_image_assets() {
        let dir = tempfile::tempdir().expect("tempdir");

        // Generate a uniform red 20x20 RGBA sample that can be saved to all
        // the raster formats the UI allows for overlay images.
        let red_pixel = image::Rgba([255u8, 0, 0, 255]);
        let rgba_buffer = image::RgbaImage::from_pixel(20, 20, red_pixel);
        let sample = image::DynamicImage::ImageRgba8(rgba_buffer);

        let mut asset_paths = HashMap::new();
        let mut add = |asset_id: &str, path: PathBuf, format: image::ImageFormat| {
            sample
                .save_with_format(&path, format)
                .expect("write test overlay image");
            asset_paths.insert(asset_id.into(), path);
        };

        add(
            "asset-jpg",
            dir.path().join("sticker.jpg"),
            image::ImageFormat::Jpeg,
        );
        add(
            "asset-webp",
            dir.path().join("sticker.webp"),
            image::ImageFormat::WebP,
        );
        add(
            "asset-gif",
            dir.path().join("sticker.gif"),
            image::ImageFormat::Gif,
        );
        add(
            "asset-bmp",
            dir.path().join("sticker.bmp"),
            image::ImageFormat::Bmp,
        );

        let mut plan = valid_plan();
        plan.overlay_render_plan = Some(serde_json::json!({
            "version": 1,
            "canvas": { "width": 200, "height": 60 },
            "items": [
                {
                    "kind": "image",
                    "id": "img-jpg",
                    "startMs": 0,
                    "endMs": 1000,
                    "transform": {
                        "x": 10.0,
                        "y": 10.0,
                        "width": 20.0,
                        "height": 20.0,
                        "rotation": 0.0,
                        "anchorX": 0.0,
                        "anchorY": 0.0,
                        "zIndex": 1,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 0,
                        "outDurationMs": 0,
                        "easing": "linear"
                    },
                    "enabled": true,
                    "assetId": "asset-jpg",
                    "fit": "contain",
                    "borderRadius": 0.0,
                    "borderWidth": 0.0,
                    "borderColor": "#ffffff",
                    "shadowEnabled": false,
                    "shadowColor": "#000000",
                    "shadowBlur": 0.0
                },
                {
                    "kind": "image",
                    "id": "img-webp",
                    "startMs": 0,
                    "endMs": 1000,
                    "transform": {
                        "x": 50.0,
                        "y": 10.0,
                        "width": 20.0,
                        "height": 20.0,
                        "rotation": 0.0,
                        "anchorX": 0.0,
                        "anchorY": 0.0,
                        "zIndex": 2,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 0,
                        "outDurationMs": 0,
                        "easing": "linear"
                    },
                    "enabled": true,
                    "assetId": "asset-webp",
                    "fit": "contain",
                    "borderRadius": 0.0,
                    "borderWidth": 0.0,
                    "borderColor": "#ffffff",
                    "shadowEnabled": false,
                    "shadowColor": "#000000",
                    "shadowBlur": 0.0
                },
                {
                    "kind": "image",
                    "id": "img-gif",
                    "startMs": 0,
                    "endMs": 1000,
                    "transform": {
                        "x": 90.0,
                        "y": 10.0,
                        "width": 20.0,
                        "height": 20.0,
                        "rotation": 0.0,
                        "anchorX": 0.0,
                        "anchorY": 0.0,
                        "zIndex": 3,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 0,
                        "outDurationMs": 0,
                        "easing": "linear"
                    },
                    "enabled": true,
                    "assetId": "asset-gif",
                    "fit": "contain",
                    "borderRadius": 0.0,
                    "borderWidth": 0.0,
                    "borderColor": "#ffffff",
                    "shadowEnabled": false,
                    "shadowColor": "#000000",
                    "shadowBlur": 0.0
                },
                {
                    "kind": "image",
                    "id": "img-bmp",
                    "startMs": 0,
                    "endMs": 1000,
                    "transform": {
                        "x": 130.0,
                        "y": 10.0,
                        "width": 20.0,
                        "height": 20.0,
                        "rotation": 0.0,
                        "anchorX": 0.0,
                        "anchorY": 0.0,
                        "zIndex": 4,
                        "opacity": 1.0
                    },
                    "animation": {
                        "inType": "fade",
                        "outType": "fade",
                        "inDurationMs": 0,
                        "outDurationMs": 0,
                        "easing": "linear"
                    },
                    "enabled": true,
                    "assetId": "asset-bmp",
                    "fit": "contain",
                    "borderRadius": 0.0,
                    "borderWidth": 0.0,
                    "borderColor": "#ffffff",
                    "shadowEnabled": false,
                    "shadowColor": "#000000",
                    "shadowBlur": 0.0
                }
            ],
            "assets": [
                { "id": "asset-jpg", "kind": "image" },
                { "id": "asset-webp", "kind": "image" },
                { "id": "asset-gif", "kind": "image" },
                { "id": "asset-bmp", "kind": "image" }
            ],
            "fonts": []
        }));

        let canvas = cursor::RenderCanvas {
            width: 200,
            height: 60,
            fps: 30,
            ..Default::default()
        };
        let frame_plan = prepare_cursor_frame_plan(
            &canvas,
            1000,
            Vec::new(),
            &plan,
            &asset_paths,
            (0.0, 0.0, canvas.width as f64, canvas.height as f64),
        )
        .expect("prepare frame plan succeeds");

        assert!(frame_plan.overlay_engine.is_some());
        let engine = frame_plan.overlay_engine.unwrap();
        assert_eq!(
            engine.images().len(),
            4,
            "all non-PNG overlay image assets should be decoded"
        );

        let mut pixmap = tiny_skia::Pixmap::new(200, 60).unwrap();
        engine
            .render_to_pixmap(100, &mut pixmap)
            .expect("render image overlays");
        let has_content = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
        assert!(has_content, "rendered image overlay frame contains pixels");
    }

    #[test]
    fn test_render_standalone_webcam_overlay_with_synthetic_stream_index() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-webcam-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let webcam_path = temp_dir.join("webcam.mp4");
        let out_path = temp_dir.join("out_webcam_test.mp4");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate screen test video");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&webcam_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate webcam test video");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);
        asset_paths.insert("rec-1:webcam:2".to_string(), webcam_path);

        let plan = RenderPlan {
            project_id: "test-webcam-project".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            gaps: Vec::new(),
            overlays: vec![RenderPlanOverlay {
                asset_id: "rec-1:webcam:2".into(),
                stream_index: Some(2), // synthetic project stream index
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                speed: 1.0,
                x: 10.0,
                y: 10.0,
                width: 100.0,
                height: 80.0,
                crop: None,
                opacity: 1.0,
                visible: true,
                shape: "rectangle".into(),
                border_width: Some(0.0),
                border_color: Some("#ffffff".into()),
                border_opacity: Some(1.0),
                shadow_enabled: Some(false),
                shadow_color: Some("#000000".into()),
                shadow_blur: Some(0.0),
                shadow_offset_x: Some(0.0),
                shadow_offset_y: Some(0.0),
                preset: None,
            }],
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 320,
                height: 240,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-webcam-project",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "webcam overlay composition with synthetic stream index failed: {:?}",
            res.err()
        );
        assert!(out_path.is_file(), "exported composition should exist");
    }

    #[test]
    fn test_render_standalone_webcam_with_audio_and_chapters() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-webcam-full-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let screen_path = temp_dir.join("screen.mp4");
        let webcam_path = temp_dir.join("webcam.mp4");
        let mic_path = temp_dir.join("microphone.wav");
        let out_path = temp_dir.join("out_webcam_full_test.mp4");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate screen test video");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&webcam_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate webcam test video");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=1",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&mic_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate audio wav");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);
        asset_paths.insert("rec-1:webcam:2".to_string(), webcam_path);
        asset_paths.insert("rec-1:microphone:1".to_string(), mic_path);

        let plan = RenderPlan {
            project_id: "test-webcam-full-project".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            gaps: Vec::new(),
            overlays: vec![RenderPlanOverlay {
                asset_id: "rec-1:webcam:2".into(),
                stream_index: Some(2),
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                speed: 1.0,
                x: 10.0,
                y: 10.0,
                width: 100.0,
                height: 80.0,
                crop: None,
                opacity: 1.0,
                visible: true,
                shape: "circle".into(),
                border_width: Some(2.0),
                border_color: Some("#ffffff".into()),
                border_opacity: Some(1.0),
                shadow_enabled: Some(true),
                shadow_color: Some("#000000".into()),
                shadow_blur: Some(10.0),
                shadow_offset_x: Some(0.0),
                shadow_offset_y: Some(4.0),
                preset: None,
            }],
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: vec![
                RenderPlanChapter {
                    id: "ch-1".into(),
                    title: "Intro".into(),
                    start_ms: 0,
                    end_ms: 500,
                },
                RenderPlanChapter {
                    id: "ch-2".into(),
                    title: "Demo".into(),
                    start_ms: 500,
                    end_ms: 1000,
                },
            ],
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 640,
                height: 480,
                padding: 16,
                background: "#1e1e1e".into(),
                border_radius: 8,
                shadow: true,
                shadow_color: Some("#000000".into()),
                shadow_blur: Some(16.0),
                shadow_offset_x: Some(0.0),
                shadow_offset_y: Some(8.0),
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: Some(vec![RenderPlanAudio {
                asset_id: "rec-1:microphone:1".into(),
                stream_index: Some(1),
                role: Some("microphone".into()),
                volume: 1.0,
                muted: false,
                segments: vec![RenderSegment {
                    asset_id: "rec-1:microphone:1".into(),
                    stream_index: Some(1),
                    volume: Some(1.0),
                    fade_in_ms: None,
                    fade_out_ms: None,
                    volume_keyframes: None,
                    audio_filter: None,
                    speed: 1.0,
                    source_in_ms: 0,
                    source_out_ms: 1000,
                    output_start_ms: 0,
                    output_end_ms: 1000,
                    source_width: None,
                    source_height: None,
                }],
            }]),
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-webcam-full-project",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "full composition with webcam, audio, chapters, and canvas failed: {:?}",
            res.err()
        );
        assert!(out_path.is_file(), "exported composition should exist");
    }

    #[test]
    fn test_safe_filter_color_resolution() {
        assert_eq!(safe_filter_color("black"), "#000000");
        assert_eq!(safe_filter_color("BLACK"), "#000000");
        assert_eq!(safe_filter_color("white"), "#ffffff");
        assert_eq!(safe_filter_color("red"), "#ef4444");
        assert_eq!(safe_filter_color("blue"), "#3b82f6");
        assert_eq!(safe_filter_color("green"), "#10b981");
        assert_eq!(safe_filter_color("yellow"), "#f59e0b");
        assert_eq!(safe_filter_color("gray"), "#6b7280");
        assert_eq!(safe_filter_color("grey"), "#6b7280");
        assert_eq!(safe_filter_color("transparent"), "#00000000");
        assert_eq!(safe_filter_color("#123456"), "#123456");
        assert_eq!(safe_filter_color("#12345678"), "#12345678");
        assert_eq!(safe_filter_color("unknown_color"), "#000000");
    }

    #[test]
    fn test_privacy_mask_export_end_to_end() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir = std::env::temp_dir().join(format!("rf-mask-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        struct CleanupDir(PathBuf);
        impl Drop for CleanupDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = CleanupDir(temp_dir.clone());

        let screen_path = temp_dir.join("screen.mp4");
        let out_path = temp_dir.join("out_mask_test.mp4");

        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(status.success(), "generate screen test video");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("asset-screen".to_string(), screen_path);

        // Include all 3 modes (redact, blur, pixelate) with odd coordinates to verify outward even snapping
        let plan = RenderPlan {
            project_id: "test-mask-export-project".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: vec![
                RenderPlanMask {
                    id: "mask-redact".into(),
                    asset_id: None,
                    start_ms: 0,
                    end_ms: 1000,
                    mode: "redact".into(),
                    rect: RenderCropFloat {
                        x: 15.0,      // odd coordinate
                        y: 15.0,      // odd coordinate
                        width: 81.0,  // odd dimension
                        height: 41.0, // odd dimension
                    },
                    blur_radius: 24.0,
                    pixel_size: 16,
                    redact_color: "black".into(),
                    enabled: true,
                },
                RenderPlanMask {
                    id: "mask-blur".into(),
                    asset_id: None,
                    start_ms: 0,
                    end_ms: 1000,
                    mode: "blur".into(),
                    rect: RenderCropFloat {
                        x: 100.0,
                        y: 20.0,
                        width: 80.0,
                        height: 50.0,
                    },
                    blur_radius: 16.0,
                    pixel_size: 16,
                    redact_color: "black".into(),
                    enabled: true,
                },
                RenderPlanMask {
                    id: "mask-pixelate".into(),
                    asset_id: None,
                    start_ms: 0,
                    end_ms: 1000,
                    mode: "pixelate".into(),
                    rect: RenderCropFloat {
                        x: 191.0,     // odd coordinate
                        y: 31.0,      // odd coordinate
                        width: 81.0,  // odd dimension
                        height: 51.0, // odd dimension
                    },
                    blur_radius: 24.0,
                    pixel_size: 8,
                    redact_color: "black".into(),
                    enabled: true,
                },
            ],
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 320,
                height: 240,
                fps: 10,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            "test-mask-export-project",
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "export composition with redact, blur, and pixelate masks failed: {:?}",
            res.err()
        );
        assert!(
            out_path.is_file(),
            "exported composition with masks should exist and be created"
        );
        assert!(
            out_path.metadata().unwrap().len() > 0,
            "exported video must not be empty"
        );
    }

    #[test]
    fn test_camera_overlay_odd_dimensions_alignment() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-cam-align-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let screen_path = temp_dir.join("screen.mp4");
        let camera_path = temp_dir.join("camera.mp4");
        let out_path = temp_dir.join("aligned_out.mp4");

        // 1-second screen source (320x180)
        let s1 = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(s1.success(), "create screen source");

        // 1-second camera source (320x240)
        let s2 = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&camera_path)
            .status()
            .unwrap();
        assert!(s2.success(), "create camera source");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("screen-asset".to_string(), screen_path);
        asset_paths.insert("camera-asset".to_string(), camera_path);

        // Canvas 4:5 (240x300) with two overlays having ODD dimensions and float coordinates
        let plan = RenderPlan {
            project_id: "test-cam-align".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "screen-asset".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(180),
            }],
            overlays: vec![
                RenderPlanOverlay {
                    asset_id: "camera-asset".into(),
                    stream_index: Some(0),
                    source_in_ms: 0,
                    source_out_ms: 500,
                    output_start_ms: 0,
                    output_end_ms: 500,
                    speed: 1.0,
                    x: 21.5,
                    y: 35.5,
                    width: 75.0,  // ODD dimension
                    height: 75.0, // ODD dimension
                    shape: "rounded".into(),
                    opacity: 1.0,
                    border_color: Some("#ffffff".into()),
                    border_width: Some(2.0),
                    border_opacity: Some(1.0),
                    shadow_enabled: Some(true),
                    shadow_color: Some("#000000".into()),
                    shadow_blur: Some(8.0),
                    shadow_offset_x: Some(0.0),
                    shadow_offset_y: Some(4.0),
                    crop: None,
                    visible: true,
                    preset: None,
                },
                RenderPlanOverlay {
                    asset_id: "camera-asset".into(),
                    stream_index: Some(0),
                    source_in_ms: 500,
                    source_out_ms: 1000,
                    output_start_ms: 500,
                    output_end_ms: 1000,
                    speed: 1.0,
                    x: 37.3,
                    y: 49.7,
                    width: 81.0,  // ODD dimension
                    height: 81.0, // ODD dimension
                    shape: "circle".into(),
                    opacity: 1.0,
                    border_color: Some("#3884f3".into()),
                    border_width: Some(3.0),
                    border_opacity: Some(0.5),
                    shadow_enabled: Some(true),
                    shadow_color: Some("#000000".into()),
                    shadow_blur: Some(12.0),
                    shadow_offset_x: Some(0.0),
                    shadow_offset_y: Some(6.0),
                    crop: None,
                    visible: true,
                    preset: None,
                },
            ],
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 240,
                height: 300,
                fps: 10,
                aspect_ratio: Some("4:5".into()),
                background: "#070b14".into(),
                padding: 10,
                border_radius: 8,
                shadow: true,
                video_position_y: Some(0.5),
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            masks: Vec::new(),
            gaps: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "none".into(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "none".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            &plan.project_id,
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(
            res.is_ok(),
            "render with odd overlay dimensions: {:?}",
            res.err()
        );
        assert!(out_path.is_file(), "output video exists");

        let validation = validate_export_output(
            &ffprobe,
            &out_path,
            &plan,
            &settings,
            res.expect("rendered").has_audio,
        );
        assert!(validation.is_ok(), "validation: {:?}", validation.err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_camera_overlay_renders_throughout_duration() {
        use image::GenericImageView;

        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-cam-render-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let screen_path = temp_dir.join("screen.mp4");
        let camera_path = temp_dir.join("camera.mp4");
        let out_path = temp_dir.join("out.mp4");
        let frame_path = temp_dir.join("extracted_frame.png");

        // 1-second solid black screen source (320x240)
        let s1 = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x240:r=10:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&screen_path)
            .status()
            .unwrap();
        assert!(s1.success(), "create screen source");

        // 1-second solid red camera source (100x100)
        let s2 = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=100x100:r=10:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&camera_path)
            .status()
            .unwrap();
        assert!(s2.success(), "create camera source");

        let mut asset_paths = HashMap::new();
        asset_paths.insert("screen-asset".to_string(), screen_path);
        asset_paths.insert("camera-asset".to_string(), camera_path);

        let plan = RenderPlan {
            project_id: "test-cam-render".into(),
            duration_ms: 1000,
            segments: vec![RenderSegment {
                asset_id: "screen-asset".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                source_width: Some(320),
                source_height: Some(240),
            }],
            overlays: vec![RenderPlanOverlay {
                asset_id: "camera-asset".into(),
                stream_index: Some(0),
                source_in_ms: 0,
                source_out_ms: 1000,
                output_start_ms: 0,
                output_end_ms: 1000,
                speed: 1.0,
                x: 50.0,
                y: 50.0,
                width: 100.0,
                height: 100.0,
                shape: "circle".into(),
                opacity: 1.0,
                border_color: Some("#ffffff".into()),
                border_width: Some(2.0),
                border_opacity: Some(1.0),
                shadow_enabled: Some(true),
                shadow_color: Some("#000000".into()),
                shadow_blur: Some(8.0),
                shadow_offset_x: Some(0.0),
                shadow_offset_y: Some(4.0),
                crop: None,
                visible: true,
                preset: None,
            }],
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 320,
                height: 240,
                fps: 10,
                aspect_ratio: None,
                background: "#000000".into(),
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            masks: Vec::new(),
            gaps: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "none".into(),
        };

        let settings = ExportSettings {
            preset: "balanced".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "none".into(),
            range: None,
        };

        let res = render_timeline_composition(
            &*ffmpeg.to_string_lossy(),
            &out_path,
            &plan,
            &plan.project_id,
            &asset_paths,
            &settings,
            encoding::ExportEncoder::Software,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &|_| {},
            None,
            Some(&ffprobe),
        );
        assert!(res.is_ok(), "render camera overlay: {:?}", res.err());
        assert!(out_path.is_file(), "output video exists");

        // Extract a frame at t=0.5s (500ms into the 1s export)
        let extract = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args(["-y", "-ss", "0.5", "-i"])
            .arg(&out_path)
            .args(["-vframes", "1"])
            .arg(&frame_path)
            .status()
            .unwrap();
        assert!(extract.success(), "extract frame at 0.5s");
        assert!(frame_path.is_file(), "frame extracted");

        let img = image::open(&frame_path).expect("open extracted frame");
        // Check pixel at the center of the camera circle: (x = 50 + 50 = 100, y = 50 + 50 = 100)
        let pixel = img.get_pixel(100, 100);
        // Red camera video should produce a high red channel (>= 150) and low blue channel (< 80)
        assert!(
            pixel[0] > 150 && pixel[2] < 80,
            "Center of camera overlay at 0.5s should show camera video (red), but got RGBA: {:?}",
            pixel
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
