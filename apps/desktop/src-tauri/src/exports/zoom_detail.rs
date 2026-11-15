//! Zoom clarity analysis (M2 #3).
//!
//! The export decoders scale every source into the fitted content rect at
//! canvas resolution *before* anyone samples it, so a zoom crop magnifies an
//! already-downscaled plane. The fix is a **detail plane**: a second decode at
//! `D = content × min(m, r)` (`m` = zoom scale, `r` = source pixels per content
//! pixel) that the compositor samples for zoomed frames only.
//!
//! This module is the single place that decides, per pass window:
//! - whether a detail plane is worth its decode sidecar (`m > 1.02 && r > 1.02`),
//! - what size it is (even, never above the source),
//! - which frame ranges need it (identity frames keep the decoder→encoder bypass),
//! - how much sharpening the remaining upscale (`m > r`) needs.

use super::camera::{evaluate_zoom_transform, segment_is_loupe, zoom_transform_is_identity};
use super::cursor::RenderCanvas;
use super::RenderPlanZoomSegment;

/// Zoom scales at or below this are treated as "no magnification" — a 2%
/// zoom is not worth a second decode.
pub(crate) const DETAIL_MIN_SCALE: f64 = 1.02;
/// Same threshold for the source-to-content ratio.
pub(crate) const DETAIL_MIN_RATIO: f64 = 1.02;

/// A half-open run of output frames that need the detail plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameRun {
    pub start: u64,
    pub end: u64,
}

impl FrameRun {
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ZoomDetailPlan {
    /// Largest zoom scale (`canvas_width / crop_width`) in the window.
    pub max_scale: f64,
    /// Source pixels available per content pixel (`source_width / content_width`).
    pub resolution_ratio: f64,
    /// Detail plane size in pixels (even, ≤ source).
    pub width: u32,
    pub height: u32,
    /// `m > 1.02 && r > 1.02`: a second decode pays for itself.
    pub needed: bool,
    /// Frames whose crop is non-identity, i.e. the frames the detail decoder
    /// has to emit. Empty when `needed` is false.
    pub runs: Vec<FrameRun>,
    /// True when at least one needed frame sits inside an animated transition.
    /// The compatibility renderer samples those from the post-scale stream, so
    /// the export reports `zoom-detail`.
    pub has_transitions: bool,
    /// RCAS strength (0..1) for the remaining upscale past the source.
    pub sharpening: f64,
    /// `zoomSharpening` resolved from the canvas: `off` | `auto` | `strong`.
    pub sharpening_mode: String,
}

impl ZoomDetailPlan {
    pub fn is_active(&self) -> bool {
        self.needed && !self.runs.is_empty()
    }

