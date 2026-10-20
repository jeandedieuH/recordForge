//! Connector routing geometry shared by arrow/line strokes and callout leader
//! lines. Mirrors `packages/overlay-core/src/connectors.ts` so export output
//! matches the canvas preview path-for-path.

const EPSILON: f32 = 1e-6;
const QUADRATIC_STEPS: usize = 32;

/// A connector centerline between `start` and `end`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ConnectorPath {
    /// Straight segment.
    Line { start: (f32, f32), end: (f32, f32) },
    /// Single 90° bend for the "elbow" style.
    Elbow {
        start: (f32, f32),
        corner: (f32, f32),
        end: (f32, f32),
    },
    /// Quadratic bézier for the "curved" style; control is the elbow corner.
    Quad {
        start: (f32, f32),
        control: (f32, f32),
        end: (f32, f32),
    },
}

impl ConnectorPath {
    pub(crate) fn start(&self) -> (f32, f32) {
        match *self {
            Self::Line { start, .. } | Self::Elbow { start, .. } | Self::Quad { start, .. } => {
                start
            }
        }
    }

    pub(crate) fn end(&self) -> (f32, f32) {
        match *self {
            Self::Line { end, .. } | Self::Elbow { end, .. } | Self::Quad { end, .. } => end,
        }
    }

    /// Point "toward" which the start head looks back along the connector.
    pub(crate) fn start_toward(&self) -> (f32, f32) {
        match *self {
            Self::Line { end, .. } => end,
            Self::Elbow { corner, .. }
            | Self::Quad {
                control: corner, ..
            } => corner,
        }
    }

    /// Point "toward" which the end head looks back along the connector.
    pub(crate) fn end_toward(&self) -> (f32, f32) {
        match *self {
            Self::Line { start, .. } => start,
            Self::Elbow { corner, .. }
            | Self::Quad {
                control: corner, ..
            } => corner,
        }
    }
}

fn distance(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt()
}

fn lerp(a: (f32, f32), b: (f32, f32), t: f32) -> (f32, f32) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

/// Elbow corner for a start→end connector. The long axis bends first so the
/// connector travels the dominant direction before turning; `prefer_horizontal`
/// overrides that (callout leaders exit along the box edge's axis). Axis-aligned
/// connectors return `None` because they are already straight.
fn connector_corner(
    start: (f32, f32),
    end: (f32, f32),
    prefer_horizontal: Option<bool>,
) -> Option<(f32, f32)> {
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    if dx.abs() < EPSILON || dy.abs() < EPSILON {
        return None;
    }
    let horizontal_first = prefer_horizontal.unwrap_or_else(|| dx.abs() >= dy.abs());
    Some(if horizontal_first {
        (end.0, start.1)
    } else {
        (start.0, end.1)
    })
}

/// Centerline for a connector between `start` and `end`. The "curved" style
/// reuses the elbow corner as its quadratic control point so both routed styles
/// round the same corner of the dragged rectangle.
pub(crate) fn connector_path_for(
    style: &str,
    start: (f32, f32),
    end: (f32, f32),
    prefer_horizontal: Option<bool>,
) -> ConnectorPath {
    if !matches!(style, "elbow" | "curved") {
        return ConnectorPath::Line { start, end };
    }
    let Some(corner) = connector_corner(start, end, prefer_horizontal) else {
        return ConnectorPath::Line { start, end };
    };
    if style == "elbow" {
        ConnectorPath::Elbow { start, corner, end }
    } else {
        ConnectorPath::Quad {
            start,
            control: corner,
            end,
        }
    }
}

fn quadratic_at(p0: (f32, f32), c: (f32, f32), p1: (f32, f32), t: f32) -> (f32, f32) {
    let mt = 1.0 - t;
    (
        mt * mt * p0.0 + 2.0 * mt * t * c.0 + t * t * p1.0,
        mt * mt * p0.1 + 2.0 * mt * t * c.1 + t * t * p1.1,
    )
}

