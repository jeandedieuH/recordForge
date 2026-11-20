//! Single export camera model shared by the video filter graph and the cursor
//! renderer.
//!
//! Three faces of the same math live here:
//! - `evaluate_zoom_transform` — the numeric float crop in canvas space at an
//!   output timestamp, used by the cursor renderer and by tests.
//! - `build_zoompan_expressions` — the symbolic z/x/y expressions FFmpeg's
//!   zoompan filter evaluates per frame.
//! - `zoompan_integer_crop` — reproduces zoompan's integer crop selection
//!   (truncation + chroma snap) from the same float crop, so the cursor can be
//!   registered onto the exact pixels sws_scale samples.
//!
//! Crop interpolation (Z6) is log-space for the crop width
//! (`w(p) = wA * (wB/wA)^p`) with the center gliding around the screen-fixed
//! point `f = (cB*sB - cA*sA) / (sB - sA)`. This must match
//! `interpolateCrop` in `packages/editor-core/src/composition.ts`.

use super::{
    cursor, RenderCropFloat, RenderPlan, RenderPlanZoomKeyframe, RenderPlanZoomMotionPlan,
    RenderPlanZoomMotionPoint, RenderPlanZoomMotionSegment, RenderPlanZoomSegment,
};

/// Crop/zoom state at one output timestamp in canvas coordinates.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ZoomTransformState {
    pub progress: f64,
    pub scale: f64,
    pub crop_x: f64,
    pub crop_y: f64,
    pub crop_w: f64,
    pub crop_h: f64,
}

/// True when the segment is a Glass Loupe: it magnifies inside a lens and must
/// never be resolved as a frame zoom (`resolveLoupes` handles it instead).
pub(crate) fn segment_is_loupe(segment: &RenderPlanZoomSegment) -> bool {
    segment.style.as_deref() == Some("loupe")
}

pub(crate) fn ease_progress(progress: f64, easing: &str) -> f64 {
    let p = progress.clamp(0.0, 1.0);
    match easing {
        "linear" => p,
        "ease-in" => p * p,
        "ease-out" => 1.0 - (1.0 - p).powi(2),
        "snappy" => 1.0 - (1.0 - p).powi(3),
        "cinematic" => p * p * (3.0 - 2.0 * p),
        "smooth" => p * p * p * (p * (p * 6.0 - 15.0) + 10.0),
        "spring" => {
            // Normalized damped spring: 1 - e^(-7p)(cos(6p) + (7/6) sin(6p)),
            // divided by its endpoint value so f(0)=0 and f(1)=1 while keeping
            // ~2.6% overshoot. Matches the TypeScript zoomEasedProgress.
            let raw =
                |v: f64| 1.0 - (-7.0 * v).exp() * ((6.0 * v).cos() + (7.0 / 6.0) * (6.0 * v).sin());
            raw(p) / raw(1.0)
        }
        _ => {
            if p < 0.5 {
                2.0 * p * p
            } else {
                1.0 - (-2.0 * p + 2.0).powi(2) / 2.0
            }
        }
    }
}

fn find_keyframe_target(
    keyframes: &[RenderPlanZoomKeyframe],
    time_ms: f64,
    fallback: &RenderCropFloat,
) -> RenderCropFloat {
    if keyframes.is_empty() {
        return fallback.clone();
    }
    if time_ms <= keyframes[0].time_ms as f64 {
        return keyframes[0].target.clone();
    }
    if time_ms >= keyframes[keyframes.len() - 1].time_ms as f64 {
        return keyframes[keyframes.len() - 1].target.clone();
    }
    for i in 0..keyframes.len() - 1 {
        let k0 = &keyframes[i];
        let k1 = &keyframes[i + 1];
        if time_ms >= k0.time_ms as f64 && time_ms <= k1.time_ms as f64 {
            let span = (k1.time_ms.saturating_sub(k0.time_ms).max(1)) as f64;
            let alpha = ((time_ms - k0.time_ms as f64) / span).clamp(0.0, 1.0);
            return RenderCropFloat {
                x: k0.target.x + (k1.target.x - k0.target.x) * alpha,
                y: k0.target.y + (k1.target.y - k0.target.y) * alpha,
                width: k0.target.width + (k1.target.width - k0.target.width) * alpha,
                height: k0.target.height + (k1.target.height - k0.target.height) * alpha,
            };
        }
    }
    fallback.clone()
}

/// Per-axis crop center under log-space zoom interpolation. `fixed` is the
/// content position that stays put on screen while the crop zooms; near-equal
/// zoom levels have no usable fixed point and degrade to a pure pan.
/// Mirrors the TypeScript `interpolateCropCenter`.
fn interpolate_crop_center(
    center_a: f64,
    center_b: f64,
    size_a: f64,
    size_b: f64,
    size: f64,
    canvas_size: f64,
    progress: f64,
) -> f64 {
    let safe_a = size_a.max(1e-6);
    let safe_b = size_b.max(1e-6);
    let scale_a = canvas_size / safe_a;
    let scale_b = canvas_size / safe_b;
    if (scale_b - scale_a).abs() < 1e-3 * scale_a {
        return center_a + (center_b - center_a) * progress;
    }
    let fixed = (center_b * scale_b - center_a * scale_a) / (scale_b - scale_a);
    fixed - (fixed - center_a) * (size / safe_a)
}

/// Zoom-space crop interpolation shared by the numeric evaluator, the zoompan
/// expressions, and the TypeScript `interpolateCrop`. Works for progress
/// outside [0, 1] (spring overshoot) and for a `to` crop that is recomputed
/// per frame (follow camera).
pub(crate) fn interpolate_crop(
    from: &RenderCropFloat,
    to: &RenderCropFloat,
    progress: f64,
    canvas_w: f64,
    canvas_h: f64,
) -> RenderCropFloat {
    let canvas_w = canvas_w.max(1.0);
    let canvas_h = canvas_h.max(1.0);
    let from_w = from.width.max(1e-6);
    let to_w = to.width.max(1e-6);
    let width = (from_w * (to_w / from_w).powf(progress)).min(canvas_w);
    let height = width / canvas_w * canvas_h;

    let center_x = interpolate_crop_center(
        from.x + from.width / 2.0,
        to.x + to.width / 2.0,
        from.width,
        to.width,
        width,
        canvas_w,
        progress,
    );
    let center_y = interpolate_crop_center(
        from.y + from.height / 2.0,
        to.y + to.height / 2.0,
        from.height,
        to.height,
        height,
        canvas_h,
        progress,
    );

    RenderCropFloat {
        x: (center_x - width / 2.0).clamp(0.0, (canvas_w - width).max(0.0)),
        y: (center_y - height / 2.0).clamp(0.0, (canvas_h - height).max(0.0)),
        width,
        height,
    }
}

/// Evaluate the float zoom crop (canvas space) at a fractional output PTS so
/// the cursor and video use the same transition progress between integer
/// millisecond boundaries.
pub(crate) fn evaluate_zoom_transform(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas_width: u32,
    canvas_height: u32,
    canvas_padding: u32,
    output_ms: f64,
) -> ZoomTransformState {
    let canvas_w = canvas_width as f64;
    let canvas_h = canvas_height as f64;

    let Some(segment) = zoom_segments
        .iter()
        .filter(|segment| {
            segment.enabled
                && !segment_is_loupe(segment)
                && output_ms >= segment.start_ms as f64
                && output_ms < segment.end_ms as f64
        })
        // Match the editor's deterministic overlap rule: the latest starting
        // segment wins, with the id as the stable tie-breaker.
        .max_by(|left, right| {
            left.start_ms
                .cmp(&right.start_ms)
                .then_with(|| left.id.cmp(&right.id))
        })
    else {
        return ZoomTransformState {
            progress: 0.0,
            scale: 1.0,
            crop_x: 0.0,
            crop_y: 0.0,
            crop_w: canvas_w,
            crop_h: canvas_h,
        };
    };

    let duration = (segment.end_ms - segment.start_ms).max(1) as f64;
    let mut trans_in = (segment.transition_in_ms as f64).clamp(0.0, duration);
    let mut trans_out = (segment.transition_out_ms as f64).clamp(0.0, duration);
    if trans_in + trans_out > duration {
        trans_in = duration / 2.0;
        trans_out = duration - trans_in;
    }

    let elapsed = (output_ms - segment.start_ms as f64).max(0.0);
    let mut is_panned_from_prev = false;

    let progress = if elapsed <= 0.0 {
        let progress = if trans_in == 0.0 { 1.0 } else { 0.0 };
        if segment.from_target.is_some() && progress < 1.0 {
            is_panned_from_prev = true;
        }
        progress
    } else if elapsed < trans_in {
        if segment.from_target.is_some() {
            is_panned_from_prev = true;
        }
        let raw = (elapsed / trans_in.max(1.0)).clamp(0.0, 1.0);
        ease_progress(raw, &segment.easing)
    } else if elapsed <= duration - trans_out {
        1.0
    } else if elapsed <= duration {
        // Out phase mirrors the easing's own tail: 1 - ease(elapsed/out).
        // Symmetric easings are unchanged; asymmetric ones get a real
        // decelerating tail instead of re-accelerating toward full screen.
        let elapsed_out = elapsed - (duration - trans_out);
        let raw = (elapsed_out / trans_out.max(1.0)).clamp(0.0, 1.0);
        1.0 - ease_progress(raw, &segment.easing)
    } else {
        0.0
    };

    let fallback_target = clamped_zoom_target(canvas_width, canvas_height, canvas_padding, segment);
    let target = if let Some(motion_plan) = &segment.motion_plan {
        if let Some(point) = cursor_engine::evaluate_cubic_motion_plan(motion_plan, output_ms) {
            let motion_target = RenderCropFloat {
                x: point.x - fallback_target.width / 2.0,
                y: point.y - fallback_target.height / 2.0,
                width: fallback_target.width,
                height: fallback_target.height,
            };
            clamped_zoom_crop(
                canvas_width,
                canvas_height,
                canvas_padding,
                &motion_target,
                segment.scale,
            )
        } else {
            fallback_target.clone()
        }
    } else if let Some(keyframes) = &segment.keyframes {
        if !keyframes.is_empty() {
            let kf = find_keyframe_target(keyframes, output_ms, &segment.target);
            clamped_zoom_crop(
                canvas_width,
                canvas_height,
                canvas_padding,
                &kf,
                segment.scale,
            )
        } else {
            fallback_target.clone()
        }
    } else {
        fallback_target
    };

    let full = RenderCropFloat {
        x: 0.0,
        y: 0.0,
        width: canvas_w,
        height: canvas_h,
    };
    let from = if is_panned_from_prev {
        segment
            .from_target
            .as_ref()
            .map(|from_raw| {
                clamped_zoom_crop(
                    canvas_width,
                    canvas_height,
                    canvas_padding,
                    from_raw,
                    // Match `collect_zoompan_segment_exprs` and TS `resolveZoomTransform`:
                    // an omitted `from_scale` defaults to 1.0 (full-frame scale).
                    segment.from_scale.unwrap_or(1.0),
                )
            })
            .unwrap_or_else(|| full.clone())
    } else {
        full
    };

    // Log-space crop interpolation keeps preview, cursor export, and zoompan
    // on the same camera path (see `interpolateCrop` in editor-core).
    let crop = interpolate_crop(&from, &target, progress, canvas_w, canvas_h);
    let scale = canvas_w / crop.width.max(1.0);

    ZoomTransformState {
        progress,
        scale,
        crop_x: crop.x,
        crop_y: crop.y,
        crop_w: crop.width,
        crop_h: crop.height,
    }
}

/// True when a zoom transform is the identity: the full canvas is sampled and
/// mapped 1:1, so a `zoompan` stage would only add a swscale round trip.
pub(crate) fn zoom_transform_is_identity(
    state: &ZoomTransformState,
    canvas_width: u32,
    canvas_height: u32,
) -> bool {
    const EPS: f64 = 1e-6;
    state.crop_x.abs() <= EPS
        && state.crop_y.abs() <= EPS
        && (state.crop_w - canvas_width as f64).abs() <= EPS
        && (state.crop_h - canvas_height as f64).abs() <= EPS
}