    pub fn detail_frames(&self) -> u64 {
        self.runs.iter().map(FrameRun::len).sum()
    }
}

/// Frames covered by the plan's zoom segments, as half-open output-frame runs.
/// Loupe segments never move the frame and contribute nothing.
fn zoom_frame_runs(
    zoom_segments: &[RenderPlanZoomSegment],
    fps: u32,
    first_frame: u64,
    frame_count: u64,
) -> Vec<FrameRun> {
    let fps = fps.max(1) as f64;
    let window_end = first_frame.saturating_add(frame_count);
    let mut runs: Vec<FrameRun> = zoom_segments
        .iter()
        .filter(|segment| {
            segment.enabled && !segment_is_loupe(segment) && segment.end_ms > segment.start_ms
        })
        .filter_map(|segment| {
            let start = (segment.start_ms as f64 / 1000.0 * fps).round() as u64;
            let end = (segment.end_ms as f64 / 1000.0 * fps).round() as u64;
            let start = start.max(first_frame);
            let end = end.min(window_end);
            (end > start).then_some(FrameRun { start, end })
        })
        .collect();
    runs.sort_by_key(|run| run.start);

    // Merge overlapping/adjacent runs so the decoder emits each frame once.
    let mut merged: Vec<FrameRun> = Vec::with_capacity(runs.len());
    for run in runs {
        match merged.last_mut() {
            Some(last) if run.start <= last.end => last.end = last.end.max(run.end),
            _ => merged.push(run),
        }
    }
    merged
}

/// RCAS strength for a zoom that upscales past the source.
///
/// `m / r` is the remaining upscale factor; the first 1.35× is the gentle ramp
/// (half strength at ~1/3 of the range), and `strong` doubles the result.
/// `off` keeps the plain resample.
pub(crate) fn rcas_strength(scale: f64, ratio: f64, mode: &str) -> f64 {
    if mode == "off" {
        return 0.0;
    }
    if ratio <= 0.0 || scale <= ratio {
        return 0.0;
    }
    let excess = scale / ratio - 1.0;
    let base = (excess / 0.35).clamp(0.0, 1.0);
    let strength = if mode == "strong" {
        base.min(1.0) * 2.0
    } else {
        base
    };
    strength.clamp(0.0, 1.0)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn analyze_zoom_detail(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &RenderCanvas,
    content: (u32, u32),
    source: (u32, u32),
    first_frame: u64,
    frame_count: u64,
) -> ZoomDetailPlan {
    let mode = canvas
        .zoom_sharpening
        .clone()
        .unwrap_or_else(|| "auto".into());
    let empty = |ratio: f64| ZoomDetailPlan {
        max_scale: 1.0,
        resolution_ratio: ratio,
        width: 0,
        height: 0,
        needed: false,
        runs: Vec::new(),
        has_transitions: false,
        sharpening: 0.0,
        sharpening_mode: mode.clone(),
    };

    if frame_count == 0 || zoom_segments.is_empty() || content.0 == 0 || content.1 == 0 {
        return empty(1.0);
    }
    let ratio = source.0 as f64 / content.0 as f64;
    if ratio <= DETAIL_MIN_RATIO {
        // The canvas already carries full source detail: nothing to sample.
        return empty(ratio);
    }

    let fps = canvas.fps.max(1) as f64;
    let runs = zoom_frame_runs(zoom_segments, canvas.fps, first_frame, frame_count);
    if runs.is_empty() {
        return empty(ratio);
    }

    let mut max_scale: f64 = 1.0;
    let mut has_transitions = false;
    let mut previous: Option<(u64, f64, f64, f64, f64)> = None;
    for run in &runs {
        for frame in run.start..run.end {
            let output_ms = frame as f64 * 1000.0 / fps;
            let state = evaluate_zoom_transform(
                zoom_segments,
                canvas.width,
                canvas.height,
                canvas.padding,
                output_ms,
            );
            if zoom_transform_is_identity(&state, canvas.width, canvas.height) {
                previous = None;
                continue;
            }
            let crop = (state.crop_x, state.crop_y, state.crop_w, state.crop_h);
            if let Some((prev_frame, px, py, pw, ph)) = previous {
                // A changing crop (or a jump from an identity frame) is an
                // animated transition; a hold repeats the same crop.
                if frame == prev_frame + 1
                    && ((px - crop.0).abs() > 0.5
                        || (py - crop.1).abs() > 0.5
                        || (pw - crop.2).abs() > 0.5
                        || (ph - crop.3).abs() > 0.5)
                {
                    has_transitions = true;
                }
            } else if run.len() > 1 {
                // The first non-identity frame of a run that keeps zooming is
                // itself part of a transition.
                has_transitions = true;
            }
            previous = Some((frame, crop.0, crop.1, crop.2, crop.3));
            max_scale = max_scale.max(canvas.width as f64 / state.crop_w.max(1.0));
        }
    }

    let needed = max_scale > DETAIL_MIN_SCALE;
    if !needed {
        return empty(ratio);
    }

    // Sample at the resolution the widest zoom can actually use, never above
    // the source, and keep both axes on an even grid for NV12.
    let factor = max_scale.min(ratio);
    let width = even_clamp(content.0 as f64 * factor, source.0);
    let height = even_clamp(content.1 as f64 * factor, source.1);
    let needed = width > content.0 && height > content.1;

    ZoomDetailPlan {
        max_scale,
        resolution_ratio: ratio,
        width,
        height,
        needed,
        runs,
        has_transitions,
        // Only sharpen when the plane carries real extra detail: a zoom on a
        // canvas-resolution source is a plain upscale, and sharpening it would
        // change pixels every existing zoom spec renders today.
        sharpening: if needed {
            rcas_strength(max_scale, ratio, &mode)
        } else {
            0.0
        },
        sharpening_mode: mode,
    }
}

fn even_clamp(value: f64, limit: u32) -> u32 {
    let snapped = ((value.round() as u32) & !1).max(2);
    snapped.min(limit.max(2) & !1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::cursor::{CursorSettings, RenderCanvas};
    use crate::exports::{RenderCropFloat, RenderPlanZoomSegment};

    fn canvas(fps: u32) -> RenderCanvas {
        RenderCanvas {
            width: 1920,
            height: 1080,
            fps,
            cursor_settings: CursorSettings::default(),
            ..RenderCanvas::default()
        }
    }

    fn zoom(start_ms: u64, end_ms: u64, scale: f64) -> RenderPlanZoomSegment {
        let crop_w = 1920.0 / scale;
        let crop_h = 1080.0 / scale;
        RenderPlanZoomSegment {
            id: format!("z{start_ms}"),
            start_ms,
            end_ms,
            target: RenderCropFloat {
                x: (1920.0 - crop_w) / 2.0,
                y: (1080.0 - crop_h) / 2.0,
                width: crop_w,
                height: crop_h,
            },
            scale,
            easing: "linear".into(),
            transition_in_ms: 0,
            transition_out_ms: 0,
            enabled: true,
            mode: "manual".into(),
            source: "manual".into(),
            preset: "product-demo".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: None,
            from_scale: None,
            keyframes: None,
            motion_plan: None,
            style: None,
            loupe: None,
        }
    }

    #[test]
    fn a_1080p_canvas_over_a_1440p_source_needs_a_detail_plane() {
        // 2560x1440 source into a 1920x1080 content rect: r = 1.333.
        let plan = analyze_zoom_detail(
            &[zoom(0, 2_000, 1.5)],
            &canvas(30),
            (1920, 1080),
            (2560, 1440),
            0,
            60,
        );
        assert!(plan.needed);
        assert!((plan.resolution_ratio - 2560.0 / 1920.0).abs() < 1e-9);
        // D = content * min(m, r) = 1920 * 1.333 = 2560 (the source itself).
        assert_eq!((plan.width, plan.height), (2560, 1440));
        assert_eq!(plan.detail_frames(), 60);
        // m (1.5) still exceeds r (1.333), so the remaining upscale is sharpened.
        assert!(plan.sharpening > 0.0);
    }

    #[test]
    fn a_source_at_canvas_resolution_never_builds_a_detail_plane() {
        let plan = analyze_zoom_detail(
            &[zoom(0, 2_000, 2.0)],
            &canvas(30),
            (1920, 1080),
            (1920, 1080),
            0,
            60,
        );
        assert!(!plan.needed);
        assert!(plan.runs.is_empty());
        // No extra detail exists, so nothing is sharpened and the frame keeps
        // the pixels every existing zoom spec renders.
        assert_eq!(plan.sharpening, 0.0);
    }

    #[test]
    fn loupe_segments_never_move_the_frame_zoom() {
        let mut segment = zoom(0, 2_000, 3.0);
        segment.style = Some("loupe".into());
        let plan = analyze_zoom_detail(&[segment], &canvas(30), (1920, 1080), (3840, 2160), 0, 60);
        assert!(!plan.needed);
        assert!(plan.runs.is_empty());
    }

    #[test]
    fn detail_runs_are_merged_and_clamped_to_the_window() {
        let segments = vec![
            zoom(0, 1_000, 1.5),
            zoom(900, 2_000, 1.5),
            zoom(5_000, 6_000, 1.5),
        ];
        let runs = zoom_frame_runs(&segments, 30, 0, 60);
        assert_eq!(runs, vec![FrameRun { start: 0, end: 60 }]);
        let runs = zoom_frame_runs(&segments, 30, 15, 15);
        assert_eq!(runs, vec![FrameRun { start: 15, end: 30 }]);
    }

    #[test]
    fn sharpening_follows_the_remaining_upscale_and_the_mode() {
        // m = 2, r = 1.333 → excess 0.5 → full strength at 1.35× range.
        assert_eq!(rcas_strength(2.0, 4.0 / 3.0, "auto"), 1.0);
        assert_eq!(rcas_strength(2.0, 4.0 / 3.0, "off"), 0.0);
        assert!((rcas_strength(1.2, 1.0, "auto") - (0.2 / 0.35)).abs() < 1e-9);
        assert!(
            (rcas_strength(1.2, 1.0, "strong") - ((0.2_f64 / 0.35) * 2.0).min(1.0)).abs() < 1e-9
        );
        assert_eq!(rcas_strength(1.5, 2.0, "auto"), 0.0);
    }
}
