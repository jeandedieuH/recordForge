use super::{
    glyphs, AnimPreset, MetricLayout, NoteTone, Part, Role, TitleClip, TitleDesign, TitleEmphasis,
    TitleLayout, TitleSceneElement, TitleSceneGradient, TitleSceneStroke, TitleTemplate,
};
use crate::{scene::TextDetails, OverlayTransform};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy)]
struct BoxRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
impl BoxRect {
    fn clip(self) -> TitleClip {
        TitleClip {
            x: self.x,
            y: self.y,
            width: self.w.max(0.0),
            height: self.h.max(0.0),
        }
    }
    fn center(self) -> (f64, f64) {
        (self.x + self.w * 0.5, self.y + self.h * 0.5)
    }
    fn inset(self, px: f64, py: f64) -> BoxRect {
        BoxRect {
            x: self.x + px,
            y: self.y + py,
            w: self.w - px * 2.0,
            h: self.h - py * 2.0,
        }
    }
    fn with_h(self, h: f64) -> BoxRect {
        BoxRect { h, ..self }
    }
    fn bottom(self) -> f64 {
        self.y + self.h
    }
}

#[derive(Clone)]
struct Style {
    family: String,
    size: f64,
    weight: String,
    spacing: f64,
    line_height: f64,
    transform: super::TitleTextTransform,
    color: String,
    align: String,
}

// Per-template default element-size ratios (of the clip's fontSize). Element
// `size` overrides in the design replace these. Mirror:
// packages/editor-core/src/title-preset-helpers.ts `titleFontSizeRatios` —
// keep the numbers identical (a test on each side locks the table).
fn size_ratios(t: TitleTemplate) -> (f64, f64, f64, f64) {
    match t {
        TitleTemplate::Hook => (1.3, 0.30, 0.22, 1.0),
        TitleTemplate::HookEmphasis => (1.15, 0.32, 0.28, 1.0),
        TitleTemplate::Clean => (1.0, 0.45, 0.33, 1.0),
        TitleTemplate::Editorial => (1.15, 0.30, 0.23, 1.0),
        TitleTemplate::Chapter => (1.0, 0.40, 1.8, 1.0),
        TitleTemplate::LowerThirdBar
        | TitleTemplate::LowerThirdGlass
        | TitleTemplate::LowerThirdLine => (1.0, 0.50, 0.40, 1.0),
        TitleTemplate::SocialHandle => (0.9, 0.50, 0.40, 1.0),
        TitleTemplate::Cta | TitleTemplate::CtaFollow | TitleTemplate::CtaLink => {
            (0.9, 0.45, 0.36, 1.0)
        }
        TitleTemplate::Step => (0.9, 0.55, 0.7, 1.0),
        TitleTemplate::Checklist => (0.9, 0.60, 0.38, 1.0),
        TitleTemplate::Shortcut => (0.75, 0.50, 0.36, 1.0),
        TitleTemplate::Terminal => (0.7, 0.45, 0.36, 1.0),
        TitleTemplate::Callout => (0.9, 0.62, 0.5, 1.0),
        TitleTemplate::Quote => (1.0, 0.42, 0.32, 1.0),
        TitleTemplate::Stat => (0.36, 0.26, 0.24, 1.7),
        TitleTemplate::StatBeforeAfter => (0.34, 0.26, 0.22, 1.5),
        TitleTemplate::Countdown => (0.22, 0.16, 0.16, 2.6),
        TitleTemplate::Location => (0.75, 0.55, 0.45, 1.0),
        TitleTemplate::Banner => (0.9, 0.38, 0.26, 1.0),
        TitleTemplate::Highlight => (1.0, 0.34, 0.26, 1.0),
        TitleTemplate::Kinetic => (1.25, 0.30, 0.24, 1.0),
        TitleTemplate::Agenda => (0.85, 0.58, 0.36, 1.0),
        TitleTemplate::Outro => (1.1, 0.32, 0.28, 1.0),
        TitleTemplate::Source => (0.75, 0.56, 0.45, 1.0),
    }
}

fn role_index(role: Role) -> usize {
    match role {
        Role::Backdrop => 0,
        Role::Decoration => 1,
        Role::Tag => 2,
        Role::Primary => 3,
        Role::Secondary => 4,
    }
}

// A stack block is one vertical slice of a template composition. Blocks are
// measured at their natural (unscaled) size, share one fit factor, and render
// top-to-bottom so type hierarchy survives when the box is short.
#[derive(Clone)]
enum StackBlock {
    /// Accent kicker line from `tag_text`.
    Tag,
    /// Explicit label rendered with the tag style and an explicit color
    /// (callout tone labels, source kicker). Already display-cased.
    Label {
        text: String,
        color: String,
    },
    /// Tag inside an accent chip (single line, never wraps).
    Chip,
    Primary {
        emphasis: bool,
    },
    Secondary,
    Metric {
        step: bool,
        before_after: bool,
    },
    /// Primary text on an accent pill that hugs the text (CTA button).
    ButtonPrimary,
    /// Tag text on an accent pill that hugs the text (outro handle).
    ButtonTag,
    ChecklistItems,
    AgendaItems,
    Keycaps,
    /// Terminal chrome: three dots plus the tag on one line.
    TerminalBar,
    /// Full-bleed accent band carrying the primary text (banner).
    Band,
    /// Reserved vertical space (no content).
    Slot(f64),
}

struct StackItem {
    block: StackBlock,
    /// Absolute gap above this block; defaults to a proportion of the
    /// previous block's type size when unset.
    gap: Option<f64>,
    /// Horizontal alignment override for the block's text, used when a
    /// template's composition axis is fixed (the banner's supporting line
    /// follows the centered band regardless of the clip alignment).
    align: Option<&'static str>,
}
impl StackItem {
    fn new(block: StackBlock) -> Self {
        Self {
            block,
            gap: None,
            align: None,
        }
    }
    fn centered(mut self) -> Self {
        self.align = Some("center");
        self
    }
}

#[derive(Clone)]
struct StackBlockInfo {
    rect: BoxRect,
    // Resolved type size driving this block (before the shared fit factor).
    size: f64,
    block: StackBlock,
}

#[derive(Clone)]
struct StackInfo {
    // Bounding rect of the rendered stack (before clipping to `rect`).
    rect: BoxRect,
    fit: f64,
    blocks: Vec<StackBlockInfo>,
}

struct Builder<'a> {
    layout: TitleLayout,
    details: &'a TextDetails,
    foreground: String,
    secondary: String,
    surface: String,
    accent: String,
    inner: BoxRect,
    pad_x: f64,
    pad_y: f64,
    // Per-role [line, word, char] counters for animation units.
    counts: [[u32; 3]; 5],
    split_rect: Option<BoxRect>,
    // The main text stack's occupied rect, recorded by `stack` so edge
    // decorations (bars, dots, numbers) hug the content instead of the box.
    stack_info: Option<StackInfo>,
}

pub(super) fn compile(
    d: &TextDetails,
    transform: &OverlayTransform,
    design: &TitleDesign,
) -> TitleLayout {
    let w = transform.width.max(1.0);
    let h = transform.height.max(1.0);
    let bd = &design.backdrop;
    let pad_x = bd
        .padding_x
        .unwrap_or(d.backdrop_padding_x)
        .max(w * 0.03)
        .min(w * 0.2);
    let pad_y = bd
        .padding_y
        .unwrap_or(d.backdrop_padding_y)
        .max(h * 0.04)
        .min(h * 0.2);
    let mut b = Builder {
        layout: TitleLayout {
            width: w,
            height: h,
            parts: Vec::new(),
            metrics: Vec::new(),
            design: design.clone(),
        },
        details: d,
        foreground: d.text_color.clone(),
        secondary: d.secondary_text_color.clone(),
        surface: bd.color.clone().unwrap_or_else(|| d.backdrop_color.clone()),
        accent: d.accent_color.clone(),
        inner: BoxRect {
            x: pad_x,
            y: pad_y,
            w: w - pad_x * 2.0,
            h: h - pad_y * 2.0,
        },
        pad_x,
        pad_y,
        counts: [[0; 3]; 5],
        split_rect: None,
        stack_info: None,
    };

    b.backdrop();
    layout_template(&mut b);
    b.accent_decor();
    b.split_backdrop();
    finalize_counts(&mut b.layout);
    b.layout
}

fn finalize_counts(layout: &mut TitleLayout) {
    let mut max = [[0u32; 3]; 5];
    for p in &layout.parts {
        let r = role_index(p.role);
        max[r][0] = max[r][0].max(p.line_idx + 1);
        max[r][1] = max[r][1].max(p.word_idx + 1);
        max[r][2] = max[r][2].max(p.char_idx + 1);
    }
    for p in &mut layout.parts {
        let r = role_index(p.role);
        p.line_count = max[r][0].max(1);
        p.word_count = max[r][1].max(1);
        p.char_count = max[r][2].max(1);
    }
}