/// Whether any frame in `[first_frame, first_frame + frame_count)` needs a
/// non-identity zoom. Sampling every CFR frame (rather than only segment
/// edges) catches short transitions and follow/keyframe pans that are not
/// identity even at a segment's endpoints.
pub(crate) fn window_needs_zoom(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &cursor::RenderCanvas,
    first_frame: u64,
    frame_count: u64,
) -> bool {
    if frame_count == 0
        || !zoom_segments
            .iter()
            .any(|segment| segment.enabled && !segment_is_loupe(segment))
    {
        return false;
    }
    let fps = canvas.fps.max(1) as f64;
    let half_max = motion_blur_params(canvas)
        .map(|params| params.half_zoom_ms.max(params.half_pan_ms))
        .unwrap_or(0.0);
    for frame in first_frame..first_frame.saturating_add(frame_count) {
        let output_ms = frame as f64 * 1000.0 / fps;
        let state = evaluate_zoom_transform(
            zoom_segments,
            canvas.width,
            canvas.height,
            canvas.padding,
            output_ms,
        );
        if !zoom_transform_is_identity(&state, canvas.width, canvas.height) {
            return true;
        }
        // A boundary frame whose center timestamp is still identity can sweep
        // into an adjacent zoom segment across its motion-blur shutter window.
        if half_max > 0.0 {
            let lo = evaluate_zoom_transform(
                zoom_segments,
                canvas.width,
                canvas.height,
                canvas.padding,
                (output_ms - half_max).max(0.0),
            );
            let hi = evaluate_zoom_transform(
                zoom_segments,
                canvas.width,
                canvas.height,
                canvas.padding,
                output_ms + half_max,
            );
            if !zoom_transform_is_identity(&lo, canvas.width, canvas.height)
                || !zoom_transform_is_identity(&hi, canvas.width, canvas.height)
            {
                return true;
            }
        }
    }
    false
}

/// One contiguous run of output frames that share a zoom treatment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ZoomPieceKind {
    /// Full frame sampled 1:1 — pass the frames through untouched.
    Identity,
    /// A fixed integer crop scaled back to the output size. `zoompan`
    /// reallocates its SwsContext and rescales single-threaded every frame;
    /// `crop` + `scale` cache one context and slice across cores.
    Hold { x: u32, y: u32, w: u32, h: u32 },
    /// Animated crop: only `zoompan` can vary the sampled rect per frame.
    Transition,
}

/// One classified run, in absolute output-frame indices (`start` inclusive,
/// `end` exclusive).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ZoomPiece {
    pub start_frame: u64,
    pub end_frame: u64,
    pub kind: ZoomPieceKind,
}

/// Upper bound on piecewise branches per pass. Every branch costs a `split`
/// output, a `trim` and a `concat` input; beyond a handful the graph bookkeeping
/// outweighs the zoompan savings, so the caller falls back to one zoompan.
pub(crate) const MAX_ZOOM_PIECES: usize = 8;

/// Classify `[first_frame, first_frame + frame_count)` into identity, steady
/// ("hold") and transition runs so the graph can skip `zoompan` where the
/// sampled rectangle does not change.
///
/// Returns `None` when the window gains nothing (a single pass-through run) or
/// needs more than `MAX_ZOOM_PIECES` branches.
pub(crate) fn classify_zoom_pieces(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &cursor::RenderCanvas,
    first_frame: u64,
    frame_count: u64,
    screen_w: f64,
    screen_h: f64,
) -> Option<Vec<ZoomPiece>> {
    if frame_count == 0 {
        return None;
    }
    let fps = canvas.fps.max(1) as f64;
    let blur = motion_blur_params(canvas);
    // Pass 1: the integer crop each frame samples (None = identity).
    let crops: Vec<Option<(u32, u32, u32, u32)>> = (0..frame_count)
        .map(|offset| {
            let output_ms = (first_frame + offset) as f64 * 1000.0 / fps;
            let state = evaluate_zoom_transform(
                zoom_segments,
                canvas.width,
                canvas.height,
                canvas.padding,
                output_ms,
            );
            if zoom_transform_is_identity(&state, canvas.width, canvas.height) {
                None
            } else {
                Some(zoompan_integer_crop(
                    (state.crop_x, state.crop_y, state.crop_w, state.crop_h),
                    screen_w.max(1.0),
                    screen_h.max(1.0),
                    canvas.width as f64,
                    canvas.height as f64,
                    1,
                    1,
                ))
            }
        })
        .collect();

    // Pass 2: a frame is "hold" when its crop matches either neighbour, so a
    // step into a new zoom level lands in the steady run instead of creating a
    // one-frame transition branch of its own. When zoom/pan motion blur is
    // active, any frame whose shutter sweeps across pixels stays `Transition`
    // so ease-in/out ramps and boundary frames never lose their blur.
    let mut pieces: Vec<ZoomPiece> = Vec::new();
    for (offset, crop) in crops.iter().enumerate() {
        let frame = first_frame + offset as u64;
        let has_blur = blur.is_some_and(|params| {
            let output_ms = frame as f64 * 1000.0 / fps;
            evaluate_motion_blur_strip(
                zoom_segments,
                canvas,
                &params,
                output_ms,
                screen_w,
                screen_h,
            )
            .is_some()
        });
        let kind = if has_blur {
            ZoomPieceKind::Transition
        } else {
            match crop {
                None => ZoomPieceKind::Identity,
                Some(crop) => {
                    let previous_matches = offset > 0 && crops[offset - 1] == Some(*crop);
                    let next_matches = crops.get(offset + 1) == Some(&Some(*crop));
                    if previous_matches || next_matches {
                        ZoomPieceKind::Hold {
                            x: crop.0,
                            y: crop.1,
                            w: crop.2,
                            h: crop.3,
                        }
                    } else {
                        ZoomPieceKind::Transition
                    }
                }
            }
        };
        match pieces.last_mut() {
            Some(piece) if piece.kind == kind && piece.end_frame == frame => {
                piece.end_frame = frame + 1;
            }
            _ => pieces.push(ZoomPiece {
                start_frame: frame,
                end_frame: frame + 1,
                kind,
            }),
        }
        if pieces.len() > MAX_ZOOM_PIECES {
            return None;
        }
    }

    // A single steady run is still worth a `crop` + `scale`: the whole window
    // samples one fixed rect, so `zoompan` would only re-allocate its context
    // every frame. A single identity/transition run keeps the old single stage.
    match pieces.as_slice() {
        [piece] if matches!(piece.kind, ZoomPieceKind::Hold { .. }) => Some(pieces),
        [_, _, ..] => Some(pieces),
        _ => None,
    }
}

/// Frame indices where enabled zoom regions begin and end, for chunk-boundary
/// snapping. A region contributes `start` (first zoomed frame) and `end`
/// (first frame after it), both clamped to `total_frames`.
pub(crate) fn zoom_region_frame_edges(
    zoom_segments: &[RenderPlanZoomSegment],
    fps: u32,
    total_frames: u64,
) -> Vec<u64> {
    let fps = fps.max(1) as f64;
    let mut edges = Vec::new();
    for segment in zoom_segments.iter().filter(|segment| {
        segment.enabled && !segment_is_loupe(segment) && segment.end_ms > segment.start_ms
    }) {
        let start = (segment.start_ms as f64 / 1000.0 * fps).round() as u64;
        let end = (segment.end_ms as f64 / 1000.0 * fps).round() as u64;
        edges.push(start.min(total_frames));
        edges.push(end.min(total_frames));
    }
    edges.sort_unstable();
    edges.dedup();
    edges.retain(|edge| *edge > 0 && *edge < total_frames);
    edges
}

/// Reproduce FFmpeg zoompan's integer crop selection in screen pixels so the
/// cursor can be registered onto the exact region sws_scale samples.
///
/// `vf_zoompan.c` `output_single_frame` computes, per output frame:
///   zoom = clip(z_expr, 1, 10);
///   w = (int)(in_w / zoom);  h = (int)(in_h / zoom);
///   dx = clip(x_expr, 0, max(in_w - w, 0)); x = (int)dx;
///   x &= ~((1 << log2_chroma_w) - 1);   same for y with log2_chroma_h
/// then sws_scale maps the w x h region at (x, y) to the output size.
///
/// `float_crop` is the canvas-space crop from `evaluate_zoom_transform`;
/// screen dims are the zoompan input (video) pixels and `canvas_*` the canvas
/// size the expressions were built for. Returns (x, y, w, h) in input pixels.
pub(crate) fn zoompan_integer_crop(
    float_crop: (f64, f64, f64, f64),
    screen_w: f64,
    screen_h: f64,
    canvas_w: f64,
    canvas_h: f64,
    log2_chroma_w: u32,
    log2_chroma_h: u32,
) -> (u32, u32, u32, u32) {
    let (crop_x, crop_y, crop_w, crop_h) = float_crop;
    let zoom = (canvas_w.max(1.0) / crop_w.max(1e-6)).clamp(1.0, 10.0);
    let w = ((screen_w / zoom).max(1.0)) as u32;
    let h = ((screen_h / zoom).max(1.0)) as u32;
    let center_x = (crop_x + crop_w / 2.0) / canvas_w.max(1.0) * screen_w;
    let center_y = (crop_y + crop_h / 2.0) / canvas_h.max(1.0) * screen_h;
    let dx = (center_x - (screen_w / zoom) / 2.0).clamp(0.0, (screen_w - w as f64).max(0.0));
    let dy = (center_y - (screen_h / zoom) / 2.0).clamp(0.0, (screen_h - h as f64).max(0.0));
    let snap_x = (1u32 << log2_chroma_w.min(4)) - 1;
    let snap_y = (1u32 << log2_chroma_h.min(4)) - 1;
    let x = (dx.max(0.0) as u32) & !snap_x;
    let y = (dy.max(0.0) as u32) & !snap_y;
    (x, y, w, h)
}

