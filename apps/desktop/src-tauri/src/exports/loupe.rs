//! Glass Loupe geometry (M2 #2) for both renderers.
//!
//! A loupe segment is a zoom segment with `style: "loupe"`. It never moves the
//! frame zoom (`camera::evaluate_zoom_transform` skips it); instead a lens floats
//! over the recording and magnifies the segment's target inside it. This module
//! resolves the lens pose at one output timestamp — the mirror of
//! `resolveLoupeAt` in `packages/editor-core/src/zoom-loupe.ts`.

use super::camera::{clamped_zoom_target, ease_progress, zoom_easing_expression};
use super::cursor::RenderCanvas;
use super::{RenderCropFloat, RenderLoupe, RenderPlan, RenderPlanZoomSegment};

/// Presence below this means the lens is effectively invisible.
const MIN_PRESENCE: f64 = 0.001;
/// Lens diameter at zero presence, as a fraction of its full size: the lens
/// grows the last 12% in as it fades in.
const MIN_PRESENCE_SCALE: f64 = 0.88;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LoupePose {
    /// 0..1 grow/fade curve.
    pub presence: f64,
    /// Lens centre in canvas pixels.
    pub center: (f64, f64),
    /// Lens radius in canvas pixels (already scaled by `presence`).
    pub radius: f64,
    /// Corner radius of the lens SDF (equals `radius` for a circle).
    pub corner_radius: f64,
    /// Magnified content in canvas coordinates.
    pub target: RenderCropFloat,
    /// Segment zoom scale, which is the lens magnification.
    pub scale: f64,
    /// True when the lens rides the resolved cursor tip — the cursor plane is
    /// dropped under it in the GPU compositor, matching preview suppression.
    pub following: bool,
    pub settings: RenderLoupe,
}

impl LoupePose {
    pub fn is_visible(&self) -> bool {
        self.presence > MIN_PRESENCE
    }
}

