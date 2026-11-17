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
/// `cursor_point` is the recorded cursor tip's position in canvas coordinates.
/// The lens always rides it: the magnified `target` centres on the tip and the
/// lens centre is the tip plus `settings.offset`. Without a point the lens
/// parks on `settings.center` or the segment target's centre — the same
/// fallback chain `resolveLoupeAt` applies.
pub(crate) fn resolve_loupe_at(
    zoom_segments: &[RenderPlanZoomSegment],
    canvas: &RenderCanvas,
    output_ms: f64,
    cursor_point: Option<(f64, f64)>,
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

    let following = cursor_point.is_some();
    // `loupe_sample_square` reads only the target centre, so a 1x1 rect keeps
    // the sample centred exactly on the cursor tip — no crop-edge clamping
    // can pull it off the point the lens sits on.
    let (target, raw_center) = match cursor_point {
        Some((px, py)) => (
            RenderCropFloat {
                x: px - 0.5,
                y: py - 0.5,
                width: 1.0,
                height: 1.0,
            },
            (px, py),
        ),
        None => {
            let target = clamped_zoom_target(canvas.width, canvas.height, canvas.padding, segment);
            let centre = settings
                .center
                .map(|center| (center.x, center.y))
                .unwrap_or((
                    target.x + target.width / 2.0,
                    target.y + target.height / 2.0,
                ));
            (target, centre)
        }
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
    /// Side of the square lens plate in canvas px (max diameter, even).
    pub plate: u32,
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

/// Signed-distance expression (px, positive outside) of the active lens' SDF
/// evaluated at plate coords (X, Y) and time `T`.
fn sdf_expr(segments: &[&RenderPlanZoomSegment], canvas: &RenderCanvas, plate: u32) -> String {
    let centre = compact(plate as f64 / 2.0);
    piecewise_expr(
        segments,
        |segment| {
            let (r, c) = sdf_params(segment, canvas);
            format!(
                "hypot(max(abs(X-{centre})-({r}-({c})),0),max(abs(Y-{centre})-({r}-({c})),0))-({c})"
            )
        },
        // Far outside so every alpha term evaluates to 0 off-window.
        "4096",
    )
}

fn color_channel_expr(segments: &[&RenderPlanZoomSegment], channel: usize, d: &str) -> String {
    // Colour zones keyed on `d`: outside the ring band the only painted pixels
    // are the black drop shadow; inside the band the ring colour; inside the
    // lens the white glass rim/veil.
    piecewise_expr(
        segments,
        |segment| {
            let settings = segment.loupe.clone().unwrap_or_default();
            let half_ring = compact(settings.ring_width.max(0.0) / 2.0);
            let ring = super::parse_color_hex(&settings.ring_color, 1.0);
            let rgb = [ring.red() as f64, ring.green() as f64, ring.blue() as f64][channel];
            format!(
                "if(gt({d},{half_ring}),0,if(gt({d},-{half_ring}),{},255))",
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

    // Plate: the largest full-size diameter in the window, even-rounded. Every
    // smaller lens draws centred inside the same plate.
    let plate = segments
        .iter()
        .map(|segment| {
            let settings = segment.loupe.clone().unwrap_or_default();
            settings.size.clamp(0.0, 1.0) * canvas.width.min(canvas.height) as f64
        })
        .fold(0.0f64, f64::max);
    let plate = (((plate.ceil() as u32) + 1) & !1)
        .max(2)
        .min(plate_dims.0.min(plate_dims.1).max(2));

    // Per-frame commands: the sample crop tracks the resolved target point and
    // both overlays ride the lens centre.
    let mut sendcmd = String::new();
    let mut previous_crop: Option<(i32, i32, i32)> = None;
    let mut previous_overlay: Option<(i32, i32)> = None;
    let mut seed = None;
    for offset in 0..frame_count {
        let abs_frame = first_frame + offset;
        let output_ms = super::cursor::frame_time_ms(abs_frame, canvas.fps);
        let cursor_point = renderers
            .iter()
            .find(|(start_ms, end_ms, _)| {
                output_ms >= *start_ms as f64 && output_ms < *end_ms as f64
            })
            .and_then(|(_, _, renderer)| renderer.cursor_canvas_point(output_ms));
        let Some(pose) = resolve_loupe_at(&plan.zoom_segments, canvas, output_ms, cursor_point)
            .filter(|pose| pose.is_visible())
        else {
            continue;
        };
        let sq = loupe_sample_square(&pose, content);
        let side = (sq.2.round() as i32 / 2 * 2).max(2);
        let max_x = (plate_dims.0 as i32 - side).max(0);
        let max_y = (plate_dims.1 as i32 - side).max(0);
        let crop_x = ((sq.0 - plate_origin.0).round() as i32 / 2 * 2).clamp(0, max_x);
        let crop_y = ((sq.1 - plate_origin.1).round() as i32 / 2 * 2).clamp(0, max_y);
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
            if previous_overlay
                .map(|prev| prev.0 != overlay_x)
                .unwrap_or(true)
            {
                for target in ["overlay@loupe", "overlay@loupe_frame"] {
                    sendcmd.push_str(&format!("{t:.6} {target} x {overlay_x};\n"));
                }
            }
            if previous_overlay
                .map(|prev| prev.1 != overlay_y)
                .unwrap_or(true)
            {
                for target in ["overlay@loupe", "overlay@loupe_frame"] {
                    sendcmd.push_str(&format!("{t:.6} {target} y {overlay_y};\n"));
                }
            }
            previous_overlay = Some(overlay);
        }
    }
    let Some(seed) = seed else {
        // No visible lens anywhere in the pass: emit nothing at all.
        return None;
    };

    let presence = piecewise_expr(&segments, presence_expr, "0");
    let d = sdf_expr(&segments, canvas, plate);

    // AA edge ≈1.5 px around the SDF boundary, faded by presence.
    let mask_lum = format!("clip(0.5-({d})/1.5,0,1)*255*({presence})");

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

    // Alpha = ring band (straddling the SDF edge) + shadow falloff outside +
    // the glass rim and faint veil inside, everything faded by presence.
    let frame_a = format!(
        "255*({presence})*clip(\
            clip((({ring_width})/2+0.75-abs({d}))/1.5,0,1)*({ring_opacity})\
            +clip((({shadow_blur})-({d}))/({shadow_blur}),0,1)*clip(({d})/1.5,0,1)*({shadow_opacity})\
            +({glass})*clip(-({d})/4,0,1)*clip((({d})+4)/4,0,1)*0.24\
            +({glass})*lt({d},0)*0.05\
        ,0,1)"
    );
    let frame_r = color_channel_expr(&segments, 0, &d);
    let frame_g = color_channel_expr(&segments, 1, &d);
    let frame_b = color_channel_expr(&segments, 2, &d);

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
        "color=c=black:s={plate}x{plate}:r={fps}:d={duration_s}{setpts},format=rgba,geq=r='{}':g='{}':b='{}':a='{}'[loupe_frame]",
        prepared.frame_r, prepared.frame_g, prepared.frame_b, prepared.frame_a
    ));
    let enable = &prepared.enable;
    filters.push(format!(
        "[{current_label}][loupe_disc]overlay@loupe=x={overlay_x}:y={overlay_y}:eof_action=pass:format=auto:enable='{enable}'[with_loupe_disc]"
    ));
    filters.push(format!(
        "[with_loupe_disc][loupe_frame]overlay@loupe_frame=x={overlay_x}:y={overlay_y}:eof_action=pass:format=auto:enable='{enable}'[with_loupe]"
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
            (0.0, 0.0),
            (1_920, 1_080),
            30,
            90,
        )
        .expect("a covered window prepares the lens");
        assert!(prepared.plate.is_multiple_of(2) && prepared.plate > 0);
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
}
