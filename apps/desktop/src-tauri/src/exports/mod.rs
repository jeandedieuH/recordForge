use crate::database::library::get_recording;
use crate::database::media::MediaJob;
use crate::errors::{InternalError, Result};
use crate::events::EventPublisher;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tracing::{info, instrument, warn};

use tiny_skia::{Color, FillRule, Paint, Path as SkiaPath, PathBuilder, Pixmap, Rect, Transform};

mod annotations;
mod captions;
mod cursor;
mod encoding;

pub use annotations::{RenderPlanAnnotation, RenderPlanImage, RenderPlanText};

/// Auto-cleanup guard for temporary mask PNG files and filter complex scripts generated during timeline compositing.
struct TempMaskFile(PathBuf);

impl Drop for TempMaskFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
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

    update_progress(
        &db,
        app,
        job_id,
        0.08,
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

    // Composition owns 0.15..0.80 of the job; FFmpeg reports elapsed time.
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
            let progress = 0.15 + ratio.clamp(0.0, 1.0) * 0.65;
            let _ = update_progress(&db, &app_handle, &job, progress, "rendering", None);
        }
    };

    update_progress(
        &db,
        app,
        job_id,
        0.15,
        "rendering",
        Some("compositing timeline tracks"),
    )?;
    let resource_dir = app.path().resource_dir().ok();
    let composition = render_timeline_composition(
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
        Some(ffprobe_path),
    );
    // A hardware encoder can fail to initialize even after a passing probe
    // (driver capabilities differ by resolution and pixel format), so retry
    // once on software instead of failing the export outright. Cancelled jobs
    // propagate unchanged.
    if let Err(error) = composition {
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
        update_progress(
            &db,
            app,
            job_id,
            0.15,
            "rendering",
            Some("retrying with the software encoder"),
        )?;
        render_timeline_composition(
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
            Some(ffprobe_path),
        )?;
    }

    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        cleanup_export_files(output_path);
        return Err(InternalError::Media("export cancelled".into()).into());
    }

    if plan.caption_mode == "sidecar" {
        update_progress(
            &db,
            app,
            job_id,
            0.84,
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
            0.87,
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
        0.9,
        "validating",
        Some("validating rendered media"),
    )?;
    validate_export_output(ffprobe_path, &partial_path, &plan, &settings)?;
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

/// Returns a source size shared by every screen segment, or `None` when the
/// segments are missing dimensions or have mixed source sizes.
fn common_screen_source(
    segments: &[RenderSegment],
    asset_paths: &HashMap<String, PathBuf>,
    ffprobe_path: Option<&Path>,
) -> Option<(u32, u32)> {
    let mut common: Option<(u32, u32)> = None;
    for segment in segments {
        let dimensions = if let (Some(w), Some(h)) = (segment.source_width, segment.source_height) {
            Some((w, h))
        } else if let (Some(ffprobe), Some(path)) =
            (ffprobe_path, asset_paths.get(&segment.asset_id))
        {
            if let Ok(metadata) = crate::media::probe::probe_media(
                &ffprobe.to_string_lossy(),
                path,
                &segment.asset_id,
            ) {
                if let (Some(w), Some(h)) = (metadata.width, metadata.height) {
                    Some((w as u32, h as u32))
                } else {
                    None
                }
            } else {
                None
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

fn video_screen_rect(
    canvas: &cursor::RenderCanvas,
    source: Option<(u32, u32)>,
    is_side_by_side: bool,
) -> (f64, f64, f64, f64) {
    let padding = canvas.padding as f64;
    let content_width = (canvas.width as f64 - padding * 2.0).max(1.0);
    let content_height = (canvas.height as f64 - padding * 2.0).max(1.0);
    if is_side_by_side {
        let target_w = (content_width * 0.76).round().max(1.0);
        let target_h = ((target_w / canvas.width as f64) * canvas.height as f64)
            .round()
            .max(1.0);
        let (source_w, source_h) = match source {
            Some((w, h)) => (w as f64, h as f64),
            None => (target_w, target_h),
        };
        let fit_scale = (target_w / source_w).min(target_h / source_h);
        let fit_width = (source_w * fit_scale).floor();
        let fit_height = (source_h * fit_scale).floor();
        let x = (padding + (target_w - fit_width) / 2.0).floor();
        let y =
            (padding + (content_height - target_h) / 2.0 + (target_h - fit_height) / 2.0).floor();
        (x, y, fit_width, fit_height)
    } else {
        let (source_w, source_h) = match source {
            Some((w, h)) => (w as f64, h as f64),
            None => (content_width, content_height),
        };
        let fit_scale = (content_width / source_w).min(content_height / source_h);
        let fit_width = (source_w * fit_scale).floor();
        let fit_height = (source_h * fit_scale).floor();
        let x = (padding + (content_width - fit_width) / 2.0).floor();
        let y = (padding + (content_height - fit_height) / 2.0).floor();
        (x, y, fit_width, fit_height)
    }
}

/// Compose screen, manual zoom, camera overlays, canvas framing, cursor
/// telemetry, and semantic audio tracks in one FFmpeg graph. The cursor layer
/// is generated frame by frame in Rust and streamed over stdin as a rawvideo
/// input, so the whole export is a single encode. Keeping the graph here makes
/// the export path authoritative for every control exposed by the editor.
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
) -> Result<()> {
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
    let bg_image_path =
        resolve_background_image_with_resource_dir(&canvas.background, asset_paths, resource_dir);
    let mut temp_mask_guards = Vec::new();
    if let Some(bg_path) = &bg_image_path {
        if bg_path.starts_with(std::env::temp_dir())
            && bg_path
                .file_name()
                .and_then(|f| f.to_str())
                .is_some_and(|name| name.starts_with("recordforge_bg_"))
        {
            temp_mask_guards.push(TempMaskFile(bg_path.clone()));
        }
    }
    let mut input_assets = collect_input_assets(plan, asset_paths)?;
    let bg_input_index = if let Some(bg_path) = &bg_image_path {
        let idx = input_assets.len();
        input_assets.push(("canvas:background".to_string(), bg_path.clone()));
        Some(idx)
    } else {
        None
    };
    let chapters_input_index = if (settings.chapter_mode == "embed"
        || settings.chapter_mode == "both")
        && !plan.chapters.is_empty()
    {
        let meta_content = generate_ffmetadata(project_id, &plan.chapters);
        let meta_path = std::env::temp_dir().join(format!(
            "rf-chapters-{}-{}.ffmeta",
            project_id,
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&meta_path, meta_content.as_bytes())
            .map_err(|err| InternalError::Storage(format!("write ffmetadata: {err}")))?;
        let idx = input_assets.len();
        input_assets.push(("meta:chapters".to_string(), meta_path.clone()));
        temp_mask_guards.push(TempMaskFile(meta_path));
        Some(idx)
    } else {
        None
    };
    let content_width = canvas
        .width
        .saturating_sub(canvas.padding.saturating_mul(2))
        .max(1);
    let content_height = canvas
        .height
        .saturating_sub(canvas.padding.saturating_mul(2))
        .max(1);
    let is_side_by_side = plan.overlays.iter().any(|overlay| {
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
    });
    let (screen_x, screen_y, screen_w, screen_h) = video_screen_rect(
        canvas,
        common_screen_source(&plan.segments, asset_paths, ffprobe_path),
        is_side_by_side,
    );

    let canvas_mask_idx = if canvas.border_radius > 0 {
        let radius = (canvas.border_radius as f32)
            .min(screen_w as f32 / 2.0)
            .min(screen_h as f32 / 2.0);
        let mask_bytes = cursor::generate_rounded_rect_mask_png(
            screen_w.round().max(1.0) as u32,
            screen_h.round().max(1.0) as u32,
            radius,
        )
        .map_err(|err| InternalError::Media(format!("generate canvas border mask: {err}")))?;
        let mask_path = std::env::temp_dir().join(format!(
            "rf-mask-canvas-{}-{}-{}-{}.png",
            project_id,
            screen_w.round() as u32,
            screen_h.round() as u32,
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&mask_path, &mask_bytes)
            .map_err(|err| InternalError::Storage(format!("write canvas border mask: {err}")))?;
        let idx = input_assets.len();
        input_assets.push(("mask:canvas".to_string(), mask_path.clone()));
        temp_mask_guards.push(TempMaskFile(mask_path));
        Some(idx)
    } else {
        None
    };

    let shadow_input_index = if canvas.shadow {
        let shadow_path = generate_shadow_plate_png(
            canvas.width,
            canvas.height,
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
        if let Some(sp) = &shadow_path {
            let idx = input_assets.len();
            input_assets.push(("canvas:shadow".to_string(), sp.clone()));
            temp_mask_guards.push(TempMaskFile(sp.clone()));
            Some(idx)
        } else {
            None
        }
    } else {
        None
    };

    let mut camera_mask_indices = HashMap::new();
    let mut camera_border_indices = HashMap::new();
    let mut camera_shadow_indices = HashMap::new();
    for (index, overlay) in plan.overlays.iter().enumerate() {
        if !overlay.visible || overlay.output_end_ms <= overlay.output_start_ms {
            continue;
        }
        let overlay_w = overlay.width.round().max(1.0) as u32;
        let overlay_h = overlay.height.round().max(1.0) as u32;

        if overlay.shadow_enabled.unwrap_or(false) {
            if let Some(sp) = generate_camera_shadow_plate_png(
                canvas.width,
                canvas.height,
                overlay.x,
                overlay.y,
                overlay.width,
                overlay.height,
                &overlay.shape,
                overlay.shadow_color.as_deref(),
                overlay.shadow_blur,
                overlay.shadow_offset_x,
                overlay.shadow_offset_y,
            ) {
                let idx = input_assets.len();
                input_assets.push((format!("shadow:cam:{index}"), sp.clone()));
                temp_mask_guards.push(TempMaskFile(sp));
                camera_shadow_indices.insert(index, idx);
            }
        }

        if overlay.shape == "circle" {
            let mask_bytes = cursor::generate_circle_mask_png(overlay_w, overlay_h)
                .map_err(|err| InternalError::Media(format!("generate circle mask: {err}")))?;
            let mask_path = std::env::temp_dir().join(format!(
                "rf-mask-cam-circle-{}-{}-{}-{}-{}.png",
                project_id,
                index,
                overlay_w,
                overlay_h,
                uuid::Uuid::new_v4()
            ));
            std::fs::write(&mask_path, &mask_bytes)
                .map_err(|err| InternalError::Storage(format!("write circle mask: {err}")))?;
            let idx = input_assets.len();
            input_assets.push((format!("mask:cam_circle:{index}"), mask_path.clone()));
            temp_mask_guards.push(TempMaskFile(mask_path));
            camera_mask_indices.insert(index, idx);
        } else if overlay.shape == "rounded" {
            let radius = (overlay.width.min(overlay.height) * 0.12).max(4.0) as f32;
            let mask_bytes =
                cursor::generate_rounded_rect_mask_png(overlay_w, overlay_h, radius)
                    .map_err(|err| InternalError::Media(format!("generate rounded mask: {err}")))?;
            let mask_path = std::env::temp_dir().join(format!(
                "rf-mask-cam-rounded-{}-{}-{}-{}-{}.png",
                project_id,
                index,
                overlay_w,
                overlay_h,
                uuid::Uuid::new_v4()
            ));
            std::fs::write(&mask_path, &mask_bytes)
                .map_err(|err| InternalError::Storage(format!("write rounded mask: {err}")))?;
            let idx = input_assets.len();
            input_assets.push((format!("mask:cam_rounded:{index}"), mask_path.clone()));
            temp_mask_guards.push(TempMaskFile(mask_path));
            camera_mask_indices.insert(index, idx);
        }

        if let Some(border_width) = overlay.border_width.filter(|value| *value > 0.0) {
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
            let idx = input_assets.len();
            input_assets.push((format!("border:cam:{index}"), border_path.clone()));
            temp_mask_guards.push(TempMaskFile(border_path));
            camera_border_indices.insert(index, idx);
        }
    }

    let input_indices = input_assets
        .iter()
        .enumerate()
        .map(|(index, (asset_id, _))| (asset_id.clone(), index))
        .collect::<HashMap<_, _>>();
    let (segment_w, segment_h) = if is_side_by_side {
        (
            (content_width as f64 * 0.76).round().max(1.0) as u32,
            ((content_width as f64 * 0.76 / canvas.width as f64) * canvas.height as f64)
                .round()
                .max(1.0) as u32,
        )
    } else {
        (content_width, content_height)
    };
    let crop_x = ((segment_w as f64 - screen_w) / 2.0).floor();
    let crop_y = ((segment_h as f64 - screen_h) / 2.0).floor();
    let background = safe_filter_color(&canvas.background);
    let mut filters = Vec::new();
    let mut video_labels = Vec::new();
    let mut cursor_ms = 0;
    for (index, segment) in plan.segments.iter().enumerate() {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(InternalError::Media("export cancelled".into()).into());
        }
        if segment.output_start_ms > cursor_ms {
            let gap_label = format!("gap{index}");
            let gap_color = if bg_input_index.is_some() {
                "black@0".to_string()
            } else {
                background.clone()
            };
            filters.push(format!(
                "color=c={gap_color}:s={segment_w}x{segment_h}:r={}:d={}[{gap_label}]",
                canvas.fps,
                seconds(segment.output_start_ms - cursor_ms),
            ));
            video_labels.push(format!("[{gap_label}]"));
        }
        validate_segment_known(segment, project_id, asset_paths)?;
        let input_index = *input_indices.get(&segment.asset_id).ok_or_else(|| {
            InternalError::Media("render plan references an unknown asset".into())
        })?;
        let asset_path = asset_paths.get(&segment.asset_id).ok_or_else(|| {
            InternalError::Media("render plan references an unknown asset".into())
        })?;
        let input = resolve_video_stream_specifier(
            ffprobe_path,
            asset_path,
            &segment.asset_id,
            input_index,
            segment.stream_index,
        )?;
        let label = format!("screen{index}");
        let mut filter = format!(
            "{input}trim=start={}:end={},setpts=PTS-STARTPTS",
            seconds(segment.source_in_ms),
            seconds(segment.source_out_ms),
        );
        if (segment.speed - 1.0).abs() > f64::EPSILON {
            filter.push_str(&format!(",setpts=PTS/{:.6}", segment.speed));
        }
        let pad_color = if bg_input_index.is_some() {
            "black@0".to_string()
        } else {
            background.clone()
        };
        let segment_duration = seconds(
            segment
                .output_end_ms
                .saturating_sub(segment.output_start_ms),
        );
        filter.push_str(&format!(
            ",scale={segment_w}:{segment_h}:force_original_aspect_ratio=decrease,pad={segment_w}:{segment_h}:(ow-iw)/2:(oh-ih)/2:color={pad_color},fps={},setsar=1,tpad=stop_mode=clone:stop_duration={segment_duration},tpad=stop_mode=add:stop_duration={segment_duration}:color={pad_color},trim=duration={segment_duration},setpts=PTS-STARTPTS[{label}]",
            canvas.fps,
        ));
        filters.push(filter);
        video_labels.push(format!("[{label}]"));
        cursor_ms = segment.output_end_ms;
    }
    if cursor_ms < plan.duration_ms {
        let gap_label = "gap_trailing";
        let gap_color = if bg_input_index.is_some() {
            "black@0".to_string()
        } else {
            background.clone()
        };
        filters.push(format!(
            "color=c={gap_color}:s={segment_w}x{segment_h}:r={}:d={}[{gap_label}]",
            canvas.fps,
            seconds(plan.duration_ms - cursor_ms),
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
    let plan_duration = seconds(plan.duration_ms);

    let is_fullscreen_canvas = bg_input_index.is_none()
        && canvas.border_radius == 0
        && !canvas.shadow
        && !is_side_by_side
        && screen_w >= (canvas.width as f64 - 0.5)
        && screen_h >= (canvas.height as f64 - 0.5)
        && screen_x.abs() < 0.5
        && screen_y.abs() < 0.5
        && crop_x.abs() < 0.5
        && crop_y.abs() < 0.5;

    let base_label = "canvas_base";
    if is_fullscreen_canvas {
        if plan.zoom_segments.iter().any(|segment| segment.enabled) {
            let (z_expr, x_expr, y_expr) =
                build_zoompan_expressions(plan, canvas, canvas.width as f64, canvas.height as f64);
            filters.push(format!(
                "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS,zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={}x{}:fps={},setsar=1[{base_label}]",
                canvas.width, canvas.height, canvas.fps
            ));
        } else {
            filters.push(format!(
                "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS,setsar=1[{base_label}]"
            ));
        }
    } else {
        // 1. Generate the background plate [bg_plate]
        if let Some(bg_idx) = bg_input_index {
            let fit_mode = canvas.background_fit.as_deref().unwrap_or("cover");
            let mut bg_filter = match fit_mode {
                "contain" | "fit" => {
                    format!(
                        "[{bg_idx}:v]loop=loop=-1:size=1:start=0,split=2[bg_underlay_src][bg_main_src];\
                         [bg_underlay_src]scale={}:{}:force_original_aspect_ratio=increase,crop={}:{},boxblur=luma_radius=30:luma_power=2:chroma_radius=30:chroma_power=2,drawbox=x=0:y=0:w={}:h={}:color=black@0.25:t=fill,setsar=1[bg_underlay];\
                         [bg_main_src]scale={}:{}:force_original_aspect_ratio=decrease,setsar=1[bg_main];\
                         [bg_underlay][bg_main]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p",
                        canvas.width,
                        canvas.height,
                        canvas.width,
                        canvas.height,
                        canvas.width,
                        canvas.height,
                        canvas.width,
                        canvas.height
                    )
                }
                _ => {
                    format!(
                        "[{bg_idx}:v]loop=loop=-1:size=1:start=0,scale={}:{}:force_original_aspect_ratio=increase,crop={}:{},setsar=1,format=yuv420p",
                        canvas.width, canvas.height, canvas.width, canvas.height
                    )
                }
            };
            let bg_blur = canvas.background_blur.unwrap_or(0.0).clamp(0.0, 100.0);
            if bg_blur > 0.0 {
                let radius = (bg_blur.round() as u32).clamp(1, 50);
                bg_filter.push_str(&format!(
                    ",boxblur=luma_radius={radius}:luma_power=2:chroma_radius={radius}:chroma_power=2"
                ));
            }
            let bg_dim = canvas.background_dim.unwrap_or(0.0).clamp(0.0, 1.0);
            if bg_dim > 0.0 {
                bg_filter.push_str(&format!(
                    ",drawbox=x=0:y=0:w={}:h={}:color=black@{:.3}:t=fill",
                    canvas.width, canvas.height, bg_dim
                ));
            }
            bg_filter.push_str(&format!(
                ",fps={},tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS[bg_plate]",
                canvas.fps
            ));
            filters.push(bg_filter);
        } else {
            let mut solid_filter = format!(
                "color=c={background}:s={}x{}:r={}:d={}",
                canvas.width, canvas.height, canvas.fps, plan_duration
            );
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

        // 2. Crop and format the fitted video layer [screen_fitted]
        let mut screen_filter = if plan.zoom_segments.iter().any(|segment| segment.enabled) {
            let (z_expr, x_expr, y_expr) =
                build_zoompan_expressions(plan, canvas, screen_w, screen_h);
            format!(
                "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS,crop={screen_w:.0}:{screen_h:.0}:{crop_x:.0}:{crop_y:.0},zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={screen_w:.0}x{screen_h:.0}:fps={},setsar=1",
                canvas.fps
            )
        } else {
            format!(
                "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS,crop={screen_w:.0}:{screen_h:.0}:{crop_x:.0}:{crop_y:.0},setsar=1"
            )
        };
        if let Some(mask_idx) = canvas_mask_idx {
            let raw_label = "screen_unmasked";
            let mask_label = "screen_mask_loop";
            screen_filter.push_str(&format!(",format=rgba[{raw_label}]"));
            filters.push(screen_filter);
            filters.push(format!(
                "[{mask_idx}:v]format=gray,scale={screen_w:.0}:{screen_h:.0},setsar=1,loop=loop=-1:size=1:start=0[{mask_label}];\
                 [{raw_label}][{mask_label}]alphamerge[screen_fitted]"
            ));
        } else {
            screen_filter.push_str("[screen_fitted]");
            filters.push(screen_filter);
        }

        // 3. Composite shadow and screen layer onto background plate [canvas_base]
        let mut bg_current = "[bg_plate]".to_string();
        if let Some(shadow_idx) = shadow_input_index {
            filters.push(format!(
                "[{shadow_idx}:v]loop=loop=-1:size=1:start=0,scale={}x{},format=rgba,setsar=1,fps={},tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS[shadow_loop]",
                canvas.width, canvas.height, canvas.fps
            ));
            filters.push(format!(
                "{bg_current}[shadow_loop]overlay=x=0:y=0:shortest=1:format=auto[bg_with_shadow]"
            ));
            bg_current = "[bg_with_shadow]".to_string();
        }
        let overlay_format = if canvas_mask_idx.is_some() {
            "format=auto"
        } else {
            "format=yuv420"
        };
        filters.push(format!(
            "{bg_current}[screen_fitted]overlay=x={screen_x:.0}:y={screen_y:.0}:shortest=1:{overlay_format}[{base_label}]"
        ));
    }

    let composed_label = base_label.to_string();

    let mut current_label = composed_label;

    // The overlay layer (cursor telemetry, vector annotations, styled text presets, graphics)
    // rides directly on the screen/canvas base so that camera video overlays,
    // privacy masks, and captions render cleanly on top.
    let cursor_renderers = build_cursor_renderers(
        plan,
        project_id,
        asset_paths,
        canvas,
        (screen_x, screen_y, screen_w, screen_h),
    )?;
    let has_overlay_plan = plan.overlay_render_plan.is_some();
    let has_annotations = !plan.annotations.is_empty();
    let has_texts = !plan.texts.is_empty();
    let has_images = !plan.images.is_empty();
    let mut cursor_plan = None;
    if !cursor_renderers.is_empty()
        || has_overlay_plan
        || has_annotations
        || has_texts
        || has_images
    {
        let cursor_input_index = input_assets.len();
        let cursor_label = "with_overlay";
        filters.push(format!(
            "[{current_label}][{cursor_input_index}:v]overlay=shortest=1:format=yuv420[{cursor_label}]"
        ));
        current_label = cursor_label.to_string();
        cursor_plan = Some(prepare_cursor_frame_plan(
            canvas,
            plan.duration_ms,
            cursor_renderers,
            plan,
            asset_paths,
        )?);
    }

    for (index, overlay) in plan.overlays.iter().enumerate() {
        if !overlay.visible || overlay.output_end_ms <= overlay.output_start_ms {
            continue;
        }
        validate_overlay(overlay, project_id, asset_paths, canvas)?;
        let input_index = *input_indices.get(&overlay.asset_id).ok_or_else(|| {
            InternalError::Media("camera overlay references an unknown asset".into())
        })?;
        let asset_path = asset_paths.get(&overlay.asset_id).ok_or_else(|| {
            InternalError::Media("camera overlay references an unknown asset".into())
        })?;
        let input = resolve_video_stream_specifier(
            ffprobe_path,
            asset_path,
            &overlay.asset_id,
            input_index,
            overlay.stream_index,
        )?;
        if !overlay.speed.is_finite() || overlay.speed <= 0.0 {
            return Err(InternalError::Media("camera overlay speed is invalid".into()).into());
        }

        let enable = format!(
            "between(t,{},{})",
            seconds(overlay.output_start_ms),
            seconds(overlay.output_end_ms)
        );

        // 1. Composite shadow underlay if present
        if let Some(&shadow_idx) = camera_shadow_indices.get(&index) {
            let shadow_loop_label = format!("cam_shadow_loop{index}");
            let after_shadow_label = format!("cam_with_shadow{index}");
            filters.push(format!(
                "[{shadow_idx}:v]loop=loop=-1:size=1:start=0,scale={}x{},format=rgba,setsar=1,fps={},tpad=stop_mode=clone:stop_duration={plan_duration},tpad=stop_mode=add:stop_duration={plan_duration}:color=black,trim=duration={plan_duration},setpts=PTS-STARTPTS[{shadow_loop_label}]",
                canvas.width, canvas.height, canvas.fps
            ));
            filters.push(format!(
                "[{current_label}][{shadow_loop_label}]overlay=x=0:y=0:eof_action=pass:enable='{enable}':format=auto[{after_shadow_label}]"
            ));
            current_label = after_shadow_label;
        }

        // 2. Format camera video stream (trim, speed, crop/cover, scale, opacity)
        let mut camera_filter = format!(
            "{input}trim=start={}:end={},setpts=(PTS-STARTPTS)/{:.6}+{}/TB",
            seconds(overlay.source_in_ms),
            seconds(overlay.source_out_ms),
            overlay.speed,
            seconds(overlay.output_start_ms),
        );
        if let Some(crop) = &overlay.crop {
            camera_filter.push_str(&format!(
                ",crop={}:{}:{}:{}",
                crop.width, crop.height, crop.x, crop.y
            ));
            camera_filter.push_str(&format!(
                ",scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba",
                overlay.width.max(1.0),
                overlay.height.max(1.0),
                overlay.width.max(1.0),
                overlay.height.max(1.0)
            ));
        } else {
            camera_filter.push_str(&format!(
                ",scale={}:{}:force_original_aspect_ratio=increase,crop={}:{}:(iw-ow)/2:(ih-oh)/2,format=rgba",
                overlay.width.max(1.0),
                overlay.height.max(1.0),
                overlay.width.max(1.0),
                overlay.height.max(1.0)
            ));
        }
        if overlay.opacity < 1.0 {
            camera_filter.push_str(&format!(",colorchannelmixer=aa={:.4}", overlay.opacity));
        }

        // 3. Mask camera video stream (for circle and rounded shapes)
        let masked_camera_label = if let Some(&cam_mask_idx) = camera_mask_indices.get(&index) {
            let raw_label = format!("camera_unmasked{index}");
            let mask_label = format!("cam_mask_loop{index}");
            let masked_label = format!("camera_masked{index}");
            let overlay_w = overlay.width.max(1.0).round() as u32;
            let overlay_h = overlay.height.max(1.0).round() as u32;
            camera_filter.push_str(&format!("[{raw_label}]"));
            filters.push(camera_filter);
            filters.push(format!(
                "[{cam_mask_idx}:v]format=gray,scale={overlay_w}:{overlay_h},setsar=1,loop=loop=-1:size=1:start=0[{mask_label}];\
                 [{raw_label}][{mask_label}]alphamerge[{masked_label}]"
            ));
            masked_label
        } else {
            let raw_label = format!("camera_raw{index}");
            camera_filter.push_str(&format!("[{raw_label}]"));
            filters.push(camera_filter);
            raw_label
        };

        // 4. Overlay border stroke if present
        let final_camera_label = if let Some(&border_idx) = camera_border_indices.get(&index) {
            let border_loop_label = format!("cam_border_loop{index}");
            let bordered_label = format!("camera_bordered{index}");
            let overlay_w = overlay.width.max(1.0).round() as u32;
            let overlay_h = overlay.height.max(1.0).round() as u32;
            filters.push(format!(
                "[{border_idx}:v]format=rgba,scale={overlay_w}:{overlay_h},setsar=1,loop=loop=-1:size=1:start=0[{border_loop_label}];\
                 [{masked_camera_label}][{border_loop_label}]overlay=x=0:y=0:shortest=1:format=auto[{bordered_label}]"
            ));
            bordered_label
        } else {
            masked_camera_label
        };

        // 5. Composite camera on top of current canvas
        let next_label = format!("composite{index}");
        filters.push(format!(
            "[{current_label}][{final_camera_label}]overlay=x={:.2}:y={:.2}:eof_action=pass:enable='{enable}'[{next_label}]",
            overlay.x, overlay.y
        ));
        current_label = next_label;
    }

    for (index, mask) in plan.masks.iter().enumerate() {
        if !mask.enabled || mask.end_ms <= mask.start_ms {
            continue;
        }
        validate_mask(mask, project_id, asset_paths, canvas)?;
        let x = mask
            .rect
            .x
            .round()
            .clamp(0.0, canvas.width.saturating_sub(1) as f64);
        let y = mask
            .rect
            .y
            .round()
            .clamp(0.0, canvas.height.saturating_sub(1) as f64);
        let width = mask
            .rect
            .width
            .round()
            .clamp(1.0, (canvas.width as f64 - x).max(1.0));
        let height = mask
            .rect
            .height
            .round()
            .clamp(1.0, (canvas.height as f64 - y).max(1.0));
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
                    "[{current_label}]drawbox=x={x:.0}:y={y:.0}:w={width:.0}:h={height:.0}:color={color}:t=fill:enable='{enable}'[{next_label}]"
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
                    format!("[{source_label}]crop=w={width:.0}:h={height:.0}:x={x:.0}:y={y:.0}");
                if mask.mode == "blur" {
                    region_filter.push_str(&format!(
                        ",boxblur=luma_radius={:.0}:luma_power=2",
                        mask.blur_radius.clamp(1.0, 128.0)
                    ));
                } else {
                    let pixel_size = mask.pixel_size.clamp(2, 128) as f64;
                    let small_width = (width / pixel_size).floor().max(1.0);
                    let small_height = (height / pixel_size).floor().max(1.0);
                    region_filter.push_str(&format!(
                        ",scale=w={small_width:.0}:h={small_height:.0}:flags=neighbor,scale=w={width:.0}:h={height:.0}:flags=neighbor"
                    ));
                }
                region_filter.push_str(&format!("[{filtered_label}]"));
                filters.push(region_filter);
                filters.push(format!(
                    "[{base_label}][{filtered_label}]overlay=x={x:.0}:y={y:.0}:eof_action=pass:enable='{enable}'[{next_label}]"
                ));
            }
            _ => {
                return Err(InternalError::Media("mask mode is unsupported".into()).into());
            }
        }
        current_label = next_label;
    }

    for (caption_index, caption) in plan.captions.iter().enumerate() {
        captions::validate_caption(caption)?;
        if plan.caption_mode != "burn-in" {
            continue;
        }
        let safe_id = caption
            .id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let next_label = format!("caption_{caption_index}_{safe_id}");
        filters.push(captions::drawtext_filter(
            caption,
            &current_label,
            &next_label,
            canvas.height,
        )?);
        current_label = next_label;
    }

    let final_label = "export_output";
    filters.push(format!("[{current_label}]format=yuv420p[{final_label}]"));
    current_label = final_label.to_string();

    let audio_tracks = plan
        .audio_tracks
        .as_ref()
        .map(|tracks| tracks.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| plan.audio.iter().collect::<Vec<_>>());
    let duration_ms = plan.duration_ms.max(1);
    let is_gif = settings.container == "gif" || settings.preset.starts_with("gif-");
    let mut audio_labels = Vec::new();
    let mut audio_segment_index = 0usize;
    if !is_gif {
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
                    ffprobe_path,
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
    }

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "0",
            "-filter_threads",
            "0",
        ])
        // Machine-readable progress blocks on stderr; the runner parses
        // `out_time=` from them and keeps them out of failure diagnostics.
        .args(["-progress", "pipe:2"]);
    for (asset_kind, asset_path) in &input_assets {
        if asset_kind == "canvas:background"
            || asset_kind == "canvas:shadow"
            || asset_kind.starts_with("mask:")
            || asset_kind.starts_with("shadow:")
            || asset_kind.starts_with("border:")
        {
            command.args(["-loop", "1"]);
        }
        command.arg("-i").arg(asset_path);
    }
    if cursor_plan.is_some() {
        // The generated cursor layer is a transparent RGBA stream fed frame by
        // frame through stdin; frame timestamps come from the declared rate.
        command
            .args(["-f", "rawvideo", "-pix_fmt", "rgba"])
            .args(["-s", &format!("{}x{}", canvas.width, canvas.height)])
            .args(["-r", &canvas.fps.to_string()])
            .arg("-i")
            .arg("-");
    }
    if is_gif {
        let (gif_fps, dither_opt) = match settings.preset.as_str() {
            "gif-fast" => (15, "bayer:bayer_scale=4"),
            "gif-high-quality" => (30, "floyd_steinberg"),
            _ => (20, "bayer:bayer_scale=3"),
        };
        filters.push(format!(
            "[{current_label}]fps={gif_fps},split[gif_v1][gif_v2];[gif_v1]palettegen=stats_mode=diff:reserve_transparent=0[gif_pal];[gif_v2][gif_pal]paletteuse=dither={dither_opt}[gif_out]"
        ));
        current_label = "gif_out".to_string();
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
    if is_gif || audio_labels.is_empty() {
        command.arg("-an");
    } else {
        command.args(["-map", "[aout]"]);
    }
    if is_gif {
        command.args(["-c:v", "gif", "-loop", "0", "-f", "gif"]);
    } else {
        encoding::append_export_video_args(
            &mut command,
            settings,
            encoder,
            canvas.fps,
            canvas.width,
            canvas.height,
        );
        if !audio_labels.is_empty() {
            command.args(["-c:a", "aac", "-b:a", audio_bitrate(settings)]);
        }
        if let Some(idx) = chapters_input_index {
            command.args(["-map_chapters", &idx.to_string()]);
        }
        command.args(["-movflags", "+faststart"]);
    }
    command
        .args(["-t", &seconds(plan.duration_ms)])
        .arg(output_path);

    run_export_ffmpeg(
        &mut command,
        &cancel,
        output_path,
        "timeline composition",
        Some(plan.duration_ms),
        cursor_plan,
        Some(on_progress),
    )
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
) -> Result<Vec<(u64, u64, cursor::CursorRenderer)>> {
    let mut renderers = Vec::new();
    for effect in plan
        .cursor_effects
        .iter()
        .filter(|effect| effect.enabled && effect.end_ms > effect.start_ms)
    {
        let telemetry_path = asset_paths.get(&effect.asset_id).ok_or_else(|| {
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
                    asset_id = %effect.asset_id,
                    "cursor position unavailable; exporting without cursor overlay"
                );
                continue;
            }
            crate::capture::cursor::CursorTelemetryHealth::ShapesUnavailable => {
                tracing::info!(
                    %project_id,
                    asset_id = %effect.asset_id,
                    "cursor shape metadata unavailable; using preset fallback"
                );
            }
            _ => {}
        }

        let telemetry_json = serde_json::to_string(&v2)
            .map_err(|e| InternalError::Media(format!("serialize cursor telemetry: {e}")))?;
        let telemetry: cursor_engine::CursorTelemetryFile = serde_json::from_str(&telemetry_json)
            .map_err(|e| {
            InternalError::Media(format!("parse cursor telemetry for engine: {e}"))
        })?;
        if telemetry.events.is_empty() {
            continue;
        }
        let settings = cursor_settings_for_effect(&canvas.cursor_settings, effect);
        let renderer = cursor::CursorRenderer::new_with_zoom(
            settings,
            telemetry,
            &plan.segments,
            &plan.zoom_segments,
            canvas,
            Some(screen_rect),
        )
        .map_err(|error| InternalError::Media(format!("prepare cursor overlay: {error}")))?;
        renderers.push((effect.start_ms, effect.end_ms, renderer));
    }
    if renderers.is_empty() {
        tracing::warn!(%project_id, "cursor telemetry is unavailable; exporting without a cursor overlay");
    }
    Ok(renderers)
}

/// Preallocated state for streaming the combined overlay layer (cursor, annotations, text, images) into FFmpeg's stdin.
#[allow(dead_code)]
struct CursorFramePlan {
    fps: u32,
    width: u32,
    height: u32,
    frame_count: u64,
    pixmap: resvg::tiny_skia::Pixmap,
    renderers: Vec<(u64, u64, cursor::CursorRenderer)>,
    overlay_engine: Option<overlay_engine::OverlayEngine>,
}

fn prepare_cursor_frame_plan(
    canvas: &cursor::RenderCanvas,
    duration_ms: u64,
    renderers: Vec<(u64, u64, cursor::CursorRenderer)>,
    plan: &RenderPlan,
    asset_paths: &HashMap<String, PathBuf>,
) -> Result<CursorFramePlan> {
    let pixmap = resvg::tiny_skia::Pixmap::new(canvas.width, canvas.height)
        .ok_or_else(|| InternalError::Media("overlay frame is too large".into()))?;
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
        parsed_plan.canvas = overlay_engine::OverlayCanvas {
            width: canvas.width,
            height: canvas.height,
        };
        let mut image_asset_ids = std::collections::BTreeSet::new();
        image_asset_ids.extend(plan.images.iter().map(|image| image.asset_id.clone()));
        image_asset_ids.extend(parsed_plan.assets.iter().map(|asset| asset.id.clone()));
        let mut engine = overlay_engine::OverlayEngine::from_render_plan(parsed_plan)
            .map_err(|error| InternalError::Media(format!("build overlay render plan: {error}")))?;
        for asset_id in image_asset_ids {
            let path = asset_paths.get(&asset_id).ok_or_else(|| {
                InternalError::Permissions("overlay references a missing image asset".into())
            })?;
            register_overlay_image_asset(&mut engine, &asset_id, path)?;
        }
        Some(engine)
    } else {
        None
    };

    Ok(CursorFramePlan {
        fps: canvas.fps,
        width: canvas.width,
        height: canvas.height,
        frame_count,
        pixmap,
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

/// Stream every composited overlay frame into FFmpeg's stdin.
///
/// The overlay graph uses shortest=1, so FFmpeg stops reading stdin as soon as
/// the composed video ends. Feeding ceil(duration*fps) frames can exceed that
/// by one frame; a closed pipe here means the consumer finished, and the
/// exit-status check in the runner decides whether the render actually failed.
fn feed_cursor_frames(
    stdin: &mut std::process::ChildStdin,
    cursor: &mut CursorFramePlan,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<()> {
    let mut writer = std::io::BufWriter::with_capacity(256 * 1024, stdin);
    for frame_index in 0..cursor.frame_count {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(InternalError::Media("export cancelled".into()).into());
        }
        // Rawvideo assigns each input frame the exact CFR PTS. Do not floor
        // this value: the old integer calculation accumulated almost one frame
        // of cursor timing error over long exports.
        let output_time_ms = cursor::frame_time_ms(frame_index, cursor.fps);
        let overlay_time_ms = output_time_ms.floor().max(0.0) as u64;
        cursor.pixmap.fill(resvg::tiny_skia::Color::TRANSPARENT);

        // 1. Render active overlay items (annotations, text presets, images)
        if let Some(engine) = &cursor.overlay_engine {
            engine
                .render_to_pixmap(overlay_time_ms, &mut cursor.pixmap)
                .map_err(|error| InternalError::Media(format!("render overlay frame: {error}")))?;
        }

        // 2. Render cursor telemetry (if active at the exact frame PTS)
        if let Some((_, _, renderer)) = cursor.renderers.iter_mut().find(|(start_ms, end_ms, _)| {
            output_time_ms >= *start_ms as f64 && output_time_ms < *end_ms as f64
        }) {
            renderer.render_frame_at(output_time_ms, cursor.pixmap.data_mut());
        }

        // Unpremultiply directly in-place without heap allocations
        cursor::unpremultiply_rgba(cursor.pixmap.data_mut());

        if let Err(error) = writer.write_all(cursor.pixmap.data()) {
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
    let is_gif = settings.container == "gif" || settings.preset.starts_with("gif-");
    if !is_gif && settings.chapter_mode != plan.chapter_mode {
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
fn run_export_ffmpeg(
    command: &mut Command,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
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
                Some(mut stdin) => feed_cursor_frames(&mut stdin, cursor_plan, cancel),
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
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
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
                    tracing::error!(stage, detail = %detail, stderr = %String::from_utf8_lossy(&diagnostic), "ffmpeg export process failed");
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
    if video.width != Some(canvas.width as i32) || video.height != Some(canvas.height as i32) {
        return Err(InternalError::Media("export dimensions failed validation".into()).into());
    }
    let expected_video_codec = if settings.container == "gif" || settings.codec == "gif" {
        "gif"
    } else if settings.codec == "hevc" {
        "hevc"
    } else {
        "h264"
    };
    if video.codec != expected_video_codec {
        return Err(InternalError::Media("export video codec failed validation".into()).into());
    }
    if settings.container == "gif" {
        if metadata.has_audio {
            return Err(InternalError::Media("gif export must not contain audio".into()).into());
        }
        return Ok(());
    }
    let expected_audio = plan.audio_tracks.as_ref().is_some_and(|tracks| {
        tracks
            .iter()
            .any(|track| !track.muted && !track.segments.is_empty())
    }) || plan
        .audio
        .as_ref()
        .is_some_and(|track| !track.muted && !track.segments.is_empty());
    if expected_audio != metadata.has_audio {
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
        "white" => "#ffffff".into(),
        "red" => "#ef4444".into(),
        "blue" => "#3b82f6".into(),
        "yellow" => "#facc15".into(),
        "transparent" => "#00000000".into(),
        _ => "#070b14".into(),
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

    let path = build_rounded_rect_path(x, y, w, h, r)?;
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

    // Try generating CSS gradients (linear, radial, mesh) to a temporary PNG
    if trimmed.contains("-gradient(") {
        if let Some(grad_path) = generate_background_plate_png(trimmed, 1920, 1080) {
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
                    return rasterize_svg_bytes_to_png(&bytes, 1920, 1080);
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
                if let Some(png_path) = rasterize_svg_bytes_to_png(&bytes, 1920, 1080) {
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
                        if let Some(png_path) = rasterize_svg_bytes_to_png(&bytes, 1920, 1080) {
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
                    if let Some(png_path) = rasterize_svg_bytes_to_png(&bytes, 1920, 1080) {
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
                    if let Some(png_path) = rasterize_svg_bytes_to_png(&bytes, 1920, 1080) {
                        return Some(png_path);
                    }
                }
            }
            return Some(candidate);
        }
    }

    None
}

fn compact_num(val: f64) -> String {
    if val.fract().abs() < 1e-6 {
        format!("{:.0}", val)
    } else {
        let s = format!("{:.3}", val);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn zoom_easing_expression(p: &str, easing: &str) -> String {
    match easing {
        "linear" => p.to_string(),
        "ease-in" => format!("{p}*{p}"),
        "ease-out" => format!("({p})*(2-({p}))"),
        "snappy" => format!("({p})*(3-({p})*(3-({p})))"),
        // Cubic smoothstep: t²(3-2t)
        "cinematic" => format!("({p})*({p})*(3-2*({p}))"),
        // Quintic smootherstep: 6t⁵ - 15t⁴ + 10t³ — matches preview's
        // zoomEasedProgress which uses 0-velocity + 0-acceleration endpoints.
        "smooth" => format!("({p})*({p})*({p})*(({p})*(({p})*6-15)+10)"),
        "spring" => format!("min(1,max(0,pow(2,-10*({p}))*sin((({p})-0.1)*15.708)+1))"),
        _ => format!("if(lte({p},0.5),2*({p})*({p}),1-pow(-2*({p})+2,2)/2)"),
    }
}

/// Derive the effective scale from the crop rectangle used by every renderer.
/// The persisted segment scale is a convenient editor value, but the crop is
/// the authoritative geometry at export time.
fn effective_zoom_scale(canvas_width: f64, crop: &RenderCropFloat) -> f64 {
    if !canvas_width.is_finite() || canvas_width <= 0.0 {
        return 1.0;
    }
    (canvas_width / crop.width.max(1.0)).clamp(1.0, 8.0)
}

/// Clamp a zoom segment target to full canvas coordinates [0..canvas_width] x [0..canvas_height].
/// This mirrors the TypeScript `clampZoomTarget` and `resolveZoomTransform`
/// behavior used by the preview so exports produce identical framing.
pub(crate) fn clamped_zoom_target(
    canvas_width: u32,
    canvas_height: u32,
    canvas_padding: u32,
    segment: &RenderPlanZoomSegment,
) -> RenderCropFloat {
    clamped_zoom_crop(
        canvas_width,
        canvas_height,
        canvas_padding,
        &segment.target,
        segment.scale,
    )
}

pub(crate) fn clamped_zoom_crop(
    canvas_width: u32,
    canvas_height: u32,
    _canvas_padding: u32,
    target: &RenderCropFloat,
    scale: f64,
) -> RenderCropFloat {
    let canvas_w = canvas_width as f64;
    let canvas_h = canvas_height as f64;
    let safe_scale = if scale.is_finite() {
        scale.clamp(1.0, 8.0)
    } else {
        1.0
    };

    let clamped_target_width = if target.width.is_finite() {
        target.width.clamp(1.0, canvas_w)
    } else {
        canvas_w
    };
    let minimum_crop_width = (canvas_w / 8.0).max(1.0);
    let target_width = clamped_target_width.max(minimum_crop_width);

    // Zoompan is an aspect-preserving transform. A stale/manual target height
    // must not make the cursor and video use different vertical crops.
    let (final_width, final_height) = if (target_width - canvas_w).abs() < 1.0 && safe_scale > 1.01
    {
        (
            (canvas_w / safe_scale).max(1.0),
            (canvas_h / safe_scale).max(1.0),
        )
    } else {
        (
            target_width,
            (target_width * canvas_h / canvas_w).clamp(1.0, canvas_h),
        )
    };

    // Match the TypeScript clamp-then-canonicalize order. Centering from the
    // raw out-of-bounds rectangle would make preview and export disagree on
    // legacy targets dragged past an edge.
    let clamped_target_x = if target.x.is_finite() {
        target
            .x
            .clamp(0.0, (canvas_w - clamped_target_width).max(0.0))
    } else {
        0.0
    };
    let requested_height = if target.height.is_finite() {
        target.height.clamp(1.0, canvas_h)
    } else {
        canvas_h
    };
    let clamped_target_y = if target.y.is_finite() {
        target.y.clamp(0.0, (canvas_h - requested_height).max(0.0))
    } else {
        0.0
    };
    let target_cx = clamped_target_x + clamped_target_width / 2.0;
    let target_cy = clamped_target_y + requested_height / 2.0;

    let final_x = (target_cx - final_width / 2.0).clamp(0.0, (canvas_w - final_width).max(0.0));
    let final_y = (target_cy - final_height / 2.0).clamp(0.0, (canvas_h - final_height).max(0.0));

    RenderCropFloat {
        x: final_x,
        y: final_y,
        width: final_width,
        height: final_height,
    }
}

fn build_balanced_linear_expression(
    points: &[(f64, f64)],
    start_index: usize,
    end_index: usize,
    fallback: &str,
) -> String {
    let interval_count = end_index.saturating_sub(start_index);
    if interval_count == 0 {
        return fallback.to_string();
    }

    if interval_count == 1 {
        let (t0_s, val0) = points[start_index];
        let (t1_s, val1) = points[end_index];
        if t1_s <= t0_s {
            return fallback.to_string();
        }

        let span_s = t1_s - t0_s;
        let delta = val1 - val0;
        let t0_str = compact_num(t0_s);
        let t1_str = compact_num(t1_s);
        let val0_str = compact_num(val0);
        let delta_str = compact_num(delta);
        let span_str = compact_num(span_s);

        let interp = if delta.abs() < 1e-4 {
            val0_str
        } else if val0.abs() < 1e-6 {
            format!("{delta_str}*(it-{t0_str})/{span_str}")
        } else if delta > 0.0 {
            format!("{val0_str}+{delta_str}*(it-{t0_str})/{span_str}")
        } else {
            format!("{val0_str}{delta_str}*(it-{t0_str})/{span_str}")
        };

        return format!("if(gte(it,{t0_str})*lt(it,{t1_str}),{interp},{fallback})");
    }

    let split_index = start_index + interval_count / 2;
    let left = build_balanced_linear_expression(points, start_index, split_index, fallback);
    let right = build_balanced_linear_expression(points, split_index, end_index, fallback);
    let split_time = compact_num(points[split_index].0);
    format!("if(lt(it,{split_time}),{left},{right})")
}

fn build_keyframe_center_expression(
    keyframes: &[RenderPlanZoomKeyframe],
    canvas: &cursor::RenderCanvas,
    dimension: f64,
    axis: &str,
    scale: f64,
    fallback: &str,
) -> String {
    let canvas_dim = if axis == "x" {
        canvas.width as f64
    } else {
        canvas.height as f64
    };
    if keyframes.is_empty() || canvas_dim <= 0.0 {
        return fallback.to_string();
    }

    let mut points: Vec<(f64, f64)> = Vec::with_capacity(keyframes.len());
    for keyframe in keyframes {
        let time_s = keyframe.time_ms as f64 / 1000.0;
        let target = clamped_zoom_crop(
            canvas.width,
            canvas.height,
            canvas.padding,
            &keyframe.target,
            scale,
        );
        let value = if axis == "x" {
            (((target.x + target.width / 2.0) / canvas_dim) * dimension).clamp(0.0, dimension)
        } else {
            (((target.y + target.height / 2.0) / canvas_dim) * dimension).clamp(0.0, dimension)
        };
        if let Some(last) = points.last_mut() {
            if (last.0 - time_s).abs() < 1e-4 {
                last.1 = value;
                continue;
            }
        }
        points.push((time_s, value));
    }

    if points.len() <= 1 {
        return fallback.to_string();
    }

    let mut simplified: Vec<(f64, f64)> = Vec::with_capacity(points.len());
    for (time_s, value) in points {
        if simplified.len() >= 2 {
            let p0 = simplified[simplified.len() - 2];
            let p1 = simplified[simplified.len() - 1];
            if (p1.1 - p0.1).abs() < 1.0 && (value - p1.1).abs() < 1.0 {
                simplified.pop();
                simplified.push((time_s, p1.1));
                continue;
            }
        }
        simplified.push((time_s, value));
    }

    build_balanced_linear_expression(&simplified, 0, simplified.len() - 1, fallback)
}

fn motion_point_axis_value(point: &RenderPlanZoomMotionPoint, axis: &str) -> f64 {
    if axis == "x" {
        point.x
    } else {
        point.y
    }
}

fn build_motion_cubic_expression(
    segment: &RenderPlanZoomMotionSegment,
    canvas: &cursor::RenderCanvas,
    dimension: f64,
    axis: &str,
) -> String {
    let canvas_dim = if axis == "x" {
        canvas.width as f64
    } else {
        canvas.height as f64
    };
    let start_s = segment.start_ms as f64 / 1000.0;
    let end_s = segment.end_ms as f64 / 1000.0;
    let span_s = end_s - start_s;
    if canvas_dim <= 0.0 || dimension <= 0.0 || span_s <= 0.0 {
        return "0".to_string();
    }

    let to_render_value = |point: &RenderPlanZoomMotionPoint| {
        (motion_point_axis_value(point, axis) / canvas_dim * dimension).clamp(0.0, dimension)
    };
    let p0 = to_render_value(&segment.start);
    let p1 = to_render_value(&segment.control1);
    let p2 = to_render_value(&segment.control2);
    let p3 = to_render_value(&segment.end);
    let coefficient_a = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
    let coefficient_b = 3.0 * p0 - 6.0 * p1 + 3.0 * p2;
    let coefficient_c = -3.0 * p0 + 3.0 * p1;
    let coefficient_d = p0;
    let start_str = compact_num(start_s);
    let span_str = compact_num(span_s);
    let u = format!("((it-{start_str})/{span_str})");
    let polynomial = format!(
        "(({a}*{u}+{b})*{u}+{c})*{u}+{d}",
        a = compact_num(coefficient_a),
        b = compact_num(coefficient_b),
        c = compact_num(coefficient_c),
        d = compact_num(coefficient_d),
    );
    format!("max(0,min({},{}))", compact_num(dimension), polynomial)
}

fn build_balanced_motion_expression(
    segments: &[RenderPlanZoomMotionSegment],
    canvas: &cursor::RenderCanvas,
    dimension: f64,
    axis: &str,
    start_index: usize,
    end_index: usize,
    fallback: &str,
) -> String {
    let segment_count = end_index.saturating_sub(start_index);
    if segment_count == 0 {
        return fallback.to_string();
    }

    if segment_count == 1 {
        let segment = &segments[start_index];
        let start_s = compact_num(segment.start_ms as f64 / 1000.0);
        let end_s = compact_num(segment.end_ms as f64 / 1000.0);
        let curve = build_motion_cubic_expression(segment, canvas, dimension, axis);
        return format!("if(gte(it,{start_s})*lt(it,{end_s}),{curve},{fallback})");
    }

    let split_index = start_index + segment_count / 2;
    let left = build_balanced_motion_expression(
        segments,
        canvas,
        dimension,
        axis,
        start_index,
        split_index,
        fallback,
    );
    let right = build_balanced_motion_expression(
        segments,
        canvas,
        dimension,
        axis,
        split_index,
        end_index,
        fallback,
    );
    let split_time = compact_num(segments[split_index].start_ms as f64 / 1000.0);
    format!("if(lt(it,{split_time}),{left},{right})")
}

fn build_motion_plan_center_expression(
    motion_plan: &RenderPlanZoomMotionPlan,
    canvas: &cursor::RenderCanvas,
    dimension: f64,
    axis: &str,
    fallback: &str,
) -> String {
    if motion_plan.version != cursor_engine::CUBIC_BEZIER_MOTION_PLAN_VERSION
        || motion_plan.kind != cursor_engine::CUBIC_BEZIER_MOTION_PLAN_KIND
        || motion_plan.segments.is_empty()
    {
        return fallback.to_string();
    }

    build_balanced_motion_expression(
        &motion_plan.segments,
        canvas,
        dimension,
        axis,
        0,
        motion_plan.segments.len(),
        fallback,
    )
}

fn build_zoompan_expressions(
    plan: &RenderPlan,
    canvas: &cursor::RenderCanvas,
    screen_w: f64,
    screen_h: f64,
) -> (String, String, String) {
    let mut z_expr = "1.0".to_string();
    let full_cx = screen_w / 2.0;
    let full_cy = screen_h / 2.0;
    let mut cx_expr = compact_num(full_cx);
    let mut cy_expr = compact_num(full_cy);
    let canvas_w = canvas.width as f64;
    let canvas_h = canvas.height as f64;

    let mut zoom_segments = plan
        .zoom_segments
        .iter()
        .filter(|segment| segment.enabled)
        .collect::<Vec<_>>();
    // Build the expression in ascending order so a later overlapping segment
    // is the outer condition, matching preview and cursor export.
    zoom_segments.sort_by(|left, right| {
        left.start_ms
            .cmp(&right.start_ms)
            .then_with(|| left.id.cmp(&right.id))
    });

    for segment in zoom_segments {
        if segment.end_ms <= segment.start_ms {
            continue;
        }
        let duration_s = (segment.end_ms - segment.start_ms) as f64 / 1000.0;
        let mut trans_in_s = (segment.transition_in_ms as f64 / 1000.0).clamp(0.0, duration_s);
        let mut trans_out_s = (segment.transition_out_ms as f64 / 1000.0).clamp(0.0, duration_s);
        if trans_in_s + trans_out_s > duration_s {
            trans_in_s = duration_s / 2.0;
            trans_out_s = duration_s - trans_in_s;
        }
        let start_s = segment.start_ms as f64 / 1000.0;
        let end_s = segment.end_ms as f64 / 1000.0;
        let in_end_s = start_s + trans_in_s;
        let out_start_s = end_s - trans_out_s;

        let target = clamped_zoom_target(canvas.width, canvas.height, canvas.padding, segment);
        // The crop rectangle is the authoritative geometry. Deriving scale
        // from it keeps FFmpeg's video zoom and the cursor rasterizer aligned
        // even when a legacy/manual plan contains stale `scale` metadata.
        let target_scale = effective_zoom_scale(canvas.width as f64, &target);

        let target_cx =
            (((target.x + target.width / 2.0) / canvas_w) * screen_w).clamp(0.0, screen_w);
        let target_cy =
            (((target.y + target.height / 2.0) / canvas_h) * screen_h).clamp(0.0, screen_h);

        let from_target = segment.from_target.as_ref().map(|from_raw| {
            clamped_zoom_crop(
                canvas.width,
                canvas.height,
                canvas.padding,
                from_raw,
                segment.from_scale.unwrap_or(1.0),
            )
        });
        let (from_cx, from_cy) = if let Some(from) = from_target.as_ref() {
            let cx = (((from.x + from.width / 2.0) / canvas_w) * screen_w).clamp(0.0, screen_w);
            let cy = (((from.y + from.height / 2.0) / canvas_h) * screen_h).clamp(0.0, screen_h);
            (cx, cy)
        } else {
            (full_cx, full_cy)
        };

        let start_str = compact_num(start_s);
        let end_str = compact_num(end_s);
        let in_end_str = compact_num(in_end_s);
        let out_start_str = compact_num(out_start_s);
        let trans_in_str = compact_num(trans_in_s);
        let trans_out_str = compact_num(trans_out_s);

        let target_scale_str = compact_num(target_scale);
        let target_cx_str = compact_num(target_cx);
        let target_cy_str = compact_num(target_cy);
        let from_cx_str = compact_num(from_cx);
        let from_cy_str = compact_num(from_cy);
        let full_cx_str = compact_num(full_cx);
        let full_cy_str = compact_num(full_cy);
        let has_motion_plan = segment
            .motion_plan
            .as_ref()
            .is_some_and(|motion_plan| !motion_plan.segments.is_empty());
        let has_keyframes = !has_motion_plan
            && segment
                .keyframes
                .as_ref()
                .is_some_and(|keyframes| keyframes.len() > 1);
        let has_dynamic_center = has_motion_plan || has_keyframes;
        let target_cx_expression = if has_motion_plan {
            segment.motion_plan.as_ref().map_or_else(
                || target_cx_str.clone(),
                |motion_plan| {
                    build_motion_plan_center_expression(
                        motion_plan,
                        canvas,
                        screen_w,
                        "x",
                        &target_cx_str,
                    )
                },
            )
        } else if has_keyframes {
            build_keyframe_center_expression(
                segment.keyframes.as_deref().unwrap_or_default(),
                canvas,
                screen_w,
                "x",
                target_scale,
                &target_cx_str,
            )
        } else {
            target_cx_str.clone()
        };
        let target_cy_expression = if has_motion_plan {
            segment.motion_plan.as_ref().map_or_else(
                || target_cy_str.clone(),
                |motion_plan| {
                    build_motion_plan_center_expression(
                        motion_plan,
                        canvas,
                        screen_h,
                        "y",
                        &target_cy_str,
                    )
                },
            )
        } else if has_keyframes {
            build_keyframe_center_expression(
                segment.keyframes.as_deref().unwrap_or_default(),
                canvas,
                screen_h,
                "y",
                target_scale,
                &target_cy_str,
            )
        } else {
            target_cy_str.clone()
        };

        let progress_in = if trans_in_s < 1e-4 {
            "1.0".to_string()
        } else if start_s.abs() < 1e-6 {
            format!("it/{trans_in_str}")
        } else {
            format!("(it-{start_str})/{trans_in_str}")
        };
        let eased_in = zoom_easing_expression(&progress_in, &segment.easing);

        let progress_out = if trans_out_s < 1e-4 {
            "1.0".to_string()
        } else {
            format!("({end_str}-it)/{trans_out_str}")
        };
        let eased_out = zoom_easing_expression(&progress_out, &segment.easing);

        // Interpolate crop width, then derive zoom from that width. Interpolating
        // scale directly is not equivalent to the preview's crop interpolation
        // and causes cursor drift throughout every transition (especially with
        // spring easing).
        let canvas_width_str = compact_num(canvas_w);
        let from_width = from_target.as_ref().map_or(canvas_w, |from| from.width);
        let from_width_str = compact_num(from_width);
        let delta_width_in_value = target.width - from_width;
        let delta_width_in = compact_num(delta_width_in_value);
        let crop_width_in = if delta_width_in_value.abs() < 1e-4 {
            from_width_str.clone()
        } else {
            format!("{from_width_str}+{delta_width_in}*{eased_in}")
        };
        let z_in = format!("{canvas_width_str}/max(1,({crop_width_in}))");

        let delta_width_out_value = target.width - canvas_w;
        let delta_width_out = compact_num(delta_width_out_value);
        let crop_width_out = if delta_width_out_value.abs() < 1e-4 {
            canvas_width_str.clone()
        } else {
            format!("{canvas_width_str}+{delta_width_out}*{eased_out}")
        };
        let z_out = format!("{canvas_width_str}/max(1,({crop_width_out}))");

        let z_seg = if trans_in_s < 1e-4 && trans_out_s < 1e-4 {
            target_scale_str.clone()
        } else if trans_in_s < 1e-4 {
            format!("if(lte(it,{out_start_str}),{target_scale_str},{z_out})")
        } else if trans_out_s < 1e-4 {
            format!("if(lt(it,{in_end_str}),{z_in},{target_scale_str})")
        } else {
            format!("if(lt(it,{in_end_str}),{z_in},if(lte(it,{out_start_str}),{target_scale_str},{z_out}))")
        };

        // Center X
        let delta_cx_in = target_cx - from_cx;
        let delta_cx_in_str = compact_num(delta_cx_in);
        let cx_in = if has_dynamic_center {
            format!("{from_cx_str}+(({target_cx_expression})-({from_cx_str}))*{eased_in}")
        } else if delta_cx_in.abs() < 1e-4 {
            target_cx_str.clone()
        } else if delta_cx_in > 0.0 {
            format!("{from_cx_str}+{delta_cx_in_str}*{eased_in}")
        } else {
            format!("{from_cx_str}{delta_cx_in_str}*{eased_in}")
        };

        let delta_cx_out = target_cx - full_cx;
        let delta_cx_out_str = compact_num(delta_cx_out);
        let cx_out = if has_dynamic_center {
            format!("{full_cx_str}+(({target_cx_expression})-({full_cx_str}))*{eased_out}")
        } else if delta_cx_out.abs() < 1e-4 {
            full_cx_str.clone()
        } else if delta_cx_out > 0.0 {
            format!("{full_cx_str}+{delta_cx_out_str}*{eased_out}")
        } else {
            format!("{full_cx_str}{delta_cx_out_str}*{eased_out}")
        };

        let cx_hold = target_cx_expression;

        let cx_seg = if trans_in_s < 1e-4 && trans_out_s < 1e-4 {
            cx_hold
        } else if trans_in_s < 1e-4 {
            format!("if(lte(it,{out_start_str}),{cx_hold},{cx_out})")
        } else if trans_out_s < 1e-4 {
            format!("if(lt(it,{in_end_str}),{cx_in},{cx_hold})")
        } else {
            format!(
                "if(lt(it,{in_end_str}),{cx_in},if(lte(it,{out_start_str}),{cx_hold},{cx_out}))"
            )
        };

        // Center Y
        let delta_cy_in = target_cy - from_cy;
        let delta_cy_in_str = compact_num(delta_cy_in);
        let cy_in = if has_dynamic_center {
            format!("{from_cy_str}+(({target_cy_expression})-({from_cy_str}))*{eased_in}")
        } else if delta_cy_in.abs() < 1e-4 {
            target_cy_str.clone()
        } else if delta_cy_in > 0.0 {
            format!("{from_cy_str}+{delta_cy_in_str}*{eased_in}")
        } else {
            format!("{from_cy_str}{delta_cy_in_str}*{eased_in}")
        };

        let delta_cy_out = target_cy - full_cy;
        let delta_cy_out_str = compact_num(delta_cy_out);
        let cy_out = if has_dynamic_center {
            format!("{full_cy_str}+(({target_cy_expression})-({full_cy_str}))*{eased_out}")
        } else if delta_cy_out.abs() < 1e-4 {
            full_cy_str.clone()
        } else if delta_cy_out > 0.0 {
            format!("{full_cy_str}+{delta_cy_out_str}*{eased_out}")
        } else {
            format!("{full_cy_str}{delta_cy_out_str}*{eased_out}")
        };

        let cy_hold = target_cy_expression;

        let cy_seg = if trans_in_s < 1e-4 && trans_out_s < 1e-4 {
            cy_hold
        } else if trans_in_s < 1e-4 {
            format!("if(lte(it,{out_start_str}),{cy_hold},{cy_out})")
        } else if trans_out_s < 1e-4 {
            format!("if(lt(it,{in_end_str}),{cy_in},{cy_hold})")
        } else {
            format!(
                "if(lt(it,{in_end_str}),{cy_in},if(lte(it,{out_start_str}),{cy_hold},{cy_out}))"
            )
        };

        let cond = if start_s.abs() < 1e-6 {
            format!("lt(it,{end_str})")
        } else {
            format!("gte(it,{start_str})*lt(it,{end_str})")
        };

        z_expr = format!("if({cond},{z_seg},{z_expr})");
        cx_expr = format!("if({cond},{cx_seg},{cx_expr})");
        cy_expr = format!("if({cond},{cy_seg},{cy_expr})");
    }

    let x_expr = format!("if(lte(zoom,1.001),0,max(0,min(iw-iw/zoom,({cx_expr})-(iw/zoom)/2)))");
    let y_expr = format!("if(lte(zoom,1.001),0,max(0,min(ih-ih/zoom,({cy_expr})-(ih/zoom)/2)))");

    (z_expr, x_expr, y_expr)
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
    ffprobe_path: Option<&Path>,
    asset_path: &Path,
    asset_id: &str,
    input_index: usize,
    stream_index: Option<i32>,
) -> Result<String> {
    let Some(ffprobe) = ffprobe_path else {
        return Ok(stream_index.map_or_else(
            || format!("[{input_index}:v:0]"),
            |index| format!("[{input_index}:{index}]"),
        ));
    };
    let metadata =
        crate::media::probe::probe_media(&ffprobe.to_string_lossy(), asset_path, asset_id)
            .map_err(|_| {
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
    ffprobe_path: Option<&Path>,
    asset_path: &Path,
    asset_id: &str,
    input_index: usize,
    stream_index: Option<i32>,
) -> Result<Option<String>> {
    let Some(ffprobe) = ffprobe_path else {
        return Ok(Some(stream_index.map_or_else(
            || format!("[{input_index}:a:0]"),
            |index| format!("[{input_index}:{index}]"),
        )));
    };
    let metadata =
        crate::media::probe::probe_media(&ffprobe.to_string_lossy(), asset_path, asset_id)
            .map_err(|_| {
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
        let frame_plan = prepare_cursor_frame_plan(&canvas, 5000, Vec::new(), &plan, &asset_paths)
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
        let frame_plan = prepare_cursor_frame_plan(&canvas, 5000, Vec::new(), &plan, &asset_paths)
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
        let canvas_16_9 = cursor::RenderCanvas {
            width: 1920,
            height: 1080,
            padding: 0,
            ..Default::default()
        };
        let rect = video_screen_rect(&canvas_16_9, Some((1920, 1080)), false);
        assert_eq!(rect, (0.0, 0.0, 1920.0, 1080.0));

        // 9:16 vertical canvas (1080x1920) with 16:9 source (1920x1080) and 0 padding
        let canvas_9_16 = cursor::RenderCanvas {
            width: 1080,
            height: 1920,
            padding: 0,
            ..Default::default()
        };
        let rect_9_16 = video_screen_rect(&canvas_9_16, Some((1920, 1080)), false);
        // Source 1920x1080 fit into 1080x1920: scale = 1080/1920 = 0.5625 -> 1080 x 607, centered at y = (1920 - 607)/2 = 656
        assert_eq!(rect_9_16.0, 0.0);
        assert_eq!(rect_9_16.2, 1080.0);
        assert_eq!(rect_9_16.3, 607.0);
        assert_eq!(rect_9_16.1, 656.0);

        // 1:1 square canvas (1080x1080) with 16:9 source (1920x1080) and 40px padding
        let canvas_1_1 = cursor::RenderCanvas {
            width: 1080,
            height: 1080,
            padding: 40,
            ..Default::default()
        };
        let rect_1_1 = video_screen_rect(&canvas_1_1, Some((1920, 1080)), false);
        // Content area: 1000 x 1000. Source fit: 1000 x 562. Centered: x=40, y = 40 + (1000 - 562)/2 = 259
        assert_eq!(rect_1_1.0, 40.0);
        assert_eq!(rect_1_1.2, 1000.0);
        assert_eq!(rect_1_1.3, 562.0);
        assert_eq!(rect_1_1.1, 259.0);

        // 16:9 canvas (1920x1080) with 16:9 source in side-by-side mode (76% screen width)
        let rect_sbs = video_screen_rect(&canvas_16_9, Some((1920, 1080)), true);
        assert_eq!(rect_sbs.0, 0.0);
        assert_eq!(rect_sbs.2, 1459.0);
        assert_eq!(rect_sbs.3, 820.0);
        assert_eq!(rect_sbs.1, 130.0);
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

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-gif-{}", uuid::Uuid::new_v4()));
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

        let validation = validate_export_output(&ffprobe, &out_path, &plan, &settings);
        assert!(validation.is_ok(), "validate gif failed: {:?}", validation.err());
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
        let frame_plan = prepare_cursor_frame_plan(&canvas, 1000, Vec::new(), &plan, &asset_paths)
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
}