fn quadratic_length(p0: (f32, f32), c: (f32, f32), p1: (f32, f32)) -> f32 {
    let mut total = 0.0;
    let mut prev = p0;
    for i in 1..=QUADRATIC_STEPS {
        let point = quadratic_at(p0, c, p1, i as f32 / QUADRATIC_STEPS as f32);
        total += distance(prev, point);
        prev = point;
    }
    total
}

/// Approximate the bézier parameter `t` at `target` arc distance from the start.
fn quadratic_parameter_at_distance(
    p0: (f32, f32),
    c: (f32, f32),
    p1: (f32, f32),
    target: f32,
) -> f32 {
    if target <= 0.0 {
        return 0.0;
    }
    let mut prev = p0;
    let mut traveled = 0.0;
    for i in 1..=QUADRATIC_STEPS {
        let point = quadratic_at(p0, c, p1, i as f32 / QUADRATIC_STEPS as f32);
        let segment = distance(prev, point);
        if traveled + segment >= target {
            let fraction = if segment <= EPSILON {
                0.0
            } else {
                (target - traveled) / segment
            };
            return (i - 1) as f32 / QUADRATIC_STEPS as f32 + fraction / QUADRATIC_STEPS as f32;
        }
        traveled += segment;
        prev = point;
    }
    1.0
}

/// de Casteljau sub-curve of quadratic (p0, c, p1) restricted to t ∈ [t0, t1].
fn quadratic_subcurve(
    p0: (f32, f32),
    c: (f32, f32),
    p1: (f32, f32),
    t0: f32,
    t1: f32,
) -> ((f32, f32), (f32, f32), (f32, f32)) {
    let upper = t1.clamp(0.0, 1.0);
    let left_control = lerp(p0, c, upper);
    let end = quadratic_at(p0, c, p1, upper);
    let lower = t0.clamp(0.0, 1.0);
    let u = if upper <= EPSILON {
        0.0
    } else {
        (lower / upper).clamp(0.0, 1.0)
    };
    let start = quadratic_at(p0, c, p1, lower);
    let control = lerp(left_control, end, u);
    (start, control, end)
}

pub(crate) fn connector_length(path: &ConnectorPath) -> f32 {
    match *path {
        ConnectorPath::Line { start, end } => distance(start, end),
        ConnectorPath::Elbow { start, corner, end } => {
            distance(start, corner) + distance(corner, end)
        }
        ConnectorPath::Quad {
            start,
            control,
            end,
        } => quadratic_length(start, control, end),
    }
}

fn trim_polyline_start(points: &[(f32, f32)], trim: f32) -> Vec<(f32, f32)> {
    let mut result: Vec<(f32, f32)> = points.to_vec();
    let mut remaining = trim;
    while result.len() > 1 && remaining > 0.0 {
        let segment = distance(result[0], result[1]);
        if segment <= EPSILON {
            result.remove(0);
            continue;
        }
        if remaining >= segment {
            remaining -= segment;
            result.remove(0);
            continue;
        }
        result[0] = lerp(result[0], result[1], remaining / segment);
        remaining = 0.0;
    }
    result
}

fn trim_polyline_end(points: &[(f32, f32)], trim: f32) -> Vec<(f32, f32)> {
    let mut result: Vec<(f32, f32)> = points.to_vec();
    let mut remaining = trim;
    while result.len() > 1 && remaining > 0.0 {
        let last = result.len() - 1;
        let segment = distance(result[last - 1], result[last]);
        if segment <= EPSILON {
            result.pop();
            continue;
        }
        if remaining >= segment {
            remaining -= segment;
            result.pop();
            continue;
        }
        result[last] = lerp(result[last], result[last - 1], remaining / segment);
        remaining = 0.0;
    }
    result
}

