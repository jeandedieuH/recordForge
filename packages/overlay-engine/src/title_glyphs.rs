use rustybuzz::{
    ttf_parser::{GlyphId, OutlineBuilder, Tag},
    Face, UnicodeBuffer, Variation,
};
use std::{collections::BTreeMap, fmt::Write};
use unicode_segmentation::UnicodeSegmentation;

pub(super) fn face(family: &str, weight: &str) -> Face<'static> {
    let bytes: &[u8] = match family {
        "serif" => include_bytes!("../fonts/sourceserif4.ttf"),
        "mono" => include_bytes!("../fonts/jetbrainsmono.ttf"),
        "heading" | "outfit" => include_bytes!("../fonts/outfit.ttf"),
        _ => include_bytes!("../fonts/inter.ttf"),
    };
    let mut face = Face::from_slice(bytes, 0).expect("embedded OFL font must be valid");
    let weight = weight
        .parse::<f32>()
        .unwrap_or(if weight == "bold" { 700.0 } else { 400.0 });
    face.set_variations(&[
        Variation {
            tag: Tag::from_bytes(b"wght"),
            value: weight.clamp(100.0, 900.0),
        },
        Variation {
            tag: Tag::from_bytes(b"opsz"),
            value: 32.0,
        },
    ]);
    face
}

fn shape(face: &Face<'_>, text: &str) -> rustybuzz::GlyphBuffer {
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    rustybuzz::shape(face, &[], buffer)
}
pub(super) fn measure(face: &Face<'_>, text: &str, size: f64, spacing: f64) -> f64 {
    let shaped = shape(face, text);
    let advance: i64 = shaped
        .glyph_positions()
        .iter()
        .map(|p| i64::from(p.x_advance))
        .sum();
    advance as f64 * size / f64::from(face.units_per_em())
        + text.graphemes(true).count().saturating_sub(1) as f64 * spacing * size
}

pub(super) fn wrap(
    face: &Face<'_>,
    text: &str,
    width: f64,
    size: f64,
    spacing: f64,
) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        let mut used = 0.0;
        for token in paragraph.split_word_bounds() {
            let token_width = measure(face, token, size, spacing).max(0.0);
            if token_width > width {
                for grapheme in token.graphemes(true) {
                    let w = measure(face, grapheme, size, spacing).max(0.0) + spacing * size;
                    if used + w > width && !line.is_empty() {
                        lines.push(std::mem::take(&mut line));
                        used = 0.0;
                    }
                    line.push_str(grapheme);
                    used += w;
                }
                continue;
            }
            if used + token_width > width && !line.is_empty() {
                lines.push(line.trim_end().to_owned());
                line.clear();
                used = 0.0;
            }
            if line.is_empty() && token.chars().all(char::is_whitespace) {
                continue;
            }
            line.push_str(token);
            used += token_width + spacing * size;
        }
        lines.push(line.trim_end().to_owned());
    }
    lines
}

#[derive(Default)]
pub(super) struct Run {
    pub path: String,
    pub x: f64,
    pub width: f64,
    pub start: usize,
    pub end: usize,
}

pub(super) fn runs(face: &Face<'_>, text: &str, size: f64, spacing: f64, typing: bool) -> Vec<Run> {
    let units = f64::from(face.units_per_em());
    let shaped = shape(face, text);
    let boundaries: Vec<(usize, &str)> = if typing {
        text.grapheme_indices(true).collect()
    } else {
        text.split_word_bound_indices().collect()
    };
    let mut groups: BTreeMap<usize, Run> = BTreeMap::new();
    let mut x = 0.0;
    let mut previous_cluster = None;
    for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
        let cluster = info.cluster as usize;
        let group_index = boundaries
            .partition_point(|(start, _)| *start <= cluster)
            .saturating_sub(1);
        let (start, token) = boundaries.get(group_index).copied().unwrap_or((0, text));
        if previous_cluster.is_some_and(|previous| previous != cluster) {
            x += spacing * size;
        }
        previous_cluster = Some(cluster);
        let advance = f64::from(position.x_advance) * size / units;
        let group = groups.entry(group_index).or_insert_with(|| Run {
            x,
            start,
            end: start + token.len(),
            ..Default::default()
        });
        let mut outline = Outline {
            path: String::new(),
            x: x + f64::from(position.x_offset) * size / units,
            y: -f64::from(position.y_offset) * size / units,
            scale: size / units,
        };
        face.outline_glyph(GlyphId(info.glyph_id as u16), &mut outline);
        group.path.push_str(&outline.path);
        group.width = (x + advance - group.x).max(group.width);
        x += advance;
    }
    groups.into_values().collect()
}

pub(super) fn glyph_path(face: &Face<'_>, text: &str) -> String {
    runs(face, text, 1.0, 0.0, false)
        .into_iter()
        .map(|r| r.path)
        .collect()
}

struct Outline {
    path: String,
    x: f64,
    y: f64,
    scale: f64,
}
impl Outline {
    fn point(&self, x: f32, y: f32) -> (f64, f64) {
        (
            self.x + f64::from(x) * self.scale,
            self.y - f64::from(y) * self.scale,
        )
    }
}
impl OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.point(x, y);
        let _ = write!(self.path, "M{x:.4} {y:.4}");
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.point(x, y);
        let _ = write!(self.path, "L{x:.4} {y:.4}");
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (a, b) = self.point(x1, y1);
        let (x, y) = self.point(x, y);
        let _ = write!(self.path, "Q{a:.4} {b:.4} {x:.4} {y:.4}");
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (a, b) = self.point(x1, y1);
        let (c, d) = self.point(x2, y2);
        let (x, y) = self.point(x, y);
        let _ = write!(self.path, "C{a:.4} {b:.4} {c:.4} {d:.4} {x:.4} {y:.4}");
    }
    fn close(&mut self) {
        self.path.push('Z');
    }
}
