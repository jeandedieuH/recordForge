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
use tracing::{info, instrument, warn};

mod captions;
mod cursor;

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
    pub masks: Vec<RenderPlanMask>,
    #[serde(default)]
    pub zoom_segments: Vec<RenderPlanZoomSegment>,
    #[serde(default)]
    pub cursor_effects: Vec<RenderPlanCursorEffect>,
    #[serde(default)]
    pub canvas: Option<cursor::RenderCanvas>,
    #[serde(default)]
    pub audio: Option<RenderPlanAudio>,
    // `Some(empty)` means the current editor intentionally has no audio tracks.
    #[serde(default)]
    pub audio_tracks: Option<Vec<RenderPlanAudio>>,
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
    "static".into()
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
    #[serde(default = "default_export_container")]
    pub container: String,
    #[serde(default = "default_caption_mode")]
    pub caption_mode: String,
    #[serde(default)]
    pub range: Option<ExportRange>,
}

fn default_export_preset() -> String {
    "default-mp4".into()
}

fn default_export_codec() -> String {
    "h264".into()
}

fn default_export_container() -> String {
    "mp4".into()
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
    settings
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
    if asset_paths
        .values()
        .any(|asset_path| asset_path == output_path)
    {
        return Err(InternalError::Permissions(
            "export destination cannot overwrite a project asset".into(),
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

    update_progress(
        &db,
        app,
        job_id,
        0.15,
        "rendering",
        Some("compositing timeline tracks"),
    )?;
    render_timeline_composition(
        &ffmpeg_path.to_string_lossy(),
        &partial_path,
        &plan,
        project_id,
        &asset_paths,
        &settings,
        cancel.clone(),
    )?;

    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        cleanup_export_files(output_path);
        return Err(InternalError::Media("export cancelled".into()).into());
    }

    update_progress(
        &db,
        app,
        job_id,
        0.72,
        "cursor",
        Some("rendering cursor effects"),
    )?;
    apply_cursor_overlay(
        &ffmpeg_path.to_string_lossy(),
        &partial_path,
        &plan,
        project_id,
        &asset_paths,
        cancel.clone(),
    )?;

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
    info!(project_id = %project_id, "timeline export rendered");
    Ok(())
}

/// Returns a source size shared by every screen segment, or `None` when the
/// segments are missing dimensions or have mixed source sizes.
fn common_screen_source(segments: &[RenderSegment]) -> Option<(u32, u32)> {
    let mut common: Option<(u32, u32)> = None;
    for segment in segments {
        let (width, height) = (segment.source_width?, segment.source_height?);
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
        let target_w = (content_width * 0.68).round().max(1.0);
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

/// Compose screen, manual zoom, camera overlays, canvas framing, and semantic
/// audio tracks in one FFmpeg graph. Keeping the graph here makes the export
/// path authoritative for every control exposed by the Phase 6 inspector.
fn render_timeline_composition(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    settings: &ExportSettings,
    cancel: Arc<std::sync::atomic::AtomicBool>,
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
    let input_assets = collect_input_assets(plan, asset_paths)?;
    let input_indices = input_assets
        .iter()
        .enumerate()
        .map(|(index, (asset_id, _))| (asset_id.clone(), index))
        .collect::<HashMap<_, _>>();
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
        let usable_w = (canvas.width as f64 - (canvas.padding as f64) * 2.0).max(1.0);
        let target_camera_x =
            (canvas.padding as f64) + (usable_w * 0.68).round() + (usable_w * 0.02).round();
        (overlay.x - target_camera_x).abs() <= 2.0
    });
    let (screen_x, screen_y, screen_w, screen_h) = video_screen_rect(
        canvas,
        common_screen_source(&plan.segments),
        is_side_by_side,
    );
    let (segment_w, segment_h) = if is_side_by_side {
        (
            (content_width as f64 * 0.68).round().max(1.0) as u32,
            ((content_width as f64 * 0.68 / canvas.width as f64) * canvas.height as f64)
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
            filters.push(format!(
                "color=c={background}:s={segment_w}x{segment_h}:r={}:d={}[{gap_label}]",
                canvas.fps,
                seconds(segment.output_start_ms - cursor_ms),
            ));
            video_labels.push(format!("[{gap_label}]"));
        }
        validate_segment_known(segment, project_id, asset_paths)?;
        let input_index = *input_indices.get(&segment.asset_id).ok_or_else(|| {
            InternalError::Media("render plan references an unknown asset".into())
        })?;
        let input = input_stream_at(input_index, segment.stream_index, false)?;
        let label = format!("screen{index}");
        let mut filter = format!(
            "{input}trim=start={}:end={},setpts=PTS-STARTPTS",
            seconds(segment.source_in_ms),
            seconds(segment.source_out_ms),
        );
        if (segment.speed - 1.0).abs() > f64::EPSILON {
            filter.push_str(&format!(",setpts=PTS/{:.6}", segment.speed));
        }
        filter.push_str(&format!(
            ",scale={segment_w}:{segment_h}:force_original_aspect_ratio=decrease,pad={segment_w}:{segment_h}:(ow-iw)/2:(oh-ih)/2:color={background},fps={},setsar=1[{label}]",
            canvas.fps,
        ));
        filters.push(filter);
        video_labels.push(format!("[{label}]"));
        cursor_ms = segment.output_end_ms;
    }
    if cursor_ms < plan.duration_ms {
        let gap_label = "gap_trailing";
        filters.push(format!(
            "color=c={background}:s={segment_w}x{segment_h}:r={}:d={}[{gap_label}]",
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
    // Crop the fitted recorded video out of the padded content area, then pad
    // it to the full canvas so radius and shadow are applied to the actual
    // video layer rather than the padded content box.
    let mut canvas_filter = format!(
        "{video_input}tpad=stop_mode=clone:stop_duration={plan_duration},trim=duration={plan_duration},crop={screen_w:.0}:{screen_h:.0}:{crop_x:.0}:{crop_y:.0},pad={}:{}:{screen_x:.0}:{screen_y:.0}:color={background},setsar=1",
        canvas.width, canvas.height
    );
    if canvas.border_radius > 0 {
        let (red, green, blue) = hex_rgb(&background);
        let radius = (canvas.border_radius as f64)
            .min(screen_w / 2.0)
            .min(screen_h / 2.0);
        let left = screen_x + radius;
        let right = screen_x + screen_w - radius;
        let top = screen_y + radius;
        let bottom = screen_y + screen_h - radius;
        let mask = format!(
            "(((X<{left})*(Y<{top})*(hypot(X-{left},Y-{top})>{radius})+(X>{right})*(Y<{top})*(hypot(X-{right},Y-{top})>{radius})+(X<{left})*(Y>{bottom})*(hypot(X-{left},Y-{bottom})>{radius})+(X>{right})*(Y>{bottom})*(hypot(X-{right},Y-{bottom})>{radius}))>0)"
        );
        canvas_filter.push_str(&format!(
            ",format=rgb24,geq=r='if({mask},{red},r)':g='if({mask},{green},g)':b='if({mask},{blue},b)'"
        ));
    }
    if canvas.shadow {
        let shadow_color = safe_filter_color(canvas.shadow_color.as_deref().unwrap_or("#000000"));
        let shadow_blur = canvas.shadow_blur.unwrap_or(16.0).clamp(1.0, 64.0);
        canvas_filter.push_str(&format!(
            ",drawbox=x={}:y={}:w={}:h={}:color={shadow_color}@0.3:t={shadow_blur:.2}",
            (screen_x + canvas.shadow_offset_x.unwrap_or(0.0)).max(0.0),
            (screen_y + canvas.shadow_offset_y.unwrap_or(0.0)).max(0.0),
            screen_w,
            screen_h,
        ));
    }
    let base_label = "canvas_base";
    canvas_filter.push_str(&format!("[{base_label}]"));
    filters.push(canvas_filter);

    let composed_label = if plan.zoom_segments.iter().any(|segment| segment.enabled) {
        let width_expression = zoom_crop_expression(plan, canvas, "width");
        let height_expression = zoom_crop_expression(plan, canvas, "height");
        let x_expression = zoom_crop_expression(plan, canvas, "x");
        let y_expression = zoom_crop_expression(plan, canvas, "y");
        let label = "canvas_zoom";
        filters.push(format!(
            "[{base_label}]crop=w='{width_expression}':h='{height_expression}':x='{x_expression}':y='{y_expression}',scale={}:{}[{label}]",
            canvas.width, canvas.height
        ));
        label.to_string()
    } else {
        base_label.to_string()
    };

    let mut current_label = composed_label;
    for (index, overlay) in plan.overlays.iter().enumerate() {
        if !overlay.visible || overlay.output_end_ms <= overlay.output_start_ms {
            continue;
        }
        validate_overlay(overlay, project_id, asset_paths, canvas)?;
        let input_index = *input_indices.get(&overlay.asset_id).ok_or_else(|| {
            InternalError::Media("camera overlay references an unknown asset".into())
        })?;
        let input = input_stream_at(input_index, overlay.stream_index, false)?;
        let camera_label = format!("camera{index}");
        let camera_color = safe_filter_color(overlay.border_color.as_deref().unwrap_or("#ffffff"));
        if !overlay.speed.is_finite() || overlay.speed <= 0.0 {
            return Err(InternalError::Media("camera overlay speed is invalid".into()).into());
        }
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
        }
        camera_filter.push_str(&format!(
            ",scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba",
            overlay.width.max(1.0),
            overlay.height.max(1.0),
            overlay.width.max(1.0),
            overlay.height.max(1.0)
        ));
        if overlay.opacity < 1.0 {
            camera_filter.push_str(&format!(",colorchannelmixer=aa={:.4}", overlay.opacity));
        }
        if overlay.shape == "circle" {
            camera_filter.push_str(
                ",geq=r='r':g='g':b='b':a='if(lte((X-W/2)^2+(Y-H/2)^2,(min(W,H)/2)^2),255,0)'",
            );
        } else if overlay.shape == "rounded" {
            let radius = (overlay.width.min(overlay.height) * 0.12).max(4.0);
            let radius_squared = radius * radius;
            let alpha = format!(
                "if((X>={radius:.2})*(X<=W-{radius:.2})+(Y>={radius:.2})*(Y<=H-{radius:.2})+((X-{radius:.2})^2+(Y-{radius:.2})^2<={radius_squared:.2})+((X-W+{radius:.2})^2+(Y-{radius:.2})^2<={radius_squared:.2})+((X-{radius:.2})^2+(Y-H+{radius:.2})^2<={radius_squared:.2})+((X-W+{radius:.2})^2+(Y-H+{radius:.2})^2<={radius_squared:.2})>0,255,0)"
            );
            camera_filter.push_str(&format!(",geq=r='r':g='g':b='b':a='{alpha}'"));
        }
        if overlay.shadow_enabled.unwrap_or(false) {
            let shadow_color =
                safe_filter_color(overlay.shadow_color.as_deref().unwrap_or("#000000"));
            let shadow_blur = overlay.shadow_blur.unwrap_or(8.0).clamp(0.0, 64.0);
            let shadow_opacity = (0.35 - shadow_blur / 256.0).clamp(0.08, 0.35);
            camera_filter.push_str(&format!(
                ",drawbox=x={:.2}:y={:.2}:w=iw-1:h=ih-1:color={shadow_color}@{shadow_opacity:.4}:t={:.2}",
                overlay.shadow_offset_x.unwrap_or(0.0),
                overlay.shadow_offset_y.unwrap_or(4.0),
                shadow_blur.max(1.0)
            ));
        }
        if let Some(border_width) = overlay.border_width.filter(|value| *value > 0.0) {
            let border_opacity = overlay.border_opacity.unwrap_or(1.0).clamp(0.0, 1.0);
            camera_filter.push_str(&format!(
                ",drawbox=x=0:y=0:w=iw-1:h=ih-1:color={camera_color}@{border_opacity:.4}:t={border_width:.2}"
            ));
        }
        camera_filter.push_str(&format!("[{camera_label}]"));
        filters.push(camera_filter);

        let next_label = format!("composite{index}");
        let enable = format!(
            "between(t,{},{})",
            seconds(overlay.output_start_ms),
            seconds(overlay.output_end_ms)
        );
        filters.push(format!(
            "[{current_label}][{camera_label}]overlay=x={:.2}:y={:.2}:eof_action=pass:enable='{enable}'[{next_label}]",
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

    let audio_tracks = plan
        .audio_tracks
        .as_ref()
        .map(|tracks| tracks.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| plan.audio.iter().collect::<Vec<_>>());
    let duration_ms = plan.duration_ms.max(1);
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
            source_in_ms: 0,
            source_out_ms: duration_ms,
            output_start_ms: 0,
            output_end_ms: duration_ms,
            source_width: None,
            source_height: None,
        };
        let segments = if track.segments.is_empty() {
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
            let input = input_stream_at(
                input_index,
                segment.stream_index.or(track.stream_index),
                true,
            )?;
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
        filters.push(format!(
            "{}atrim=duration={}[aout]",
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

    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"]);
    for (_, asset_path) in &input_assets {
        command.arg("-i").arg(asset_path);
    }
    command
        .args(["-filter_complex", &filters.join(";")])
        .args(["-map", &format!("[{current_label}]")]);
    if audio_labels.is_empty() {
        command.arg("-an");
    } else {
        command.args(["-map", "[aout]"]);
    }
    append_video_encoding_args(&mut command, settings, canvas.fps);
    if !audio_labels.is_empty() {
        command.args(["-c:a", "aac", "-b:a", audio_bitrate(settings)]);
    }
    command
        .arg("-shortest")
        .args(["-movflags", "+faststart"])
        .arg(output_path);

    run_ffmpeg_command(&mut command, &cancel, output_path, "timeline composition")
}

#[allow(dead_code)]
fn render_timeline_with_audio(
    ffmpeg_path: &str,
    source_path: &Path,
    output_path: &Path,
    plan: &RenderPlan,
    recording_id: &str,
) -> Result<()> {
    if plan.segments.is_empty() {
        return Err(InternalError::Media("timeline has no video segments".into()).into());
    }

    let duration_ms = plan
        .segments
        .iter()
        .map(|segment| segment.output_end_ms)
        .max()
        .unwrap_or(plan.duration_ms)
        .max(1);
    let mut filters = Vec::new();
    let video_count = plan.segments.len();

    for (index, segment) in plan.segments.iter().enumerate() {
        validate_segment(segment, recording_id)?;
        let input = input_stream_at(0, segment.stream_index, false)?;
        let output_label = if video_count == 1 {
            "vout".to_string()
        } else {
            format!("v{index}")
        };
        filters.push(format!(
            "{input}trim=start={}:end={},setpts=PTS-STARTPTS[{output_label}]",
            seconds(segment.source_in_ms),
            seconds(segment.source_out_ms),
        ));
    }

    if video_count > 1 {
        let inputs = (0..video_count)
            .map(|index| format!("[v{index}]"))
            .collect::<Vec<_>>()
            .join("");
        filters.push(format!("{inputs}concat=n={video_count}:v=1:a=0[vout]"));
    }

    let audio_tracks = plan
        .audio_tracks
        .as_ref()
        .map(|tracks| tracks.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| plan.audio.iter().collect::<Vec<_>>());
    let mut audio_labels = Vec::new();
    let mut audio_segment_count = 0usize;

    for track in audio_tracks {
        if track.muted {
            continue;
        }
        validate_asset(&track.asset_id)?;
        let fallback_segment = RenderSegment {
            asset_id: track.asset_id.clone(),
            stream_index: track.stream_index,
            volume: Some(track.volume),
            fade_in_ms: None,
            fade_out_ms: None,
            speed: 1.0,
            source_in_ms: 0,
            source_out_ms: duration_ms,
            output_start_ms: 0,
            output_end_ms: duration_ms,
            source_width: None,
            source_height: None,
        };
        let segments = if track.segments.is_empty() {
            vec![fallback_segment]
        } else {
            track.segments.clone()
        };

        for segment in segments {
            validate_segment(&segment, recording_id)?;
            let volume = segment.volume.unwrap_or(track.volume);
            if !volume.is_finite() || !(0.0..=2.0).contains(&volume) {
                return Err(InternalError::Media(
                    "audio volume is outside the supported range".into(),
                )
                .into());
            }
            let input = input_stream_at(0, segment.stream_index.or(track.stream_index), true)?;
            let label = format!("a{audio_segment_count}");
            let mut filter = format!(
                "{input}atrim=start={}:end={},asetpts=PTS-STARTPTS,volume={volume:.4}",
                seconds(segment.source_in_ms),
                seconds(segment.source_out_ms),
            );
            if segment.output_start_ms > 0 {
                filter.push_str(&format!(",adelay={}:all=1", segment.output_start_ms));
            }
            filter.push_str(&format!(",apad=pad_dur={}[{label}]", seconds(duration_ms)));
            filters.push(filter);
            audio_labels.push(format!("[{label}]"));
            audio_segment_count += 1;
        }
    }

    if audio_labels.len() == 1 {
        filters.push(format!(
            "{}atrim=duration={}[aout]",
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

    let partial_path = partial_output_path(output_path);
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(source_path)
        .args(["-filter_complex", &filters.join(";")])
        .args(["-map", "[vout]"]);

    if audio_labels.is_empty() {
        command.arg("-an");
    } else {
        command.args(["-map", "[aout]"]);
    }

    command.args([
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    ]);
    if !audio_labels.is_empty() {
        command.args(["-c:a", "aac", "-b:a", "128k"]);
    }
    command
        .arg("-shortest")
        .args(["-movflags", "+faststart"])
        .arg(&partial_path);

    let output = command
        .output()
        .map_err(|error| InternalError::Media(format!("timeline render run: {error}")))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&partial_path);
        warn!("timeline render process failed; stderr is intentionally redacted");
        return Err(InternalError::Media("timeline render failed".into()).into());
    }

    crate::capture::disk::atomic_replace(&partial_path, output_path)?;
    Ok(())
}

fn apply_cursor_overlay(
    ffmpeg_path: &str,
    output_path: &Path,
    plan: &RenderPlan,
    project_id: &str,
    asset_paths: &HashMap<String, PathBuf>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) -> Result<()> {
    let canvas = match plan.canvas.as_ref() {
        Some(canvas) => canvas,
        None => return Ok(()),
    };
    // Capture removes the OS cursor before recording, so every export with
    // telemetry must render the configured replacement cursor.
    if canvas.width == 0
        || canvas.height == 0
        || canvas.fps == 0
        || canvas.width > 7_680
        || canvas.height > 4_320
        || canvas.fps > 240
    {
        return Err(
            InternalError::Media("cursor render canvas dimensions are unsupported".into()).into(),
        );
    }

    let effects = plan.cursor_effects.clone();

    let mut renderers = Vec::new();
    for effect in effects {
        if !effect.enabled || effect.end_ms <= effect.start_ms {
            continue;
        }
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
        let settings = cursor_settings_for_effect(&canvas.cursor_settings, &effect);
        let renderer = cursor::CursorRenderer::new_with_zoom(
            settings,
            telemetry,
            &plan.segments,
            &plan.zoom_segments,
            canvas,
        )
        .map_err(|error| InternalError::Media(format!("prepare cursor overlay: {error}")))?;
        renderers.push((effect.start_ms, effect.end_ms, renderer));
    }
    if renderers.is_empty() {
        tracing::warn!(%project_id, "cursor telemetry is unavailable; exporting without a cursor overlay");
        return Ok(());
    }
    let frame_size = (canvas.width as usize)
        .checked_mul(canvas.height as usize)
        .and_then(|size| size.checked_mul(4))
        .ok_or_else(|| InternalError::Media("cursor overlay frame is too large".into()))?;
    let frame_count = plan
        .duration_ms
        .saturating_mul(canvas.fps as u64)
        .saturating_add(999)
        .checked_div(1000)
        .unwrap_or(1)
        .max(1);
    let partial_path = cursor_partial_output_path(output_path);
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-y")
        .args(["-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(output_path)
        .args([
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{}x{}", canvas.width, canvas.height),
            "-r",
            &canvas.fps.to_string(),
            "-i",
            "-",
        ])
        .args([
            "-filter_complex",
            "[0:v][1:v]overlay=shortest=1:format=auto[vout]",
            "-map",
            "[vout]",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-shortest",
            "-movflags",
            "+faststart",
        ])
        .arg(&partial_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| InternalError::Media(format!("start cursor overlay render: {error}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| InternalError::Media("cursor overlay stdin unavailable".into()))?;
    let mut frame = vec![0; frame_size];
    // The overlay graph uses shortest=1, so FFmpeg stops reading stdin as soon
    // as the composed video ends. Feeding ceil(duration*fps) frames can exceed
    // that by one frame; a closed pipe here means the consumer finished, and
    // the exit-status check below decides whether the render actually failed.
    let mut consumer_finished_early = false;
    for frame_index in 0..frame_count {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&partial_path);
            return Err(InternalError::Media("export cancelled".into()).into());
        }
        let output_ms = frame_index.saturating_mul(1000) / canvas.fps as u64;
        frame.fill(0);
        if let Some((_, _, renderer)) = renderers
            .iter_mut()
            .find(|(start_ms, end_ms, _)| output_ms >= *start_ms && output_ms < *end_ms)
        {
            renderer.render_frame(output_ms, &mut frame);
        }
        if let Err(error) = stdin.write_all(&frame) {
            if is_pipe_closed(&error) {
                consumer_finished_early = true;
                break;
            }
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&partial_path);
            return Err(
                InternalError::Media(format!("write cursor overlay frame: {error}")).into(),
            );
        }
    }
    drop(stdin);

    let output = child.wait_with_output().map_err(|error| {
        InternalError::Media(format!("wait for cursor overlay render: {error}"))
    })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&partial_path);
        let detail =
            ffmpeg_failure_detail(&output.stderr).unwrap_or_else(|| "no diagnostic output".into());
        warn!(detail = %detail, "cursor overlay process failed");
        return Err(InternalError::Media(format!("cursor overlay render failed: {detail}")).into());
    }
    if consumer_finished_early {
        info!("cursor overlay consumer closed the frame pipe before the planned frame count");
    }

    crate::capture::disk::atomic_replace(&partial_path, output_path)?;
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

pub(crate) fn cursor_partial_output_path(output_path: &Path) -> PathBuf {
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
    if settings.container != "mp4" || !matches!(settings.codec.as_str(), "h264" | "hevc") {
        return Err(InternalError::Media("export codec or container is unsupported".into()).into());
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
    ) {
        return Err(InternalError::Media("export preset is unsupported".into()).into());
    }
    if settings.caption_mode != plan.caption_mode {
        return Err(InternalError::Media(
            "export caption settings do not match the render plan".into(),
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

fn append_video_encoding_args(command: &mut Command, settings: &ExportSettings, fps: u32) {
    let codec = if settings.codec == "hevc" {
        "libx265"
    } else {
        "libx264"
    };
    let (preset, crf) = match settings.preset.as_str() {
        "fast-share" => ("ultrafast", "23"),
        "high-quality" => ("slow", "18"),
        "smooth-60fps" => ("veryfast", "20"),
        "ultra-4k" => ("medium", "18"),
        "ultra-4k-60" => ("medium", "18"),
        "vertical" | "square" => ("veryfast", "20"),
        _ => ("veryfast", "20"),
    };
    let target_fps = match settings.preset.as_str() {
        "smooth-60fps" | "ultra-4k-60" => 60.max(fps),
        _ => fps,
    };
    command
        .arg("-c:v")
        .arg(codec)
        .arg("-preset")
        .arg(preset)
        .arg("-crf")
        .arg(crf)
        .arg("-r")
        .arg(target_fps.to_string())
        .args(["-pix_fmt", "yuv420p"]);
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
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(redact_paths)
        .last()
        .map(|line| line.chars().take(300).collect::<String>())
        .filter(|line| !line.is_empty())
}

fn run_ffmpeg_command(
    command: &mut Command,
    cancel: &std::sync::atomic::AtomicBool,
    partial_path: &Path,
    stage: &str,
) -> Result<()> {
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| InternalError::Media(format!("start {stage}: {error}")))?;
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(partial_path);
            return Err(InternalError::Media("export cancelled".into()).into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let _ = std::fs::remove_file(partial_path);
                let detail = child
                    .stderr
                    .take()
                    .and_then(|mut stderr| {
                        use std::io::Read;
                        let mut raw = Vec::new();
                        stderr.read_to_end(&mut raw).ok()?;
                        ffmpeg_failure_detail(&raw)
                    })
                    .unwrap_or_else(|| "no diagnostic output".into());
                warn!(stage, detail = %detail, "ffmpeg export process failed");
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
}

fn validate_export_output(
    ffprobe_path: &Path,
    path: &Path,
    plan: &RenderPlan,
    settings: &ExportSettings,
) -> Result<()> {
    let metadata =
        crate::media::probe::probe_media(&ffprobe_path.to_string_lossy(), path, &plan.project_id)?;
    let duration_delta = metadata.duration_ms.abs_diff(plan.duration_ms);
    if duration_delta > 150 {
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
    let expected_video_codec = if settings.codec == "hevc" {
        "hevc"
    } else {
        "h264"
    };
    if video.codec != expected_video_codec {
        return Err(InternalError::Media("export video codec failed validation".into()).into());
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

pub(crate) fn cleanup_export_files(output_path: &Path) {
    let partial = partial_output_path(output_path);
    let _ = std::fs::remove_file(&partial);
    let _ = std::fs::remove_file(cursor_partial_output_path(output_path));
    let _ = std::fs::remove_file(partial.with_extension("srt"));
    let _ = std::fs::remove_file(cursor_partial_output_path(&partial));
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
    match trimmed.to_ascii_lowercase().as_str() {
        "white" => "#ffffff".into(),
        "red" => "#ef4444".into(),
        "blue" => "#3b82f6".into(),
        "yellow" => "#facc15".into(),
        "transparent" => "#00000000".into(),
        _ => "#000000".into(),
    }
}

fn hex_rgb(value: &str) -> (u8, u8, u8) {
    let digits = value.strip_prefix('#').unwrap_or("");
    if digits.len() < 6 {
        return (0, 0, 0);
    }
    let red = u8::from_str_radix(&digits[0..2], 16).unwrap_or(0);
    let green = u8::from_str_radix(&digits[2..4], 16).unwrap_or(0);
    let blue = u8::from_str_radix(&digits[4..6], 16).unwrap_or(0);
    (red, green, blue)
}

fn zoom_easing_expression(progress: &str, easing: &str) -> String {
    match easing {
        "linear" => progress.to_string(),
        "ease-in" => format!("({progress})*({progress})"),
        "ease-out" => format!("1-(1-({progress}))*(1-({progress}))"),
        "snappy" => format!("1-pow(1-({progress}),3)"),
        "cinematic" => format!("({progress})*({progress})*(3-2*({progress}))"),
        "smooth" => format!("pow({progress},3)*(({progress})*(({progress})*6-15)+10)"),
        "spring" => format!("(pow(2,-10*({progress}))*sin((({progress})-0.1)*15.708)+1)"),
        _ => format!(
            "if(lte(({progress}),0.5),2*({progress})*({progress}),1-pow(-2*({progress})+2,2)/2)"
        ),
    }
}

/// Clamp a zoom segment target to the padded visible content area and apply its
/// additional scale, returning the final crop rectangle in full-canvas coordinates.
/// This mirrors the TypeScript `clampZoomTarget` and `resolveZoomTransform`
/// behavior used by the preview so exports produce the same framing.
pub(crate) fn clamped_zoom_target(
    canvas_width: u32,
    canvas_height: u32,
    canvas_padding: u32,
    segment: &RenderPlanZoomSegment,
) -> RenderCropFloat {
    let padding = canvas_padding as f64;
    let content_width = (canvas_width as f64 - padding * 2.0).max(1.0);
    let content_height = (canvas_height as f64 - padding * 2.0).max(1.0);
    let scale = segment.scale.clamp(1.0, 8.0);

    // Clamp the declared target to the padded safe area in full-canvas coordinates.
    let target_width = segment.target.width.max(1.0).min(content_width);
    let target_height = segment.target.height.max(1.0).min(content_height);
    let target_x = segment
        .target
        .x
        .clamp(padding, canvas_width as f64 - padding - target_width);
    let target_y = segment
        .target
        .y
        .clamp(padding, canvas_height as f64 - padding - target_height);

    // Apply the additional zoom scale, keeping the final crop centered within
    // the safe target and clamped back to the padded safe area.
    let final_width = (target_width / scale).max(1.0);
    let final_height = (target_height / scale).max(1.0);
    let final_x = (target_x + (target_width - final_width) / 2.0)
        .clamp(padding, canvas_width as f64 - padding - final_width);
    let final_y = (target_y + (target_height - final_height) / 2.0)
        .clamp(padding, canvas_height as f64 - padding - final_height);

    RenderCropFloat {
        x: final_x,
        y: final_y,
        width: final_width,
        height: final_height,
    }
}

fn zoom_crop_expression(plan: &RenderPlan, canvas: &cursor::RenderCanvas, axis: &str) -> String {
    let full = match axis {
        "width" => canvas.width as f64,
        "height" => canvas.height as f64,
        _ => 0.0,
    };
    let mut expression = format!("{full:.3}");
    for segment in plan
        .zoom_segments
        .iter()
        .rev()
        .filter(|segment| segment.enabled)
    {
        if segment.end_ms <= segment.start_ms {
            continue;
        }
        let duration_s = (segment.end_ms - segment.start_ms) as f64 / 1000.0;
        let mut trans_in_s = (segment.transition_in_ms as f64 / 1000.0).clamp(0.010, duration_s);
        let mut trans_out_s = (segment.transition_out_ms as f64 / 1000.0).clamp(0.010, duration_s);
        if trans_in_s + trans_out_s > duration_s {
            trans_in_s = duration_s / 2.0;
            trans_out_s = duration_s - trans_in_s;
        }
        let start_s = segment.start_ms as f64 / 1000.0;
        let end_s = segment.end_ms as f64 / 1000.0;
        let in_end_s = start_s + trans_in_s;
        let out_start_s = end_s - trans_out_s;

        let target = clamped_zoom_target(canvas.width, canvas.height, canvas.padding, segment);
        let target_value = match axis {
            "width" => target.width,
            "height" => target.height,
            "x" => target.x,
            "y" => target.y,
            _ => full,
        };

        let progress_in = format!("((t-{start_s:.3})/{trans_in_s:.3})");
        let eased_in = zoom_easing_expression(&progress_in, &segment.easing);
        let interpolated_in = if axis == "x" || axis == "y" {
            let center_full = if axis == "x" {
                canvas.width as f64 / 2.0
            } else {
                canvas.height as f64 / 2.0
            };
            let center_target = if axis == "x" {
                target.x + target.width / 2.0
            } else {
                target.y + target.height / 2.0
            };
            let dim_full = if axis == "x" {
                canvas.width as f64
            } else {
                canvas.height as f64
            };
            let dim_target = if axis == "x" {
                target.width
            } else {
                target.height
            };
            let center_eased = format!(
                "({center_full:.3})+(({center_target:.3})-({center_full:.3}))*({eased_in})"
            );
            let dim_eased =
                format!("({dim_full:.3})+(({dim_target:.3})-({dim_full:.3}))*({eased_in})");
            format!("({center_eased})-({dim_eased})/2")
        } else {
            format!("({full:.3})+(({target_value:.3})-({full:.3}))*({eased_in})")
        };

        let progress_out = format!("(({end_s:.3}-t)/{trans_out_s:.3})");
        let eased_out = zoom_easing_expression(&progress_out, &segment.easing);
        let interpolated_out = if axis == "x" || axis == "y" {
            let center_full = if axis == "x" {
                canvas.width as f64 / 2.0
            } else {
                canvas.height as f64 / 2.0
            };
            let center_target = if axis == "x" {
                target.x + target.width / 2.0
            } else {
                target.y + target.height / 2.0
            };
            let dim_full = if axis == "x" {
                canvas.width as f64
            } else {
                canvas.height as f64
            };
            let dim_target = if axis == "x" {
                target.width
            } else {
                target.height
            };
            let center_eased = format!(
                "({center_full:.3})+(({center_target:.3})-({center_full:.3}))*({eased_out})"
            );
            let dim_eased =
                format!("({dim_full:.3})+(({dim_target:.3})-({dim_full:.3}))*({eased_out})");
            format!("({center_eased})-({dim_eased})/2")
        } else {
            format!("({full:.3})+(({target_value:.3})-({full:.3}))*({eased_out})")
        };

        let val_hold = format!("{target_value:.3}");

        let segment_expr = format!(
            "if(lt(t,{in_end_s:.3}),{interpolated_in},if(lte(t,{out_start_s:.3}),{val_hold},{interpolated_out}))"
        );

        expression =
            format!("if(gte(t,{start_s:.3})*lt(t,{end_s:.3}),{segment_expr},{expression})");
    }
    expression
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

fn zoom_values_are_finite(segment: &RenderPlanZoomSegment) -> bool {
    [
        segment.start_ms as f64,
        segment.end_ms as f64,
        segment.target.x,
        segment.target.y,
        segment.target.width,
        segment.target.height,
        segment.scale,
    ]
    .iter()
    .all(|value| value.is_finite())
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

fn input_stream_at(input_index: usize, stream_index: Option<i32>, audio: bool) -> Result<String> {
    if let Some(index) = stream_index {
        if index < 0 {
            return Err(
                InternalError::Media("render plan has an invalid stream index".into()).into(),
            );
        }
        return Ok(format!("[{input_index}:{index}]"));
    }
    Ok(if audio {
        format!("[{input_index}:a:0]")
    } else {
        format!("[{input_index}:v:0]")
    })
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
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            canvas: Some(cursor::RenderCanvas {
                width: 1_920,
                height: 1_080,
                fps: 30,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: Some(Vec::new()),
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
    fn uses_shared_zoom_easing_names_and_exclusive_segment_end() {
        let progress = zoom_easing_expression("p", "cinematic");
        assert!(progress.contains("3-2*"));
        let crop = zoom_crop_expression(
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
                    scale: 1.0,
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
                }],
                ..valid_plan()
            },
            &cursor::RenderCanvas {
                width: 1_920,
                height: 1_080,
                fps: 30,
                ..Default::default()
            },
            "width",
        );
        assert!(crop.contains("lt(t,1.000)"));
    }

    #[test]
    fn clamps_zoom_crop_to_padded_content_area() {
        let crop = zoom_crop_expression(
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
                    scale: 1.0,
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
                }],
                ..valid_plan()
            },
            &cursor::RenderCanvas {
                width: 1_920,
                height: 1_080,
                fps: 30,
                padding: 48,
                ..Default::default()
            },
            "width",
        );
        // The content area for a 48px padded 1920x1080 canvas is 1824x984,
        // so the final crop width should be clamped to 1824, not 4000.
        assert!(crop.contains("1824.000"));
        assert!(!crop.contains("4000"));
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
    fn validates_60fps_and_4k_export_presets() {
        let plan = valid_plan();
        for preset in ["smooth-60fps", "ultra-4k", "ultra-4k-60"] {
            let settings = ExportSettings {
                preset: preset.into(),
                codec: "h264".into(),
                container: "mp4".into(),
                caption_mode: "burn-in".into(),
                range: None,
            };
            assert!(validate_export_settings(&settings, &plan).is_ok());
        }
        let settings_4k = ExportSettings {
            preset: "ultra-4k".into(),
            codec: "h264".into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            range: None,
        };
        assert_eq!(audio_bitrate(&settings_4k), "192k");
    }
}