/// Shorten a connector's shaft by `start_trim`/`end_trim` arc length so stroked
/// heads do not overlap the line. Trims are capped at 45% of the total length
/// each, matching the previous straight-line head offset behavior.
pub(crate) fn trim_connector(
    path: &ConnectorPath,
    start_trim: f32,
    end_trim: f32,
) -> ConnectorPath {
    let total = connector_length(path);
    if total <= EPSILON {
        return *path;
    }
    let start = start_trim.clamp(0.0, total * 0.45);
    let end = end_trim.clamp(0.0, total * 0.45);
    if start <= 0.0 && end <= 0.0 {
        return *path;
    }

    if let ConnectorPath::Quad {
        start: p0,
        control,
        end: p1,
    } = *path
    {
        let t0 = quadratic_parameter_at_distance(p0, control, p1, start);
        let t1 = quadratic_parameter_at_distance(p0, control, p1, (total - end).max(0.0));
        let (ns, nc, ne) = quadratic_subcurve(p0, control, p1, t0, t1.max(t0));
        return ConnectorPath::Quad {
            start: ns,
            control: nc,
            end: ne,
        };
    }

    let points: Vec<(f32, f32)> = match *path {
        ConnectorPath::Line { start, end } => vec![start, end],
        ConnectorPath::Elbow { start, corner, end } => vec![start, corner, end],
        ConnectorPath::Quad { .. } => return *path,
    };
    let trimmed = trim_polyline_end(&trim_polyline_start(&points, start), end);
    match trimmed.as_slice() {
        [a, corner, b, ..] => ConnectorPath::Elbow {
            start: *a,
            corner: *corner,
            end: *b,
        },
        [a, b] => ConnectorPath::Line { start: *a, end: *b },
        [a] => ConnectorPath::Line { start: *a, end: *a },
        [] => *path,
    }
}

/// Shaft length to remove so a stroked head does not overlap the line.
pub(crate) fn head_trim(head: &str, head_size: f32) -> f32 {
    if head == "none" {
        0.0
    } else if head == "circle" {
        head_size / 2.0
    } else {
        head_size * 0.7
    }
}