fn compact_num(val: f64) -> String {
    if val.fract().abs() < 1e-6 {
        format!("{:.0}", val)
    } else {
        let s = format!("{:.3}", val);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

pub(crate) fn zoom_easing_expression(p: &str, easing: &str) -> String {
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
        // Normalized damped spring, same curve as ease_progress/zoomEasedProgress:
        // (1 - e^(-7p)(cos(6p) + (7/6) sin(6p))) / raw(1).
        "spring" => format!("(1-exp(-7*({p}))*((cos(6*({p})))+(7/6)*sin(6*({p}))))/0.999422"),
        _ => format!("if(lte({p},0.5),2*({p})*({p}),1-pow(-2*({p})+2,2)/2)"),
    }
}

/// Derive the effective scale from the crop rectangle used by every renderer.
/// The persisted segment scale is a convenient editor value, but the crop is
/// the authoritative geometry at export time.
pub(crate) fn effective_zoom_scale(canvas_width: f64, crop: &RenderCropFloat) -> f64 {
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

/// Center expression for one transition phase under log-space interpolation:
/// `c = f*(1-r) + cA*r` around the screen-fixed point `f`, falling back to a
/// pure-pan lerp when both ends share the zoom level. `center_b` may be a
/// dynamic (motion-plan / keyframe) expression and appears exactly once.
///
/// The width ratio is normally recovered from zoompan's `zoom` variable
/// (`r = canvas_w / (from_w * zoom)`) so the eased ratio term only appears
/// once — inside the z expression — keeping these expressions compact. When
/// `explicit_ratio_expr` is `Some`, the caller is separating zoom and pan
/// shutter times (e.g. pan-only motion blur), so the centre evaluates its own
/// ratio directly from `it` and stays decoupled from zoompan's `zoom`.
#[allow(clippy::too_many_arguments)]
fn zoompan_center_expression(
    center_a_expr: &str,
    center_b_expr: &str,
    scale_a: f64,
    scale_b: f64,
    eased: &str,
    canvas_w: f64,
    from_w: f64,
    explicit_ratio_expr: Option<&str>,
) -> String {
    if !scale_a.is_finite() || !scale_b.is_finite() || scale_a <= 0.0 {
        return center_b_expr.to_string();
    }
    if (scale_b - scale_a).abs() < 1e-3 * scale_a {
        // Equal zoom levels: the fixed point is undefined; pan linearly.
        return format!("({center_a_expr})+(({center_b_expr})-({center_a_expr}))*({eased})");
    }
    let ratio_expr = if let Some(explicit) = explicit_ratio_expr {
        format!("({explicit})")
    } else if (from_w - canvas_w).abs() < 1e-6 {
        "(1/zoom)".to_string()
    } else {
        format!(
            "({}/({}*zoom))",
            compact_num(canvas_w),
            compact_num(from_w.max(1e-6))
        )
    };
    let fixed = format!(
        "(({center_b_expr})*{s_b}-({center_a_expr})*{s_a})/{ds}",
        s_b = compact_num(scale_b),
        s_a = compact_num(scale_a),
        ds = compact_num(scale_b - scale_a),
    );
    format!("({fixed})*(1-({ratio_expr}))+({center_a_expr})*({ratio_expr})")
}

/// Build the log-space crop-width ratio expression `r = (wB/wA)^p` that the
/// z/x/y expressions share for a transition phase.
fn zoompan_ratio_expression(ratio: f64, eased: &str) -> String {
    if !ratio.is_finite() || ratio <= 0.0 || (ratio - 1.0).abs() < 1e-9 {
        "1".to_string()
    } else {
        format!("exp(log({})*({eased}))", compact_num(ratio))
    }
}

/// Convert a canvas-space rect center to the screen-space value the zoompan
/// x/y expressions operate on.
fn zoompan_screen_center(center_canvas: f64, canvas_dim: f64, screen_dim: f64) -> f64 {
    ((center_canvas / canvas_dim) * screen_dim).clamp(0.0, screen_dim)
}

/// Per-segment expression payloads for one zoom segment, plus the time range
/// needed to route `it` through the balanced segment tree.
struct ZoompanSegmentExpr {
    start_s: f64,
    end_s: f64,
    cond: String,
    z: String,
    cx: String,
    cy: String,
}

/// Wrap `fallback` in the segment's guard condition, yielding
/// `if(cond, expr, fallback)`. Chained over a sorted slice in ascending
/// order this reproduces the "latest starting segment wins" selection the
/// numeric evaluator applies.
fn zoompan_segment_exprs_guard(
    segment: &ZoompanSegmentExpr,
    fallback: (String, String, String),
) -> (String, String, String) {
    (
        format!("if({},{},{})", segment.cond, segment.z, fallback.0),
        format!("if({},{},{})", segment.cond, segment.cx, fallback.1),
        format!("if({},{},{})", segment.cond, segment.cy, fallback.2),
    )
}

/// Number of segments folded into a single linear chain at a tree leaf.
/// Small leaves keep `it` routing cheap while bounding tree depth.
const ZOOMPAN_EXPR_LEAF_SEGMENTS: usize = 8;

/// Combine the per-segment z/cx/cy expressions into three balanced
/// `if(lt(it,split), left, right)` trees.
///
/// FFmpeg's expression parser rejects trees deeper than `MAX_DEPTH` (100) —
/// and worse, `parse_primary` ignores the parse result for a function's
/// second and third argument, so an over-deep subtree is silently dropped
/// and the expression evaluates to a constant. A linear `if` chain over N
/// zoom segments reaches depth ~N + leaf depth and overflows around ~75
/// segments (observed on long recordings: the x/y expressions collapse to
/// `if(lte(zoom,1.001),0,0)`, pinning the crop to the top-left corner while
/// `z` still zooms). Routing `it` through a binary tree keeps depth O(log n).
///
/// Selection semantics are identical to the linear chain: for `it < split`
/// only left segments can be active (segments are sorted by start, so every
/// right segment starts at or after `split`); for `it >= split` the right
/// subtree checks its (later-starting, higher-priority) segments first and
/// falls back to a chain of the left segments still active past `split_s`.
fn build_zoompan_segment_exprs(
    segments: &[ZoompanSegmentExpr],
    fallback: &(String, String, String),
) -> (String, String, String) {
    if segments.len() <= ZOOMPAN_EXPR_LEAF_SEGMENTS {
        return segments.iter().fold(fallback.clone(), |acc, segment| {
            zoompan_segment_exprs_guard(segment, acc)
        });
    }

    let mid = segments.len() / 2;
    let split_s = segments[mid].start_s;
    let left = build_zoompan_segment_exprs(&segments[..mid], fallback);

    // Left segments spanning the split can still be active at it >= split_s;
    // they keep their original (lower) priority inside the right subtree.
    let tail = segments[..mid]
        .iter()
        .filter(|segment| segment.end_s > split_s)
        .fold(fallback.clone(), |acc, segment| {
            zoompan_segment_exprs_guard(segment, acc)
        });
    let right = build_zoompan_segment_exprs(&segments[mid..], &tail);

    let split = compact_num(split_s);
    (
        format!("if(lt(it,{split}),{},{})", left.0, right.0),
        format!("if(lt(it,{split}),{},{})", left.1, right.1),
        format!("if(lt(it,{split}),{},{})", left.2, right.2),
    )
}

/// Build the guarded `if(cond, z|cx|cy, …)` payload for every enabled zoom
/// segment, sorted so later-starting segments win when ranges overlap.
fn collect_zoompan_segment_exprs(
    plan: &RenderPlan,
    canvas: &cursor::RenderCanvas,
    screen_w: f64,
    screen_h: f64,
    independent_centers: bool,
) -> Vec<ZoompanSegmentExpr> {
    let full_cx = screen_w / 2.0;
    let full_cy = screen_h / 2.0;
    let mut segment_exprs: Vec<ZoompanSegmentExpr> = Vec::new();
    let canvas_w = canvas.width as f64;
    let canvas_h = canvas.height as f64;

    let mut zoom_segments = plan
        .zoom_segments
        .iter()
        .filter(|segment| segment.enabled && !segment_is_loupe(segment))
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

        let target_cx = zoompan_screen_center(target.x + target.width / 2.0, canvas_w, screen_w);
        let target_cy = zoompan_screen_center(target.y + target.height / 2.0, canvas_h, screen_h);

        let from_crop = segment.from_target.as_ref().map(|from_raw| {
            clamped_zoom_crop(
                canvas.width,
                canvas.height,
                canvas.padding,
                from_raw,
                segment.from_scale.unwrap_or(1.0),
            )
        });
        let (from_w, from_cx, from_cy) = if let Some(from) = from_crop.as_ref() {
            (
                from.width,
                zoompan_screen_center(from.x + from.width / 2.0, canvas_w, screen_w),
                zoompan_screen_center(from.y + from.height / 2.0, canvas_h, screen_h),
            )
        } else {
            (canvas_w, full_cx, full_cy)
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
        let from_w_str = compact_num(from_w.max(1.0));
        let from_cx_str = compact_num(from_cx);
        let from_cy_str = compact_num(from_cy);
        let full_cx_str = compact_num(full_cx);
        let full_cy_str = compact_num(full_cy);
        let canvas_w_str = compact_num(canvas_w);
        let has_motion_plan = segment
            .motion_plan
            .as_ref()
            .is_some_and(|motion_plan| !motion_plan.segments.is_empty());
        let has_keyframes = !has_motion_plan
            && segment
                .keyframes
                .as_ref()
                .is_some_and(|keyframes| keyframes.len() > 1);
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
            segment.keyframes.as_ref().map_or_else(
                || target_cx_str.clone(),
                |keyframes| {
                    build_keyframe_center_expression(
                        keyframes,
                        canvas,
                        screen_w,
                        "x",
                        target_scale,
                        &target_cx_str,
                    )
                },
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
            segment.keyframes.as_ref().map_or_else(
                || target_cy_str.clone(),
                |keyframes| {
                    build_keyframe_center_expression(
                        keyframes,
                        canvas,
                        screen_h,
                        "y",
                        target_scale,
                        &target_cy_str,
                    )
                },
            )
        } else {
            target_cy_str.clone()
        };

        // Eased progress within in/out transitions. When a segment starts at
        // 0 s, clamp `progress_in` at 0 so negative-shifted motion-blur taps
        // on frame 0 never feed negative values into easing polynomials.
        let eased_in = if trans_in_s > 0.0001 {
            let progress_in = if start_s.abs() < 1e-6 {
                format!("max(0,(it-{start_str})/{trans_in_str})")
            } else {
                format!("((it-{start_str})/{trans_in_str})")
            };
            zoom_easing_expression(&progress_in, &segment.easing)
        } else {
            "1".to_string()
        };
        let eased_out = if trans_out_s > 0.0001 {
            // Out phase runs the easing forward over remaining time:
            // 1 - ease(elapsedOut/out). Symmetric easings are unchanged;
            // asymmetric easings get a real decelerating tail.
            let progress_out = format!("((it-{out_start_str})/{trans_out_str})");
            format!(
                "1-({})",
                zoom_easing_expression(&progress_out, &segment.easing)
            )
        } else {
            "1".to_string()
        };

        // Z6: crop width travels in log space. r = w(p)/wA = (wB/wA)^p and
        // the zoom factor is canvas_w / (wA * r), clamped to [1, canvas_w] so
        // spring overshoot on ease-out matches `interpolate_crop`'s `min(canvas_w)`.
        let ratio_in = target.width / from_w.max(1e-6);
        let ratio_in_expr = zoompan_ratio_expression(ratio_in, &eased_in);
        let ratio_out = target.width / canvas_w.max(1e-6);
        let ratio_out_expr = zoompan_ratio_expression(ratio_out, &eased_out);

        let z_in = if trans_in_s > 0.0001 {
            format!("{canvas_w_str}/max(1,min({canvas_w_str},({from_w_str}*({ratio_in_expr}))))")
        } else {
            target_scale_str.clone()
        };
        let z_out = if trans_out_s > 0.0001 {
            format!("{canvas_w_str}/max(1,min({canvas_w_str},({canvas_w_str}*({ratio_out_expr}))))")
        } else {
            "1".to_string()
        };
        let z_seg = if trans_in_s < 1e-4 && trans_out_s < 1e-4 {
            target_scale_str.clone()
        } else if trans_in_s < 1e-4 {
            format!("if(lte(it,{out_start_str}),{target_scale_str},{z_out})")
        } else if trans_out_s < 1e-4 {
            format!("if(lt(it,{in_end_str}),{z_in},{target_scale_str})")
        } else {
            format!(
                "if(lt(it,{in_end_str}),{z_in},if(lte(it,{out_start_str}),{target_scale_str},{z_out}))"
            )
        };

        // Centers: in-phase interpolates from the previous/full crop, hold uses
        // the (possibly dynamic) target center, out-phase interpolates back to
        // the full frame — all through the same fixed-point form.
        let scale_a_in = canvas_w / from_w.max(1e-6);
        let scale_b = target_scale;
        let explicit_in = independent_centers.then_some(ratio_in_expr.as_str());
        let cx_in = if trans_in_s > 0.0001 {
            zoompan_center_expression(
                &from_cx_str,
                &target_cx_expression,
                scale_a_in,
                scale_b,
                &eased_in,
                canvas_w,
                from_w,
                explicit_in,
            )
        } else {
            target_cx_expression.clone()
        };
        let cy_in = if trans_in_s > 0.0001 {
            zoompan_center_expression(
                &from_cy_str,
                &target_cy_expression,
                scale_a_in,
                scale_b,
                &eased_in,
                canvas_w,
                from_w,
                explicit_in,
            )
        } else {
            target_cy_expression.clone()
        };

        // For the out phase the "from" crop is the full canvas, so the ratio
        // runs from canvas width down to the target and back via eased_out.
        let scale_a_out = 1.0_f64;
        let explicit_out = independent_centers.then_some(ratio_out_expr.as_str());
        let cx_out = if trans_out_s > 0.0001 {
            zoompan_center_expression(
                &full_cx_str,
                &target_cx_expression,
                scale_a_out,
                scale_b,
                &eased_out,
                canvas_w,
                canvas_w,
                explicit_out,
            )
        } else {
            full_cx_str.clone()
        };
        let cy_out = if trans_out_s > 0.0001 {
            zoompan_center_expression(
                &full_cy_str,
                &target_cy_expression,
                scale_a_out,
                scale_b,
                &eased_out,
                canvas_w,
                canvas_w,
                explicit_out,
            )
        } else {
            full_cy_str.clone()
        };

        let cx_hold = target_cx_expression;
        let cy_hold = target_cy_expression;

        let cx_seg = if trans_in_s < 1e-4 && trans_out_s < 1e-4 {
            cx_hold.clone()
        } else if trans_in_s < 1e-4 {
            format!("if(lte(it,{out_start_str}),{cx_hold},{cx_out})")
        } else if trans_out_s < 1e-4 {
            format!("if(lt(it,{in_end_str}),{cx_in},{cx_hold})")
        } else {
            format!(
                "if(lt(it,{in_end_str}),{cx_in},if(lte(it,{out_start_str}),{cx_hold},{cx_out}))"
            )
        };
        let cy_seg = if trans_in_s < 1e-4 && trans_out_s < 1e-4 {
            cy_hold.clone()
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

        segment_exprs.push(ZoompanSegmentExpr {
            start_s,
            end_s,
            cond,
            z: z_seg,
            cx: cx_seg,
            cy: cy_seg,
        });
    }

    segment_exprs
}

/// The unwrapped crop triple behind `build_zoompan_expressions`: `z` is the
/// zoom factor and `cx`/`cy` the crop *centre* in screen-plate pixels before
/// the `x`/`y` top-left clamp. The motion-blur tap branches need the centres
/// (they shift the trajectory before clamping), so the wrap stays separate.
pub(crate) fn build_zoompan_crop_expressions(
    plan: &RenderPlan,
    canvas: &cursor::RenderCanvas,
    screen_w: f64,
    screen_h: f64,
) -> (String, String, String) {
    build_zoompan_crop_expressions_with_options(plan, canvas, screen_w, screen_h, false)
}

/// Variant of `build_zoompan_crop_expressions` that optionally decouples `cx`/`cy`
/// from zoompan's `zoom` variable so pan motion blur evaluates its own shutter
/// time even when `zoom` blur is 0 or uses a different shutter width.
pub(crate) fn build_zoompan_crop_expressions_with_options(
    plan: &RenderPlan,
    canvas: &cursor::RenderCanvas,
    screen_w: f64,
    screen_h: f64,
    independent_centers: bool,
) -> (String, String, String) {
    let segment_exprs =
        collect_zoompan_segment_exprs(plan, canvas, screen_w, screen_h, independent_centers);
    build_zoompan_segment_exprs(
        &segment_exprs,
        &(
            "1.0".to_string(),
            compact_num(screen_w / 2.0),
            compact_num(screen_h / 2.0),
        ),
    )
}

/// Turn crop-centre expressions into zoompan's `x`/`y` top-left expressions.
/// `zoom` inside is bound by zoompan to the branch's own evaluated `z`, so the
/// same wrap serves the sharp stage and every blur tap.
pub(crate) fn wrap_zoompan_xy(cx_expr: &str, cy_expr: &str) -> (String, String) {
    let x_expr = format!("if(lte(zoom,1.001),0,max(0,min(iw-iw/zoom,({cx_expr})-(iw/zoom)/2)))");
    let y_expr = format!("if(lte(zoom,1.001),0,max(0,min(ih-ih/zoom,({cy_expr})-(ih/zoom)/2)))");
    (x_expr, y_expr)
}

/// Kept for the expression tests (and as the readable form of the crop+wrap
/// pair); the live zoom stage composes `build_zoompan_crop_expressions` and
/// `wrap_zoompan_xy` directly so blur taps can reuse the centres.
#[allow(dead_code)]
pub(crate) fn build_zoompan_expressions(
    plan: &RenderPlan,
    canvas: &cursor::RenderCanvas,
    screen_w: f64,
    screen_h: f64,
) -> (String, String, String) {
    let (z_expr, cx_expr, cy_expr) =
        build_zoompan_crop_expressions(plan, canvas, screen_w, screen_h);
    let (x_expr, y_expr) = wrap_zoompan_xy(&cx_expr, &cy_expr);

    (z_expr, x_expr, y_expr)
}

/// Retarget a zoompan expression to a frame time `offset_s` seconds away: the
/// only time-varying token the expression builder emits is `it` (the input
/// timestamp), so a whole-identifier replace shifts the sampled crop — the
/// trick behind the motion-blur shutter taps.
pub(crate) fn shift_zoompan_time(expr: &str, offset_s: f64) -> String {
    if offset_s.abs() < 1e-9 {
        return expr.to_string();
    }
    let replacement = if offset_s > 0.0 {
        format!("(it+{})", compact_num(offset_s))
    } else {
        format!("(it-{})", compact_num(-offset_s))
    };
    let mut out = String::with_capacity(expr.len() + 8);
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let bytes = expr.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'i'
            && bytes.get(i + 1) == Some(&b't')
            && (i == 0 || !is_ident(bytes[i - 1]))
            && bytes.get(i + 2).is_none_or(|next| !is_ident(*next))
        {
            out.push_str(&replacement);
            i += 2;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// Reference exposure duration (ms) at `1.0` slider strength.
///
/// Anchoring the shutter to a 60 ms ceiling for 24+ fps recordings keeps
/// motion blur visually rich and consistent between 30 fps and 60 fps instead
/// of halving exposure at higher capture/export frame rates, while slower
/// outputs (e.g. 15 fps GIFs) still expand to a full frame interval.
pub(crate) const MOTION_BLUR_REFERENCE_EXPOSURE_MS: f64 = 60.0;

/// Full-strength (`1.0`) shutter exposure window in milliseconds for `fps`.
pub(crate) fn motion_blur_shutter_base_ms(fps: u32) -> f64 {
    (1000.0 / fps.max(1) as f64).max(MOTION_BLUR_REFERENCE_EXPOSURE_MS)
}

/// Shutter half-windows for zoom/pan motion blur shared by both renderers.
///
/// `0.5` ("Natural") evaluates a 30 ms exposure (`±15 ms`) and `1.0`
/// ("Dynamic") evaluates 60 ms (`±30 ms`) at 24+ fps. Zoom and pan carry
/// independent half-windows so setting either slider scales exposure linearly
/// and enabling one axis never time-shifts or distorts the other.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MotionBlurParams {
    pub half_zoom_ms: f64,
    pub half_pan_ms: f64,
}

impl MotionBlurParams {
    /// True when pan blur is active at a different shutter width than zoom
    /// blur, so compat `zoompan` centre expressions must stay decoupled from
    /// zoompan's `zoom` variable.
    pub(crate) fn needs_independent_centers(&self) -> bool {
        self.half_pan_ms > 0.0 && (self.half_zoom_ms - self.half_pan_ms).abs() > 1e-6
    }
}

/// GPU shader tap cap (hardware bilinear taps in `composite.wgsl` are cheap,
/// so 32 taps eliminate stepping even on wide 60 ms 4K zooms).
pub(crate) const GPU_MAX_BLUR_TAPS: u32 = 32;

/// Compat cap on blur taps per branch: each tap is a `zoompan` + `scale`
/// branch, and 9 tapered taps keep wide cinema smears smooth without strobe
/// banding while staying well within interactive export budgets.
pub(crate) const COMPAT_MAX_BLUR_TAPS: u32 = 9;

/// Minimum output-screen sweep (px) before motion blur engages. Keeps still
/// frames and sub-pixel drift on the zero-cost sharp path.
const MIN_MOTION_BLUR_SWEEP_PX: f64 = 0.75;

/// Continuous normalized shutter strip evaluated for one frame.
/// `start` and `end` are `[x, y, w, h]` in normalized `[0, 1]` content UV space
/// (identical to `FrameParams.crop` in `composite.wgsl`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MotionBlurStrip {
    pub start: [f32; 4],
    pub end: [f32; 4],
    pub taps: u32,
    pub sweep_px: f64,
}

/// Tapered shutter weight for tap `tap` of `taps` (midpoint quadrature).
///
/// Mirrors the `0.45 + 0.55 * sin(PI * t)` curve in `composite.wgsl`, the
/// cursor shutter accumulator, and the WebGL preview shader so edges feather
/// naturally instead of showing hard box-filter double edges.
pub(crate) fn motion_blur_tap_weight(tap: u32, taps: u32) -> f64 {
    if taps <= 1 {
        return 1.0;
    }
    let progress = (tap as f64 + 0.5) / taps as f64;
    0.45 + 0.55 * (std::f64::consts::PI * progress).sin()
}

/// `None` when the plan has no active zoom/pan blur — the sharp zoom path is
/// emitted unchanged. `blur.cursor` is rasterizer work and never reaches here.
pub(crate) fn motion_blur_params(canvas: &cursor::RenderCanvas) -> Option<MotionBlurParams> {
    let blur = canvas.motion_blur.filter(|blur| blur.is_active())?;
    let zoom = blur.zoom.clamp(0.0, 1.0);
    let pan = blur.pan.clamp(0.0, 1.0);
    if zoom <= 0.0 && pan <= 0.0 {
        return None;
    }
    let base_ms = motion_blur_shutter_base_ms(canvas.fps);
    Some(MotionBlurParams {
        half_zoom_ms: base_ms * zoom / 2.0,
        half_pan_ms: base_ms * pan / 2.0,
    })
}

/// Canonical per-frame zoom/pan shutter strip in continuous normalized content
/// UV space, shared by the GPU compositor (which passes `start`/`end`/`taps`
/// directly to `composite.wgsl`) and the compat planner (which uses `taps` to
/// decide whether a frame/piece needs blur branches).
///
/// Evaluates the zoom crop width across `t ± half_zoom_ms` and the pan centre
/// across `t ± half_pan_ms` independently, centered on `t`, and sizes `taps`
/// from the **output screen-pixel** displacement across the four viewport
/// corners so zoomed-in pans never under-sample.
pub(crate) fn evaluate_motion_blur_strip(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &cursor::RenderCanvas,
    params: &MotionBlurParams,
    output_ms: f64,
    display_w: f64,
    display_h: f64,
) -> Option<MotionBlurStrip> {
    if zoom_segments.is_empty() || (params.half_zoom_ms <= 0.0 && params.half_pan_ms <= 0.0) {
        return None;
    }
    let cw = canvas.width.max(1) as f64;
    let ch = canvas.height.max(1) as f64;
    let eval = |time_ms: f64| {
        evaluate_zoom_transform(
            zoom_segments,
            canvas.width,
            canvas.height,
            canvas.padding,
            time_ms.max(0.0),
        )
    };
    let center = eval(output_ms);
    let c_w = center.crop_w.clamp(1.0, cw);
    let c_h = center.crop_h.clamp(1.0, ch);
    let c_cx = center.crop_x + c_w * 0.5;
    let c_cy = center.crop_y + c_h * 0.5;

    let same_window = params.half_zoom_ms > 0.0
        && params.half_pan_ms > 0.0
        && (params.half_zoom_ms - params.half_pan_ms).abs() < 1e-6;

    let (z_lo, z_hi) = if params.half_zoom_ms > 0.0 {
        (
            Some(eval(output_ms - params.half_zoom_ms)),
            Some(eval(output_ms + params.half_zoom_ms)),
        )
    } else {
        (None, None)
    };

    let (w_start, h_start, w_end, h_end) = match (z_lo.as_ref(), z_hi.as_ref()) {
        (Some(lo), Some(hi)) => (
            lo.crop_w.clamp(1.0, cw),
            lo.crop_h.clamp(1.0, ch),
            hi.crop_w.clamp(1.0, cw),
            hi.crop_h.clamp(1.0, ch),
        ),
        _ => (c_w, c_h, c_w, c_h),
    };

    let (cx_start, cy_start, cx_end, cy_end) = if params.half_pan_ms > 0.0 {
        let (p_lo, p_hi) = if same_window {
            (
                z_lo.expect("same_window guarantees z_lo"),
                z_hi.expect("same_window guarantees z_hi"),
            )
        } else {
            (
                eval(output_ms - params.half_pan_ms),
                eval(output_ms + params.half_pan_ms),
            )
        };
        (
            p_lo.crop_x + p_lo.crop_w * 0.5,
            p_lo.crop_y + p_lo.crop_h * 0.5,
            p_hi.crop_x + p_hi.crop_w * 0.5,
            p_hi.crop_y + p_hi.crop_h * 0.5,
        )
    } else {
        (c_cx, c_cy, c_cx, c_cy)
    };

    let norm_rect = |w: f64, h: f64, cx: f64, cy: f64| -> [f32; 4] {
        let nw = (w / cw).clamp(1.0 / cw, 1.0);
        let nh = (h / ch).clamp(1.0 / ch, 1.0);
        let nx = (cx / cw - nw * 0.5).clamp(0.0, 1.0 - nw);
        let ny = (cy / ch - nh * 0.5).clamp(0.0, 1.0 - nh);
        [nx as f32, ny as f32, nw as f32, nh as f32]
    };
    let start = norm_rect(w_start, h_start, cx_start, cy_start);
    let end = norm_rect(w_end, h_end, cx_end, cy_end);

    // Measure worst-case displacement across the four viewport corners in
    // output screen pixels (amplified by the active zoom factor).
    let crop_w_norm = (c_w / cw).max(1e-4);
    let crop_h_norm = (c_h / ch).max(1e-4);
    let dx_left = (end[0] as f64 - start[0] as f64).abs();
    let dx_right = ((end[0] + end[2]) as f64 - (start[0] + start[2]) as f64).abs();
    let dy_top = (end[1] as f64 - start[1] as f64).abs();
    let dy_bottom = ((end[1] + end[3]) as f64 - (start[1] + start[3]) as f64).abs();
    let screen_dx = dx_left.max(dx_right) / crop_w_norm * display_w.max(1.0);
    let screen_dy = dy_top.max(dy_bottom) / crop_h_norm * display_h.max(1.0);
    let sweep_px = screen_dx.hypot(screen_dy);

    if sweep_px < MIN_MOTION_BLUR_SWEEP_PX {
        return None;
    }
    let taps = ((sweep_px / 1.5).ceil() as u32).clamp(3, GPU_MAX_BLUR_TAPS);
    Some(MotionBlurStrip {
        start,
        end,
        taps,
        sweep_px,
    })
}

/// Samples a single frame's blur needs (1 = no movement → keep the sharp path).
pub(crate) fn motion_blur_frame_taps(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &cursor::RenderCanvas,
    params: &MotionBlurParams,
    output_ms: f64,
    screen_w: f64,
    screen_h: f64,
) -> u32 {
    evaluate_motion_blur_strip(zoom_segments, canvas, params, output_ms, screen_w, screen_h)
        .map(|strip| strip.taps)
        .unwrap_or(1)
}

/// Worst-case tap count across `[first_frame, +frame_count)`. The caller caps
/// it (`COMPAT_MAX_BLUR_TAPS`); the GPU reaches `GPU_MAX_BLUR_TAPS` because
/// shader taps cost a single hardware bilinear fetch while each compat tap is
/// a full `zoompan` branch.
pub(crate) fn motion_blur_window_taps(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &cursor::RenderCanvas,
    params: &MotionBlurParams,
    first_frame: u64,
    frame_count: u64,
    screen_w: f64,
    screen_h: f64,
) -> u32 {
    let fps = canvas.fps.max(1) as f64;
    (0..frame_count)
        .map(|offset| {
            motion_blur_frame_taps(
                zoom_segments,
                canvas,
                params,
                (first_frame + offset) as f64 * 1000.0 / fps,
                screen_w,
                screen_h,
            )
        })
        .max()
        .unwrap_or(1)
}

/// `z`/`x`/`y` for blur tap `tap` of `taps` using midpoint quadrature across
/// each axis's independent shutter window (`±half_zoom_ms` for `z`,
/// `±half_pan_ms` for `cx`/`cy`). Shifting `it` directly avoids duplicating
/// expressions and keeps FFmpeg's expression depth identical to the sharp path.
pub(crate) fn zoom_blur_tap_exprs(
    z_expr: &str,
    cx_expr: &str,
    cy_expr: &str,
    tap: u32,
    taps: u32,
    params: &MotionBlurParams,
) -> (String, String, String) {
    if taps <= 1 {
        let (x, y) = wrap_zoompan_xy(cx_expr, cy_expr);
        return (z_expr.to_string(), x, y);
    }
    let progress = (tap as f64 + 0.5) / taps as f64;
    let u = -1.0 + 2.0 * progress;
    let zoom_offset_s = u * params.half_zoom_ms / 1000.0;
    let pan_offset_s = u * params.half_pan_ms / 1000.0;
    let z = shift_zoompan_time(z_expr, zoom_offset_s);
    let cx = shift_zoompan_time(cx_expr, pan_offset_s);
    let cy = shift_zoompan_time(cy_expr, pan_offset_s);
    let (x, y) = wrap_zoompan_xy(&cx, &cy);
    (z, x, y)
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ------------------------------------------------------------------
    // Minimal FFmpeg filter-expression evaluator (test-only).
    // Supports: numbers, + - * /, parentheses, unary minus, commas, and the
    // functions emitted by `build_zoompan_expressions`: if, lt, lte, gt,
    // gte, between, min, max, exp, log, cos, sin, pow, abs — plus the
    // variables `it`, `iw`, `ih`, `zoom`.
    // ------------------------------------------------------------------

    struct ExprEval<'a> {
        text: &'a [u8],
        pos: usize,
        vars: &'a [(&'static str, f64)],
    }

    impl<'a> ExprEval<'a> {
        fn skip_ws(&mut self) {
            while self.pos < self.text.len() && self.text[self.pos].is_ascii_whitespace() {
                self.pos += 1;
            }
        }

        fn peek(&self) -> Option<u8> {
            self.text.get(self.pos).copied()
        }

        fn eat(&mut self, byte: u8) -> bool {
            self.skip_ws();
            if self.peek() == Some(byte) {
                self.pos += 1;
                true
            } else {
                false
            }
        }

        fn expr(&mut self) -> f64 {
            let mut value = self.term();
            loop {
                if self.eat(b'+') {
                    value += self.term();
                } else if self.eat(b'-') {
                    value -= self.term();
                } else {
                    return value;
                }
            }
        }

        fn term(&mut self) -> f64 {
            let mut value = self.unary();
            loop {
                if self.eat(b'*') {
                    value *= self.unary();
                } else if self.eat(b'/') {
                    value /= self.unary();
                } else {
                    return value;
                }
            }
        }

        fn unary(&mut self) -> f64 {
            self.skip_ws();
            if self.eat(b'-') {
                -self.unary()
            } else if self.eat(b'+') {
                self.unary()
            } else {
                self.primary()
            }
        }

        fn primary(&mut self) -> f64 {
            self.skip_ws();
            match self.peek() {
                Some(b'(') => {
                    self.pos += 1;
                    let value = self.expr();
                    assert!(self.eat(b')'), "expected closing paren in expression");
                    value
                }
                Some(byte) if byte.is_ascii_digit() || byte == b'.' => self.number(),
                Some(byte) if byte.is_ascii_alphabetic() || byte == b'_' => self.ident_or_call(),
                _ => panic!("unexpected byte {:?} at {}", self.peek(), self.pos),
            }
        }

        fn number(&mut self) -> f64 {
            let start = self.pos;
            while self.pos < self.text.len()
                && (self.text[self.pos].is_ascii_digit() || self.text[self.pos] == b'.')
            {
                self.pos += 1;
            }
            std::str::from_utf8(&self.text[start..self.pos])
                .unwrap()
                .parse()
                .unwrap()
        }

        fn ident_or_call(&mut self) -> f64 {
            let start = self.pos;
            while self.pos < self.text.len()
                && (self.text[self.pos].is_ascii_alphanumeric() || self.text[self.pos] == b'_')
            {
                self.pos += 1;
            }
            let name = std::str::from_utf8(&self.text[start..self.pos]).unwrap();
            self.skip_ws();
            if self.peek() != Some(b'(') {
                return self
                    .vars
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| *value)
                    .unwrap_or_else(|| panic!("unknown variable {name}"));
            }
            self.pos += 1;
            let mut args = Vec::new();
            loop {
                args.push(self.expr());
                if self.eat(b',') {
                    continue;
                }
                assert!(self.eat(b')'), "expected ) after {name} args");
                break;
            }
            match (name, args.as_slice()) {
                ("if", &[c, a, b]) => {
                    if c != 0.0 {
                        a
                    } else {
                        b
                    }
                }
                ("lt", &[a, b]) => ((a < b) as i32) as f64,
                ("lte", &[a, b]) => ((a <= b) as i32) as f64,
                ("gt", &[a, b]) => ((a > b) as i32) as f64,
                ("gte", &[a, b]) => ((a >= b) as i32) as f64,
                ("between", &[x, min, max]) => ((x >= min && x <= max) as i32) as f64,
                ("min", &[a, b]) => a.min(b),
                ("max", &[a, b]) => a.max(b),
                ("exp", &[a]) => a.exp(),
                ("log", &[a]) => a.ln(),
                ("cos", &[a]) => a.cos(),
                ("sin", &[a]) => a.sin(),
                ("pow", &[a, b]) => a.powf(b),
                ("abs", &[a]) => a.abs(),
                _ => panic!("unsupported function {name}({args:?})"),
            }
        }
    }

    fn eval_ffmpeg_expr(expression: &str, it_s: f64, iw: f64, ih: f64, zoom: f64) -> f64 {
        let vars = [("it", it_s), ("iw", iw), ("ih", ih), ("zoom", zoom)];
        ExprEval {
            text: expression.as_bytes(),
            pos: 0,
            vars: &vars,
        }
        .expr()
    }

    // ------------------------------------------------------------------
    // FFmpeg expression-tree depth (`libavutil/eval.c` `MAX_DEPTH` = 100).
    // Leaf nodes have depth 0; every function call, operator, or `if` adds
    // one to the depth of its deepest argument. FFmpeg's parser silently
    // drops a function argument whose subtree overflows, so expressions
    // must stay well under the limit.
    // ------------------------------------------------------------------

    struct ExprDepth<'a> {
        text: &'a [u8],
        pos: usize,
    }

    impl<'a> ExprDepth<'a> {
        fn skip_ws(&mut self) {
            while self.pos < self.text.len() && self.text[self.pos].is_ascii_whitespace() {
                self.pos += 1;
            }
        }

        fn peek(&self) -> Option<u8> {
            self.text.get(self.pos).copied()
        }

        fn eat(&mut self, byte: u8) -> bool {
            self.skip_ws();
            if self.peek() == Some(byte) {
                self.pos += 1;
                true
            } else {
                false
            }
        }

        fn expr(&mut self) -> usize {
            let mut depth = self.term();
            loop {
                if self.eat(b'+') || self.eat(b'-') {
                    depth = depth.max(self.term()) + 1;
                } else {
                    return depth;
                }
            }
        }

        fn term(&mut self) -> usize {
            let mut depth = self.unary();
            loop {
                if self.eat(b'*') || self.eat(b'/') || self.eat(b'%') {
                    depth = depth.max(self.unary()) + 1;
                } else {
                    return depth;
                }
            }
        }

        fn unary(&mut self) -> usize {
            self.skip_ws();
            // Sign folds into the parsed node's `value`; it adds no depth.
            if self.eat(b'-') || self.eat(b'+') {
                self.unary()
            } else {
                self.primary()
            }
        }

        fn primary(&mut self) -> usize {
            self.skip_ws();
            match self.peek() {
                Some(b'(') => {
                    self.pos += 1;
                    let depth = self.expr();
                    assert!(self.eat(b')'), "expected closing paren in expression");
                    depth
                }
                Some(byte) if byte.is_ascii_digit() || byte == b'.' => {
                    while self.pos < self.text.len()
                        && (self.text[self.pos].is_ascii_digit() || self.text[self.pos] == b'.')
                    {
                        self.pos += 1;
                    }
                    0
                }
                Some(byte) if byte.is_ascii_alphabetic() || byte == b'_' => {
                    while self.pos < self.text.len()
                        && (self.text[self.pos].is_ascii_alphanumeric()
                            || self.text[self.pos] == b'_')
                    {
                        self.pos += 1;
                    }
                    self.skip_ws();
                    if self.peek() != Some(b'(') {
                        return 0;
                    }
                    self.pos += 1;
                    let mut depth = 0;
                    loop {
                        depth = depth.max(self.expr());
                        if self.eat(b',') {
                            continue;
                        }
                        assert!(self.eat(b')'), "expected ) after function args");
                        break;
                    }
                    depth + 1
                }
                other => panic!("unexpected byte {other:?} at {}", self.pos),
            }
        }
    }

    fn ffmpeg_expr_depth(expression: &str) -> usize {
        let mut parser = ExprDepth {
            text: expression.as_bytes(),
            pos: 0,
        };
        parser.expr()
    }

    fn test_plan(zoom_segments: Vec<RenderPlanZoomSegment>) -> RenderPlan {
        RenderPlan {
            project_id: "camera-test".into(),
            camera_layouts: Vec::new(),
            layer_order: Vec::new(),
            duration_ms: 5_000,
            segments: vec![super::super::RenderSegment {
                asset_id: "asset-screen".into(),
                stream_index: Some(0),
                volume: None,
                fade_in_ms: None,
                fade_out_ms: None,
                volume_keyframes: None,
                audio_filter: None,
                speed: 1.0,
                source_in_ms: 0,
                source_out_ms: 5_000,
                output_start_ms: 0,
                output_end_ms: 5_000,
                source_width: None,
                source_height: None,
            }],
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments,
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(cursor::RenderCanvas {
                width: 1_920,
                height: 1_080,
                fps: 30,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            keystrokes: Vec::new(),
            keystroke_platform: "unknown".into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn zoom_segment(
        id: &str,
        start_ms: u64,
        end_ms: u64,
        target: RenderCropFloat,
        scale: f64,
        easing: &str,
        transition_in_ms: u64,
        transition_out_ms: u64,
        from_target: Option<RenderCropFloat>,
    ) -> RenderPlanZoomSegment {
        RenderPlanZoomSegment {
            style: None,
            loupe: None,
            id: id.into(),
            start_ms,
            end_ms,
            target,
            scale,
            easing: easing.into(),
            transition_in_ms,
            transition_out_ms,
            enabled: true,
            mode: "manual".into(),
            source: "auto".into(),
            preset: "product-demo".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target,
            from_scale: None,
            keyframes: None,
            motion_plan: None,
        }
    }

    #[test]
    fn zoom_pieces_split_identity_hold_and_identity_runs() {
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        // Immediate step to 2x between 1 s and 3 s: the steady crop needs no
        // zoompan at all.
        let segments = vec![zoom_segment(
            "hold",
            1_000,
            3_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            0,
            0,
            None,
        )];
        let pieces = classify_zoom_pieces(&segments, &canvas, 0, 120, 1_920.0, 1_080.0)
            .expect("piecewise classification");
        assert_eq!(pieces.len(), 3, "identity / hold / identity");
        assert_eq!(pieces[0].kind, ZoomPieceKind::Identity);
        assert_eq!((pieces[0].start_frame, pieces[0].end_frame), (0, 30));
        assert_eq!(
            pieces[1].kind,
            ZoomPieceKind::Hold {
                x: 480,
                y: 270,
                w: 960,
                h: 540
            }
        );
        assert_eq!((pieces[1].start_frame, pieces[1].end_frame), (30, 90));
        assert_eq!(pieces[2].kind, ZoomPieceKind::Identity);
        assert_eq!((pieces[2].start_frame, pieces[2].end_frame), (90, 120));
        // Frames tile the window exactly, with no gaps or overlap.
        for pair in pieces.windows(2) {
            assert_eq!(pair[0].end_frame, pair[1].start_frame);
        }
    }

    #[test]
    fn zoom_pieces_keep_animated_frames_as_transitions() {
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        let segments = vec![zoom_segment(
            "eased",
            1_000,
            3_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "cinematic",
            500,
            500,
            None,
        )];
        let pieces = classify_zoom_pieces(&segments, &canvas, 0, 120, 1_920.0, 1_080.0)
            .expect("piecewise classification");
        // Identity → animated in → steady hold → animated out → identity.
        assert_eq!(pieces[0].kind, ZoomPieceKind::Identity);
        assert!(
            pieces
                .iter()
                .any(|piece| piece.kind == ZoomPieceKind::Transition),
            "the eased in/out phases must stay on zoompan"
        );
        assert!(
            pieces
                .iter()
                .any(|piece| matches!(piece.kind, ZoomPieceKind::Hold { .. })),
            "the steady middle of the zoom must use crop+scale"
        );
        let covered: u64 = pieces
            .iter()
            .map(|piece| piece.end_frame - piece.start_frame)
            .sum();
        assert_eq!(covered, 120);
    }

    #[test]
    fn zoom_pieces_keep_a_whole_window_hold_as_one_run() {
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        // A window entirely inside a steady 2x zoom: one hold run is enough to
        // drop zoompan, even though there is nothing to splice.
        let segments = vec![zoom_segment(
            "steady",
            0,
            10_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            0,
            0,
            None,
        )];
        let pieces = classify_zoom_pieces(&segments, &canvas, 0, 150, 1_920.0, 1_080.0)
            .expect("whole-window hold");
        assert_eq!(pieces.len(), 1);
        assert_eq!(
            pieces[0].kind,
            ZoomPieceKind::Hold {
                x: 480,
                y: 270,
                w: 960,
                h: 540
            }
        );
    }

    #[test]
    fn zoom_pieces_fall_back_when_the_graph_would_explode() {
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        // Alternating short zoom levels change the crop every 200 ms, giving
        // many runs: the caller must fall back to one zoompan stage.
        let segments = (0..8)
            .map(|index| {
                let start = index * 200;
                zoom_segment(
                    &format!("step-{index}"),
                    start,
                    start + 200,
                    RenderCropFloat {
                        x: 0.0,
                        y: 0.0,
                        width: 640.0 - index as f64 * 20.0,
                        height: 360.0,
                    },
                    1.0,
                    "linear",
                    0,
                    0,
                    None,
                )
            })
            .collect::<Vec<_>>();
        assert!(
            classify_zoom_pieces(&segments, &canvas, 0, 90, 1_920.0, 1_080.0).is_none(),
            "piecewise zoom is bounded by MAX_ZOOM_PIECES"
        );
    }

    #[test]
    fn zoompan_expressions_match_the_numeric_evaluator() {
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        let motion_plan = RenderPlanZoomMotionPlan {
            version: 1,
            kind: "cubic-bezier".into(),
            segments: vec![RenderPlanZoomMotionSegment {
                start_ms: 3_400,
                end_ms: 4_600,
                start: RenderPlanZoomMotionPoint { x: 480.0, y: 270.0 },
                control1: RenderPlanZoomMotionPoint { x: 900.0, y: 200.0 },
                control2: RenderPlanZoomMotionPoint {
                    x: 1_100.0,
                    y: 700.0,
                },
                end: RenderPlanZoomMotionPoint {
                    x: 1_400.0,
                    y: 540.0,
                },
            }],
        };
        let mut follow = zoom_segment(
            "follow",
            3_400,
            4_600,
            RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            0,
            0,
            None,
        );
        follow.motion_plan = Some(motion_plan);
        follow.mode = "follow-cursor".into();

        let segments = vec![
            // Static in/hold/out with a symmetric easing.
            zoom_segment(
                "static",
                0,
                1_200,
                RenderCropFloat {
                    x: 480.0,
                    y: 270.0,
                    width: 960.0,
                    height: 540.0,
                },
                2.0,
                "cinematic",
                300,
                300,
                None,
            ),
            // Bridged pan from the previous target.
            zoom_segment(
                "bridged",
                1_200,
                2_200,
                RenderCropFloat {
                    x: 1_200.0,
                    y: 540.0,
                    width: 640.0,
                    height: 360.0,
                },
                3.0,
                "snappy",
                300,
                300,
                Some(RenderCropFloat {
                    x: 480.0,
                    y: 270.0,
                    width: 960.0,
                    height: 540.0,
                }),
            ),
            // Spring overshoot through in and out phases.
            zoom_segment(
                "spring",
                2_200,
                3_400,
                RenderCropFloat {
                    x: 0.0,
                    y: 0.0,
                    width: 640.0,
                    height: 360.0,
                },
                3.0,
                "spring",
                400,
                300,
                None,
            ),
            follow,
        ];
        let plan = test_plan(segments.clone());
        let (z_expr, x_expr, y_expr) = build_zoompan_expressions(&plan, &canvas, 1_920.0, 1_080.0);

        let iw = 1_920.0;
        let ih = 1_080.0;
        let canvas_w = canvas.width as f64;
        let canvas_h = canvas.height as f64;

        for step in 0..=60 {
            let t_ms = step as f64 * 4_600.0 / 60.0;
            let it_s = t_ms / 1_000.0;

            let state = evaluate_zoom_transform(&segments, canvas.width, canvas.height, 0, t_ms);
            let zoom_num = (canvas_w / state.crop_w.max(1e-6)).clamp(1.0, 10.0);
            let zoom_expr = eval_ffmpeg_expr(&z_expr, it_s, iw, ih, f64::NAN).clamp(1.0, 10.0);
            assert!(
                (zoom_expr - zoom_num).abs() < 0.01,
                "zoom at {t_ms}ms: expr {zoom_expr} vs numeric {zoom_num}"
            );

            let x_expr_val = eval_ffmpeg_expr(&x_expr, it_s, iw, ih, zoom_expr);
            let y_expr_val = eval_ffmpeg_expr(&y_expr, it_s, iw, ih, zoom_expr);
            let expected_x =
                (state.crop_x / canvas_w * iw).clamp(0.0, (iw - iw / zoom_num).max(0.0));
            let expected_y =
                (state.crop_y / canvas_h * ih).clamp(0.0, (ih - ih / zoom_num).max(0.0));
            assert!(
                (x_expr_val - expected_x).abs() < 0.75,
                "x at {t_ms}ms: expr {x_expr_val} vs numeric {expected_x}"
            );
            assert!(
                (y_expr_val - expected_y).abs() < 0.75,
                "y at {t_ms}ms: expr {y_expr_val} vs numeric {expected_y}"
            );
        }
    }

    #[test]
    fn zoompan_integer_crop_matches_ffmpeg_quantization() {
        // canvas 1920x1080, zoompan input 2560x1440, crop (480,270,960,540)
        // -> zoom 2 -> w=1280 h=720; crop center (960,540) -> screen
        // (1280,720); dx = 1280-640 = 640, dy = 720-360 = 360.
        let (x, y, w, h) = zoompan_integer_crop(
            (480.0, 270.0, 960.0, 540.0),
            2_560.0,
            1_440.0,
            1_920.0,
            1_080.0,
            1,
            1,
        );
        assert_eq!((x, y, w, h), (640, 360, 1280, 720));

        // Chroma snap clears the low bit of the origin.
        let (x, y, _, _) = zoompan_integer_crop(
            (480.5, 270.4, 960.0, 540.0),
            2_560.0,
            1_440.0,
            1_920.0,
            1_080.0,
            1,
            1,
        );
        assert_eq!(x % 2, 0);
        assert_eq!(y % 2, 0);

        // Full-frame crop: zoom = 1, whole input, origin 0.
        let (x, y, w, h) = zoompan_integer_crop(
            (0.0, 0.0, 1_920.0, 1_080.0),
            2_560.0,
            1_440.0,
            1_920.0,
            1_080.0,
            1,
            1,
        );
        assert_eq!((x, y, w, h), (0, 0, 2560, 1440));

        // Crop pushed past the bottom-right edge clamps at in - crop.
        let (x, y, w, h) = zoompan_integer_crop(
            (1_500.0, 900.0, 960.0, 540.0),
            2_560.0,
            1_440.0,
            1_920.0,
            1_080.0,
            1,
            1,
        );
        // Center (1980, 1170) -> screen (2640, 1560) -> dx clamps to
        // in_w - w = 1280, dy to 720.
        assert_eq!((x, y, w, h), (1280, 720, 1280, 720));
    }

    #[test]
    fn camera_crops_fixture_matches_typescript() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCrop {
            x: f64,
            y: f64,
            width: f64,
            height: f64,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureSegment {
            start_ms: u64,
            duration_ms: u64,
            target: FixtureCrop,
            scale: f64,
            easing: String,
            transition_in_ms: u64,
            transition_out_ms: u64,
            from_target: Option<FixtureCrop>,
            from_scale: Option<f64>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureFrame {
            time_ms: f64,
            crop: FixtureCrop,
            #[allow(dead_code)]
            scale: f64,
            #[allow(dead_code)]
            progress: f64,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCase {
            name: String,
            canvas: FixtureCanvas,
            segment: FixtureSegment,
            frames: Vec<FixtureFrame>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureCanvas {
            width: u32,
            height: u32,
            padding: u32,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<FixtureCase>,
        }

        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tooling/fixtures/camera-fixtures/camera-crops.json");
        let json = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let fixture: Fixture = serde_json::from_str(&json).expect("parse camera fixture");
        assert!(!fixture.cases.is_empty());

        fn to_crop(crop: &FixtureCrop) -> RenderCropFloat {
            RenderCropFloat {
                x: crop.x,
                y: crop.y,
                width: crop.width,
                height: crop.height,
            }
        }

        for case in &fixture.cases {
            let segment = RenderPlanZoomSegment {
                style: None,
                loupe: None,
                id: format!("fixture-{}", case.name),
                start_ms: case.segment.start_ms,
                end_ms: case.segment.start_ms + case.segment.duration_ms,
                target: to_crop(&case.segment.target),
                scale: case.segment.scale,
                easing: case.segment.easing.clone(),
                transition_in_ms: case.segment.transition_in_ms,
                transition_out_ms: case.segment.transition_out_ms,
                enabled: true,
                mode: "manual".into(),
                source: "auto".into(),
                preset: "product-demo".into(),
                follow_deadzone_percent: None,
                follow_smoothing_alpha: None,
                label: None,
                from_target: case.segment.from_target.as_ref().map(to_crop),
                from_scale: case.segment.from_scale,
                keyframes: None,
                motion_plan: None,
            };
            let segments = vec![segment];
            for frame in &case.frames {
                let state = evaluate_zoom_transform(
                    &segments,
                    case.canvas.width,
                    case.canvas.height,
                    case.canvas.padding,
                    frame.time_ms,
                );
                let (dx, dy, dw, dh) = (
                    (state.crop_x - frame.crop.x).abs(),
                    (state.crop_y - frame.crop.y).abs(),
                    (state.crop_w - frame.crop.width).abs(),
                    (state.crop_h - frame.crop.height).abs(),
                );
                assert!(
                    dx < 0.5 && dy < 0.5 && dw < 0.5 && dh < 0.5,
                    "case {} at {}ms: rust crop ({}, {}, {}, {}) vs ts ({}, {}, {}, {})",
                    case.name,
                    frame.time_ms,
                    state.crop_x,
                    state.crop_y,
                    state.crop_w,
                    state.crop_h,
                    frame.crop.x,
                    frame.crop.y,
                    frame.crop.width,
                    frame.crop.height,
                );
            }
        }
    }

    /// A motion plan the size of a real follow-cursor zoom (~40 cubic
    /// segments), which is what pushed the old linear if-chain past FFmpeg's
    /// expression-tree depth limit on long recordings. Endpoints are shared
    /// between neighbours like the cursor engine emits them: at a shared
    /// boundary the numeric evaluator reports the earlier segment's `end`
    /// while the FFmpeg expression evaluates the next segment's `start` —
    /// equal only when the chain is continuous.
    fn dense_motion_plan(
        start_ms: u64,
        end_ms: u64,
        motion_segments: usize,
    ) -> RenderPlanZoomMotionPlan {
        let step = (end_ms - start_ms) / motion_segments.max(1) as u64;
        let point = |i: usize| {
            let t = i as f64 / motion_segments as f64;
            RenderPlanZoomMotionPoint {
                x: 200.0 + 1_200.0 * (t * 3.0).sin().abs(),
                y: 120.0 + 700.0 * (t * 2.0).cos().abs(),
            }
        };
        let segments = (0..motion_segments)
            .map(|i| {
                let start = point(i);
                let end = point(i + 1);
                RenderPlanZoomMotionSegment {
                    start_ms: start_ms + i as u64 * step,
                    end_ms: start_ms + (i as u64 + 1) * step,
                    control1: RenderPlanZoomMotionPoint {
                        x: start.x + (end.x - start.x) / 3.0,
                        y: start.y + (end.y - start.y) / 3.0,
                    },
                    control2: RenderPlanZoomMotionPoint {
                        x: start.x + (end.x - start.x) * 2.0 / 3.0,
                        y: start.y + (end.y - start.y) * 2.0 / 3.0,
                    },
                    start,
                    end,
                }
            })
            .collect();
        RenderPlanZoomMotionPlan {
            version: 1,
            kind: "cubic-bezier".into(),
            segments,
        }
    }

    /// Regression test for the FFmpeg `MAX_DEPTH` overflow: a long export
    /// (~96 zoom segments, several with dense follow-cursor motion plans and
    /// a few overlapping ranges) used to emit a linear `if` chain whose x/y
    /// expressions exceeded 100 tree depth; FFmpeg then silently dropped the
    /// overflowing argument and pinned the crop at (0,0) while `z` still
    /// zoomed — the exported video zoomed onto the wrong region and the
    /// rendered cursor missed its target.
    #[test]
    fn zoompan_expressions_stay_under_ffmpeg_depth_limit_on_long_plans() {
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        let easings = ["linear", "cinematic", "snappy", "smooth", "spring"];
        let mut segments: Vec<RenderPlanZoomSegment> = Vec::new();
        for i in 0..96u64 {
            let start_ms = 4_000 + i * 12_000;
            let end_ms = start_ms + 8_000;
            let mut segment = zoom_segment(
                &format!("seg-{i:02}"),
                start_ms,
                end_ms,
                RenderCropFloat {
                    x: (i * 37 % 960) as f64,
                    y: (i * 53 % 540) as f64,
                    width: 640.0 + (i % 3) as f64 * 160.0,
                    height: 360.0 + (i % 3) as f64 * 90.0,
                },
                1.5 + (i % 4) as f64 * 0.5,
                easings[i as usize % easings.len()],
                if i % 2 == 0 { 300 } else { 0 },
                if i % 3 == 0 { 400 } else { 0 },
                if i % 5 == 0 {
                    Some(RenderCropFloat {
                        x: 100.0,
                        y: 60.0,
                        width: 960.0,
                        height: 540.0,
                    })
                } else {
                    None
                },
            );
            if i % 7 == 3 {
                segment.mode = "follow-cursor".into();
                segment.motion_plan = Some(dense_motion_plan(start_ms, end_ms, 40));
            }
            segments.push(segment);
        }
        // Overlapping ranges exercise the right-subtree fallback tails: a
        // later-starting segment must win while it is active, and the earlier
        // segment must take over again once the overlap ends.
        let overlap_a = zoom_segment(
            "overlap-a",
            50_000,
            90_000,
            RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            0,
            0,
            None,
        );
        let overlap_b = zoom_segment(
            "overlap-b",
            70_000,
            80_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 640.0,
                height: 360.0,
            },
            3.0,
            "linear",
            0,
            0,
            None,
        );
        segments.push(overlap_a);
        segments.push(overlap_b);

        let plan = test_plan(segments.clone());
        let (z_expr, x_expr, y_expr) = build_zoompan_expressions(&plan, &canvas, 1_920.0, 1_080.0);

        // The old linear if-chain over these same segments would exceed
        // FFmpeg's MAX_DEPTH (100) — measure it to pin down the regression.
        let segment_exprs = collect_zoompan_segment_exprs(&plan, &canvas, 1_920.0, 1_080.0, false);
        let fallback = ("1.0".to_string(), "960".to_string(), "540".to_string());
        let linear = segment_exprs.iter().fold(fallback.clone(), |acc, segment| {
            zoompan_segment_exprs_guard(segment, acc)
        });
        assert!(
            ffmpeg_expr_depth(&format!(
                "if(lte(zoom,1.001),0,max(0,min(iw-iw/zoom,({})-(iw/zoom)/2)))",
                linear.1
            )) > 100,
            "linear chain should reproduce the historical overflow"
        );

        for (name, expr) in [("z", &z_expr), ("x", &x_expr), ("y", &y_expr)] {
            let depth = ffmpeg_expr_depth(expr);
            assert!(
                depth <= 80,
                "{name} expression depth {depth} approaches FFmpeg's MAX_DEPTH (100)"
            );
        }

        // Parity against the numeric evaluator on a dense grid, including
        // the overlap windows and motion-plan holds.
        let iw = 1_920.0;
        let ih = 1_080.0;
        let canvas_w = canvas.width as f64;
        let canvas_h = canvas.height as f64;
        let duration_ms = 4_000.0 + 96.0 * 12_000.0;
        for step in 0..=600 {
            let t_ms = step as f64 * duration_ms / 600.0;
            let it_s = t_ms / 1_000.0;

            let state = evaluate_zoom_transform(&segments, canvas.width, canvas.height, 0, t_ms);
            let zoom_num = (canvas_w / state.crop_w.max(1e-6)).clamp(1.0, 10.0);
            let zoom_expr = eval_ffmpeg_expr(&z_expr, it_s, iw, ih, f64::NAN).clamp(1.0, 10.0);
            assert!(
                (zoom_expr - zoom_num).abs() < 0.01,
                "zoom at {t_ms}ms: expr {zoom_expr} vs numeric {zoom_num}"
            );

            let x_expr_val = eval_ffmpeg_expr(&x_expr, it_s, iw, ih, zoom_expr);
            let y_expr_val = eval_ffmpeg_expr(&y_expr, it_s, iw, ih, zoom_expr);
            let expected_x =
                (state.crop_x / canvas_w * iw).clamp(0.0, (iw - iw / zoom_num).max(0.0));
            let expected_y =
                (state.crop_y / canvas_h * ih).clamp(0.0, (ih - ih / zoom_num).max(0.0));
            assert!(
                (x_expr_val - expected_x).abs() < 0.75,
                "x at {t_ms}ms: expr {x_expr_val} vs numeric {expected_x}"
            );
            assert!(
                (y_expr_val - expected_y).abs() < 0.75,
                "y at {t_ms}ms: expr {y_expr_val} vs numeric {expected_y}"
            );
        }
    }

    #[test]
    fn window_needs_zoom_only_inside_zoom_regions() {
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        let segments = vec![zoom_segment(
            "zoom",
            4_000,
            9_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            1.5,
            "linear",
            0,
            0,
            None,
        )];
        // Frames before, inside, and after the region (region is [120, 270)).
        assert!(!window_needs_zoom(&segments, &canvas, 0, 120));
        assert!(window_needs_zoom(&segments, &canvas, 120, 150));
        assert!(!window_needs_zoom(&segments, &canvas, 270, 120));
        // A window that only clips the region's last frame still needs zoom.
        assert!(window_needs_zoom(&segments, &canvas, 269, 1));
        // No enabled segments at all is always identity.
        assert!(!window_needs_zoom(&segments, &canvas, 120, 0));
        let mut disabled = segments.clone();
        disabled[0].enabled = false;
        assert!(!window_needs_zoom(&disabled, &canvas, 120, 150));
    }

    #[test]
    fn window_needs_zoom_includes_motion_blur_boundary_frames() {
        let segments = vec![zoom_segment(
            "zoom",
            4_000,
            9_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            1.5,
            "linear",
            450,
            450,
            None,
        )];
        // Chunk [0, 120) ends at frame 119 (t = 3966.67 ms): 33.33 ms before
        // zoom_segment starts at 4000 ms. Without motion blur, it stays identity.
        let canvas_sharp = blur_canvas(None);
        assert!(!window_needs_zoom(&segments, &canvas_sharp, 0, 120));

        // With zoom/pan motion blur at 1.0 (half_max = 30 ms -> +half lands at
        // 3996.67 ms, still < 4000 ms), 119 is outside 30 ms, so check frame 119
        // relative to a segment starting at 3990 ms where frame 119's shutter
        // reaches 3996.67 ms into the zoom!
        let boundary_segments = vec![zoom_segment(
            "zoom",
            3_990,
            9_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            1.5,
            "linear",
            450,
            450,
            None,
        )];
        assert!(!window_needs_zoom(
            &boundary_segments,
            &canvas_sharp,
            0,
            120
        ));
        let canvas_blur = blur_canvas(Some(cursor::RenderMotionBlur {
            enabled: true,
            cursor: 0.0,
            zoom: 1.0,
            pan: 1.0,
        }));
        assert!(window_needs_zoom(&boundary_segments, &canvas_blur, 0, 120));
    }

    #[test]
    fn zoom_region_frame_edges_clamp_and_dedupe() {
        let segments = vec![
            zoom_segment(
                "a",
                1_000,
                2_000,
                RenderCropFloat {
                    x: 0.0,
                    y: 0.0,
                    width: 960.0,
                    height: 540.0,
                },
                2.0,
                "linear",
                0,
                0,
                None,
            ),
            zoom_segment(
                "b",
                2_000,
                2_500,
                RenderCropFloat {
                    x: 0.0,
                    y: 0.0,
                    width: 960.0,
                    height: 540.0,
                },
                2.0,
                "linear",
                0,
                0,
                None,
            ),
        ];
        assert_eq!(
            zoom_region_frame_edges(&segments, 30, 300),
            vec![30, 60, 75]
        );
        // Frames outside the plan are dropped.
        assert_eq!(zoom_region_frame_edges(&segments, 30, 45), vec![30]);
        // A disabled region contributes nothing.
        let mut disabled = segments;
        disabled[0].enabled = false;
        assert_eq!(zoom_region_frame_edges(&disabled, 30, 300), vec![60, 75]);
    }

    // ------------------------------------------------------------------
    // Compat zoom/pan motion blur (M2 #1)
    // ------------------------------------------------------------------

    fn blur_canvas(blur: Option<cursor::RenderMotionBlur>) -> cursor::RenderCanvas {
        cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            motion_blur: blur,
            ..Default::default()
        }
    }

    #[test]
    fn motion_blur_params_needs_an_active_zoom_or_pan_shutter() {
        assert!(motion_blur_params(&blur_canvas(None)).is_none());
        assert!(
            motion_blur_params(&blur_canvas(Some(cursor::RenderMotionBlur {
                enabled: false,
                zoom: 0.8,
                ..Default::default()
            })))
            .is_none()
        );
        // Cursor-only blur is rasterizer work — no zoom/pan taps.
        assert!(
            motion_blur_params(&blur_canvas(Some(cursor::RenderMotionBlur {
                enabled: true,
                cursor: 0.8,
                ..Default::default()
            })))
            .is_none()
        );
        let canvas_with_blur = blur_canvas(Some(cursor::RenderMotionBlur {
            enabled: true,
            cursor: 0.0,
            zoom: 0.5,
            pan: 0.8,
        }));
        let params = motion_blur_params(&canvas_with_blur).expect("active zoom/pan blur");
        // Cinema-calibrated half-windows: 60 ms reference base -> 0.5 = 15 ms,
        // 0.8 = 24 ms — identical at 30 fps and 60 fps!
        let base_30 = motion_blur_shutter_base_ms(30);
        assert!((base_30 - 60.0).abs() < 1e-9);
        assert!((params.half_zoom_ms - base_30 * 0.25).abs() < 1e-9);
        assert!((params.half_pan_ms - base_30 * 0.4).abs() < 1e-9);
        assert!(params.needs_independent_centers());

        let mut canvas_60 = canvas_with_blur.clone();
        canvas_60.fps = 60;
        let params_60 = motion_blur_params(&canvas_60).expect("active 60fps blur");
        assert!((params_60.half_zoom_ms - params.half_zoom_ms).abs() < 1e-9);
        assert!((params_60.half_pan_ms - params.half_pan_ms).abs() < 1e-9);

        let mut canvas_15 = canvas_with_blur;
        canvas_15.fps = 15;
        let params_15 = motion_blur_params(&canvas_15).expect("active 15fps blur");
        assert!((params_15.half_zoom_ms - (1000.0 / 15.0) * 0.25).abs() < 1e-9);
    }

    #[test]
    fn shift_zoompan_time_rewrites_only_bare_it() {
        let expr = "if(gte(it,1.0)*lt(it,2.5),it*2,bit+it2+x_it+start)";
        let shifted = shift_zoompan_time(expr, 0.5);
        assert_eq!(
            shifted,
            "if(gte((it+0.5),1.0)*lt((it+0.5),2.5),(it+0.5)*2,bit+it2+x_it+start)"
        );
        assert_eq!(shift_zoompan_time(expr, 0.0), expr);
        let back = shift_zoompan_time("gte(it,1)", -0.25);
        assert_eq!(back, "gte((it-0.25),1)");
    }

    #[test]
    fn zoom_blur_tap_exprs_sweep_axes_independently_with_midpoint_quadrature() {
        let params = MotionBlurParams {
            half_zoom_ms: 10.0,
            half_pan_ms: 5.0,
        };
        // One tap is the sharp path verbatim.
        let (z, _, _) = zoom_blur_tap_exprs("Z", "CX", "CY", 0, 1, &params);
        assert_eq!(z, "Z");
        // Five midpoint taps: u = -0.8, -0.4, 0.0, +0.4, +0.8.
        let (z_first, x_first, _) = zoom_blur_tap_exprs("it", "it*2", "it*3", 0, 5, &params);
        assert_eq!(z_first, "(it-0.008)");
        assert!(
            x_first.contains("(it-0.004)*2"),
            "pan shifts by half_pan_ms without duplicating base expression: {x_first}"
        );
        let (z_mid, x_mid, _) = zoom_blur_tap_exprs("it", "it*2", "it*3", 2, 5, &params);
        assert_eq!(z_mid, "it");
        assert!(x_mid.contains("(it*2)"));
        let (z_last, x_last, _) = zoom_blur_tap_exprs("it", "it*2", "it*3", 4, 5, &params);
        assert_eq!(z_last, "(it+0.008)");
        assert!(x_last.contains("(it+0.004)*2"));

        // Pan-only blur keeps z unshifted while shifting cx/cy.
        let pan_only = MotionBlurParams {
            half_zoom_ms: 0.0,
            half_pan_ms: 10.0,
        };
        let (z_pan, x_pan, _) = zoom_blur_tap_exprs("it", "it*2", "it*3", 0, 5, &pan_only);
        assert_eq!(z_pan, "it");
        assert!(x_pan.contains("(it-0.008)*2"));
    }

    #[test]
    fn compat_pan_only_center_expression_moves_independently_of_zoom() {
        let canvas = blur_canvas(Some(cursor::RenderMotionBlur {
            enabled: true,
            cursor: 0.0,
            zoom: 0.0,
            pan: 1.0,
        }));
        let params = motion_blur_params(&canvas).unwrap();
        assert!(params.needs_independent_centers());
        let segments = vec![zoom_segment(
            "zoom",
            1_000,
            3_000,
            RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            500,
            0,
            None,
        )];
        let mut plan = test_plan(segments);
        plan.duration_ms = 4_000;
        plan.canvas = Some(canvas.clone());
        let (z_expr, cx_expr, cy_expr) = build_zoompan_crop_expressions_with_options(
            &plan,
            &canvas,
            1_920.0,
            1_080.0,
            params.needs_independent_centers(),
        );
        let (z0, x0, _) = zoom_blur_tap_exprs(&z_expr, &cx_expr, &cy_expr, 0, 5, &params);
        let (z4, x4, _) = zoom_blur_tap_exprs(&z_expr, &cx_expr, &cy_expr, 4, 5, &params);
        let eval_at = |z_s: &str, x_s: &str, t: f64| -> (f64, f64) {
            let z_val = eval_ffmpeg_expr(z_s, t, 1_920.0, 1_080.0, 1.0);
            let x_val = eval_ffmpeg_expr(x_s, t, 1_920.0, 1_080.0, z_val);
            (z_val, x_val)
        };
        let (zv0, xv0) = eval_at(&z0, &x0, 1.25);
        let (zv4, xv4) = eval_at(&z4, &x4, 1.25);
        assert!(
            (zv0 - zv4).abs() < 1e-6,
            "pan-only blur keeps zoom identical across taps: {zv0} vs {zv4}"
        );
        assert!(
            (xv0 - xv4).abs() > 2.0,
            "pan-only blur must actually sweep x across taps: {xv0} vs {xv4}"
        );
    }

    #[test]
    fn evaluate_motion_blur_strip_is_symmetric_and_axis_independent() {
        let segments = vec![zoom_segment(
            "zoom",
            1_000,
            3_000,
            RenderCropFloat {
                x: 100.0,
                y: 80.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            500,
            0,
            None,
        )];
        let center_canvas = blur_canvas(Some(cursor::RenderMotionBlur {
            enabled: true,
            cursor: 0.0,
            zoom: 0.0,
            pan: 1.0,
        }));
        let pan_params = motion_blur_params(&center_canvas).unwrap();
        let center = evaluate_zoom_transform(&segments, 1_920, 1_080, 0, 1_250.0);
        let pan_strip = evaluate_motion_blur_strip(
            &segments,
            &center_canvas,
            &pan_params,
            1_250.0,
            1_920.0,
            1_080.0,
        )
        .expect("pan-only strip during off-center zoom");
        // Width stays fixed at `center` (zero zoom shift!).
        let expected_w = (center.crop_w / 1_920.0) as f32;
        assert!((pan_strip.start[2] - expected_w).abs() < 1e-5);
        assert!((pan_strip.end[2] - expected_w).abs() < 1e-5);
        // Midpoint of start/end centers lands right on `center` (zero backward shift!).
        let mid_cx = (pan_strip.start[0] + pan_strip.end[0]) * 0.5 + expected_w * 0.5;
        let expected_cx = ((center.crop_x + center.crop_w * 0.5) / 1_920.0) as f32;
        assert!(
            (mid_cx - expected_cx).abs() < 0.002,
            "expected symmetric center {expected_cx}, got {mid_cx}"
        );

        // Zoom-only keeps center fixed and sweeps only width/height.
        let zoom_canvas = blur_canvas(Some(cursor::RenderMotionBlur {
            enabled: true,
            cursor: 0.0,
            zoom: 1.0,
            pan: 0.0,
        }));
        let zoom_params = motion_blur_params(&zoom_canvas).unwrap();
        let zoom_strip = evaluate_motion_blur_strip(
            &segments,
            &zoom_canvas,
            &zoom_params,
            1_250.0,
            1_920.0,
            1_080.0,
        )
        .expect("zoom-only strip");
        assert!((zoom_strip.start[2] - zoom_strip.end[2]).abs() > 0.01);
        let start_cx = zoom_strip.start[0] + zoom_strip.start[2] * 0.5;
        let end_cx = zoom_strip.end[0] + zoom_strip.end[2] * 0.5;
        assert!(
            (start_cx - end_cx).abs() < 1e-4,
            "zoom-only must not pan center: {start_cx} vs {end_cx}"
        );
    }

    #[test]
    fn motion_blur_tap_weights_are_symmetric_and_peaked_at_center() {
        let n = 7u32;
        let weights: Vec<f64> = (0..n).map(|tap| motion_blur_tap_weight(tap, n)).collect();
        for i in 0..(n as usize) / 2 {
            assert!((weights[i] - weights[n as usize - 1 - i]).abs() < 1e-9);
        }
        assert!(weights[3] > weights[0]);
        assert!(weights[0] >= 0.45);
    }

    #[test]
    fn motion_blur_frame_taps_grow_only_while_the_crop_moves() {
        let canvas = blur_canvas(Some(cursor::RenderMotionBlur {
            enabled: true,
            zoom: 1.0,
            pan: 1.0,
            ..Default::default()
        }));
        let params = motion_blur_params(&canvas).unwrap();
        let segments = vec![zoom_segment(
            "zoom",
            1_000,
            3_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            500,
            0,
            None,
        )];
        // A steady frame outside the segment keeps the sharp path.
        assert_eq!(
            motion_blur_frame_taps(&segments, &canvas, &params, 4_000.0, 1_920.0, 1_080.0),
            1
        );
        // Mid zoom-in transition the sweep is wide open.
        let taps = motion_blur_frame_taps(&segments, &canvas, &params, 1_250.0, 1_920.0, 1_080.0);
        assert!(taps >= 3, "moving crop should request >=3 taps, got {taps}");
        // The window scan agrees — capped by the caller, never below 1.
        let window = motion_blur_window_taps(&segments, &canvas, &params, 0, 120, 1_920.0, 1_080.0);
        assert!(window >= taps && window >= 1);
    }

    #[test]
    fn from_target_without_from_scale_defaults_to_identity_in_both_evaluators() {
        let mut seg = zoom_segment(
            "bridged",
            1_000,
            3_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "linear",
            1_000,
            0,
            Some(RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 1_920.0,
                height: 1_080.0,
            }),
        );
        seg.from_scale = None;

        // At segment start (p=0), numeric evaluator must start at 1.0x (not 2.0x),
        // matching `collect_zoompan_segment_exprs` and TS `resolveZoomTransform`.
        let at_start =
            evaluate_zoom_transform(std::slice::from_ref(&seg), 1_920, 1_080, 0, 1_000.0);
        assert!(
            (at_start.scale - 1.0).abs() < 1e-6,
            "expected scale 1.0 at start when from_scale is None, got {}",
            at_start.scale
        );
        let at_mid = evaluate_zoom_transform(&[seg], 1_920, 1_080, 0, 1_500.0);
        assert!(
            (at_mid.scale - std::f64::consts::SQRT_2).abs() < 1e-4,
            "expected log-space midpoint sqrt(2), got {}",
            at_mid.scale
        );
    }

    #[test]
    fn start_at_zero_zoompan_clamps_negative_motion_blur_time_shifts() {
        let seg = zoom_segment(
            "zero-start",
            0,
            2_000,
            RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            2.0,
            "smooth",
            400,
            400,
            None,
        );
        let canvas = cursor::RenderCanvas {
            width: 1_920,
            height: 1_080,
            fps: 30,
            ..Default::default()
        };
        let mut plan = test_plan(vec![seg]);
        plan.duration_ms = 2_000;
        plan.canvas = Some(canvas.clone());
        let (z_expr, _, _) = build_zoompan_expressions(&plan, &canvas, 1_920.0, 1_080.0);
        // `progress_in` must clamp `max(0, ...)` so negative time shifts from
        // centered motion blur on frame 0 never feed negative p into smoothstep.
        assert!(
            z_expr.contains("max(0,"),
            "expected non-negative progress clamp in start_ms==0 zoompan expr: {z_expr}"
        );
        let z_before_zero = eval_ffmpeg_expr(&z_expr, -0.05, 1_920.0, 1_080.0, 1.0);
        assert!(
            (z_before_zero - 1.0).abs() < 1e-6,
            "negative shifted tap on frame 0 must stay at 1.0x, got {z_before_zero}"
        );
    }
}
