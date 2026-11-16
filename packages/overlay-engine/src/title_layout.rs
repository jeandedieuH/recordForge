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
// `size` overrides in the design replace these.
fn size_ratios(t: TitleTemplate) -> (f64, f64, f64, f64) {
    match t {
        TitleTemplate::Hook => (1.3, 0.30, 0.22, 1.0),
        TitleTemplate::HookEmphasis => (1.15, 0.30, 0.22, 1.0),
        TitleTemplate::Clean => (1.0, 0.34, 0.27, 1.0),
        TitleTemplate::Editorial => (1.15, 0.30, 0.23, 1.0),
        TitleTemplate::Chapter => (1.0, 0.33, 1.8, 1.0),
        TitleTemplate::LowerThirdBar
        | TitleTemplate::LowerThirdGlass
        | TitleTemplate::LowerThirdLine => (1.0, 0.42, 0.24, 1.0),
        TitleTemplate::SocialHandle => (0.9, 0.34, 0.24, 1.0),
        TitleTemplate::Cta | TitleTemplate::CtaFollow | TitleTemplate::CtaLink => {
            (0.9, 0.34, 0.24, 1.0)
        }
        TitleTemplate::Step => (0.9, 0.33, 0.7, 1.0),
        TitleTemplate::Checklist => (0.6, 0.4, 0.24, 1.0),
        TitleTemplate::Shortcut => (0.57, 0.33, 0.24, 1.0),
        TitleTemplate::Terminal => (0.62, 0.25, 0.22, 1.0),
        TitleTemplate::Callout => (0.85, 0.31, 0.25, 1.0),
        TitleTemplate::Quote => (1.0, 0.27, 0.23, 1.0),
        TitleTemplate::Stat => (0.34, 0.24, 0.23, 1.7),
        TitleTemplate::StatBeforeAfter => (0.3, 0.22, 0.2, 1.5),
        TitleTemplate::Countdown => (0.2, 0.15, 0.15, 2.6),
        TitleTemplate::Location => (0.8, 0.3, 0.22, 1.0),
        TitleTemplate::Banner => (0.9, 0.3, 0.2, 1.0),
        TitleTemplate::Highlight => (1.0, 0.3, 0.2, 1.0),
        TitleTemplate::Kinetic => (1.25, 0.3, 0.24, 1.0),
        TitleTemplate::Agenda => (0.6, 0.36, 0.24, 1.0),
        TitleTemplate::Outro => (1.1, 0.3, 0.26, 1.0),
        TitleTemplate::Source => (0.7, 0.28, 0.23, 1.0),
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
            b.tag_line(inner.with_h(inner.h * 0.15));
            b.primary(inner.inset(0.0, inner.h * 0.2).with_h(inner.h * 0.55), true);
            b.secondary(inner.inset(0.0, inner.h * 0.8).with_h(inner.h * 0.2));
        }
        TitleTemplate::Hook | TitleTemplate::HookEmphasis | TitleTemplate::Kinetic => {
            let emphasis = t != TitleTemplate::Kinetic;
            b.tag_chip(inner.inset(0.0, 0.0).with_h(inner.h * 0.16));
            b.primary(
                inner.inset(0.0, inner.h * 0.2).with_h(inner.h * 0.56),
                emphasis,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.82).with_h(inner.h * 0.18));
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
            b.tag_line(inner.inset(0.0, inner.h * 0.07).with_h(inner.h * 0.12));
            b.primary(
                inner.inset(0.0, inner.h * 0.24).with_h(inner.h * 0.5),
                false,
            );
            b.rect(
                BoxRect {
                    x: inner.x,
                    y: inner.y + inner.h * 0.85,
                    w: inner.w * 0.12,
                    h: rule,
                },
                0.0,
                &b.accent.clone(),
                1.0,
                Role::Decoration,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.87).with_h(inner.h * 0.13));
        }
        TitleTemplate::Chapter => {
            // Big chapter number left, rule, title block right.
            let num_w = inner.w * 0.22;
            let tag_style = b.style_for(Role::Tag);
            b.text_at(
                &b.details.tag_text.clone().unwrap_or_else(|| "01".into()),
                BoxRect {
                    x: inner.x,
                    y: inner.y,
                    w: num_w,
                    h: inner.h,
                },
                Role::Tag,
                &tag_style,
                false,
            );
            let x = inner.x + num_w + inner.w * 0.04;
            b.rect(
                BoxRect {
                    x: inner.x + num_w,
                    y: inner.y + inner.h * 0.08,
                    w: (inner.w * 0.006).max(2.0),
                    h: inner.h * 0.84,
                },
                0.0,
                &b.accent.clone(),
                1.0,
                Role::Decoration,
            );
            let right = BoxRect {
                x,
                y: inner.y,
                w: inner.x + inner.w - x,
                h: inner.h,
            };
            b.primary(
                right.inset(0.0, right.h * 0.1).with_h(right.h * 0.55),
                false,
            );
            b.secondary(right.inset(0.0, right.h * 0.72).with_h(right.h * 0.28));
        }
        TitleTemplate::LowerThirdBar => {
            let bar_w = (inner.w * 0.014).max(4.0);
            b.rect(
                BoxRect {
                    x: inner.x,
                    y: inner.y + inner.h * 0.08,
                    w: bar_w,
                    h: inner.h * 0.84,
                },
                bar_w * 0.5,
                &b.accent.clone(),
                1.0,
                Role::Decoration,
            );
            let text = inner.inset(bar_w + inner.w * 0.03, inner.h * 0.05);
            b.primary(text.with_h(text.h * 0.6), false);
            b.secondary(text.inset(0.0, text.h * 0.62).with_h(text.h * 0.38));
        }
        TitleTemplate::LowerThirdGlass | TitleTemplate::LowerThirdLine => {
            let text = inner;
            b.primary(text.inset(0.0, text.h * 0.06).with_h(text.h * 0.58), false);
            if t == TitleTemplate::LowerThirdLine {
                let y = inner.y + inner.h * 0.68;
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
            b.secondary(text.inset(0.0, text.h * 0.74).with_h(text.h * 0.26));
        }
        TitleTemplate::SocialHandle => {
            b.tag_chip(inner.inset(0.0, 0.0).with_h(inner.h * 0.2));
            b.primary(
                inner.inset(0.0, inner.h * 0.26).with_h(inner.h * 0.48),
                false,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.8).with_h(inner.h * 0.2));
        }
        TitleTemplate::Cta | TitleTemplate::CtaFollow | TitleTemplate::CtaLink => {
            // Button: accent pill behind the primary text, centered lower half.
            b.tag_line(inner.inset(0.0, 0.0).with_h(inner.h * 0.16));
            let btn = inner
                .inset(inner.w * 0.06, inner.h * 0.28)
                .with_h(inner.h * 0.4);
            b.rect(btn, btn.h * 0.5, &b.accent.clone(), 1.0, Role::Decoration);
            let mut style = b.style_for(Role::Primary);
            style.color = b.surface.clone();
            b.text_at(
                &b.details.primary_text.clone(),
                btn.inset(btn.w * 0.06, 0.0),
                Role::Primary,
                &style,
                false,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.78).with_h(inner.h * 0.22));
        }
        TitleTemplate::Step => {
            let r = inner.h * 0.34;
            let cx = inner.x + r;
            let cy = inner.y + inner.h * 0.32;
            b.circle(cx, cy, r, &b.accent.clone(), Role::Decoration);
            let mut style = b.style_for(Role::Tag);
            style.color = b.surface.clone();
            style.size = r * 1.1;
            b.text_at(
                &b.details.tag_text.clone().unwrap_or_else(|| "1".into()),
                BoxRect {
                    x: cx - r,
                    y: cy - r * 0.72,
                    w: r * 2.0,
                    h: r * 1.6,
                },
                Role::Tag,
                &style,
                false,
            );
            let x = cx + r + inner.w * 0.03;
            let right = BoxRect {
                x,
                y: inner.y,
                w: inner.x + inner.w - x,
                h: inner.h,
            };
            b.primary(
                right.inset(0.0, right.h * 0.06).with_h(right.h * 0.52),
                false,
            );
            b.secondary(right.inset(0.0, right.h * 0.66).with_h(right.h * 0.34));
        }
        TitleTemplate::Checklist => {
            b.tag_line(inner.inset(0.0, 0.0).with_h(inner.h * 0.18));
            let items: Vec<String> = b
                .details
                .secondary_text
                .clone()
                .unwrap_or_default()
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .take(5)
                .collect();
            let items = if items.is_empty() {
                vec![b.details.primary_text.clone()]
            } else {
                items
            };
            let rows = inner.inset(0.0, inner.h * 0.22);
            let row_h = rows.h / items.len().max(1) as f64;
            let box_s = row_h * 0.42;
            let mut style = b.style_for(Role::Secondary);
            style.size = (row_h * 0.5).min(style.size);
            for (i, item) in items.iter().enumerate() {
                let y = rows.y + i as f64 * row_h;
                let bx = inner.x;
                let by = y + (row_h - box_s) * 0.5;
                // Checkbox: rounded square + accent tick.
                b.rect(
                    BoxRect {
                        x: bx,
                        y: by,
                        w: box_s,
                        h: box_s,
                    },
                    box_s * 0.24,
                    &b.foreground.clone(),
                    0.16,
                    Role::Decoration,
                );
                {
                    let mut e = TitleSceneElement::new(check_path(bx, by, box_s), "rgba(0,0,0,0)");
                    e.stroke = Some(TitleSceneStroke {
                        color: b.accent.clone(),
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
                    b.push_part(e, Role::Decoration, (bx + box_s * 0.5, by + box_s * 0.5));
                }
                b.text_at(
                    item,
                    BoxRect {
                        x: bx + box_s * 1.5,
                        y,
                        w: inner.x + inner.w - bx - box_s * 1.5,
                        h: row_h,
                    },
                    Role::Secondary,
                    &style,
                    false,
                );
            }
        }
        TitleTemplate::Shortcut => {
            b.keycaps(
                &b.details.primary_text.clone(),
                inner.inset(0.0, inner.h * 0.08).with_h(inner.h * 0.6),
            );
            b.secondary(inner.inset(0.0, inner.h * 0.76).with_h(inner.h * 0.24));
        }
        TitleTemplate::Terminal => {
            // Chrome dots + mono command; typewriter comes from the anim spec.
            let dot_r = inner.h * 0.045;
            for (i, shade) in [0.35_f64, 0.28, 0.22].iter().enumerate() {
                b.circle(
                    inner.x + dot_r + i as f64 * dot_r * 3.0,
                    inner.y + inner.h * 0.1,
                    dot_r,
                    &b.foreground.clone(),
                    Role::Decoration,
                );
                if let Some(last) = b.layout.parts.last_mut() {
                    last.element.opacity = *shade;
                }
            }
            b.tag_line(BoxRect {
                x: inner.x + dot_r * 9.0,
                y: inner.y,
                w: inner.w - dot_r * 9.0,
                h: inner.h * 0.2,
            });
            b.primary(
                inner.inset(0.0, inner.h * 0.26).with_h(inner.h * 0.52),
                false,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.82).with_h(inner.h * 0.18));
        }
        TitleTemplate::Callout => {
            let tone = b.layout.design.note_tone;
            let tone_color = match tone {
                NoteTone::Note => "#60a5fa".to_string(),
                NoteTone::Tip => b.accent.clone(),
                NoteTone::Warning => "#f59e0b".to_string(),
            };
            let bar_w = (inner.w * 0.014).max(4.0);
            b.rect(
                BoxRect {
                    x: inner.x,
                    y: inner.y + inner.h * 0.06,
                    w: bar_w,
                    h: inner.h * 0.88,
                },
                bar_w * 0.5,
                &tone_color,
                1.0,
                Role::Decoration,
            );
            let text = inner.inset(bar_w + inner.w * 0.03, 0.0);
            let mut tag_style = b.style_for(Role::Tag);
            tag_style.color = tone_color.clone();
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
            b.text_at(
                &label,
                text.inset(0.0, 0.0).with_h(text.h * 0.18),
                Role::Tag,
                &tag_style,
                false,
            );
            b.primary(text.inset(0.0, text.h * 0.22).with_h(text.h * 0.5), false);
            b.secondary(text.inset(0.0, text.h * 0.76).with_h(text.h * 0.24));
        }
        TitleTemplate::Quote => {
            let mut mark_style = b.style_for(Role::Tag);
            mark_style.family = "serif".into();
            mark_style.size = inner.h * 0.5;
            mark_style.color = b.accent.clone();
            b.text_at(
                "\u{201C}",
                BoxRect {
                    x: inner.x - mark_style.size * 0.1,
                    y: inner.y - mark_style.size * 0.1,
                    w: mark_style.size * 1.4,
                    h: mark_style.size,
                },
                Role::Decoration,
                &mark_style,
                false,
            );
            let text = inner.inset(inner.w * 0.08, inner.h * 0.12);
            b.primary(text.inset(0.0, 0.0).with_h(text.h * 0.68), false);
            b.secondary(text.inset(0.0, text.h * 0.76).with_h(text.h * 0.24));
        }
        TitleTemplate::Stat | TitleTemplate::StatBeforeAfter | TitleTemplate::Countdown => {
            b.tag_line(inner.inset(0.0, 0.0).with_h(inner.h * 0.14));
            let step = t == TitleTemplate::Countdown;
            let metric_rect = inner.inset(0.0, inner.h * 0.16).with_h(inner.h * 0.55);
            b.metric(metric_rect, step);
            if t == TitleTemplate::StatBeforeAfter {
                // Arrow showing the before → after direction.
                let y = metric_rect.y + metric_rect.h * 0.5;
                b.path(
                    arrow_path(inner.x + inner.w * 0.76, y, inner.w * 0.16, inner.h * 0.06),
                    &b.accent.clone(),
                    1.0,
                    Role::Decoration,
                    None,
                );
            }
            b.primary(
                inner.inset(0.0, inner.h * 0.72).with_h(inner.h * 0.14),
                false,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.86).with_h(inner.h * 0.14));
        }
        TitleTemplate::Location => {
            let pin_h = inner.h * 0.34;
            b.path(
                pin_path(inner.x + pin_h * 0.35, inner.y + inner.h * 0.04, pin_h),
                &b.accent.clone(),
                1.0,
                Role::Decoration,
                None,
            );
            let text = inner.inset(inner.h * 0.5, 0.0);
            b.primary(text.inset(0.0, text.h * 0.05).with_h(text.h * 0.55), false);
            b.secondary(text.inset(0.0, text.h * 0.68).with_h(text.h * 0.32));
        }
        TitleTemplate::Banner => {
            // Accent band across the clip with the headline on it.
            let band = inner
                .inset(-b.pad_x * 0.999, inner.h * 0.18)
                .with_h(inner.h * 0.5);
            b.rect(band, 0.0, &b.accent.clone(), 1.0, Role::Decoration);
            let mut style = b.style_for(Role::Primary);
            style.color = b.surface.clone();
            style.align = "center".into();
            b.text_at(
                &b.details.primary_text.clone(),
                band.inset(band.w * 0.04, 0.0),
                Role::Primary,
                &style,
                false,
            );
            let mut sub = b.style_for(Role::Secondary);
            sub.align = "center".into();
            let sub_text = b.details.secondary_text.clone().unwrap_or_default();
            b.text_at(
                &sub_text,
                inner.inset(0.0, inner.h * 0.76).with_h(inner.h * 0.2),
                Role::Secondary,
                &sub,
                false,
            );
        }
        TitleTemplate::Highlight => {
            // Marker emphasis over the whole primary when no phrase is set.
            b.primary(
                inner.inset(0.0, inner.h * 0.16).with_h(inner.h * 0.56),
                true,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.78).with_h(inner.h * 0.22));
        }
        TitleTemplate::Agenda => {
            let mut tag_style = b.style_for(Role::Tag);
            tag_style.size *= 1.4;
            let title = b.details.primary_text.clone();
            b.text_at(
                &title,
                inner.inset(0.0, 0.0).with_h(inner.h * 0.2),
                Role::Tag,
                &tag_style,
                false,
            );
            let items: Vec<String> = b
                .details
                .secondary_text
                .clone()
                .unwrap_or_default()
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .take(6)
                .collect();
            let rows = inner.inset(0.0, inner.h * 0.26);
            let row_h = rows.h / items.len().max(1) as f64;
            let dot_r = (row_h * 0.16).min(inner.w * 0.01);
            let mut style = b.style_for(Role::Secondary);
            style.size = (row_h * 0.46).min(style.size);
            for (i, item) in items.iter().enumerate() {
                let cy = rows.y + i as f64 * row_h + row_h * 0.5;
                let color = if i == 0 {
                    b.accent.clone()
                } else {
                    b.secondary.clone()
                };
                b.circle(inner.x + dot_r, cy, dot_r, &color, Role::Decoration);
                if i + 1 < items.len() {
                    b.rect(
                        BoxRect {
                            x: inner.x + dot_r - 1.0,
                            y: cy + dot_r,
                            w: 2.0,
                            h: row_h - dot_r * 2.0,
                        },
                        0.0,
                        &b.secondary.clone(),
                        0.4,
                        Role::Decoration,
                    );
                }
                b.text_at(
                    item,
                    BoxRect {
                        x: inner.x + dot_r * 3.4,
                        y: rows.y + i as f64 * row_h,
                        w: inner.x + inner.w - inner.x - dot_r * 3.4,
                        h: row_h,
                    },
                    Role::Secondary,
                    &style,
                    false,
                );
            }
        }
        TitleTemplate::Outro => {
            b.primary(inner.inset(0.0, inner.h * 0.08).with_h(inner.h * 0.5), true);
            let pill = inner
                .inset(inner.w * 0.18, inner.h * 0.64)
                .with_h(inner.h * 0.2);
            b.rect(pill, pill.h * 0.5, &b.accent.clone(), 1.0, Role::Decoration);
            let mut style = b.style_for(Role::Tag);
            style.color = b.surface.clone();
            style.align = "center".into();
            style.size = (pill.h * 0.44).max(10.0);
            b.text_at(
                &b.details
                    .tag_text
                    .clone()
                    .unwrap_or_else(|| "recordforge".into()),
                pill,
                Role::Tag,
                &style,
                false,
            );
            b.secondary(inner.inset(0.0, inner.h * 0.88).with_h(inner.h * 0.12));
        }
        TitleTemplate::Source => {
            let mut tag_style = b.style_for(Role::Tag);
            tag_style.color = b.accent.clone();
            let label = b
                .details
                .tag_text
                .clone()
                .unwrap_or_else(|| "SOURCE".into())
                .to_uppercase();
            b.text_at(
                &label,
                inner.inset(0.0, 0.0).with_h(inner.h * 0.3),
                Role::Tag,
                &tag_style,
                false,
            );
            b.primary(inner.inset(0.0, inner.h * 0.3).with_h(inner.h * 0.4), false);
            b.secondary(inner.inset(0.0, inner.h * 0.74).with_h(inner.h * 0.26));
        }
    }
}