/// Point where a callout leader leaves the bubble: the ray from the box center
/// to the target, clipped to the box border. The boolean reports whether the
/// leader exits horizontally (left/right edge) so elbow/curved leaders leave
/// the bubble cleanly.
pub(crate) fn callout_attach_point(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    target: (f32, f32),
) -> ((f32, f32), bool) {
    let center_x = x + width / 2.0;
    let center_y = y + height / 2.0;
    let dx = target.0 - center_x;
    let dy = target.1 - center_y;
    if dx.abs() < EPSILON && dy.abs() < EPSILON {
        return ((center_x, y + height), false);
    }
    let t_x = if dx == 0.0 {
        f32::INFINITY
    } else {
        (width / 2.0).max(EPSILON) / dx.abs()
    };
    let t_y = if dy == 0.0 {
        f32::INFINITY
    } else {
        (height / 2.0).max(EPSILON) / dy.abs()
    };
    let t = t_x.min(t_y);
    ((center_x + dx * t, center_y + dy * t), t_x <= t_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straight_style_produces_line() {
        let path = connector_path_for("straight", (0.0, 0.0), (100.0, 50.0), None);
        assert_eq!(
            path,
            ConnectorPath::Line {
                start: (0.0, 0.0),
                end: (100.0, 50.0)
            }
        );
    }

    #[test]
    fn elbow_bends_along_dominant_axis_first() {
        let path = connector_path_for("elbow", (0.0, 0.0), (100.0, 50.0), None);
        assert_eq!(
            path,
            ConnectorPath::Elbow {
                start: (0.0, 0.0),
                corner: (100.0, 0.0),
                end: (100.0, 50.0)
            }
        );
        let tall = connector_path_for("elbow", (0.0, 0.0), (50.0, 100.0), None);
        assert_eq!(
            tall,
            ConnectorPath::Elbow {
                start: (0.0, 0.0),
                corner: (0.0, 100.0),
                end: (50.0, 100.0)
            }
        );
    }

    #[test]
    fn elbow_honors_preferred_axis() {
        let path = connector_path_for("elbow", (0.0, 0.0), (100.0, 50.0), Some(false));
        assert_eq!(
            path,
            ConnectorPath::Elbow {
                start: (0.0, 0.0),
                corner: (0.0, 50.0),
                end: (100.0, 50.0)
            }
        );
    }

    #[test]
    fn curved_uses_elbow_corner_as_control() {
        let path = connector_path_for("curved", (0.0, 0.0), (100.0, 50.0), None);
        assert_eq!(
            path,
            ConnectorPath::Quad {
                start: (0.0, 0.0),
                control: (100.0, 0.0),
                end: (100.0, 50.0)
            }
        );
    }

    #[test]
    fn axis_aligned_routed_styles_degenerate_to_line() {
        for style in ["elbow", "curved"] {
            let path = connector_path_for(style, (10.0, 10.0), (10.0, 90.0), None);
            assert!(matches!(path, ConnectorPath::Line { .. }));
        }
    }

    #[test]
    fn trim_shortens_line_from_both_ends() {
        let path = ConnectorPath::Line {
            start: (0.0, 0.0),
            end: (100.0, 0.0),
        };
        let trimmed = trim_connector(&path, 10.0, 20.0);
        assert_eq!(
            trimmed,
            ConnectorPath::Line {
                start: (10.0, 0.0),
                end: (80.0, 0.0)
            }
        );
    }

    #[test]
    fn trim_caps_each_end_at_forty_five_percent() {
        let path = ConnectorPath::Line {
            start: (0.0, 0.0),
            end: (100.0, 0.0),
        };
        let trimmed = trim_connector(&path, 90.0, 0.0);
        assert_eq!(
            trimmed,
            ConnectorPath::Line {
                start: (45.0, 0.0),
                end: (100.0, 0.0)
            }
        );
    }

    #[test]
    fn trim_elbow_consumes_corner_when_segment_shorter_than_trim() {
        let path = ConnectorPath::Elbow {
            start: (0.0, 0.0),
            corner: (10.0, 0.0),
            end: (10.0, 100.0),
        };
        // Start trim 25 eats the 10px first segment plus 15px of the second.
        let trimmed = trim_connector(&path, 25.0, 0.0);
        let ConnectorPath::Line { start, end } = trimmed else {
            panic!("consumed corner should collapse to a line")
        };
        assert!((start.0 - 10.0).abs() < 0.01);
        assert!((start.1 - 15.0).abs() < 0.01);
        assert_eq!(end, (10.0, 100.0));
    }

    #[test]
    fn trim_curve_preserves_endpoints_when_trimmed() {
        let path = ConnectorPath::Quad {
            start: (0.0, 0.0),
            control: (100.0, 0.0),
            end: (100.0, 100.0),
        };
        let total = connector_length(&path);
        let trimmed = trim_connector(&path, total * 0.25, total * 0.25);
        let ConnectorPath::Quad { start, end, .. } = trimmed else {
            panic!("trimmed curve stays quadratic")
        };
        assert!(start.0 > 0.0, "start should move along the curve");
        assert!(end.1 < 100.0, "end should stop before the tip");
    }

    #[test]
    fn callout_attach_exits_through_nearest_border() {
        // Target below-right of a 100x50 box at (0,0) → exits the bottom edge.
        let (point, horizontal) = callout_attach_point(0.0, 0.0, 100.0, 50.0, (75.0, 150.0));
        assert!(!horizontal, "should exit vertically");
        assert_eq!(point.1, 50.0);
        // Target straight right → exits right edge.
        let (point, horizontal) = callout_attach_point(0.0, 0.0, 100.0, 50.0, (300.0, 25.0));
        assert!(horizontal);
        assert_eq!(point.0, 100.0);
        assert_eq!(point.1, 25.0);
    }

    #[test]
    fn head_trim_matches_canvas_offsets() {
        assert_eq!(head_trim("none", 14.0), 0.0);
        assert_eq!(head_trim("circle", 14.0), 7.0);
        assert_eq!(head_trim("arrow", 14.0), 9.8);
        assert_eq!(head_trim("diamond", 14.0), 9.8);
    }
}
