use rustybuzz::{Face, UnicodeBuffer};
use std::sync::OnceLock;

// Measurement for the px-resolved caption writer. The three static Inter
// instances (generated in H1a, OFL-1.1) are the SAME files the writer drops
// into `fontsdir`, and HarfBuzz shaping (kerning + ligatures on, the rustybuzz
// defaults) matches what libass's own shaping produces — so the chip width and
// line centers computed here track the rendered text.
//
// Known limitation: glyphs that map to `.notdef` (CJK, emoji, Arabic — not in
// Inter) fall back to a system font inside libass that we cannot measure.
// Those clusters get a heuristic width (full-width scripts 1.0 em, everything
// else 0.6 em), which keeps the chip roughly right but not pixel-exact.

pub(super) const INTER_SEMIBOLD_FILE: &str = "inter-semibold.ttf";
pub(super) const INTER_BOLD_FILE: &str = "inter-bold.ttf";
pub(super) const INTER_EXTRABOLD_FILE: &str = "inter-extrabold.ttf";

const INTER_SEMIBOLD: &[u8] =
    include_bytes!("../../../../../../packages/overlay-engine/fonts/inter-semibold.ttf");
const INTER_BOLD: &[u8] =
    include_bytes!("../../../../../../packages/overlay-engine/fonts/inter-bold.ttf");
const INTER_EXTRABOLD: &[u8] =
    include_bytes!("../../../../../../packages/overlay-engine/fonts/inter-extrabold.ttf");

fn weight_index(weight: u16) -> usize {
    match weight {
        700 => 1,
        800 => 2,
        _ => 0,
    }
}

fn face_for(weight: u16) -> &'static Face<'static> {
    static FACES: OnceLock<[Face<'static>; 3]> = OnceLock::new();
    &FACES.get_or_init(|| {
        [
            Face::from_slice(INTER_SEMIBOLD, 0).expect("embedded Inter SemiBold must parse"),
            Face::from_slice(INTER_BOLD, 0).expect("embedded Inter Bold must parse"),
            Face::from_slice(INTER_EXTRABOLD, 0).expect("embedded Inter ExtraBold must parse"),
        ]
    })[weight_index(weight)]
}

pub(super) fn font_file_for(weight: u16) -> (&'static str, &'static [u8]) {
    match weight_index(weight) {
        1 => (INTER_BOLD_FILE, INTER_BOLD),
        2 => (INTER_EXTRABOLD_FILE, INTER_EXTRABOLD),
        _ => (INTER_SEMIBOLD_FILE, INTER_SEMIBOLD),
    }
}

/// The ASS `Fontname`/`Bold` pair that makes libass resolve the static
/// instance instead of synthesizing emboldening or falling back to Arial.
pub(super) fn ass_family_for(weight: u16) -> (&'static str, &'static str) {
    match weight_index(weight) {
        1 => ("Inter", "-1"),
        2 => ("Inter ExtraBold", "0"),
        _ => ("Inter SemiBold", "0"),
    }
}

/// Vertical metrics libass needs for the Fontsize scaling and baseline
/// correction. Read from the real font tables — NOT constants — so a font
/// update cannot silently skew the burn-in off the preview.
pub(super) struct FontMetrics {
    pub units_per_em: f64,
    /// hhea ascender / descender (descender negative) — the CSS line box uses
    /// these; libass uses the OS/2 win metrics below.
    pub hhea_ascender: f64,
    pub hhea_descender: f64,
    pub win_ascender: f64,
    pub win_descender: f64,
}

impl FontMetrics {
    /// ASS `Fontsize` that makes libass render a CSS em of `font_px` pixels:
    /// libass scales by the OS/2 win metrics, so the real em is
    /// `Fontsize · upem / (winAsc + winDesc)`.
    pub fn ass_font_size(&self, font_px: f64) -> f64 {
        font_px * (self.win_ascender + self.win_descender) / self.units_per_em
    }

    /// Baseline correction between the preview's CSS line box and libass's
    /// `\an5` single-line centering. libass puts the baseline at
    /// `pos.y + (winAsc − winDesc)/(2·upem)·em`; a CSS line-height box puts it
    /// at `lineCenter + (hheaAsc − |hheaDesc|)/(2·upem)·em`. Returning the
    /// difference in px lets each per-line event sit exactly on the CSS model.
    pub fn baseline_shift_px(&self, font_px: f64) -> f64 {
        ((self.hhea_ascender + self.hhea_descender) - (self.win_ascender - self.win_descender))
            / (2.0 * self.units_per_em)
            * font_px
    }
}

pub(super) fn metrics_for(weight: u16) -> FontMetrics {
    let face = face_for(weight);
    let (win_asc, win_desc) = face
        .tables()
        .os2
        .map(|os2| {
            (
                f64::from(os2.windows_ascender()),
                f64::from(os2.windows_descender().unsigned_abs()),
            )
        })
        .unwrap_or((f64::from(face.ascender()), -f64::from(face.descender())));
    FontMetrics {
        units_per_em: f64::from(face.units_per_em()),
        hhea_ascender: f64::from(face.ascender()),
        hhea_descender: f64::from(face.descender()),
        win_ascender: win_asc,
        win_descender: win_desc,
    }
}

/// Scripts Inter does not cover get a 1 em advance guess when they are
/// full-width; everything else 0.6 em (see the module note).
fn is_fullwidth_unshaped(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x11FF | 0x2E80..=0x9FFF | 0xA000..=0xA4CF | 0xAC00..=0xD7AF
        | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6
        | 0x20000..=0x2FA1F | 0x1F300..=0x1FAFF)
}

/// HarfBuzz-measured advance of `text` at `font_px`, plus letter spacing per
/// shaped glyph. `.notdef` clusters (scripts outside Inter) use the heuristic
/// above so the chip still roughly wraps them.
pub(super) fn measure_line_px(
    weight: u16,
    text: &str,
    font_px: f64,
    letter_spacing_px: f64,
) -> f64 {
    let face = face_for(weight);
    let upem = f64::from(face.units_per_em());
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    let shaped = rustybuzz::shape(face, &[], buffer);
    let positions = shaped.glyph_positions();
    let infos = shaped.glyph_infos();
    let mut advance_units = 0.0_f64;
    for (info, position) in infos.iter().zip(positions.iter()) {
        if info.glyph_id == 0 {
            let ch = text[info.cluster as usize..].chars().next().unwrap_or('?');
            advance_units += if is_fullwidth_unshaped(ch) {
                upem
            } else {
                0.6 * upem
            };
        } else {
            advance_units += f64::from(position.x_advance);
        }
    }
    advance_units * font_px / upem + positions.len() as f64 * letter_spacing_px
}
