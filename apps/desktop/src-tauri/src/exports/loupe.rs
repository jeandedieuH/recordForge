//! Glass Loupe geometry (M2 #2) for both renderers.
//!
//! A loupe segment is a zoom segment with `style: "loupe"`. It never moves the
//! frame zoom (`camera::evaluate_zoom_transform` skips it); instead a lens floats
//! over the recording and magnifies the segment's target inside it. This module
//! resolves the lens pose at one output timestamp — the mirror of
//! `resolveLoupeAt` in `packages/editor-core/src/zoom-loupe.ts`.

use super::camera::{clamped_zoom_target, ease_progress};
use super::cursor::RenderCanvas;
use super::{RenderCropFloat, RenderLoupe, RenderPlanZoomSegment};

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
}
