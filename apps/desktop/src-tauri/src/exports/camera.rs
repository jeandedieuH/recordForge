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
                    segment.from_scale.unwrap_or(segment.scale),
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
/// The width ratio is recovered from zoompan's `zoom` variable
/// (`r = canvas_w / (from_w * zoom)`) so the eased ratio term only appears
/// once — inside the z expression — keeping these expressions compact.
fn zoompan_center_expression(
    center_a_expr: &str,
    center_b_expr: &str,
    scale_a: f64,
    scale_b: f64,
    eased: &str,
    canvas_w: f64,
    from_w: f64,
) -> String {
    if !scale_a.is_finite() || !scale_b.is_finite() || scale_a <= 0.0 {
        return center_b_expr.to_string();
    }
    if (scale_b - scale_a).abs() < 1e-3 * scale_a {
        // Equal zoom levels: the fixed point is undefined; pan linearly.
        return format!("({center_a_expr})+(({center_b_expr})-({center_a_expr}))*({eased})");
    }
    let ratio_expr = if (from_w - canvas_w).abs() < 1e-6 {
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

pub(crate) fn build_zoompan_expressions(
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

        // Eased progress within in/out transitions.
        let eased_in = if trans_in_s > 0.0001 {
            let progress_in = format!("((it-{start_str})/{trans_in_str})");
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
        // the zoom factor is canvas_w / (wA * r).
        let ratio_in = target.width / from_w.max(1e-6);
        let ratio_in_expr = zoompan_ratio_expression(ratio_in, &eased_in);
        let ratio_out = target.width / canvas_w.max(1e-6);
        let ratio_out_expr = zoompan_ratio_expression(ratio_out, &eased_out);

        let z_in = if trans_in_s > 0.0001 {
            format!("{canvas_w_str}/max(1,({from_w_str}*({ratio_in_expr})))")
        } else {
            target_scale_str.clone()
        };
        let z_out = if trans_out_s > 0.0001 {
            format!("{canvas_w_str}/max(1,({canvas_w_str}*({ratio_out_expr})))")
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
        let cx_in = if trans_in_s > 0.0001 {
            zoompan_center_expression(
                &from_cx_str,
                &target_cx_expression,
                scale_a_in,
                scale_b,
                &eased_in,
                canvas_w,
                from_w,
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
            )
        } else {
            target_cy_expression.clone()
        };

        // For the out phase the "from" crop is the full canvas, so the ratio
        // runs from canvas width down to the target and back via eased_out.
        let scale_a_out = 1.0_f64;
        let cx_out = if trans_out_s > 0.0001 {
            zoompan_center_expression(
                &full_cx_str,
                &target_cx_expression,
                scale_a_out,
                scale_b,
                &eased_out,
                canvas_w,
                canvas_w,
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

        z_expr = format!("if({cond},{z_seg},{z_expr})");
        cx_expr = format!("if({cond},{cx_seg},{cx_expr})");
        cy_expr = format!("if({cond},{cy_seg},{cy_expr})");
    }

    let x_expr = format!("if(lte(zoom,1.001),0,max(0,min(iw-iw/zoom,({cx_expr})-(iw/zoom)/2)))");
    let y_expr = format!("if(lte(zoom,1.001),0,max(0,min(ih-ih/zoom,({cy_expr})-(ih/zoom)/2)))");

    (z_expr, x_expr, y_expr)
}

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

    fn test_plan(zoom_segments: Vec<RenderPlanZoomSegment>) -> RenderPlan {
        RenderPlan {
            project_id: "camera-test".into(),
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
}