impl BoxRect {
    fn with_h(self, h: f64) -> BoxRect {
        BoxRect { h, ..self }
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

    // Tag inside a small accent chip.
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
        let face = glyphs::face(&style.family, &style.weight);
        let tw = glyphs::measure(&face, &tag.to_uppercase(), style.size, style.spacing);
        let chip_w = tw + style.size * 1.1;
        let chip_h = style.size * 1.9;
        let chip = BoxRect {
            x: rect.x
                + match style.align.as_str() {
                    "center" => (rect.w - chip_w) * 0.5,
                    "right" => rect.w - chip_w,
                    _ => 0.0,
                },
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
        self.text_at(
            &tag,
            chip.inset(style.size * 0.55, 0.0),
            Role::Tag,
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

    fn secondary(&mut self, rect: BoxRect) {
        let Some(text) = self.details.secondary_text.clone() else {
            return;
        };
        let style = self.style_for(Role::Secondary);
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
        let lines = glyphs::wrap(&face, &text, rect.w, style.size, style.spacing);
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
        let emph_text = if emphasis && emph.text.is_empty() {
            text.clone() // Highlight template marks everything.
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
        for line in &lines {
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
            let baseline = rect.y
                + (rect.h - block_height) * 0.5
                + size * 0.95
                + self.counts[role_index(role)][0] as f64 * size * style.line_height;
            let line_clip = TitleClip {
                x: rect.x,
                y: baseline - size,
                width: rect.w,
                height: size * 1.25,
            };
            let line_idx = self.counts[role_index(role)][0];
            for run in glyphs::runs(&face, line, size, style.spacing, per_char || typewriter) {
                let run_selected = selected.is_some_and(|(s, e)| {
                    source_start + run.end > s && source_start + run.start < e
                });
                let line_word_idx = self.counts[role_index(role)][1];
                let line_char_idx = self.counts[role_index(role)][2];
                let unit = (line_idx, line_word_idx, line_char_idx);
                if run_selected && !run.path.is_empty() {
                    self.emphasis_decor(
                        &emph,
                        x + run.x,
                        run.width,
                        baseline,
                        size,
                        line_clip,
                        unit,
                    );
                }
                let anchor = (x + run.x + run.width * 0.5, baseline - size * 0.35);
                if !run.path.is_empty() {
                    let mut e = TitleSceneElement::new(run.path.clone(), &style.color);
                    e.translate_x = x + run.x;
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

    #[allow(clippy::too_many_arguments)]
    fn emphasis_decor(
        &mut self,
        emph: &TitleEmphasis,
        x: f64,
        w: f64,
        baseline: f64,
        size: f64,
        line_clip: TitleClip,
        unit: (u32, u32, u32),
    ) {
        let color = emph.color.clone().unwrap_or_else(|| self.accent.clone());
        let push = |b: &mut Self, e: TitleSceneElement| {
            let anchor = (x + w * 0.5, baseline - size * 0.35);
            b.layout.parts.push(Part {
                element: e,
                role: Role::Decoration,
                line_idx: unit.0,
                word_idx: unit.1,
                char_idx: unit.2,
                line_count: 1,
                word_count: 1,
                char_count: 1,
                anchor,
                tracking: 0.0,
                sweep: Some(line_clip),
                typing: None,
                emphasis: true,
                shimmer: None,
            });
        };
        match emph.style {
            super::EmphasisStyle::Color => {}
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
                push(self, e);
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
                push(self, e);
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
                push(self, e);
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
                push(self, e);
            }
        }
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
        let scale = (rect.w / total).min(rect.h / (size * 1.8)).min(1.0);
        let key_h = size * 1.8 * scale;
        let align = self.style_for(Role::Primary).align;
        let mut x = rect.x
            + match align.as_str() {
                "center" => (rect.w - total * scale) * 0.5,
                "right" => rect.w - total * scale,
                _ => 0.0,
            };
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
            self.text_at(
                key,
                BoxRect {
                    x: x + size * 0.4 * scale,
                    y: r.y + size * 0.15 * scale,
                    w: r.w - size * 0.8 * scale,
                    h: r.h - size * 0.3 * scale,
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

    fn metric(&mut self, rect: BoxRect, step: bool) {
        let metric = self.layout.design.metric.clone();
        let style = self.style_for(Role::Primary);
        let mel = self.layout.design.elements.metric.clone();
        let mel_size = mel.as_ref().and_then(|m| m.size);
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
        let units = cells as f64 * advance + prefix_w + suffix_w;
        let base = mel_size.unwrap_or(style.size);
        let size = base.min(rect.h / 1.2).min(rect.w / units.max(1.0));
        let x = rect.x
            + match style.align.as_str() {
                "center" => (rect.w - units * size) * 0.5,
                "right" => rect.w - units * size,
                _ => 0.0,
            };
        let baseline = rect.y + (rect.h - size * 1.2) * 0.5 + size * 0.95;
        for (text, x) in [
            (&prefix, x),
            (&suffix, x + (prefix_w + cells as f64 * advance) * size),
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
            x: x + prefix_w * size,
            y: baseline,
            size,
            advance: advance * size,
            fill: mel_color.unwrap_or_else(|| self.foreground.clone()),
            metric,
            step,
            anchor: rect.center(),
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
        let inner = self.inner;
        match design.accent.style {
            super::AccentStyle::None => {}
            super::AccentStyle::Bar => {
                let w = (inner.w * 0.012).max(3.0);
                self.rect(
                    BoxRect {
                        x: inner.x - self.pad_x * 0.45,
                        y: inner.y,
                        w,
                        h: inner.h,
                    },
                    w * 0.5,
                    &self.accent.clone(),
                    1.0,
                    Role::Decoration,
                );
            }
            super::AccentStyle::Dot => {
                let r = (inner.h * 0.08).min(inner.w * 0.03);
                self.circle(
                    inner.x - self.pad_x * 0.4,
                    inner.y + inner.h * 0.14,
                    r.max(3.0),
                    &self.accent.clone(),
                    Role::Decoration,
                );
            }
            super::AccentStyle::Number => {
                let r = (inner.h * 0.16).min(inner.w * 0.08).max(12.0);
                let cx = inner.x + r;
                let cy = inner.y + r * 1.2;
                self.circle(cx, cy, r, &self.accent.clone(), Role::Decoration);
                let mut style = self.style_for(Role::Tag);
                style.color = self.surface.clone();
                style.size = r;
                let text = self.details.tag_text.clone().unwrap_or_else(|| "1".into());
                self.text_at(
                    &text,
                    BoxRect {
                        x: cx - r,
                        y: cy - r * 0.72,
                        w: r * 2.0,
                        h: r * 1.5,
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
    // Map pin: circular head plus a triangle tapering to the bottom point.
    let r = h * 0.42;
    let cy = y + r;
    format!(
        "{}M{} {}L{} {}L{} {}Z",
        circle_path(cx, cy, r),
        cx - r * 0.55,
        cy + r * 0.7,
        cx + r * 0.55,
        cy + r * 0.7,
        cx,
        y + h,
    )
}