fn apply_transform(text: &str, t: super::TitleTextTransform) -> String {
    match t {
        super::TitleTextTransform::None => text.to_string(),
        super::TitleTextTransform::Uppercase => text.to_uppercase(),
        super::TitleTextTransform::Lowercase => text.to_lowercase(),
        super::TitleTextTransform::Capitalize => text
            .split(' ')
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn layout_template(b: &mut Builder<'_>) {
    let t = b.layout.design.template;
    let inner = b.inner;
    match t {
        TitleTemplate::Clean => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Tag),
                    StackItem::new(StackBlock::Primary { emphasis: true }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Hook | TitleTemplate::HookEmphasis | TitleTemplate::Kinetic => {
            let emphasis = t != TitleTemplate::Kinetic;
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Chip),
                    StackItem::new(StackBlock::Primary { emphasis }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Editorial => {
            let rule = (inner.w.min(inner.h) * 0.012).max(1.0);
            b.rect(
                BoxRect { h: rule, ..inner },
                0.0,
                &b.foreground.clone(),
                1.0,
                Role::Decoration,
            );
            let area = BoxRect {
                y: inner.y + rule + inner.h * 0.03,
                h: inner.h - rule - inner.h * 0.03,
                ..inner
            };
            let info = b.stack(
                area,
                &[
                    StackItem::new(StackBlock::Tag),
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            // Short accent rule separating headline and subtitle.
            if let Some(prim) = info
                .blocks
                .iter()
                .find(|bl| matches!(bl.block, StackBlock::Primary { .. }))
            {
                let y = match info
                    .blocks
                    .iter()
                    .find(|bl| matches!(bl.block, StackBlock::Secondary))
                {
                    Some(sec) => prim.rect.bottom() + (sec.rect.y - prim.rect.bottom()) * 0.42,
                    None => prim.rect.bottom() + prim.size * info.fit * 0.3,
                };
                let x = match prim.rect.x > inner.x {
                    true => prim.rect.x,
                    false => inner.x,
                };
                b.rect(
                    BoxRect {
                        x,
                        y,
                        w: inner.w * 0.12,
                        h: rule,
                    },
                    0.0,
                    &b.accent.clone(),
                    1.0,
                    Role::Decoration,
                );
            }
        }
        TitleTemplate::Chapter => {
            // Big chapter number left, divider + stacked title block right.
            let tag_style = b.style_for(Role::Tag);
            let num = b.details.tag_text.clone().unwrap_or_else(|| "01".into());
            let face = glyphs::face(&tag_style.family, &tag_style.weight);
            let shown = apply_transform(&num, tag_style.transform);
            let num_w = glyphs::measure(&face, &shown, tag_style.size, tag_style.spacing)
                .max(tag_style.size * 0.6)
                + tag_style.size * 0.3;
            let gap = inner.w * 0.04;
            let div_w = (inner.w * 0.006).max(2.0);
            let div_x = inner.x + num_w + gap * 0.5;
            let right = BoxRect {
                x: div_x + gap * 0.5 + div_w,
                y: inner.y,
                w: inner.x + inner.w - div_x - gap * 0.5 - div_w,
                h: inner.h,
            };
            let info = b.stack(
                right,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            b.rect(
                BoxRect {
                    x: div_x,
                    y: info.rect.y,
                    w: div_w,
                    h: info.rect.h,
                },
                0.0,
                &b.accent.clone(),
                1.0,
                Role::Decoration,
            );
            let mut num_style = tag_style;
            num_style.size *= info.fit;
            b.text_at(
                &num,
                BoxRect {
                    x: inner.x,
                    y: info.rect.y,
                    w: num_w,
                    h: info.rect.h,
                },
                Role::Tag,
                &num_style,
                false,
            );
        }
        TitleTemplate::LowerThirdBar => {
            let bar_w = (inner.w * 0.014).max(4.0);
            let text = inner.inset(bar_w + inner.w * 0.03, 0.0);
            let info = b.stack(
                text,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            b.rect(
                BoxRect {
                    x: inner.x,
                    y: info.rect.y,
                    w: bar_w,
                    h: info.rect.h,
                },
                bar_w * 0.5,
                &b.accent.clone(),
                1.0,
                Role::Decoration,
            );
        }
        TitleTemplate::LowerThirdGlass | TitleTemplate::LowerThirdLine => {
            let info = b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            if t == TitleTemplate::LowerThirdLine {
                // Accent rule in the gap between name and role.
                if let Some(prim) = info
                    .blocks
                    .iter()
                    .find(|bl| matches!(bl.block, StackBlock::Primary { .. }))
                {
                    let y = match info
                        .blocks
                        .iter()
                        .find(|bl| matches!(bl.block, StackBlock::Secondary))
                    {
                        Some(sec) => prim.rect.bottom() + (sec.rect.y - prim.rect.bottom()) * 0.35,
                        None => prim.rect.bottom() + prim.size * info.fit * 0.22,
                    };
                    b.rect(
                        BoxRect {
                            x: inner.x,
                            y,
                            w: inner.w * 0.16,
                            h: (inner.h * 0.03).max(2.0),
                        },
                        0.0,
                        &b.accent.clone(),
                        1.0,
                        Role::Decoration,
                    );
                }
            }
        }
        TitleTemplate::SocialHandle => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Chip),
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Cta | TitleTemplate::CtaFollow | TitleTemplate::CtaLink => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::ButtonPrimary),
                    StackItem::new(StackBlock::Secondary),
                    StackItem::new(StackBlock::Tag),
                ],
            );
        }
        TitleTemplate::Step => {
            let p_size = b.style_for(Role::Primary).size;
            let col_w = p_size * 1.7;
            let right = BoxRect {
                x: inner.x + col_w,
                y: inner.y,
                w: inner.w - col_w,
                h: inner.h,
            };
            let info = b.stack(
                right,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            // Number badge sized to the instruction's first line.
            let first = info.blocks.first().cloned().unwrap_or(StackBlockInfo {
                rect: right,
                size: p_size,
                block: StackBlock::Slot(0.0),
            });
            let size = first.size * info.fit;
            let r = size * 0.72;
            let cx = inner.x + r;
            let cy = first.rect.y + size * 0.6;
            b.circle(cx, cy, r, &b.accent.clone(), Role::Decoration);
            let mut style = b.style_for(Role::Tag);
            style.color = b.surface.clone();
            style.align = "center".into();
            style.size = r * 1.05;
            b.text_at(
                &b.details.tag_text.clone().unwrap_or_else(|| "1".into()),
                BoxRect {
                    x: cx - r,
                    y: cy - r,
                    w: r * 2.0,
                    h: r * 2.0,
                },
                Role::Tag,
                &style,
                false,
            );
        }
        TitleTemplate::Checklist => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Tag),
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::ChecklistItems),
                ],
            );
        }
        TitleTemplate::Shortcut => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Keycaps),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Terminal => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::TerminalBar),
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Callout => {
            let tone = b.layout.design.note_tone;
            let tone_color = match tone {
                NoteTone::Note => "#60a5fa".to_string(),
                NoteTone::Tip => b.accent.clone(),
                NoteTone::Warning => "#f59e0b".to_string(),
            };
            let label = b
                .details
                .tag_text
                .clone()
                .unwrap_or_else(|| match tone {
                    NoteTone::Note => "NOTE".to_string(),
                    NoteTone::Tip => "TIP".to_string(),
                    NoteTone::Warning => "WARNING".to_string(),
                })
                .to_uppercase();
            let bar_w = (inner.w * 0.014).max(4.0);
            let text = inner.inset(bar_w + inner.w * 0.03, 0.0);
            let info = b.stack(
                text,
                &[
                    StackItem::new(StackBlock::Label {
                        text: label,
                        color: tone_color.clone(),
                    }),
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            b.rect(
                BoxRect {
                    x: inner.x,
                    y: info.rect.y,
                    w: bar_w,
                    h: info.rect.h,
                },
                bar_w * 0.5,
                &tone_color,
                1.0,
                Role::Decoration,
            );
        }
        TitleTemplate::Quote => {
            let p_size = b.style_for(Role::Primary).size;
            let col = p_size * 0.9;
            let text = inner.inset(col, 0.0);
            let info = b.stack(
                text,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            // Oversized opening quote anchored beside the first line: its
            // baseline matches the first text line's baseline so it can't
            // drift out of the clip top.
            if let Some(first) = info.blocks.first() {
                let size = first.size * info.fit;
                let mut ms = b.style_for(Role::Tag);
                ms.family = "serif".into();
                ms.size = size * 1.55;
                ms.color = b.accent.clone();
                b.text_at(
                    "\u{201C}",
                    BoxRect {
                        x: inner.x,
                        y: first.rect.y + size * 0.95 - ms.size * 0.975,
                        w: col * 1.3,
                        h: ms.size * 1.25,
                    },
                    Role::Decoration,
                    &ms,
                    false,
                );
            }
        }
        TitleTemplate::Stat | TitleTemplate::StatBeforeAfter | TitleTemplate::Countdown => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Tag),
                    StackItem::new(StackBlock::Metric {
                        step: t == TitleTemplate::Countdown,
                        before_after: t == TitleTemplate::StatBeforeAfter,
                    }),
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Location => {
            let p_size = b.style_for(Role::Primary).size;
            let col = p_size * 1.15;
            let text = inner.inset(col, 0.0);
            let info = b.stack(
                text,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
            if let Some(first) = info.blocks.first() {
                let size = first.size * info.fit;
                let pin_h = size * 0.95;
                let cy = first.rect.y + size * 0.6;
                b.path(
                    pin_path(inner.x + pin_h * 0.4, cy - pin_h * 0.5, pin_h),
                    &b.accent.clone(),
                    1.0,
                    Role::Decoration,
                    None,
                );
            }
        }
        TitleTemplate::Banner => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Band),
                    // The band centers its label, so the supporting line
                    // follows the same centered axis even when the clip
                    // alignment says otherwise.
                    StackItem::new(StackBlock::Secondary).centered(),
                ],
            );
        }
        TitleTemplate::Highlight => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Tag),
                    StackItem::new(StackBlock::Primary { emphasis: true }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Agenda => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::AgendaItems),
                ],
            );
        }
        TitleTemplate::Outro => {
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Primary { emphasis: true }),
                    StackItem::new(StackBlock::ButtonTag),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
        TitleTemplate::Source => {
            let label = b
                .details
                .tag_text
                .clone()
                .unwrap_or_else(|| "SOURCE".into())
                .to_uppercase();
            b.stack(
                inner,
                &[
                    StackItem::new(StackBlock::Label {
                        text: label,
                        color: b.accent.clone(),
                    }),
                    StackItem::new(StackBlock::Primary { emphasis: false }),
                    StackItem::new(StackBlock::Secondary),
                ],
            );
        }
    }
}