/// Enabled loupe segments in timeline order.
pub(crate) fn loupe_segments(
    zoom_segments: &[RenderPlanZoomSegment],
) -> Vec<&RenderPlanZoomSegment> {
    let mut segments = zoom_segments
        .iter()
        .filter(|segment| segment.enabled && segment.style.as_deref() == Some("loupe"))
        .collect::<Vec<_>>();
    segments.sort_by(|left, right| {
        left.start_ms
            .cmp(&right.start_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    segments
}

/// Growth curve for the lens: the same in/hold/out lifecycle the frame zoom
/// uses, so the lens and the camera easing agree.
fn loupe_progress(segment: &RenderPlanZoomSegment, output_ms: f64) -> f64 {
    let duration = (segment.end_ms - segment.start_ms).max(1) as f64;
    let mut transition_in = (segment.transition_in_ms as f64).clamp(0.0, duration);
    let mut transition_out = (segment.transition_out_ms as f64).clamp(0.0, duration);
    if transition_in + transition_out > duration {
        transition_in = duration / 2.0;
        transition_out = duration - transition_in;
    }
    let elapsed = (output_ms - segment.start_ms as f64).max(0.0);
    if elapsed <= 0.0 {
        return if transition_in == 0.0 { 1.0 } else { 0.0 };
    }
    if elapsed < transition_in {
        return ease_progress(
            (elapsed / transition_in.max(1.0)).clamp(0.0, 1.0),
            &segment.easing,
        );
    }
    if elapsed <= duration - transition_out {
        return 1.0;
    }
    if elapsed <= duration {
        let elapsed_out = elapsed - (duration - transition_out);
        let raw = (elapsed_out / transition_out.max(1.0)).clamp(0.0, 1.0);
        return 1.0 - ease_progress(raw, &segment.easing);
    }
    0.0
}

/// Lens pose at one output timestamp, or `None` when no loupe covers it.
///
/// Convenience wrapper over [`resolve_loupe_in_rect`] for full-canvas callers
/// where the fitted screen fills `[0..canvas.width] × [0..canvas.height]` and
/// no frame zoom separates the displayed cursor from the unzoomed screen point.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn resolve_loupe_at(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &RenderCanvas,
    output_ms: f64,
    cursor_point: Option<(f64, f64)>,
) -> Option<LoupePose> {
    resolve_loupe_in_rect(
        zoom_segments,
        canvas,
        output_ms,
        (0.0, 0.0, canvas.width as f64, canvas.height as f64),
        cursor_point,
        cursor_point,
    )
}

/// Lens pose at one output timestamp against the active fitted `screen_rect`
/// (in canvas pixels).
///
/// - When following the cursor (`cursor_display_point` or `cursor_sample_point`
///   is `Some`), the lens centre rides `cursor_display_point + offset` (so it
///   tracks the visible pointer even when a frame zoom overlaps it) while the
///   magnified `target` centres on `cursor_sample_point` (the unzoomed pointer
///   position inside `screen_rect`).
/// - When parked (no cursor point), the segment's zoom-space target maps onto
///   `screen_rect` for magnification, and the lens parks on `settings.center`
///   (already canvas px) or that mapped target centre — matching TypeScript
///   `resolveLoupeAt` across 16:9, 9:16, padded, and side-by-side layouts.
pub(crate) fn resolve_loupe_in_rect(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &RenderCanvas,
    output_ms: f64,
    screen_rect: (f64, f64, f64, f64),
    cursor_display_point: Option<(f64, f64)>,
    cursor_sample_point: Option<(f64, f64)>,
) -> Option<LoupePose> {
    let segment = loupe_segments(zoom_segments).into_iter().rfind(|segment| {
        output_ms >= segment.start_ms as f64 && output_ms < segment.end_ms as f64
    })?;
    let settings = segment.loupe.clone().unwrap_or_default();
    let presence = loupe_progress(segment, output_ms).clamp(0.0, 1.0);

    let canvas_w = canvas.width as f64;
    let canvas_h = canvas.height as f64;
    let diameter = settings.size.clamp(0.0, 1.0)
        * canvas_w.min(canvas_h)
        * (MIN_PRESENCE_SCALE + (1.0 - MIN_PRESENCE_SCALE) * presence);
    let radius = (diameter / 2.0).max(1.0);

    let following = cursor_display_point.is_some() || cursor_sample_point.is_some();
    // `loupe_sample_square` reads only the target centre, so a 1x1 rect keeps
    // the sample centred exactly on the unzoomed cursor tip — no crop-edge
    // clamping can pull it off the point the lens magnifies.
    let (target, raw_center) = if following {
        let sample = cursor_sample_point
            .or(cursor_display_point)
            .expect("following guarantees a point");
        let display = cursor_display_point
            .or(cursor_sample_point)
            .expect("following guarantees a point");
        (
            RenderCropFloat {
                x: sample.0 - 0.5,
                y: sample.1 - 0.5,
                width: 1.0,
                height: 1.0,
            },
            display,
        )
    } else {
        let canonical = clamped_zoom_target(canvas.width, canvas.height, canvas.padding, segment);
        let sx = screen_rect.2 / canvas_w.max(1.0);
        let sy = screen_rect.3 / canvas_h.max(1.0);
        let target = RenderCropFloat {
            x: screen_rect.0 + canonical.x * sx,
            y: screen_rect.1 + canonical.y * sy,
            width: canonical.width * sx,
            height: canonical.height * sy,
        };
        let centre = settings
            .center
            .map(|center| (center.x, center.y))
            .unwrap_or((
                target.x + target.width / 2.0,
                target.y + target.height / 2.0,
            ));
        (target, centre)
    };

    let offset = settings.offset.unwrap_or_default();
    let center = (
        (raw_center.0 + offset.x).clamp(radius, (canvas_w - radius).max(radius)),
        (raw_center.1 + offset.y).clamp(radius, (canvas_h - radius).max(radius)),
    );
    let corner_radius = if settings.is_circle() {
        radius
    } else {
        (settings.corner_radius.clamp(0.0, 0.5) * radius).max(0.0)
    };

    Some(LoupePose {
        presence,
        center,
        radius,
        corner_radius,
        target,
        scale: segment.scale.max(1.0),
        following,
        settings,
    })
}

/// The square the lens samples: `diameter / scale`, centred on the target and
/// kept inside the content rect. Because the square is drawn across the whole
/// lens, the magnification the viewer sees is exactly `pose.scale`.
pub(crate) fn loupe_sample_square(
    pose: &LoupePose,
    content: (f64, f64, f64, f64),
) -> (f64, f64, f64, f64) {
    let (x, y, w, h) = content;
    let side = (pose.radius * 2.0 / pose.scale.max(1.0)).clamp(1.0, w.min(h).max(1.0));
    let centre_x =
        (pose.target.x + pose.target.width / 2.0).clamp(x + side / 2.0, x + w - side / 2.0);
    let centre_y =
        (pose.target.y + pose.target.height / 2.0).clamp(y + side / 2.0, y + h - side / 2.0);
    (centre_x - side / 2.0, centre_y - side / 2.0, side, side)
}

// ---------------------------------------------------------------------------
// Glass Loupe on the FFmpeg compatibility renderer (M2 #2)
//
// The lens is rebuilt from filters — the compositor's shader lens has no FFmpeg
// equivalent, so the graph synthesizes it:
//
// - a `crop@loupe` on the fitted screen plate samples `loupe_sample_square`
//   each frame (positions arrive via `sendcmd`, the same mechanism that moves
//   the cursor tile), scaled to the fixed lens plate size;
// - a `geq` disc provides the alpha (`alphamerge`) — presence fade and the
//   grow curve are deterministic functions of `T`, like the zoom expressions;
// - a second `geq` RGBA plate carries the ring, drop shadow and the glass
//   rim/veil approximation;
// - two `overlay`s composite lens content then the frame plate, positioned
//   per frame by the same `sendcmd` script.
//
// A rounded-rect lens and a circle share one SDF: a circle is a rounded box
// whose corner radius equals its half-side (`c = r`), matching
// `resolve_loupe_at`'s `corner_radius` for `is_circle`.
// ---------------------------------------------------------------------------

/// Everything `push_compat_loupe` needs, resolved once per pass: the fixed
/// plate size, per-frame `sendcmd` data, the overlay gating expression and the
/// piecewise `T` expressions for the two `geq` plates.
pub(crate) struct CompatLoupePlan {
    /// Side of the square lens disc plate in canvas px (max diameter, even).
    pub plate: u32,
    /// Padding around `plate` on each side for the frame/shadow plate so drop
    /// shadows fade smoothly instead of clipping against the lens box.
    pub shadow_pad: u32,
    /// `overlay` `enable` expression: union of the loupe windows, in the
    /// absolute seconds the shifted main stream runs on.
    pub enable: String,
    /// Negated windows multiplied into the cursor `enable` so the pointer
    /// hides while a lens is visible — the same suppression the compositor
    /// applies by dropping the cursor plane.
    pub cursor_suppression: String,
    /// `sendcmd` script for `crop@loupe`/`overlay@loupe`/`overlay@loupe_frame`,
    /// absolute-second commands deduplicated per axis. Empty when no lens is
    /// ever visible inside the pass.
    pub sendcmd: String,
    /// `geq` `lum` expression: the disc's AA edge × presence, 0..255.
    pub mask_lum: String,
    /// `geq` channel expressions for the frame plate (ring + shadow + glass).
    pub frame_r: String,
    pub frame_g: String,
    pub frame_b: String,
    pub frame_a: String,
    /// First visible pose's seed values for the declared filter options —
    /// `sendcmd` only rewrites what changes, so init and first frame agree.
    pub seed: (u32, i32, i32, i32, i32), // (crop side, crop x, crop y, overlay x, overlay y)
}

fn loupe_seconds(ms: f64) -> String {
    super::seconds(ms.max(0.0) as u64)
}

/// `p(T)` for one segment — the `loupe_progress` lifecycle as a filter
/// expression: eased in, held, eased out, zero outside.
fn presence_expr(segment: &RenderPlanZoomSegment) -> String {
    let duration = (segment.end_ms - segment.start_ms).max(1) as f64 / 1000.0;
    let mut trans_in = (segment.transition_in_ms as f64 / 1000.0).clamp(0.0, duration);
    let mut trans_out = (segment.transition_out_ms as f64 / 1000.0).clamp(0.0, duration);
    if trans_in + trans_out > duration {
        trans_in = duration / 2.0;
        trans_out = duration - trans_in;
    }
    let e = format!("(T-{})", compact(segment.start_ms as f64 / 1000.0));
    let in_end = compact(trans_in);
    let hold_end = compact(duration - trans_out);
    let dur = compact(duration);
    match (trans_in > 1e-4, trans_out > 1e-4) {
        (true, true) => {
            let ease_in = zoom_easing_expression(&format!("({e}/{in_end})"), &segment.easing);
            let ease_out = zoom_easing_expression(
                &format!("(({e}-{hold_end})/{})", compact(trans_out)),
                &segment.easing,
            );
            format!(
                "if(lt({e},0),0,if(lt({e},{in_end}),{ease_in},if(lte({e},{hold_end}),1,if(lte({e},{dur}),1-({ease_out}),0))))"
            )
        }
        (false, true) => {
            let ease_out = zoom_easing_expression(
                &format!("(({e}-{hold_end})/{})", compact(trans_out)),
                &segment.easing,
            );
            format!("if(lte({e},{hold_end}),1,if(lte({e},{dur}),1-({ease_out}),0))")
        }
        (true, false) => {
            let ease_in = zoom_easing_expression(&format!("({e}/{in_end})"), &segment.easing);
            format!("if(lt({e},0),0,if(lt({e},{in_end}),{ease_in},1))")
        }
        (false, false) => "1".to_string(),
    }
}

/// `if(cover_1, value_1, if(cover_2, value_2, …, default))` — the same fold the
/// zoompan piecewise uses so a later-starting segment wins overlaps.
fn piecewise_expr(
    segments: &[&RenderPlanZoomSegment],
    value: impl Fn(&RenderPlanZoomSegment) -> String,
    default: &str,
) -> String {
    segments.iter().fold(default.to_string(), |acc, segment| {
        let start = loupe_seconds(segment.start_ms as f64);
        let end = loupe_seconds(segment.end_ms as f64);
        format!("if(gte(T,{start})*lt(T,{end}),{},{acc})", value(segment))
    })
}

fn compact(value: f64) -> String {
    if value.fract().abs() < 1e-6 {
        format!("{value:.0}")
    } else {
        let s = format!("{value:.6}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// `(R, c)` sub-expressions for one segment's SDF: the full-size half-side and
/// corner radius. `R` already folds in the grow curve via `presence`.
fn sdf_params(segment: &RenderPlanZoomSegment, canvas: &RenderCanvas) -> (String, String) {
    let settings = segment.loupe.clone().unwrap_or_default();
    let radius = settings.size.clamp(0.0, 1.0) * (canvas.width.min(canvas.height) as f64) / 2.0;
    let r = format!(
        "({}*(0.88+0.12*({})))",
        compact(radius.max(1.0)),
        presence_expr(segment)
    );
    let corner = if settings.is_circle() {
        r.clone()
    } else {
        format!("({}*{r})", compact(settings.corner_radius.clamp(0.0, 0.5)))
    };
    (r, corner)
}

/// Signed-distance expression (px, negative inside, positive outside) of the
/// active lens' rounded-box SDF evaluated at plate coords (X, Y) and time `T`.
/// Mirrors `lens_distance` in `composite.wgsl` exactly, including sharp squares
/// (`corner_radius == 0`) via the interior `min(max(dx, dy), 0)` term.
fn sdf_expr(segments: &[&RenderPlanZoomSegment], canvas: &RenderCanvas, plate: u32) -> String {
    let centre = compact(plate as f64 / 2.0);
    piecewise_expr(
        segments,
        |segment| {
            let (r, c) = sdf_params(segment, canvas);
            let dx = format!("(abs(X-{centre})-({r}-({c})))");
            let dy = format!("(abs(Y-{centre})-({r}-({c})))");
            format!("(hypot(max({dx},0),max({dy},0))+min(max({dx},{dy}),0)-({c}))")
        },
        // Far outside so every alpha term evaluates to 0 off-window.
        "4096",
    )
}

fn color_channel_expr(segments: &[&RenderPlanZoomSegment], channel: usize, d: &str) -> String {
    // Colour zones keyed on `d` (negative inside, 0 at edge, positive outside):
    // outside the AA outer edge (`d > 0.5`) only the black drop shadow paints;
    // within `[0, ring_width]` inward from the edge the ring colour paints
    // (tiny_skia 0..1 channels scaled to 0..255 for FFmpeg `geq`); deeper
    // inside the white glass rim highlight paints.
    piecewise_expr(
        segments,
        |segment| {
            let settings = segment.loupe.clone().unwrap_or_default();
            if settings.ring_width <= 0.0 {
                return format!("if(gt({d},0.5),0,255)");
            }
            let ring_w = compact(settings.ring_width.max(0.0) + 0.5);
            let ring = super::parse_color_hex(&settings.ring_color, 1.0);
            let rgb = [
                (ring.red() as f64 * 255.0).round(),
                (ring.green() as f64 * 255.0).round(),
                (ring.blue() as f64 * 255.0).round(),
            ][channel];
            format!(
                "if(gt({d},0.5),0,if(gt({d},-{ring_w}),{},255))",
                compact(rgb)
            )
        },
        "0",
    )
}

/// Build every piece the compat stage needs, or `None` when no loupe segment
/// intersects `[first_frame, +frame_count)`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_compat_loupe(
    plan: &RenderPlan,
    canvas: &RenderCanvas,
    renderers: &[(u64, u64, super::cursor::CursorRenderer)],
    content: (f64, f64, f64, f64),
    screen_windows: &[super::cursor::ScreenRectWindow],
    plate_origin: (f64, f64),
    plate_dims: (u32, u32),
    first_frame: u64,
    frame_count: u64,
) -> Option<CompatLoupePlan> {
    let segments = loupe_segments(&plan.zoom_segments);
    if segments.is_empty() {
        return None;
    }
    let fps = canvas.fps.max(1) as f64;
    let window_start_ms = first_frame as f64 * 1000.0 / fps;
    let window_end_ms = (first_frame + frame_count) as f64 * 1000.0 / fps;
    let segments: Vec<&RenderPlanZoomSegment> = segments
        .into_iter()
        .filter(|segment| {
            (segment.end_ms as f64) > window_start_ms && (segment.start_ms as f64) < window_end_ms
        })
        .collect();
    if segments.is_empty() {
        return None;
    }

    // Disc plate: the largest full-size diameter in the window, even-rounded,
    // capped to the canvas short edge (NOT `plate_dims`, which can be shorter
    // than the canvas short edge on 9:16 portrait canvases).
    let plate = segments
        .iter()
        .map(|segment| {
            let settings = segment.loupe.clone().unwrap_or_default();
            settings.size.clamp(0.0, 1.0) * canvas.width.min(canvas.height) as f64
        })
        .fold(0.0f64, f64::max);
    let plate = (((plate.ceil() as u32) + 1) & !1)
        .max(2)
        .min((canvas.width.min(canvas.height) & !1).max(2));

    // Frame plate margin so the SDF drop shadow extends smoothly outside the
    // lens without clipping into a hard rectangle (capped at 64 px for geq speed).
    let max_shadow = segments
        .iter()
        .map(|segment| {
            let settings = segment.loupe.clone().unwrap_or_default();
            if settings.shadow_opacity > 0.001 {
                settings.shadow_blur.clamp(0.0, 200.0)
            } else {
                0.0
            }
        })
        .fold(0.0f64, f64::max);
    let shadow_pad = (((max_shadow * 2.0).ceil() as u32 + 1) & !1).min(64);
    let frame_plate = plate + shadow_pad * 2;

    // Per-frame commands: the sample crop tracks the resolved target point and
    // both overlays ride the lens centre.
    let mut sendcmd = String::new();
    let mut previous_crop: Option<(i32, i32, i32)> = None;
    let mut previous_overlay: Option<(i32, i32)> = None;
    let mut seed = None;
    for offset in 0..frame_count {
        let abs_frame = first_frame + offset;
        let output_ms = super::cursor::frame_time_ms(abs_frame, canvas.fps);
        let dest = screen_windows
            .iter()
            .find(|w| output_ms >= w.start_ms as f64 && output_ms < w.end_ms as f64)
            .map(|w| w.rect)
            .unwrap_or(content);
        let active_renderer = renderers
            .iter()
            .find(|(start_ms, end_ms, _)| {
                output_ms >= *start_ms as f64 && output_ms < *end_ms as f64
            })
            .map(|(_, _, renderer)| renderer);
        let cursor_display =
            active_renderer.and_then(|renderer| renderer.cursor_canvas_point(output_ms));
        let cursor_sample =
            active_renderer.and_then(|renderer| renderer.cursor_unzoomed_canvas_point(output_ms));
        let Some(pose) = resolve_loupe_in_rect(
            &plan.zoom_segments,
            canvas,
            output_ms,
            dest,
            cursor_display,
            cursor_sample,
        )
        .filter(|pose| pose.is_visible()) else {
            continue;
        };
        let sq = loupe_sample_square(&pose, dest);
        // Map the sample square from `dest` (which may shrink in side-by-side
        // camera layouts) back into `[loupe_src]`'s base fitted plate coords.
        let src_x = (content.0 - plate_origin.0) + ((sq.0 - dest.0) / dest.2.max(1.0)) * content.2;
        let src_y = (content.1 - plate_origin.1) + ((sq.1 - dest.1) / dest.3.max(1.0)) * content.3;
        let src_side = (sq.2 / dest.2.max(1.0)) * content.2;
        let max_side = (plate_dims.0.min(plate_dims.1) & !1).max(2) as i32;
        let side = (src_side.round() as i32 / 2 * 2).clamp(2, max_side);
        let max_x = (plate_dims.0 as i32 - side).max(0);
        let max_y = (plate_dims.1 as i32 - side).max(0);
        let crop_x = (src_x.round() as i32 / 2 * 2).clamp(0, max_x);
        let crop_y = (src_y.round() as i32 / 2 * 2).clamp(0, max_y);
        let half_plate = plate as f64 / 2.0;
        let overlay_x = ((pose.center.0 - half_plate).round() as i32 / 2 * 2)
            .clamp(-(plate as i32), canvas.width as i32);
        let overlay_y = ((pose.center.1 - half_plate).round() as i32 / 2 * 2)
            .clamp(-(plate as i32), canvas.height as i32);
        if seed.is_none() {
            seed = Some((side as u32, crop_x, crop_y, overlay_x, overlay_y));
        }
        // `>=` matching against the plate frame PTS — the same -0.1 ms nudge
        // the cursor script uses so a rounded timestamp can't lag a frame.
        let t = (output_ms / 1000.0 - 0.000_1).max(0.0);
        let crop = (side, crop_x, crop_y);
        if previous_crop != Some(crop) {
            if previous_crop.map(|prev| prev.0 != side).unwrap_or(true) {
                sendcmd.push_str(&format!("{t:.6} crop@loupe w {side};\n"));
                sendcmd.push_str(&format!("{t:.6} crop@loupe h {side};\n"));
            }
            if previous_crop.map(|prev| prev.1 != crop_x).unwrap_or(true) {
                sendcmd.push_str(&format!("{t:.6} crop@loupe x {crop_x};\n"));
            }
            if previous_crop.map(|prev| prev.2 != crop_y).unwrap_or(true) {
                sendcmd.push_str(&format!("{t:.6} crop@loupe y {crop_y};\n"));
            }
            previous_crop = Some(crop);
        }
        let overlay = (overlay_x, overlay_y);
        if previous_overlay != Some(overlay) {
            let frame_x = overlay_x - shadow_pad as i32;
            let frame_y = overlay_y - shadow_pad as i32;
            if previous_overlay
                .map(|prev| prev.0 != overlay_x)
                .unwrap_or(true)
            {
                sendcmd.push_str(&format!("{t:.6} overlay@loupe x {overlay_x};\n"));
                sendcmd.push_str(&format!("{t:.6} overlay@loupe_frame x {frame_x};\n"));
            }
            if previous_overlay
                .map(|prev| prev.1 != overlay_y)
                .unwrap_or(true)
            {
                sendcmd.push_str(&format!("{t:.6} overlay@loupe y {overlay_y};\n"));
                sendcmd.push_str(&format!("{t:.6} overlay@loupe_frame y {frame_y};\n"));
            }
            previous_overlay = Some(overlay);
        }
    }
    let Some(seed) = seed else {
        // No visible lens anywhere in the pass: emit nothing at all.
        return None;
    };

    let presence = piecewise_expr(&segments, presence_expr, "0");
    let d_disc = sdf_expr(&segments, canvas, plate);
    let d_frame = sdf_expr(&segments, canvas, frame_plate);

    // AA edge ≈1 px around the SDF boundary (mirrors GPU `clamp(0.5 - sdf, 0, 1)`),
    // faded by presence.
    let mask_lum = format!("clip(0.5-({d_disc}),0,1)*255*({presence})");

    let ring_width = piecewise_expr(
        &segments,
        |segment| {
            compact(
                segment
                    .loupe
                    .clone()
                    .unwrap_or_default()
                    .ring_width
                    .max(0.0),
            )
        },
        "0",
    );
    let ring_opacity = piecewise_expr(
        &segments,
        |segment| {
            compact(
                segment
                    .loupe
                    .clone()
                    .unwrap_or_default()
                    .ring_opacity
                    .clamp(0.0, 1.0),
            )
        },
        "0",
    );
    let shadow_blur = piecewise_expr(
        &segments,
        |segment| {
            compact(
                segment
                    .loupe
                    .clone()
                    .unwrap_or_default()
                    .shadow_blur
                    .max(1.0),
            )
        },
        "1",
    );
    let shadow_opacity = piecewise_expr(
        &segments,
        |segment| {
            compact(
                segment
                    .loupe
                    .clone()
                    .unwrap_or_default()
                    .shadow_opacity
                    .clamp(0.0, 1.0),
            )
        },
        "0",
    );
    let glass = piecewise_expr(
        &segments,
        |segment| {
            if segment.loupe.clone().unwrap_or_default().glass {
                "1".to_string()
            } else {
                "0".to_string()
            }
        },
        "0",
    );
    let radius_expr = piecewise_expr(&segments, |segment| sdf_params(segment, canvas).0, "1");

    // Alpha mirrors `composite.wgsl`:
    // - ring band strictly inside the lens edge (`depth = -d in [0, ring_width]`)
    // - exponential SDF drop shadow outside the lens (`d > 0`)
    // - glass rim brightening across the outer 18% inside the lens
    // Everything fades with `presence`.
    let inside = format!("clip(0.5-({d_frame}),0,1)");
    let ring_band =
        format!("gt({ring_width},0)*({inside})*clip(0.5+({ring_width})+({d_frame}),0,1)");
    let pad_taper = if shadow_pad > 0 {
        let pad = compact(shadow_pad as f64);
        let taper = compact((shadow_pad as f64 * 0.35).max(1.0));
        format!("*clip(({pad}-max({d_frame},0))/{taper},0,1)")
    } else {
        String::new()
    };
    let shadow_alpha = format!(
        "min(exp(-max({d_frame},0)/({shadow_blur}))*({shadow_opacity})*(1-({inside})){pad_taper},0.85)"
    );
    let rim_band = format!("max(0.18*({radius_expr}),1)");
    let glass_alpha =
        format!("({glass})*({inside})*clip((({rim_band})+({d_frame}))/({rim_band}),0,1)*0.35");
    let frame_a = format!(
        "255*({presence})*clip(({ring_band})*({ring_opacity})+({shadow_alpha})+({glass_alpha}),0,1)"
    );
    let frame_r = color_channel_expr(&segments, 0, &d_frame);
    let frame_g = color_channel_expr(&segments, 1, &d_frame);
    let frame_b = color_channel_expr(&segments, 2, &d_frame);

    let enable = segments
        .iter()
        .map(|segment| {
            format!(
                "between(t,{},{})",
                loupe_seconds(segment.start_ms as f64),
                loupe_seconds(segment.end_ms as f64)
            )
        })
        .collect::<Vec<_>>()
        .join("+");
    let cursor_suppression = segments
        .iter()
        .map(|segment| {
            format!(
                "(1-between(t,{},{}))",
                loupe_seconds(segment.start_ms as f64),
                loupe_seconds(segment.end_ms as f64)
            )
        })
        .collect::<Vec<_>>()
        .join("*");

    Some(CompatLoupePlan {
        plate,
        shadow_pad,
        enable,
        cursor_suppression,
        sendcmd,
        mask_lum,
        frame_r,
        frame_g,
        frame_b,
        frame_a,
        seed,
    })
}

/// Emit the compat lens stages, returning the new chain label. `loupe_src` is
/// a `split` off the fitted screen plate (already fps-normalized); the lens
/// content crops it per frame while two generated `geq` plates supply the disc
/// mask and the ring/shadow frame.
#[allow(clippy::too_many_arguments)]
pub(crate) fn push_compat_loupe(
    filters: &mut Vec<String>,
    loupe_src: &str,
    current_label: &str,
    prepared: &CompatLoupePlan,
    sendcmd_path: Option<&std::path::Path>,
    fps: u32,
    duration_s: &str,
    abs_pts: &str,
) -> String {
    let (side, crop_x, crop_y, overlay_x, overlay_y) = prepared.seed;
    let plate = prepared.plate;
    let frame_plate = plate + prepared.shadow_pad * 2;
    let frame_x = overlay_x - prepared.shadow_pad as i32;
    let frame_y = overlay_y - prepared.shadow_pad as i32;
    // `T` in the geq plates and the overlay `enable` windows both run on the
    // absolute timeline — the generated streams need the same PTS shift the
    // main chain already has.
    let setpts = if abs_pts.is_empty() {
        String::new()
    } else {
        format!(",setpts=PTS{abs_pts}")
    };
    let mut ops: Vec<String> = Vec::new();
    if !abs_pts.is_empty() {
        ops.push(format!("setpts=PTS{abs_pts}"));
    }
    if let Some(path) = sendcmd_path {
        ops.push(format!(
            "sendcmd=f='{}'",
            super::captions::escape_filter_path(path)
        ));
    }
    filters.push(format!("{loupe_src}{}[loupe_pre]", ops.join(",")));
    filters.push(format!(
        "[loupe_pre]crop@loupe=w={side}:h={side}:x={crop_x}:y={crop_y},scale={plate}:{plate}:flags=bicubic,format=rgba[loupe_sq]"
    ));
    filters.push(format!(
        "color=c=black:s={plate}x{plate}:r={fps}:d={duration_s}{setpts},format=gray,geq=lum='{}'[loupe_mask]",
        prepared.mask_lum
    ));
    filters.push("[loupe_sq][loupe_mask]alphamerge[loupe_disc]".to_string());
    filters.push(format!(
        "color=c=black:s={frame_plate}x{frame_plate}:r={fps}:d={duration_s}{setpts},format=rgba,geq=r='{}':g='{}':b='{}':a='{}'[loupe_frame]",
        prepared.frame_r, prepared.frame_g, prepared.frame_b, prepared.frame_a
    ));
    let enable = &prepared.enable;
    filters.push(format!(
        "[{current_label}][loupe_disc]overlay@loupe=x={overlay_x}:y={overlay_y}:eof_action=pass:format=auto:enable='{enable}'[with_loupe_disc]"
    ));
    filters.push(format!(
        "[with_loupe_disc][loupe_frame]overlay@loupe_frame=x={frame_x}:y={frame_y}:eof_action=pass:format=auto:enable='{enable}'[with_loupe]"
    ));
    "with_loupe".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::cursor::{CursorSettings, RenderCanvas};
    use crate::exports::{RenderCropFloat, RenderPlanZoomSegment, RenderPoint};

    fn canvas() -> RenderCanvas {
        RenderCanvas {
            width: 1920,
            height: 1080,
            fps: 30,
            cursor_settings: CursorSettings::default(),
            ..RenderCanvas::default()
        }
    }

    fn loupe(overrides: impl FnOnce(&mut RenderPlanZoomSegment)) -> RenderPlanZoomSegment {
        let mut segment = RenderPlanZoomSegment {
            id: "loupe-1".into(),
            start_ms: 1_000,
            end_ms: 4_000,
            target: RenderCropFloat {
                x: 400.0,
                y: 200.0,
                width: 480.0,
                height: 270.0,
            },
            scale: 2.0,
            easing: "linear".into(),
            transition_in_ms: 300,
            transition_out_ms: 300,
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
            style: Some("loupe".into()),
            loupe: None,
        };
        overrides(&mut segment);
        segment
    }

    /// The JSON literal mirrors what `buildRenderPlan` emits for the loupe
    /// plan test in `packages/media-core/src/render-plan.test.ts` — a field
    /// rename or a new required key on either side fails one of the two.
    #[test]
    fn the_editor_plan_json_deserializes_with_blur_and_loupe() {
        let plan: RenderPlan = serde_json::from_str(
            r#"{
                "projectId": "project-1",
                "durationMs": 10000,
                "canvas": {
                    "width": 1920,
                    "height": 1080,
                    "fps": 30,
                    "motionBlur": {
                        "enabled": true,
                        "cursor": 0.5,
                        "zoom": 0.6,
                        "pan": 0.4
                    },
                    "cursorSettings": {}
                },
                "segments": [
                    {
                        "assetId": "rec-1",
                        "speed": 1,
                        "sourceInMs": 0,
                        "sourceOutMs": 10000,
                        "outputStartMs": 0,
                        "outputEndMs": 10000
                    }
                ],
                "zoomSegments": [
                    {
                        "id": "zoom-loupe",
                        "startMs": 5000,
                        "endMs": 9000,
                        "target": { "x": 480.0, "y": 270.0, "width": 960.0, "height": 540.0 },
                        "scale": 2,
                        "style": "loupe",
                        "loupe": {
                            "shape": "rounded-rect",
                            "size": 0.4,
                            "glass": true,
                            "ringWidth": 8
                        }
                    }
                ]
            }"#,
        )
        .expect("editor render plan");

        let blur = plan
            .canvas
            .as_ref()
            .and_then(|canvas| canvas.motion_blur)
            .expect("motion blur settings");
        assert!(blur.is_active());
        assert_eq!(blur.zoom, 0.6);

        let segments = loupe_segments(&plan.zoom_segments);
        assert_eq!(segments.len(), 1);
        let settings = segments[0].loupe.clone().unwrap_or_default();
        assert!(!settings.is_circle());
        assert!(settings.glass);
        assert_eq!(settings.ring_width, 8.0);
    }

    #[test]
    fn a_loupe_covers_its_range_and_grows_in() {
        let segments = vec![loupe(|_| {})];
        let canvas = canvas();
        assert!(resolve_loupe_at(&segments, &canvas, 500.0, None).is_none());
        let early = resolve_loupe_at(&segments, &canvas, 1_030.0, None).unwrap();
        let held = resolve_loupe_at(&segments, &canvas, 2_500.0, None).unwrap();
        assert!(early.presence > 0.0 && early.presence < 1.0);
        assert_eq!(held.presence, 1.0);
        assert!(early.radius < held.radius);
    }

    #[test]
    fn the_lens_is_centred_on_the_target_and_sized_from_the_short_edge() {
        let segments = vec![loupe(|_| {})];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, None).unwrap();
        assert!((pose.radius - 0.34 * 1_080.0 / 2.0).abs() < 1e-9);
        assert!((pose.center.0 - 640.0).abs() < 1e-9);
        assert!((pose.center.1 - 335.0).abs() < 1e-9);
        assert_eq!(pose.corner_radius, pose.radius);
    }

    #[test]
    fn frame_style_segments_are_not_loupes() {
        let segments = vec![loupe(|segment| segment.style = Some("frame".into()))];
        assert!(resolve_loupe_at(&segments, &canvas(), 2_500.0, None).is_none());
        assert!(loupe_segments(&segments).is_empty());
    }

    #[test]
    fn a_rounded_lens_uses_its_corner_fraction() {
        let segments = vec![loupe(|segment| {
            segment.loupe = Some(RenderLoupe {
                shape: "rounded-rect".into(),
                corner_radius: 0.2,
                ..RenderLoupe::default()
            })
        })];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, None).unwrap();
        assert!((pose.corner_radius - pose.radius * 0.2).abs() < 1e-9);
    }

    #[test]
    fn the_lens_stays_inside_the_canvas() {
        let segments = vec![loupe(|segment| {
            segment.target = RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 48.0,
                height: 27.0,
            };
        })];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, None).unwrap();
        assert!(pose.center.0 >= pose.radius);
        assert!(pose.center.1 >= pose.radius);
        assert!(pose.center.0 + pose.radius <= 1_920.0 + 1e-6);
        assert!(pose.center.1 + pose.radius <= 1_080.0 + 1e-6);
    }

    #[test]
    fn the_lens_magnifies_by_the_scale_not_by_the_target() {
        let segments = vec![loupe(|_| {})];
        let canvas = canvas();
        let pose = resolve_loupe_at(&segments, &canvas, 2_500.0, None).unwrap();
        let (x, y, side, _) = loupe_sample_square(&pose, (0.0, 0.0, 1920.0, 1080.0));
        // A 2x lens samples half its own diameter and draws it across the lens.
        assert!((side - pose.radius).abs() < 1e-9);
        assert!((pose.radius * 2.0 / side - 2.0).abs() < 1e-9);
        assert!((x + side / 2.0 - 640.0).abs() < 1e-9);
        assert!((y + side / 2.0 - 335.0).abs() < 1e-9);
    }

    #[test]
    fn the_sample_square_stays_inside_the_content_near_an_edge() {
        let segments = vec![loupe(|segment| {
            segment.target = RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 48.0,
                height: 27.0,
            };
        })];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, None).unwrap();
        let (x, y, side, _) = loupe_sample_square(&pose, (0.0, 0.0, 1920.0, 1080.0));
        assert!(x >= -1e-9 && y >= -1e-9);
        assert!(x + side <= 1_920.0 + 1e-9);
        assert!(y + side <= 1_080.0 + 1e-9);
    }

    #[test]
    fn a_cursor_point_pulls_the_lens_and_sample_onto_the_tip() {
        let segments = vec![loupe(|_| {})];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, Some((1_000.0, 600.0))).unwrap();
        assert!(pose.following);
        assert!((pose.center.0 - 1_000.0).abs() < 1e-9);
        assert!((pose.center.1 - 600.0).abs() < 1e-9);
        // `loupe_sample_square` reads only the target centre — it must sit on
        // the tip so the magnified sample tracks the same point the lens does.
        assert!((pose.target.x + pose.target.width / 2.0 - 1_000.0).abs() < 1e-9);
        assert!((pose.target.y + pose.target.height / 2.0 - 600.0).abs() < 1e-9);
    }

    #[test]
    fn the_offset_nudges_the_lens_off_the_cursor_tip() {
        let segments = vec![loupe(|segment| {
            segment.loupe = Some(RenderLoupe {
                offset: Some(RenderPoint { x: 40.0, y: -30.0 }),
                ..RenderLoupe::default()
            })
        })];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, Some((1_000.0, 600.0))).unwrap();
        assert!((pose.center.0 - 1_040.0).abs() < 1e-9);
        assert!((pose.center.1 - 570.0).abs() < 1e-9);
    }

    #[test]
    fn a_cursor_point_at_the_corner_still_keeps_the_lens_on_canvas() {
        let segments = vec![loupe(|_| {})];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, Some((0.0, 0.0))).unwrap();
        assert!(pose.following);
        assert!(pose.center.0 >= pose.radius - 1e-9);
        assert!(pose.center.1 >= pose.radius - 1e-9);
        // The sample square clamps into the content rect, so the magnified
        // pixels stay inside even when the tip hugs the corner.
        let (x, y, side, _) = loupe_sample_square(&pose, (0.0, 0.0, 1920.0, 1080.0));
        assert!(x >= -1e-9 && y >= -1e-9);
        assert!(x + side <= 1_920.0 + 1e-9);
        assert!(y + side <= 1_080.0 + 1e-9);
    }

    #[test]
    fn no_cursor_point_parks_the_lens_and_marks_it_not_following() {
        let segments = vec![loupe(|_| {})];
        let pose = resolve_loupe_at(&segments, &canvas(), 2_500.0, None).unwrap();
        assert!(!pose.following);
        assert!((pose.center.0 - 640.0).abs() < 1e-9);
        assert!((pose.center.1 - 335.0).abs() < 1e-9);
    }

    // ------------------------------------------------------------------
    // Compatibility-renderer lens stage (M2 #2)
    // ------------------------------------------------------------------

    fn plan_with(zoom_segments: Vec<RenderPlanZoomSegment>) -> RenderPlan {
        RenderPlan {
            project_id: "loupe-test".into(),
            camera_layouts: Vec::new(),
            layer_order: Vec::new(),
            duration_ms: 10_000,
            segments: Vec::new(),
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
            canvas: Some(canvas()),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            keystrokes: Vec::new(),
            keystroke_platform: "unknown".into(),
        }
    }

    #[test]
    fn compat_loupe_prepares_commands_only_for_visible_frames() {
        let plan = plan_with(vec![loupe(|_| {})]);
        let canvas = canvas();
        // The lens holds 1000–9000 ms; a pass outside it prepares nothing.
        assert!(prepare_compat_loupe(
            &plan,
            &canvas,
            &[],
            (0.0, 0.0, 1_920.0, 1_080.0),
            &[],
            (0.0, 0.0),
            (1_920, 1_080),
            0,
            30,
        )
        .is_none());

        let prepared = prepare_compat_loupe(
            &plan,
            &canvas,
            &[],
            (0.0, 0.0, 1_920.0, 1_080.0),
            &[],
            (0.0, 0.0),
            (1_920, 1_080),
            30,
            90,
        )
        .expect("a covered window prepares the lens");
        assert!(prepared.plate.is_multiple_of(2) && prepared.plate > 0);
        // Ring colour must emit 0..255 (never tiny_skia's 0..1 float range).
        assert!(
            prepared.frame_r.contains("255"),
            "expected white ring channel 255 in frame_r, got {}",
            prepared.frame_r
        );
        // Shadow pad keeps the SDF drop shadow from clipping on the plate box.
        assert!(prepared.shadow_pad > 0 && prepared.shadow_pad.is_multiple_of(2));
        // Parked pose (no cursor) seeds the declared crop/overlay options.
        let (side, crop_x, crop_y, overlay_x, overlay_y) = prepared.seed;
        assert!(side.is_multiple_of(2));
        assert!(crop_x >= 0 && crop_y >= 0);
        assert!(overlay_x >= 0 && overlay_y >= 0);
        // The enable window covers the segment; cursor suppression negates it.
        assert!(prepared.enable.contains("between(t,1.000,4.000)"));
        assert!(prepared
            .cursor_suppression
            .contains("1-between(t,1.000,4.000)"));
        // Commands exist and target the named filters the stage emits.
        assert!(prepared.sendcmd.contains("crop@loupe w"));
        assert!(prepared.sendcmd.contains("overlay@loupe x"));
        assert!(prepared.sendcmd.contains("overlay@loupe_frame y"));
    }

    #[test]
    fn compat_loupe_stage_emits_the_named_filters_the_script_drives() {
        let plan = plan_with(vec![loupe(|_| {})]);
        let canvas = canvas();
        let prepared = prepare_compat_loupe(
            &plan,
            &canvas,
            &[],
            (0.0, 0.0, 1_920.0, 1_080.0),
            &[],
            (0.0, 0.0),
            (1_920, 1_080),
            30,
            90,
        )
        .unwrap();
        let mut filters = Vec::new();
        let out = push_compat_loupe(
            &mut filters,
            "[loupe_src]",
            "with_cursor",
            &prepared,
            Some(std::path::Path::new("C:/tmp/script.txt")),
            canvas.fps,
            "4.000",
            "+2.000000/TB",
        );
        assert_eq!(out, "with_loupe");
        let joined = filters.join("\n");
        // sendcmd rides the lens branch upstream of the crop it drives.
        let sendcmd_at = joined.find("sendcmd=f=").unwrap();
        let crop_at = joined.find("crop@loupe=").unwrap();
        assert!(sendcmd_at < crop_at);
        assert!(joined.contains("overlay@loupe=x="));
        assert!(joined.contains("overlay@loupe_frame=x="));
        assert!(joined.contains("alphamerge"));
        // Both generated plates re-anchor onto the shifted timeline.
        assert!(joined.matches("setpts=PTS+2.000000/TB").count() >= 3);
    }

    #[test]
    fn resolve_loupe_in_rect_maps_parked_target_and_separates_zoomed_cursor() {
        // 9:16 portrait canvas with a centred 16:9 screen slot.
        let mut portrait_canvas = canvas();
        portrait_canvas.width = 1_080;
        portrait_canvas.height = 1_920;
        let screen_rect = (48.0, 688.0, 984.0, 554.0);

        // Parked segment centred in zoom space (540, 960) = (0.5, 0.5).
        let parked = vec![loupe(|segment| {
            segment.target = RenderCropFloat {
                x: 270.0,
                y: 480.0,
                width: 540.0,
                height: 960.0,
            };
        })];
        let pose =
            resolve_loupe_in_rect(&parked, &portrait_canvas, 2_500.0, screen_rect, None, None)
                .expect("parked pose");
        assert!(!pose.following);
        assert!((pose.center.0 - (48.0 + 984.0 / 2.0)).abs() < 1e-6);
        assert!((pose.center.1 - (688.0 + 554.0 / 2.0)).abs() < 1e-6);

        // Overlapping frame zoom: lens rides the visible zoomed cursor tip
        // while magnifying the unzoomed screen point beneath it.
        let following = vec![loupe(|segment| {
            segment.loupe = Some(RenderLoupe {
                offset: Some(RenderPoint { x: 20.0, y: -15.0 }),
                ..RenderLoupe::default()
            });
        })];
        let pose = resolve_loupe_in_rect(
            &following,
            &canvas(),
            2_500.0,
            (48.0, 27.0, 1_824.0, 1_026.0),
            Some((1_200.0, 600.0)),
            Some((400.0, 300.0)),
        )
        .expect("following pose");
        assert!(pose.following);
        assert!((pose.center.0 - 1_220.0).abs() < 1e-6);
        assert!((pose.center.1 - 585.0).abs() < 1e-6);
        assert!((pose.target.x + pose.target.width / 2.0 - 400.0).abs() < 1e-6);
        assert!((pose.target.y + pose.target.height / 2.0 - 300.0).abs() < 1e-6);
    }

    #[test]
    fn compat_loupe_guards_zero_ring_and_tracks_screen_windows() {
        let segment = loupe(|segment| {
            segment.loupe = Some(RenderLoupe {
                ring_width: 0.0,
                ..RenderLoupe::default()
            });
        });
        let plan = plan_with(vec![segment]);
        let canvas = canvas();
        // Side-by-side window shifts the screen slot to the left half at t=2s.
        let windows = vec![
            super::super::cursor::ScreenRectWindow {
                start_ms: 0,
                end_ms: 2_000,
                rect: (0.0, 0.0, 1_920.0, 1_080.0),
            },
            super::super::cursor::ScreenRectWindow {
                start_ms: 2_000,
                end_ms: 5_000,
                rect: (48.0, 171.0, 1_312.0, 738.0),
            },
        ];
        let prepared = prepare_compat_loupe(
            &plan,
            &canvas,
            &[],
            (0.0, 0.0, 1_920.0, 1_080.0),
            &windows,
            (0.0, 0.0),
            (1_920, 1_080),
            30,
            90,
        )
        .expect("prepared loupe");
        // Zero ring width skips the ring colour branch and gates ring_band on gt(0,0).
        assert!(prepared.frame_a.contains("gt("));
        assert!(prepared.frame_r.contains("if(gt("));
        assert!(!prepared.frame_r.contains("if(gt(d,-0.5)"));
        // Overlay moves at t=2s when the side-by-side screen window takes over.
        assert!(
            prepared.sendcmd.matches("overlay@loupe x").count() >= 2,
            "expected overlay@loupe x to update across screen_windows: {}",
            prepared.sendcmd
        );
    }
}
