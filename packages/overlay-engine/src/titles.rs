use serde::{Deserialize, Serialize};

use crate::{scene::TextDetails, OverlayError, OverlayTransform};

#[path = "title_glyphs.rs"]
mod glyphs;
#[path = "title_layout.rs"]
mod layout;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TitleTemplate {
    #[default]
    CleanText,
    Emphasis,
    EditorialOpener,
    KineticHook,
    ChapterMarker,
    SpeakerId,
    SourceCredit,
    StepGuide,
    Shortcut,
    CommandLine,
    Note,
    PullQuote,
    Metric,
    CallToAction,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TitleAppearance {
    #[default]
    Dark,
    Light,
    Transparent,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TitleMotion {
    #[default]
    Designed,
    Subtle,
    None,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteTone {
    Note,
    #[default]
    Tip,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleMetric {
    pub from: f64,
    pub to: f64,
    pub decimals: u8,
    pub prefix: String,
    pub suffix: String,
}
impl Default for TitleMetric {
    fn default() -> Self {
        Self {
            from: 0.0,
            to: 98.0,
            decimals: 0,
            prefix: String::new(),
            suffix: "%".into(),
        }
    }
}
/// Optional per-element size overrides (clip units). A set field replaces the
/// template's `font_size * ratio` default so each line sizes independently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleFontSizes {
    pub primary: Option<f64>,
    pub secondary: Option<f64>,
    pub tag: Option<f64>,
    pub metric: Option<f64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleDesign {
    pub version: u8,
    pub template: TitleTemplate,
    pub appearance: TitleAppearance,
    pub motion: TitleMotion,
    pub tempo: f64,
    pub font_sizes: TitleFontSizes,
    pub emphasis_text: String,
    pub note_tone: NoteTone,
    pub letter_spacing: f64,
    pub line_height: f64,
    pub metric: TitleMetric,
}
impl Default for TitleDesign {
    fn default() -> Self {
        Self {
            version: 1,
            template: TitleTemplate::default(),
            appearance: TitleAppearance::default(),
            motion: TitleMotion::default(),
            tempo: 1.0,
            font_sizes: TitleFontSizes::default(),
            emphasis_text: String::new(),
            note_tone: NoteTone::default(),
            letter_spacing: 0.0,
            line_height: 1.15,
            metric: TitleMetric::default(),
        }
    }
}
impl TitleDesign {
    pub(crate) fn validate(&self) -> Result<(), OverlayError> {
        let ranges = [
            (self.tempo, 0.5, 2.0),
            (self.letter_spacing, -0.05, 0.2),
            (self.line_height, 0.9, 1.8),
            (self.metric.from, -1e9, 1e9),
            (self.metric.to, -1e9, 1e9),
        ];
        let sizes_valid = [
            self.font_sizes.primary,
            self.font_sizes.secondary,
            self.font_sizes.tag,
            self.font_sizes.metric,
        ]
        .into_iter()
        .all(|v| v.is_none_or(|s| s.is_finite() && (4.0..=600.0).contains(&s)));
        if self.version != 1
            || self.metric.decimals > 3
            || !sizes_valid
            || ranges
                .iter()
                .any(|(v, low, high)| !v.is_finite() || v < low || v > high)
            || self.emphasis_text.chars().count() > 500
            || self.metric.prefix.chars().count() > 20
            || self.metric.suffix.chars().count() > 20
        {
            return Err(OverlayError::InvalidPlan("invalid title design".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSceneElement {
    pub path: String,
    pub fill: String,
    pub opacity: f64,
    pub translate_x: f64,
    pub translate_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<TitleClip>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleScene {
    pub width: f64,
    pub height: f64,
    pub elements: Vec<TitleSceneElement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Backdrop,
    Decoration,
    Tag,
    Primary,
    Secondary,
}
#[derive(Debug, Clone)]
struct Part {
    element: TitleSceneElement,
    role: Role,
    order: f64,
    typing: Option<f64>,
}
#[derive(Debug, Clone)]
struct MetricLayout {
    glyphs: Vec<(char, String)>,
    cells: usize,
    x: f64,
    y: f64,
    size: f64,
    advance: f64,
    fill: String,
}
#[derive(Debug, Clone)]
pub(crate) struct TitleLayout {
    width: f64,
    height: f64,
    parts: Vec<Part>,
    metric: Option<MetricLayout>,
    design: TitleDesign,
}
/// Compile and evaluate a designed title for a point on the clip timeline.
/// Returns `None` when the clip has no title design, letting the legacy text renderer take over.
pub fn compile_and_evaluate(
    details: &TextDetails,
    transform: &OverlayTransform,
    elapsed: u64,
    duration: u64,
) -> Result<Option<TitleScene>, OverlayError> {
    let Some(design) = details.title_design.as_ref() else {
        return Ok(None);
    };
    design.validate()?;
    if details.primary_text.len()
        + details.secondary_text.as_ref().map_or(0, String::len)
        + details.tag_text.as_ref().map_or(0, String::len)
        > 32768
    {
        return Err(OverlayError::InvalidPlan(
            "title text exceeds layout budget".into(),
        ));
    }
    Ok(Some(
        layout::compile(details, transform, design).evaluate(elapsed, duration),
    ))
}

impl TitleLayout {
    pub(crate) fn evaluate(&self, elapsed: u64, duration: u64) -> TitleScene {
        let disabled = self.design.motion == TitleMotion::None;
        let enter_ms = (720.0 / self.design.tempo)
            .min(duration as f64 * 0.35)
            .max(0.001);
        let exit_ms = (260.0 / self.design.tempo)
            .min(duration as f64 * 0.20)
            .max(0.001);
        let enter = if disabled {
            1.0
        } else {
            (elapsed as f64 / enter_ms).clamp(0.0, 1.0)
        };
        let exit = if disabled {
            0.0
        } else {
            ((elapsed as f64 - (duration as f64 - exit_ms)) / exit_ms).clamp(0.0, 1.0)
        };
        let subtle = self.design.motion == TitleMotion::Subtle;
        let mut elements = Vec::with_capacity(self.parts.len() + 24);
        for part in &self.parts {
            let mut e = part.element.clone();
            let delay = match part.role {
                Role::Backdrop => 0.0,
                Role::Decoration => 0.06,
                Role::Tag => 0.10,
                Role::Primary => 0.18,
                Role::Secondary => 0.36,
            } + part.order * 0.18;
            let progress = ease(((enter - delay) / (1.0 - delay)).clamp(0.0, 1.0));
            e.opacity *= progress * (1.0 - ease(exit));
            if !disabled && !subtle {
                let offset = (1.0 - progress) * self.height.min(220.0) * 0.14;
                match (self.design.template, part.role) {
                    (
                        TitleTemplate::SpeakerId | TitleTemplate::SourceCredit,
                        Role::Primary | Role::Secondary,
                    ) => e.translate_x -= offset,
                    (TitleTemplate::KineticHook, Role::Primary) => {
                        let scale = 0.92 + 0.08 * progress;
                        e.scale_x *= scale;
                        e.scale_y *= scale;
                        e.translate_x += self.width * (1.0 - scale) * 0.5;
                        e.translate_y += offset;
                    }
                    (_, Role::Primary | Role::Secondary | Role::Tag) => e.translate_y += offset,
                    (_, Role::Decoration) => {
                        // A scene-space mask reveals rules without stretching their corner geometry.
                        let clip = e.clip.get_or_insert(TitleClip {
                            x: 0.0,
                            y: 0.0,
                            width: self.width,
                            height: self.height,
                        });
                        clip.width *= progress;
                    }
                    _ => {}
                }
                e.translate_y -= ease(exit) * self.height.min(160.0) * 0.045;
            }
            if let Some(threshold) = part.typing {
                if !disabled && !subtle {
                    e.opacity = if enter >= threshold {
                        1.0 - ease(exit)
                    } else {
                        0.0
                    };
                    e.translate_y = part.element.translate_y;
                }
            }
            elements.push(e);
        }
        if let Some(metric) = &self.metric {
            // Only numeric formatting changes per frame; all digits were shaped at scene creation.
            let value = self.design.metric.from
                + (self.design.metric.to - self.design.metric.from) * ease(enter);
            let text = format!("{:.*}", self.design.metric.decimals as usize, value);
            let offset = metric.cells.saturating_sub(text.chars().count()) as f64 * metric.advance;
            for (i, ch) in text.chars().enumerate() {
                if let Some((_, path)) = metric.glyphs.iter().find(|(c, _)| *c == ch) {
                    elements.push(TitleSceneElement {
                        path: path.clone(),
                        fill: metric.fill.clone(),
                        opacity: ease((enter / 0.3).min(1.0)) * (1.0 - ease(exit)),
                        translate_x: metric.x + offset + i as f64 * metric.advance,
                        translate_y: metric.y,
                        scale_x: metric.size,
                        scale_y: metric.size,
                        clip: None,
                    });
                }
            }
        }
        TitleScene {
            width: self.width,
            height: self.height,
            elements,
        }
    }
}
fn ease(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}