impl Builder<'_> {
    fn design(&self) -> &TitleDesign {
        &self.layout.design
    }

    fn style_for(&self, role: Role) -> Style {
        let d = self.details;
        let design = self.design();
        let (pr, sec, tag, metric) = size_ratios(design.template);
        let (ratio, el, default_weight, default_color) = match role {
            Role::Primary => (
                pr,
                design.elements.primary.as_ref(),
                d.font_weight.as_str(),
                d.text_color.as_str(),
            ),
            Role::Secondary => (
                sec,
                design.elements.secondary.as_ref(),
                "400",
                d.secondary_text_color.as_str(),
            ),
            Role::Tag => (
                tag,
                design.elements.tag.as_ref(),
                "600",
                self.accent.as_str(),
            ),
            // Non-text roles borrow the metric element slot for sizing so the
            // fourth ratio in `size_ratios` applies (metric digits, keycaps).
            _ => (
                metric,
                design.elements.metric.as_ref(),
                d.font_weight.as_str(),
                d.text_color.as_str(),
            ),
        };
        Style {
            family: el
                .and_then(|e| e.family.clone())
                .or_else(|| design.typography.family.clone())
                .unwrap_or_else(|| d.font_family.clone()),
            size: el.and_then(|e| e.size).unwrap_or(d.font_size * ratio),
            weight: el
                .and_then(|e| e.weight.clone())
                .unwrap_or_else(|| default_weight.to_string()),
            spacing: el
                .and_then(|e| e.letter_spacing)
                .unwrap_or(design.typography.letter_spacing),
            line_height: el
                .and_then(|e| e.line_height)
                .unwrap_or(design.typography.line_height),
            transform: el
                .and_then(|e| e.text_transform)
                .unwrap_or(design.typography.text_transform),
            color: el
                .and_then(|e| e.color.clone())
                .unwrap_or_else(|| default_color.to_string()),
            align: design
                .typography
                .align
                .clone()
                .unwrap_or_else(|| d.alignment.clone()),
        }
    }

    /// Natural (fit = 1) height of a wrapped text block: the same formula
    /// `text_at` uses for its height fit, so stack allocation matches.
    fn measure_text_block(&self, text: &str, w: f64, style: &Style) -> f64 {
        if text.trim().is_empty() || w <= 0.0 {
            return 0.0;
        }
        let text = apply_transform(text, style.transform);
        let face = glyphs::face(&style.family, &style.weight);
        let lines = glyphs::wrap(&face, &text, w, style.size, style.spacing);
        style.size * (1.2 + lines.len().saturating_sub(1) as f64 * style.line_height)
    }

    fn metric_style(&self) -> Style {
        self.style_for(Role::Decoration)
    }

    fn item_lines(&self, max: usize) -> Vec<String> {
        self.details
            .secondary_text
            .clone()
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .take(max)
            .collect()
    }

    /// Natural height and the reference type size for a block, or `None` when
    /// the block has no content and should drop out of the stack.
    fn block_metrics(&self, block: &StackBlock, w: f64) -> Option<(f64, f64)> {
        match block {
            StackBlock::Tag => {
                let tag = self
                    .details
                    .tag_text
                    .clone()
                    .filter(|t| !t.trim().is_empty())?;
                let style = self.style_for(Role::Tag);
                Some((self.measure_text_block(&tag, w, &style), style.size))
            }
            StackBlock::Label { text, .. } => {
                let style = self.style_for(Role::Tag);
                Some((self.measure_text_block(text, w, &style), style.size))
            }
            StackBlock::Chip => {
                self.details
                    .tag_text
                    .clone()
                    .filter(|t| !t.trim().is_empty())?;
                let size = self.style_for(Role::Tag).size;
                Some((size * 1.75, size))
            }
            StackBlock::Primary { .. } => {
                let style = self.style_for(Role::Primary);
                Some((
                    self.measure_text_block(&self.details.primary_text, w, &style),
                    style.size,
                ))
            }
            StackBlock::Secondary => {
                let text = self.details.secondary_text.clone()?;
                let style = self.style_for(Role::Secondary);
                Some((self.measure_text_block(&text, w, &style), style.size))
            }
            StackBlock::Metric { .. } => {
                let size = self.metric_style().size;
                Some((size * 1.22, size))
            }
            StackBlock::ButtonPrimary => {
                let size = self.style_for(Role::Primary).size;
                Some((size * 2.15, size))
            }
            StackBlock::ButtonTag => {
                let size = self.style_for(Role::Tag).size;
                Some((size * 2.15, size))
            }
            StackBlock::ChecklistItems | StackBlock::AgendaItems => {
                let max = if matches!(block, StackBlock::AgendaItems) {
                    6
                } else {
                    5
                };
                let n = self.item_lines(max).len();
                if n == 0 {
                    return None;
                }
                let size = self.style_for(Role::Secondary).size;
                Some((n as f64 * size * 1.55, size))
            }
            StackBlock::Keycaps => {
                if self.details.primary_text.trim().is_empty() {
                    return None;
                }
                let size = self.style_for(Role::Primary).size;
                Some((size * 1.95, size))
            }
            StackBlock::TerminalBar => {
                let size = self.style_for(Role::Tag).size;
                Some((size * 1.5, size))
            }
            StackBlock::Band => {
                let size = self.style_for(Role::Primary).size;
                Some((size * 2.0, size))
            }
            StackBlock::Slot(h) => Some((*h, 0.0)),
        }
    }

    /// Default gap after a block, proportional to its type size.
    fn gap_after(block: &StackBlock, size: f64) -> f64 {
        let factor = match block {
            StackBlock::Tag | StackBlock::Label { .. } | StackBlock::Chip => 0.5,
            StackBlock::TerminalBar => 0.45,
            StackBlock::Primary { .. } => 0.25,
            StackBlock::Secondary => 0.35,
            StackBlock::Metric { .. } => 0.14,
            StackBlock::ButtonPrimary | StackBlock::ButtonTag | StackBlock::Band => 0.45,
            StackBlock::Keycaps => 0.4,
            StackBlock::ChecklistItems | StackBlock::AgendaItems | StackBlock::Slot(_) => 0.0,
        };
        factor * size
    }

    /// Lay the blocks out top-to-bottom inside `rect` with one shared fit
    /// factor (the stack shrinks as a unit, preserving the type hierarchy),
    /// gaps proportional to type size, and the whole stack vertically centered.
    /// Returns the occupied rect and per-block rects so decorations can be
    /// sized from the content rather than the clip box.
    fn stack(&mut self, rect: BoxRect, items: &[StackItem]) -> StackInfo {
        struct Entry {
            block: StackBlock,
            h: f64,
            size: f64,
            gap: f64,
            align: Option<&'static str>,
        }
        let mut entries: Vec<Entry> = Vec::with_capacity(items.len());
        for item in items {
            let Some((h, size)) = self.block_metrics(&item.block, rect.w) else {
                continue;
            };
            let gap = if entries.is_empty() {
                0.0
            } else {
                let prev = entries.last().unwrap();
                item.gap
                    .unwrap_or_else(|| Self::gap_after(&prev.block, prev.size))
            };
            entries.push(Entry {
                block: item.block.clone(),
                h,
                size,
                gap,
                align: item.align,
            });
        }
        let total: f64 = entries.iter().map(|e| e.h + e.gap).sum();
        if total <= 0.0 {
            let info = StackInfo {
                rect: rect.with_h(0.0),
                fit: 1.0,
                blocks: Vec::new(),
            };
            self.stack_info = Some(info.clone());
            return info;
        }
        let fit = (rect.h / total).min(1.0);
        let mut y = rect.y + (rect.h - total * fit) * 0.5;
        let mut info = StackInfo {
            rect: BoxRect {
                x: rect.x,
                y,
                w: rect.w,
                h: total * fit,
            },
            fit,
            blocks: Vec::with_capacity(entries.len()),
        };
        for e in entries {
            y += e.gap * fit;
            let block_rect = BoxRect {
                x: rect.x,
                y,
                w: rect.w,
                h: e.h * fit,
            };
            self.render_block(&e.block, block_rect, fit, e.align);
            info.blocks.push(StackBlockInfo {
                rect: block_rect,
                size: e.size,
                block: e.block,
            });
            y += e.h * fit;
        }
        self.stack_info = Some(info.clone());
        info
    }

    fn render_block(
        &mut self,
        block: &StackBlock,
        rect: BoxRect,
        fit: f64,
        align: Option<&'static str>,
    ) {
        match block {
            StackBlock::Tag => self.tag_line(rect),
            StackBlock::Label { text, color } => {
                let mut style = self.style_for(Role::Tag);
                style.color = color.clone();
                self.text_at(text, rect, Role::Tag, &style, false);
            }
            StackBlock::Chip => self.tag_chip(rect),
            StackBlock::Primary { emphasis } => self.primary(rect, *emphasis),
            StackBlock::Secondary => self.secondary(rect, align),
            StackBlock::Metric { step, before_after } => self.metric(rect, *step, *before_after),
            StackBlock::ButtonPrimary => self.button(rect, Role::Primary),
            StackBlock::ButtonTag => self.button(rect, Role::Tag),
            StackBlock::ChecklistItems => self.checklist_items(rect, fit),
            StackBlock::AgendaItems => self.agenda_items(rect, fit),
            StackBlock::Keycaps => {
                let text = self.details.primary_text.clone();
                self.keycaps(&text, rect);
            }
            StackBlock::TerminalBar => self.terminal_bar(rect),
            StackBlock::Band => self.band(rect),
            StackBlock::Slot(_) => {}
        }
    }

    /// X offset of a width-`w` sub-block inside `rect` for the given alignment.
    fn align_x(rect: BoxRect, w: f64, align: &str) -> f64 {
        rect.x
            + match align {
                "center" => (rect.w - w) * 0.5,
                "right" => rect.w - w,
                _ => 0.0,
            }
    }

    fn tag_line(&mut self, rect: BoxRect) {
        let Some(tag) = self
            .details
            .tag_text
            .clone()
            .filter(|t| !t.trim().is_empty())
        else {
            return;
        };
        let style = self.style_for(Role::Tag);
        self.text_at(&tag, rect, Role::Tag, &style, false);
    }

    // Tag inside a small accent chip. The chip always holds a single line:
    // its text rect is the measured text width plus slack, centered on the
    // chip, so the label can never wrap inside its own chip.
    fn tag_chip(&mut self, rect: BoxRect) {
        let Some(tag) = self
            .details
            .tag_text
            .clone()
            .filter(|t| !t.trim().is_empty())
        else {
            return;
        };
        let mut style = self.style_for(Role::Tag);
        // The stack allocates `size * 1.75` of height; the rendered size comes
        // from the allocated height so the shared fit factor reaches the chip.
        let s = (rect.h / 1.75).min(style.size);
        style.size = s;
        let face = glyphs::face(&style.family, &style.weight);
        let shown = apply_transform(&tag, style.transform);
        let tw = glyphs::measure(&face, &shown, s, style.spacing);
        let chip_w = tw + s * 1.1;
        let chip_h = s * 1.7;
        let chip = BoxRect {
            x: Self::align_x(rect, chip_w, &style.align),
            y: rect.y + (rect.h - chip_h) * 0.5,
            w: chip_w,
            h: chip_h,
        };
        self.rect(
            chip,
            chip_h * 0.28,
            &self.accent.clone(),
            1.0,
            Role::Decoration,
        );
        style.color = self.surface.clone();
        style.align = "center".into();
        self.text_at(
            &tag,
            BoxRect {
                x: chip.x + chip.w * 0.5 - (tw + s) * 0.5,
                y: chip.y,
                w: tw + s,
                h: chip.h,
            },
            Role::Tag,
            &style,
            false,
        );
    }

    // Accent pill that hugs its label (CTA button / outro handle).
    fn button(&mut self, rect: BoxRect, role: Role) {
        let text = match role {
            Role::Primary => self.details.primary_text.clone(),
            Role::Tag => self
                .details
                .tag_text
                .clone()
                .unwrap_or_else(|| "recordforge".into()),
            _ => return,
        };
        if text.trim().is_empty() {
            return;
        }
        let mut style = self.style_for(role);
        let mut s = (rect.h / 2.15).min(style.size);
        let face = glyphs::face(&style.family, &style.weight);
        let shown = apply_transform(&text, style.transform);
        let mut tw = glyphs::measure(&face, &shown, s, style.spacing);
        let mut bw = tw + s * 1.8;
        if bw > rect.w {
            // Keep the pill inside the stack width: shrink the label instead
            // of letting the button overflow the box.
            s *= rect.w / bw;
            tw = glyphs::measure(&face, &shown, s, style.spacing);
            bw = tw + s * 1.8;
        }
        let bh = s * 1.9;
        let btn = BoxRect {
            x: Self::align_x(rect, bw, &style.align),
            y: rect.y + (rect.h - bh) * 0.5,
            w: bw,
            h: bh,
        };
        self.rect(btn, bh * 0.5, &self.accent.clone(), 1.0, Role::Decoration);
        style.color = self.surface.clone();
        style.align = "center".into();
        style.size = s;
        // The text rect is wider than the pill and centered on it: a label
        // sized exactly to the pill interior would re-wrap at its own measure.
        self.text_at(
            &text,
            BoxRect {
                x: btn.x - s,
                w: btn.w + 2.0 * s,
                ..btn
            },
            role,
            &style,
            false,
        );
    }

    // Full-bleed accent band carrying the headline (banner template).
    fn band(&mut self, rect: BoxRect) {
        let band = BoxRect {
            x: 0.0,
            y: rect.y,
            w: self.layout.width,
            h: rect.h,
        };
        self.rect(band, 0.0, &self.accent.clone(), 1.0, Role::Decoration);
        let mut style = self.style_for(Role::Primary);
        style.color = self.surface.clone();
        style.align = "center".into();
        let text = self.details.primary_text.clone();
        self.text_at(
            &text,
            band.inset(rect.h * 0.4, 0.0),
            Role::Primary,
            &style,
            false,
        );
    }

    fn primary(&mut self, rect: BoxRect, emphasis: bool) {
        let style = self.style_for(Role::Primary);
        if self.design().backdrop.style == super::BackdropStyle::Split {
            self.split_rect = Some(rect);
        }
        let text = self.details.primary_text.clone();
        self.text_at(&text, rect, Role::Primary, &style, emphasis);
    }

    fn secondary(&mut self, rect: BoxRect, align: Option<&'static str>) {
        let Some(text) = self.details.secondary_text.clone() else {
            return;
        };
        let mut style = self.style_for(Role::Secondary);
        if let Some(align) = align {
            style.align = align.into();
        }
        self.text_at(&text, rect, Role::Secondary, &style, false);
    }

    fn push_part(&mut self, element: TitleSceneElement, role: Role, anchor: (f64, f64)) {
        let c = &self.counts[role_index(role)];
        self.layout.parts.push(Part {
            element,
            role,
            line_idx: c[0],
            word_idx: c[1],
            char_idx: c[2],
            line_count: 1,
            word_count: 1,
            char_count: 1,
            anchor,
            tracking: 0.0,
            sweep: None,
            typing: None,
            emphasis: false,
            shimmer: None,
        });
    }

    fn path(
        &mut self,
        path: String,
        fill: &str,
        opacity: f64,
        role: Role,
        clip: Option<TitleClip>,
    ) {
        if path.is_empty() {
            return;
        }
        let mut e = TitleSceneElement::new(path, fill);
        e.opacity = opacity;
        e.clip = clip;
        let anchor = clip.map_or((0.0, 0.0), |c| (c.x + c.width * 0.5, c.y + c.height * 0.5));
        self.push_part(e, role, anchor);
    }

    fn rect(&mut self, r: BoxRect, radius: f64, fill: &str, opacity: f64, role: Role) {
        if r.w <= 0.0 || r.h <= 0.0 {
            return;
        }
        let mut e = TitleSceneElement::new(rounded_rect(r, radius), fill);
        e.opacity = opacity;
        e.clip = Some(r.clip());
        self.push_part(e, role, r.center());
    }

    fn circle(&mut self, cx: f64, cy: f64, r: f64, fill: &str, role: Role) {
        if r <= 0.0 {
            return;
        }
        let path = circle_path(cx, cy, r);
        let mut e = TitleSceneElement::new(path, fill);
        e.clip = Some(
            BoxRect {
                x: cx - r,
                y: cy - r,
                w: r * 2.0,
                h: r * 2.0,
            }
            .clip(),
        );
        self.push_part(e, role, (cx, cy));
    }

    /// Drop shadow / glow: extra low-alpha path copies emitted behind the
    /// element with the same animation-unit indices so both renderers draw the
    /// same soft edge (no ctx.filter / SVG filters needed).
    fn tap_offsets(&self, base: (f64, f64), radius: f64, taps: usize) -> Vec<(f64, f64)> {
        (0..taps)
            .map(|i| {
                let a = i as f64 / taps as f64 * std::f64::consts::TAU;
                (base.0 + a.cos() * radius, base.1 + a.sin() * radius)
            })
            .collect()
    }

    fn apply_shadow_glow(
        &mut self,
        src: &TitleSceneElement,
        role: Role,
        anchor: (f64, f64),
        unit: (u32, u32, u32),
        part_index: usize,
    ) {
        let design = self.design().clone();
        if let Some(sh) = &design.shadow {
            let r = (sh.blur * 0.4).min(40.0);
            let offsets = self.tap_offsets((sh.offset_x, sh.offset_y), r, 5);
            self.emit_taps_at(
                part_index, src, role, anchor, &sh.color, &offsets, 0.14, unit,
            );
        }
        if let Some(gl) = &design.glow {
            let color = gl.color.clone().unwrap_or_else(|| self.accent.clone());
            let r = (gl.blur * 0.5).min(48.0);
            let offsets = self.tap_offsets((0.0, 0.0), r, 6);
            self.emit_taps_at(part_index, src, role, anchor, &color, &offsets, 0.16, unit);
        }
    }

    // Insert tap parts just before the element they shade.
    #[allow(clippy::too_many_arguments)]
    fn emit_taps_at(
        &mut self,
        part_index: usize,
        src: &TitleSceneElement,
        role: Role,
        anchor: (f64, f64),
        color: &str,
        offsets: &[(f64, f64)],
        opacity: f64,
        unit: (u32, u32, u32),
    ) {
        let mut taps = Vec::with_capacity(offsets.len());
        for (dx, dy) in offsets {
            let mut e = src.clone();
            e.fill = color.into();
            e.opacity = opacity;
            e.translate_x += dx;
            e.translate_y += dy;
            e.gradient = None;
            e.stroke = None;
            taps.push(Part {
                element: e,
                role,
                line_idx: unit.0,
                word_idx: unit.1,
                char_idx: unit.2,
                line_count: 1,
                word_count: 1,
                char_count: 1,
                anchor,
                tracking: 0.0,
                sweep: None,
                typing: None,
                emphasis: false,
                shimmer: None,
            });
        }
        self.layout.parts.splice(part_index..part_index, taps);
    }

    /// The workhorse: wrap, fit and emit glyph-path parts for a text block.
    /// Runs are emitted per word (or per grapheme for char-unit/typewriter
    /// specs) so animation units map onto real text units.
    fn text_at(&mut self, text: &str, rect: BoxRect, role: Role, style: &Style, emphasis: bool) {
        if text.trim().is_empty() || rect.w <= 0.0 || rect.h <= 0.0 {
            return;
        }
        let text = apply_transform(text, style.transform);
        let face = glyphs::face(&style.family, &style.weight);
        let mut lines = glyphs::wrap(&face, &text, rect.w, style.size, style.spacing);
        // Centered headlines balance like CSS `text-wrap: balance`: shrink
        // the wrap width to the narrowest value that still breaks into the
        // same number of lines, evening out a ragged greedy wrap. The line
        // count never changes, so block metrics and fit are unaffected;
        // left/right aligned text keeps the greedy wrap.
        if role == Role::Primary && style.align == "center" && (2..=4).contains(&lines.len()) {
            let target = lines.len();
            let (mut lo, mut hi) = (0.0f64, rect.w);
            for _ in 0..32 {
                let mid = (lo + hi) * 0.5;
                if glyphs::wrap(&face, &text, mid, style.size, style.spacing).len() <= target {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            let balanced = glyphs::wrap(&face, &text, hi, style.size, style.spacing);
            if balanced.len() == target {
                lines = balanced;
            }
        }
        let max_width = lines
            .iter()
            .map(|line| glyphs::measure(&face, line, style.size, style.spacing))
            .fold(0.0_f64, f64::max);
        let natural_height =
            style.size * (1.2 + lines.len().saturating_sub(1) as f64 * style.line_height);
        let fit = (rect.w / max_width.max(1.0))
            .min(rect.h / natural_height)
            .min(1.0);
        let size = style.size * fit;
        let block_height = natural_height * fit;
        // Cloned so the loop can mutate self while consulting the design.
        let design = self.design().clone();
        let per_char = matches!(design.animation.in_spec.unit, super::AnimUnit::Char)
            || matches!(design.animation.in_spec.preset, AnimPreset::Typewriter)
            || matches!(design.animation.out_spec.unit, super::AnimUnit::Char);
        let typewriter = design.animation.in_spec.preset == AnimPreset::Typewriter;
        let want_tracking = design.animation.in_spec.preset == AnimPreset::TrackingExpand;
        let total_graphemes = text.graphemes(true).count().max(1);
        let block_center = rect.center();
        let emph = design.emphasis.clone();
        // An empty emphasis phrase marks the whole block only for the
        // Highlight template ("mark everything"); every other template needs
        // real, matching emphasis text before anything is decorated or
        // recolored.
        let emph_text = if emphasis && emph.text.is_empty() {
            if design.template == TitleTemplate::Highlight {
                text.clone()
            } else {
                String::new()
            }
        } else {
            apply_transform(&emph.text, style.transform)
        };
        let selected = if emphasis && !emph_text.is_empty() {
            text.find(&emph_text).map(|s| (s, s + emph_text.len()))
        } else {
            None
        };
        let use_gradient = design.fill.kind == super::FillKind::Gradient
            && role == Role::Primary
            && design.fill.gradient_stops.len() >= 2;
        let mut consumed = 0usize;
        let mut graphemes = 0usize;
        for (line_i, line) in lines.iter().enumerate() {
            let source_start = text[consumed..]
                .find(line.as_str())
                .map_or(consumed, |o| consumed + o);
            let width = glyphs::measure(&face, line, size, style.spacing);
            let x = rect.x
                + match style.align.as_str() {
                    "center" => (rect.w - width) * 0.5,
                    "right" => rect.w - width,
                    _ => 0.0,
                };
            // Geometry uses a per-call local line index; the global per-role
            // counter only drives animation unit indices so a second `text_at`
            // call for the same role doesn't get pushed down by earlier lines.
            let baseline = rect.y
                + (rect.h - block_height) * 0.5
                + size * 0.95
                + line_i as f64 * size * style.line_height;
            let line_clip = TitleClip {
                x: rect.x,
                y: baseline - size,
                width: rect.w,
                height: size * 1.25,
            };
            let line_idx = self.counts[role_index(role)][0];
            // Emphasis decorations are merged into one band per contiguous
            // selected span per line and spliced in behind the whole line so
            // adjacent words share a single band with no overlap darkening.
            let line_start = self.layout.parts.len();
            let mut spans: Vec<(f64, f64, (u32, u32, u32))> = Vec::new();
            let mut open_span: Option<(f64, f64, (u32, u32, u32))> = None;
            for run in glyphs::runs(&face, line, size, style.spacing, per_char || typewriter) {
                let run_selected = selected.is_some_and(|(s, e)| {
                    source_start + run.end > s && source_start + run.start < e
                });
                let line_word_idx = self.counts[role_index(role)][1];
                let line_char_idx = self.counts[role_index(role)][2];
                let unit = (line_idx, line_word_idx, line_char_idx);
                if run_selected {
                    match &mut open_span {
                        Some(span) => span.1 = x + run.x + run.width,
                        None => open_span = Some((x + run.x, x + run.x + run.width, unit)),
                    }
                } else if let Some(span) = open_span.take() {
                    spans.push(span);
                }
                let anchor = (x + run.x + run.width * 0.5, baseline - size * 0.35);
                if !run.path.is_empty() {
                    let mut e = TitleSceneElement::new(run.path.clone(), &style.color);
                    // Run paths are authored in absolute line-space (glyph_path
                    // relies on this for whole-string shapes), so the element
                    // translate carries only the line origin — adding run.x
                    // would double the offset and spread words apart.
                    e.translate_x = x;
                    e.translate_y = baseline;
                    e.clip = Some(line_clip);
                    if run_selected && emph.style == super::EmphasisStyle::Color {
                        e.fill = emph.color.clone().unwrap_or_else(|| self.accent.clone());
                    }
                    if use_gradient {
                        e.gradient = Some(self.run_gradient(&e, rect));
                    }
                    if let Some(stroke) = &design.stroke {
                        e.stroke = Some(TitleSceneStroke {
                            color: stroke.color.clone(),
                            width: stroke.width,
                        });
                    }
                    let part = Part {
                        element: e.clone(),
                        role,
                        line_idx,
                        word_idx: line_word_idx,
                        char_idx: line_char_idx,
                        line_count: 1,
                        word_count: 1,
                        char_count: 1,
                        anchor,
                        tracking: if want_tracking {
                            (anchor.0 - block_center.0) * 0.4
                        } else {
                            0.0
                        },
                        sweep: Some(line_clip),
                        typing: if typewriter {
                            let upto = graphemes + line[..run.end].graphemes(true).count();
                            Some(upto as f64 / total_graphemes as f64)
                        } else {
                            None
                        },
                        emphasis: run_selected,
                        shimmer: None,
                    };
                    self.layout.parts.push(part);
                    let part_index = self.layout.parts.len() - 1;
                    self.apply_shadow_glow(&e, role, anchor, unit, part_index);
                }
                // Advance unit counters: a run is one word or one grapheme.
                if per_char || typewriter {
                    self.counts[role_index(role)][2] += 1;
                    self.counts[role_index(role)][1] += 1;
                } else {
                    let words = line[run.start..run.end].graphemes(true).count().max(1);
                    self.counts[role_index(role)][2] += words as u32;
                    self.counts[role_index(role)][1] += 1;
                }
            }
            if let Some(span) = open_span.take() {
                spans.push(span);
            }
            if !spans.is_empty() {
                let mut decor = Vec::with_capacity(spans.len());
                for (x0, x1, unit) in spans {
                    if let Some(part) =
                        self.emphasis_part(&emph, x0, x1 - x0, baseline, size, line_clip, unit)
                    {
                        decor.push(part);
                    }
                }
                self.layout.parts.splice(line_start..line_start, decor);
            }
            self.counts[role_index(role)][0] += 1;
            graphemes += line.graphemes(true).count();
            consumed = source_start + line.len();
        }
        // Shimmer sweep overlay on emphasized runs.
        if self
            .design()
            .animation
            .emphasis
            .as_ref()
            .is_some_and(|l| l.preset == super::LoopPreset::Shimmer)
        {
            self.shimmer_overlay(rect);
        }
    }

    // Gradient is authored over the block rect in scene space; each element's
    // path-local gradient coords are the scene coords minus its translate
    // (paths are emitted unscaled for text runs).
    fn run_gradient(&self, e: &TitleSceneElement, block: BoxRect) -> TitleSceneGradient {
        let design = self.design();
        let angle = design.fill.gradient_angle.to_radians();
        // CSS bearing: 0 = up, 90 = right. Direction vector.
        let dx = angle.sin();
        let dy = -angle.cos();
        let (cx, cy) = block.center();
        let half = (block.w * dx.abs() + block.h * dy.abs()) * 0.5;
        let sx = cx - dx * half;
        let sy = cy - dy * half;
        TitleSceneGradient {
            x0: sx - e.translate_x,
            y0: sy - e.translate_y,
            x1: cx + dx * half - e.translate_x,
            y1: cy + dy * half - e.translate_y,
            stops: design.fill.gradient_stops.clone(),
        }
    }

    // One emphasis decoration part spanning a contiguous selected span.
    #[allow(clippy::too_many_arguments)]
    fn emphasis_part(
        &self,
        emph: &TitleEmphasis,
        x: f64,
        w: f64,
        baseline: f64,
        size: f64,
        line_clip: TitleClip,
        unit: (u32, u32, u32),
    ) -> Option<Part> {
        let color = emph.color.clone().unwrap_or_else(|| self.accent.clone());
        let e = match emph.style {
            super::EmphasisStyle::Color => return None,
            super::EmphasisStyle::Marker => {
                let r = BoxRect {
                    x: x - size * 0.05,
                    y: baseline - size * 0.8,
                    w: w + size * 0.1,
                    h: size * 0.98,
                };
                let mut e = TitleSceneElement::new(rounded_rect(r, size * 0.1), &color);
                e.opacity = 0.34;
                e.clip = Some(r.clip());
                e
            }
            super::EmphasisStyle::Underline => {
                let r = BoxRect {
                    x,
                    y: baseline + size * 0.14,
                    w,
                    h: size * 0.055,
                };
                let mut e = TitleSceneElement::new(rounded_rect(r, size * 0.028), &color);
                e.clip = Some(r.clip());
                e
            }
            super::EmphasisStyle::Strike => {
                let r = BoxRect {
                    x: x - size * 0.02,
                    y: baseline - size * 0.34,
                    w: w + size * 0.04,
                    h: size * 0.06,
                };
                let mut e = TitleSceneElement::new(rounded_rect(r, size * 0.03), &color);
                e.clip = Some(r.clip());
                e
            }
            super::EmphasisStyle::Box => {
                let r = BoxRect {
                    x: x - size * 0.08,
                    y: baseline - size * 0.85,
                    w: w + size * 0.16,
                    h: size * 1.06,
                };
                let mut e = TitleSceneElement::new(rounded_rect(r, size * 0.12), "rgba(0,0,0,0)");
                e.stroke = Some(TitleSceneStroke {
                    color,
                    width: size * 0.045,
                });
                e.clip = Some(r.clip());
                e
            }
        };
        Some(Part {
            element: e,
            role: Role::Decoration,
            line_idx: unit.0,
            word_idx: unit.1,
            char_idx: unit.2,
            line_count: 1,
            word_count: 1,
            char_count: 1,
            anchor: (x + w * 0.5, baseline - size * 0.35),
            tracking: 0.0,
            sweep: Some(line_clip),
            typing: None,
            emphasis: true,
            shimmer: None,
        })
    }

    // The shimmer loop sweeps a gradient bar across the emphasized area.
    fn shimmer_overlay(&mut self, rect: BoxRect) {
        let bar_w = rect.w * 0.3;
        let clip = rect.clip();
        let mut e = TitleSceneElement::new(
            format!(
                "M{} {}L{} {}L{} {}L{} {}Z",
                0.0,
                0.0,
                bar_w,
                0.0,
                bar_w * 0.6,
                rect.h,
                -bar_w * 0.4,
                rect.h
            ),
            "#ffffff",
        );
        e.opacity = 0.16;
        e.clip = Some(clip);
        e.gradient = Some(TitleSceneGradient {
            x0: 0.0,
            y0: 0.0,
            x1: bar_w,
            y1: 0.0,
            stops: vec![
                super::TitleGradientStop {
                    offset: 0.0,
                    color: "rgba(255,255,255,0)".into(),
                },
                super::TitleGradientStop {
                    offset: 0.5,
                    color: "rgba(255,255,255,0.7)".into(),
                },
                super::TitleGradientStop {
                    offset: 1.0,
                    color: "rgba(255,255,255,0)".into(),
                },
            ],
        });
        self.layout.parts.push(Part {
            element: e,
            role: Role::Decoration,
            line_idx: 0,
            word_idx: 0,
            char_idx: 0,
            line_count: 1,
            word_count: 1,
            char_count: 1,
            anchor: rect.center(),
            tracking: 0.0,
            sweep: Some(clip),
            typing: None,
            emphasis: true,
            shimmer: Some((rect.x - bar_w, rect.x + rect.w)),
        });
    }

    fn keycaps(&mut self, text: &str, rect: BoxRect) {
        let keys: Vec<&str> = text
            .split('+')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let keys = if keys.len() == 1 {
            text.split_whitespace().collect::<Vec<_>>()
        } else {
            keys
        };
        if keys.is_empty() {
            return;
        }
        let style = self.style_for(Role::Primary);
        let face = glyphs::face("mono", &style.weight);
        let size = style.size;
        let gap = size * 0.8;
        let widths: Vec<f64> = keys
            .iter()
            .map(|key| glyphs::measure(&face, key, size, 0.0) + size * 0.9)
            .collect();
        let total = widths.iter().sum::<f64>() + keys.len().saturating_sub(1) as f64 * gap;
        let scale = (rect.w / total).min(rect.h / (size * 1.95)).min(1.0);
        let key_h = size * 1.8 * scale;
        let align = self.style_for(Role::Primary).align;
        let mut x = Self::align_x(rect, total * scale, &align);
        for (index, (key, width)) in keys.iter().zip(widths).enumerate() {
            let r = BoxRect {
                x,
                y: rect.y + (rect.h - key_h) * 0.5,
                w: width * scale,
                h: key_h,
            };
            self.rect(
                BoxRect {
                    y: r.y + size * 0.07 * scale,
                    ..r
                },
                size * 0.16 * scale,
                &self.accent.clone(),
                0.55,
                Role::Decoration,
            );
            self.rect(
                r,
                size * 0.16 * scale,
                &self.foreground.clone(),
                0.13,
                Role::Primary,
            );
            let mut ks = self.style_for(Role::Primary);
            ks.family = "mono".into();
            ks.size = size * scale;
            ks.align = "center".into();
            self.text_at(
                key,
                BoxRect {
                    x: r.x,
                    y: r.y,
                    w: r.w,
                    h: r.h,
                },
                Role::Primary,
                &ks,
                false,
            );
            x += r.w;
            if index + 1 < keys.len() {
                let mut ps = self.style_for(Role::Secondary);
                ps.size = size * scale * 0.7;
                ps.family = "mono".into();
                self.text_at(
                    "+",
                    BoxRect {
                        x: x + gap * scale * 0.25,
                        y: r.y,
                        w: gap * scale * 0.5,
                        h: key_h,
                    },
                    Role::Decoration,
                    &ps,
                    false,
                );
                x += gap * scale;
            }
        }
    }

    // Terminal chrome row: three dots and the shell tag on one line.
    fn terminal_bar(&mut self, rect: BoxRect) {
        let s = rect.h / 1.5;
        let dot_r = s * 0.24;
        let cy = rect.y + rect.h * 0.5;
        for (i, shade) in [0.35_f64, 0.28, 0.22].iter().enumerate() {
            self.circle(
                rect.x + dot_r + i as f64 * dot_r * 3.0,
                cy,
                dot_r,
                &self.foreground.clone(),
                Role::Decoration,
            );
            if let Some(last) = self.layout.parts.last_mut() {
                last.element.opacity = *shade;
            }
        }
        let mut style = self.style_for(Role::Tag);
        style.size = s;
        if let Some(tag) = self
            .details
            .tag_text
            .clone()
            .filter(|t| !t.trim().is_empty())
        {
            let dots_w = dot_r * 2.0 + 2.0 * dot_r * 3.0;
            self.text_at(
                &tag,
                BoxRect {
                    x: rect.x + dots_w + s * 0.6,
                    y: rect.y,
                    w: rect.w - dots_w - s * 0.6,
                    h: rect.h,
                },
                Role::Tag,
                &style,
                false,
            );
        }
    }

    fn checklist_items(&mut self, rect: BoxRect, fit: f64) {
        let items = self.item_lines(5);
        if items.is_empty() {
            return;
        }
        let row_h = rect.h / items.len() as f64;
        let mut style = self.style_for(Role::Secondary);
        style.size *= fit;
        let box_s = (style.size * 0.82).min(row_h * 0.5);
        for (i, item) in items.iter().enumerate() {
            let y = rect.y + i as f64 * row_h;
            let bx = rect.x;
            let by = y + (row_h - box_s) * 0.5;
            // Checkbox: rounded square + accent tick.
            self.rect(
                BoxRect {
                    x: bx,
                    y: by,
                    w: box_s,
                    h: box_s,
                },
                box_s * 0.24,
                &self.foreground.clone(),
                0.16,
                Role::Decoration,
            );
            {
                let mut e = TitleSceneElement::new(check_path(bx, by, box_s), "rgba(0,0,0,0)");
                e.stroke = Some(TitleSceneStroke {
                    color: self.accent.clone(),
                    width: (box_s * 0.13).max(1.5),
                });
                e.clip = Some(
                    BoxRect {
                        x: bx,
                        y: by,
                        w: box_s,
                        h: box_s,
                    }
                    .clip(),
                );
                self.push_part(e, Role::Decoration, (bx + box_s * 0.5, by + box_s * 0.5));
            }
            self.text_at(
                item,
                BoxRect {
                    x: bx + box_s * 1.5,
                    y,
                    w: rect.x + rect.w - bx - box_s * 1.5,
                    h: row_h,
                },
                Role::Secondary,
                &style,
                false,
            );
        }
    }

    fn agenda_items(&mut self, rect: BoxRect, fit: f64) {
        let items = self.item_lines(6);
        if items.is_empty() {
            return;
        }
        let row_h = rect.h / items.len() as f64;
        let mut style = self.style_for(Role::Secondary);
        style.size *= fit;
        let dot_r = (style.size * 0.17).min(row_h * 0.3);
        let text_x = rect.x + dot_r * 3.4 + style.size * 0.3;
        for (i, item) in items.iter().enumerate() {
            let y = rect.y + i as f64 * row_h;
            let cy = y + row_h * 0.5;
            let color = if i == 0 {
                self.accent.clone()
            } else {
                self.secondary.clone()
            };
            self.circle(rect.x + dot_r, cy, dot_r, &color, Role::Decoration);
            if i + 1 < items.len() {
                self.rect(
                    BoxRect {
                        x: rect.x + dot_r - 1.0,
                        y: cy + dot_r,
                        w: 2.0,
                        h: row_h - dot_r * 2.0,
                    },
                    0.0,
                    &self.secondary.clone(),
                    0.4,
                    Role::Decoration,
                );
            }
            self.text_at(
                item,
                BoxRect {
                    x: text_x,
                    y,
                    w: rect.x + rect.w - text_x,
                    h: row_h,
                },
                Role::Secondary,
                &style,
                false,
            );
        }
    }

    fn metric(&mut self, rect: BoxRect, step: bool, before_after: bool) {
        let metric = self.layout.design.metric.clone();
        // Metric digits size from the metric element (fourth size ratio), not
        // the primary one — that is what makes stat/countdown numbers huge.
        let style = self.metric_style();
        let mel = self.layout.design.elements.metric.clone();
        let mel_color = mel.and_then(|m| m.color);
        let face = glyphs::face("mono", &style.weight);
        let cells = format!("{:.*}", metric.decimals as usize, metric.from)
            .len()
            .max(format!("{:.*}", metric.decimals as usize, metric.to).len());
        let prefix = metric.prefix.clone();
        let suffix = metric.suffix.clone();
        let advance = glyphs::measure(&face, "0", 1.0, 0.0);
        let prefix_w = glyphs::measure(&face, &prefix, 1.0, 0.0);
        let suffix_w = glyphs::measure(&face, &suffix, 1.0, 0.0);
        let to_units = cells as f64 * advance + prefix_w + suffix_w;
        // Before→After draws a muted static `from` value and an accent arrow
        // ahead of the animated counter on the same baseline.
        const FROM_SCALE: f64 = 0.62;
        const ARROW_UNITS: f64 = 0.9;
        const GAP_UNITS: f64 = 0.35;
        let from_text = if before_after {
            format!(
                "{}{:.*}{}",
                prefix, metric.decimals as usize, metric.from, suffix
            )
        } else {
            String::new()
        };
        let from_units = if before_after {
            glyphs::measure(&face, &from_text, 1.0, 0.0) * FROM_SCALE
        } else {
            0.0
        };
        let units = to_units
            + if before_after {
                from_units + ARROW_UNITS + GAP_UNITS * 2.0
            } else {
                0.0
            };
        let base = style.size;
        let size = base.min(rect.h / 1.2).min(rect.w / units.max(1.0));
        let total_w = units * size;
        let x = Self::align_x(rect, total_w, &style.align);
        let baseline = rect.y + (rect.h - size * 1.2) * 0.5 + size * 0.95;
        let mut counter_x = x;
        if before_after {
            let fs = size * FROM_SCALE;
            // Static "from" value in the muted secondary color.
            let mut e = TitleSceneElement::new(
                glyphs::glyph_path(&face, &from_text),
                &self.secondary.clone(),
            );
            e.translate_x = x;
            e.translate_y = baseline;
            e.scale_x = fs;
            e.scale_y = fs;
            e.clip = Some(rect.clip());
            self.push_part(e, Role::Primary, rect.center());
            let arrow_x = x + from_units * size + GAP_UNITS * size;
            self.path(
                arrow_path(
                    arrow_x,
                    baseline - size * 0.35,
                    ARROW_UNITS * size,
                    size * 0.3,
                ),
                &self.accent.clone(),
                1.0,
                Role::Decoration,
                Some(rect.clip()),
            );
            counter_x = arrow_x + ARROW_UNITS * size + GAP_UNITS * size;
        }
        for (text, x) in [
            (&prefix, counter_x),
            (
                &suffix,
                counter_x + (prefix_w + cells as f64 * advance) * size,
            ),
        ] {
            if text.is_empty() {
                continue;
            }
            let mut e =
                TitleSceneElement::new(glyphs::glyph_path(&face, text), &self.accent.clone());
            e.translate_x = x;
            e.translate_y = baseline;
            e.scale_x = size;
            e.scale_y = size;
            e.clip = Some(rect.clip());
            self.push_part(e, Role::Primary, rect.center());
        }
        self.layout.metrics.push(MetricLayout {
            glyphs: "0123456789.-"
                .chars()
                .map(|c| (c, glyphs::glyph_path(&face, &c.to_string())))
                .collect(),
            cells,
            x: counter_x + prefix_w * size,
            y: baseline,
            size,
            advance: advance * size,
            fill: mel_color.unwrap_or_else(|| self.foreground.clone()),
            metric,
            step,
            anchor: rect.center(),
            clip: rect.clip(),
        });
    }

    // ── Backdrop / accent / split ────────────────────────────────────────────

    fn backdrop(&mut self) {
        let design = self.design().clone();
        let bd = &design.backdrop;
        let d = self.details;
        let color = bd.color.clone().unwrap_or_else(|| self.surface.clone());
        let opacity = bd.opacity.unwrap_or(d.backdrop_opacity);
        let radius = bd.radius.unwrap_or(d.backdrop_border_radius);
        let r = BoxRect {
            x: 0.0,
            y: 0.0,
            w: self.layout.width,
            h: self.layout.height,
        };
        match bd.style {
            super::BackdropStyle::None => {}
            super::BackdropStyle::Box | super::BackdropStyle::Pill => {
                let rad = if bd.style == super::BackdropStyle::Pill {
                    r.h * 0.5
                } else {
                    radius
                };
                self.rect(r, rad, &color, opacity, Role::Backdrop);
            }
            super::BackdropStyle::Glass | super::BackdropStyle::Bar => {
                self.rect(
                    r,
                    radius.max(r.h * 0.06),
                    &color,
                    opacity
                        * if bd.style == super::BackdropStyle::Glass {
                            0.55
                        } else {
                            1.0
                        },
                    Role::Backdrop,
                );
                if bd.style == super::BackdropStyle::Glass {
                    // Translucent rim: stroke-only rect.
                    let inset = r.inset(
                        (r.h.min(r.w) * 0.006).max(1.0),
                        (r.h.min(r.w) * 0.006).max(1.0),
                    );
                    let mut e = TitleSceneElement::new(
                        rounded_rect(inset, (radius.max(r.h * 0.06) - 2.0).max(0.0)),
                        "rgba(0,0,0,0)",
                    );
                    e.stroke = Some(TitleSceneStroke {
                        color: self.accent.clone(),
                        width: (r.h.min(r.w) * 0.006).max(1.0),
                    });
                    e.opacity = 0.5;
                    e.clip = Some(r.clip());
                    self.push_part(e, Role::Backdrop, r.center());
                }
                if bd.style == super::BackdropStyle::Bar {
                    let bw = (r.w * 0.014).max(4.0);
                    self.rect(
                        BoxRect {
                            x: 0.0,
                            y: r.h * 0.08,
                            w: bw,
                            h: r.h * 0.84,
                        },
                        bw * 0.5,
                        &self.accent.clone(),
                        1.0,
                        Role::Backdrop,
                    );
                }
            }
            super::BackdropStyle::Brackets => {
                let u = r.w.min(r.h);
                let len = u * 0.16;
                let th = (u * 0.014).max(2.0);
                let m = u * 0.02;
                // Four L-shaped corner brackets as one path.
                let mut p = String::new();
                for (cx, cy, sx, sy) in [
                    (m, m, 1.0, 1.0),
                    (r.w - m, m, -1.0, 1.0),
                    (m, r.h - m, 1.0, -1.0),
                    (r.w - m, r.h - m, -1.0, -1.0),
                ] {
                    let _ = std::fmt::Write::write_fmt(
                        &mut p,
                        format_args!(
                            "M{} {}h{}v{}h{}Z M{} {}v{}h{}v{}Z",
                            cx,
                            cy,
                            sx * len,
                            sy * th,
                            -sx * len,
                            cx,
                            cy,
                            sy * len,
                            -sx * th,
                            -sy * len
                        ),
                    );
                }
                let mut e = TitleSceneElement::new(p, &self.accent.clone());
                e.clip = Some(r.clip());
                self.push_part(e, Role::Backdrop, r.center());
                // Faint panel behind the brackets for contrast.
                self.rect(r, radius, &color, opacity * 0.35, Role::Backdrop);
            }
            super::BackdropStyle::Split => {} // Drawn after layout around the primary block.
        }
    }

    fn split_backdrop(&mut self) {
        let design = self.design().clone();
        if design.backdrop.style != super::BackdropStyle::Split {
            return;
        }
        let Some(primary) = self.split_rect else {
            return;
        };
        let bd = &design.backdrop;
        let color = bd.color.clone().unwrap_or_else(|| self.surface.clone());
        let opacity = bd.opacity.unwrap_or(self.details.backdrop_opacity);
        let radius = bd.radius.unwrap_or(self.details.backdrop_border_radius);
        let r = primary.inset(-self.pad_x * 0.4, -self.pad_y * 0.25);
        let mut e = TitleSceneElement::new(rounded_rect(r, radius.max(r.h * 0.2)), &color);
        e.opacity = opacity;
        e.clip = Some(r.clip());
        let part = Part {
            element: e,
            role: Role::Backdrop,
            line_idx: 0,
            word_idx: 0,
            char_idx: 0,
            line_count: 1,
            word_count: 1,
            char_count: 1,
            anchor: r.center(),
            tracking: 0.0,
            sweep: Some(r.clip()),
            typing: None,
            emphasis: false,
            shimmer: None,
        };
        // Behind text but above any global backdrop parts.
        let pos = self
            .layout
            .parts
            .iter()
            .position(|p| p.role != Role::Backdrop)
            .unwrap_or(self.layout.parts.len());
        self.layout.parts.insert(pos, part);
    }

    fn accent_decor(&mut self) {
        let design = self.design().clone();
        // Decorations hug the content stack, not the clip box.
        let stack_rect = self
            .stack_info
            .as_ref()
            .map(|s| s.rect)
            .unwrap_or(self.inner);
        let first_text = self
            .stack_info
            .as_ref()
            .and_then(|s| {
                s.blocks.iter().find(|bl| {
                    matches!(
                        bl.block,
                        StackBlock::Primary { .. }
                            | StackBlock::Secondary
                            | StackBlock::Tag
                            | StackBlock::Label { .. }
                    )
                })
            })
            .map(|bl| {
                (
                    bl.rect.y,
                    bl.size * self.stack_info.as_ref().map_or(1.0, |s| s.fit),
                )
            });
        match design.accent.style {
            super::AccentStyle::None => {}
            super::AccentStyle::Bar => {
                let w = (stack_rect.w * 0.012).max(3.0);
                self.rect(
                    BoxRect {
                        x: stack_rect.x - self.pad_x.min(28.0) * 0.8,
                        y: stack_rect.y,
                        w,
                        h: stack_rect.h,
                    },
                    w * 0.5,
                    &self.accent.clone(),
                    1.0,
                    Role::Decoration,
                );
            }
            super::AccentStyle::Dot => {
                let r = (stack_rect.h * 0.08).min(stack_rect.w * 0.03);
                self.circle(
                    stack_rect.x - self.pad_x.min(28.0) * 0.8,
                    first_text.map_or(stack_rect.y + r, |(y, s)| y + s * 0.6),
                    r.max(3.0),
                    &self.accent.clone(),
                    Role::Decoration,
                );
            }
            super::AccentStyle::Number => {
                let line = first_text.unwrap_or((stack_rect.y, stack_rect.h * 0.4));
                let r = (line.1 * 0.72).max(12.0);
                let cx = stack_rect.x + r;
                let cy = line.0 + line.1 * 0.6;
                self.circle(cx, cy, r, &self.accent.clone(), Role::Decoration);
                let mut style = self.style_for(Role::Tag);
                style.color = self.surface.clone();
                style.align = "center".into();
                style.size = r * 1.05;
                let text = self.details.tag_text.clone().unwrap_or_else(|| "1".into());
                self.text_at(
                    &text,
                    BoxRect {
                        x: cx - r,
                        y: cy - r,
                        w: r * 2.0,
                        h: r * 2.0,
                    },
                    Role::Decoration,
                    &style,
                    false,
                );
            }
        }
    }
}

// ─── Paths ───────────────────────────────────────────────────────────────────

fn rounded_rect(b: BoxRect, radius: f64) -> String {
    let r = radius.min(b.w * 0.5).min(b.h * 0.5).max(0.0);
    let (x, y, right, bottom) = (b.x, b.y, b.x + b.w, b.y + b.h);
    format!("M{} {y}H{}Q{right} {y} {right} {}V{}Q{right} {bottom} {} {bottom}H{}Q{x} {bottom} {x} {}V{}Q{x} {y} {} {y}Z",x+r,right-r,y+r,bottom-r,right-r,x+r,bottom-r,y+r,x+r)
}

fn circle_path(cx: f64, cy: f64, r: f64) -> String {
    let k = r * 0.5523;
    format!(
        "M{} {}C{} {} {} {} {} {}C{} {} {} {} {} {}C{} {} {} {} {} {}C{} {} {} {} {} {}Z",
        cx + r,
        cy,
        cx + r,
        cy + k,
        cx + k,
        cy + r,
        cx,
        cy + r,
        cx - k,
        cy + r,
        cx - r,
        cy + k,
        cx - r,
        cy,
        cx - r,
        cy - k,
        cx - k,
        cy - r,
        cx,
        cy - r,
        cx + k,
        cy - r,
        cx + r,
        cy - k,
        cx + r,
        cy,
    )
}

// Counter-clockwise circle: inside a clockwise outer path it knocks a hole
// out under both nonzero and even-odd fill rules (map pin center).
fn circle_path_ccw(cx: f64, cy: f64, r: f64) -> String {
    let k = r * 0.5523;
    format!(
        "M{} {}C{} {} {} {} {} {}C{} {} {} {} {} {}C{} {} {} {} {} {}C{} {} {} {} {} {}Z",
        cx - r,
        cy,
        cx - r,
        cy + k,
        cx - k,
        cy + r,
        cx,
        cy + r,
        cx + k,
        cy + r,
        cx + r,
        cy + k,
        cx + r,
        cy,
        cx + r,
        cy - k,
        cx + k,
        cy - r,
        cx,
        cy - r,
        cx - k,
        cy - r,
        cx - r,
        cy - k,
        cx - r,
        cy,
    )
}

// Open tick path; drawn via the element's stroke rather than its fill.
fn check_path(x: f64, y: f64, size: f64) -> String {
    format!(
        "M{} {}L{} {}L{} {}",
        x + size * 0.18,
        y + size * 0.55,
        x + size * 0.42,
        y + size * 0.78,
        x + size * 0.85,
        y + size * 0.25,
    )
}

fn arrow_path(x: f64, y: f64, w: f64, h: f64) -> String {
    let head = w * 0.3;
    format!(
        "M{} {}H{}V{}L{} {}L{} {}V{}H{}Z",
        x,
        y - h * 0.22,
        x + w - head,
        y - h * 0.5,
        x + w,
        y,
        x + w - head,
        y + h * 0.5,
        y + h * 0.22,
        x,
    )
}

fn pin_path(cx: f64, y: f64, h: f64) -> String {
    // Teardrop map pin: circular head tapering to a bottom point, with a
    // counter-wound center circle that knocks the hole out under either fill
    // rule.
    let r = h * 0.36;
    let head_cy = y + r;
    let tip = y + h;
    // The tail winds the same direction as the head so the two subpaths union
    // under nonzero fill; the hole winds opposite to knock itself out.
    format!(
        "{}M{} {}L{} {}Q{} {} {} {}Q{} {} {} {}Z{}",
        circle_path(cx, head_cy, r),
        cx - r * 0.78,
        head_cy + r * 0.35,
        cx + r * 0.78,
        head_cy + r * 0.35,
        cx + r * 0.62,
        tip - h * 0.12,
        cx,
        tip,
        cx - r * 0.62,
        tip - h * 0.12,
        cx - r * 0.78,
        head_cy + r * 0.35,
        circle_path_ccw(cx, head_cy, r * 0.4),
    )
}
