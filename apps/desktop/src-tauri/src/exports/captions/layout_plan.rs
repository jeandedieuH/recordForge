use crate::errors::{InternalError, Result};
use crate::exports::RenderPlanCaption;
use serde::{Deserialize, Serialize};

// Serde mirror of `renderPlanCaptionLayoutSchema` (packages/contracts). Kept
// field-exact — camelCase + deny_unknown_fields — so a plan JSON written by
// the TypeScript render-plan builder deserializes here and a persisted job
// plan round-trips through Serialize unchanged.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutPlan {
    pub look_id: String,
    pub font_px: f64,
    pub line_height_px: f64,
    pub font_weight: u16,
    pub letter_spacing_px: f64,
    pub text_color: String,
    pub chip: Option<CaptionLayoutChip>,
    pub outline: Option<CaptionLayoutOutline>,
    pub shadow: Option<CaptionLayoutShadow>,
    pub highlight: Option<CaptionLayoutHighlight>,
    pub animation: CaptionLayoutAnimation,
    pub pages: Vec<CaptionLayoutPage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutChip {
    pub color: String,
    pub opacity: f64,
    pub radius_px: f64,
    pub pad_x_px: f64,
    pub pad_y_px: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutOutline {
    pub color: String,
    pub opacity: f64,
    pub width_px: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutShadow {
    pub color: String,
    pub opacity: f64,
    pub blur_px: f64,
    pub offset_y_px: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutHighlight {
    pub mode: String,
    pub active_color: String,
    pub inactive_opacity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutAnimation {
    pub in_ms: u64,
    pub out_ms: u64,
    pub from_scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutPage {
    pub start_ms: u64,
    pub end_ms: u64,
    pub animate_in: bool,
    pub animate_out: bool,
    pub lines: Vec<CaptionLayoutLine>,
    pub block: CaptionLayoutBlock,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutLine {
    pub text: String,
    #[serde(default)]
    pub words: Vec<CaptionLayoutWord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutWord {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionLayoutBlock {
    pub center_x: f64,
    pub center_y: f64,
    pub height: f64,
}

fn invalid() -> crate::errors::AppError {
    InternalError::Media("caption layout is invalid".into()).into()
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

fn finite(value: f64) -> bool {
    value.is_finite()
}

fn finite_range(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

fn unit_interval(value: f64) -> bool {
    finite_range(value, 0.0, 1.0)
}

/// Validates a px-resolved layout attached to a plan caption. Only shape and
/// numeric ranges are checked — line/word text is never echoed in errors.
pub(super) fn validate_layout(
    caption: &RenderPlanCaption,
    layout: &CaptionLayoutPlan,
) -> Result<()> {
    if !finite_range(layout.font_px, 8.0, 600.0)
        || !finite_range(layout.line_height_px, 8.0, 900.0)
        || !matches!(layout.font_weight, 600 | 700 | 800)
        || !finite_range(layout.letter_spacing_px, -20.0, 40.0)
        || !is_hex_color(&layout.text_color)
    {
        return Err(invalid());
    }
    if !finite_range(layout.animation.from_scale, 0.5, 1.0) {
        return Err(invalid());
    }
    if let Some(chip) = &layout.chip {
        if !is_hex_color(&chip.color)
            || !unit_interval(chip.opacity)
            || !finite(chip.radius_px)
            || chip.radius_px < 0.0
            || !finite(chip.pad_x_px)
            || chip.pad_x_px < 0.0
            || !finite(chip.pad_y_px)
            || chip.pad_y_px < 0.0
        {
            return Err(invalid());
        }
    }
    if let Some(outline) = &layout.outline {
        if !is_hex_color(&outline.color)
            || !unit_interval(outline.opacity)
            || !finite(outline.width_px)
            || outline.width_px < 0.0
        {
            return Err(invalid());
        }
    }
    if let Some(shadow) = &layout.shadow {
        if !is_hex_color(&shadow.color)
            || !unit_interval(shadow.opacity)
            || !finite(shadow.blur_px)
            || shadow.blur_px < 0.0
            || !finite(shadow.offset_y_px)
        {
            return Err(invalid());
        }
    }
    if let Some(highlight) = &layout.highlight {
        if !matches!(highlight.mode.as_str(), "word" | "focus")
            || !is_hex_color(&highlight.active_color)
            || !unit_interval(highlight.inactive_opacity)
        {
            return Err(invalid());
        }
    }
    if layout.pages.is_empty() {
        return Err(invalid());
    }
    // Pages may sit a millisecond outside the cue when MS rounding collides
    // with the export window clamp — tolerate exactly that much.
    let cue_lo = caption.start_ms.saturating_sub(1);
    let cue_hi = caption.end_ms.saturating_add(1);
    for page in &layout.pages {
        if page.start_ms >= page.end_ms
            || page.start_ms < cue_lo
            || page.end_ms > cue_hi
            || page.lines.is_empty()
            || page.lines.len() > 8
            || !finite(page.block.center_x)
            || !finite(page.block.center_y)
            || !finite(page.block.height)
            || page.block.height <= 0.0
        {
            return Err(invalid());
        }
        let mut words = 0usize;
        for line in &page.lines {
            if line.text.is_empty() {
                return Err(invalid());
            }
            words += line.words.len();
            for word in &line.words {
                if word.text.is_empty() || word.start_ms > word.end_ms {
                    return Err(invalid());
                }
            }
        }
        if words > 500 {
            return Err(invalid());
        }
    }
    Ok(())
}

// Shared contract fixture — regenerated by the editor-core vitest
// `caption-layout-fixtures.test.ts`; parsing it here keeps the Rust serde
// surface in lockstep with the TS layout engine.
#[cfg(test)]
pub(crate) mod fixture {
    use super::CaptionLayoutPlan;
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct FixtureCase {
        pub id: String,
        pub canvas: FixtureCanvas,
        #[allow(dead_code)]
        pub design: serde_json::Value,
        pub cues: Vec<FixtureCue>,
    }
    #[derive(Deserialize)]
    pub struct FixtureCanvas {
        pub width: u32,
        pub height: u32,
    }
    #[derive(Deserialize)]
    pub struct FixtureCue {
        pub input: FixtureInput,
        pub layout: CaptionLayoutPlan,
    }
    #[derive(Deserialize)]
    pub struct FixtureInput {
        pub text: String,
        #[serde(rename = "startMs")]
        pub start_ms: u64,
        #[serde(rename = "endMs")]
        pub end_ms: u64,
    }
    #[derive(Deserialize)]
    pub struct Fixture {
        pub cases: Vec<FixtureCase>,
    }

    pub fn load() -> Fixture {
        serde_json::from_str(include_str!("../../testdata/caption-layouts.json"))
            .expect("caption-layouts.json must deserialize")
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{self, Fixture};
    use super::*;
    use crate::exports::RenderPlanCaption;

    fn fixture() -> Fixture {
        fixture::load()
    }

    fn caption_with_layout() -> (RenderPlanCaption, CaptionLayoutPlan) {
        let fixture = fixture();
        let cue = &fixture.cases[0].cues[0];
        (
            RenderPlanCaption {
                id: "c".into(),
                text: cue.input.start_ms.to_string(),
                start_ms: cue.input.start_ms,
                end_ms: cue.input.end_ms,
                style: "default".into(),
                placement: "bottom".into(),
                safe_area_margin: 48,
                layout: None,
            },
            cue.layout.clone(),
        )
    }

    #[test]
    fn every_fixture_layout_parses_and_round_trips() {
        let fixture = fixture();
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            assert_ne!(case.canvas.width, 0);
            assert!(!case.cues.is_empty());
            for cue in &case.cues {
                let json = serde_json::to_string(&cue.layout).expect("serialize layout");
                let back: CaptionLayoutPlan =
                    serde_json::from_str(&json).expect("layout round trip");
                assert_eq!(back, cue.layout, "{}", case.id);
            }
        }
    }

    #[test]
    fn every_fixture_layout_validates_against_its_cue() {
        let fixture = fixture();
        for case in &fixture.cases {
            for cue in &case.cues {
                let caption = RenderPlanCaption {
                    id: "c".into(),
                    text: "x".into(),
                    start_ms: cue.input.start_ms,
                    end_ms: cue.input.end_ms,
                    style: "default".into(),
                    placement: "bottom".into(),
                    safe_area_margin: 48,
                    layout: Some(cue.layout.clone()),
                };
                validate_layout(&caption, &cue.layout)
                    .unwrap_or_else(|e| panic!("{} must validate: {e}", case.id));
            }
        }
    }

    #[test]
    fn layout_round_trips_inside_a_plan_caption() {
        let (mut caption, layout) = caption_with_layout();
        caption.layout = Some(layout.clone());
        let json = serde_json::to_string(&caption).expect("serialize");
        let back: RenderPlanCaption = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.layout, Some(layout));
    }

    #[test]
    fn rejects_bad_weight_and_font_size() {
        let (caption, mut layout) = caption_with_layout();
        layout.font_weight = 400;
        assert!(validate_layout(&caption, &layout).is_err());
        layout.font_weight = 600;
        layout.font_px = 4.0;
        assert!(validate_layout(&caption, &layout).is_err());
    }

    #[test]
    fn rejects_bad_colors_and_opacity() {
        let (caption, mut layout) = caption_with_layout();
        layout.text_color = "white".into();
        assert!(validate_layout(&caption, &layout).is_err());
        layout.text_color = "#FFFFFF".into();
        layout.chip = Some(CaptionLayoutChip {
            color: "#000000".into(),
            opacity: 1.5,
            radius_px: 4.0,
            pad_x_px: 8.0,
            pad_y_px: 4.0,
        });
        assert!(validate_layout(&caption, &layout).is_err());
    }

    #[test]
    fn rejects_empty_pages_and_pages_outside_the_cue() {
        let (caption, mut layout) = caption_with_layout();
        layout.pages.clear();
        assert!(validate_layout(&caption, &layout).is_err());
        let (caption, mut layout) = caption_with_layout();
        layout.pages[0].start_ms = 1; // cue starts much later
        assert!(validate_layout(&caption, &layout).is_err());
        let (caption, mut layout) = caption_with_layout();
        layout.pages[0].end_ms = 900_000; // cue ends far earlier
        assert!(validate_layout(&caption, &layout).is_err());
    }

    #[test]
    fn rejects_non_finite_block_geometry() {
        let (caption, mut layout) = caption_with_layout();
        layout.pages[0].block.center_x = f64::NAN;
        assert!(validate_layout(&caption, &layout).is_err());
    }
}
