use super::{
    glyphs, MetricLayout, NoteTone, Part, Role, TitleAppearance, TitleClip, TitleDesign,
    TitleLayout, TitleSceneElement, TitleTemplate,
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
}
struct Builder<'a> {
    layout: TitleLayout,
    details: &'a TextDetails,
    foreground: String,
    secondary: String,
    surface: String,
    accent: String,
}

pub(super) fn compile(
    d: &TextDetails,
    transform: &OverlayTransform,
    design: &TitleDesign,
) -> TitleLayout {
    let w = transform.width.max(1.0);
    let h = transform.height.max(1.0);
    let light = design.appearance == TitleAppearance::Light;
    let fg = if light
        && matches!(
            d.text_color.to_ascii_lowercase().as_str(),
            "#ffffff" | "#fff" | "#f8fafc"
        ) {
        "#172033"
    } else {
        &d.text_color
    };
    let secondary = if light
        && matches!(
            d.secondary_text_color.to_ascii_lowercase().as_str(),
            "#cbd5e1" | "#e2e8f0" | "#94a3b8"
        ) {
        "#526174"
    } else {
        &d.secondary_text_color
    };
    let surface = if light
        && matches!(
            d.backdrop_color.to_ascii_lowercase().as_str(),
            "#111827" | "#0f172a" | "#020617" | "#000000"
        ) {
        "#f8fafc"
    } else {
        &d.backdrop_color
    };
    let mut b = Builder {
        layout: TitleLayout {
            width: w,
            height: h,
            parts: Vec::new(),
            metric: None,
            design: design.clone(),
        },
        details: d,
        foreground: fg.into(),
        secondary: secondary.into(),
        surface: surface.into(),
        accent: d.accent_color.clone(),
    };
    let px = d.backdrop_padding_x.max(w * 0.035).min(w * 0.18);
    let py = d.backdrop_padding_y.max(h * 0.055).min(h * 0.18);
    let inner = BoxRect {
        x: px,
        y: py,
        w: w - 2.0 * px,
        h: h - 2.0 * py,
    };
    let unit = w.min(h);
    let rule = (unit * 0.012).max(1.0);
    let tag = d.tag_text.as_deref().filter(|t| !t.trim().is_empty());
    let subtitle = d.secondary_text.as_deref().unwrap_or("");
    let size = d.font_size;
    let family = d.font_family.as_str();
    let accent = b.accent.clone();
    let fg = b.foreground.clone();
    let secondary = b.secondary.clone();
    b.backdrop(BoxRect {
        x: 0.0,
        y: 0.0,
        w,
        h,
    });
    match design.template {
        TitleTemplate::CleanText => {
            if let Some(tag) = tag {
                b.text(
                    tag,
                    BoxRect {
                        h: inner.h * 0.15,
                        ..inner
                    },
                    size * 0.27,
                    "sans",
                    Role::Tag,
                    &accent,
                    false,
                );
            }
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.20,
                    h: inner.h * 0.52,
                    ..inner
                },
                size,
                family,
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.78,
                    h: inner.h * 0.20,
                    ..inner
                },
                size * 0.34,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::Emphasis => {
            b.text(
                tag.unwrap_or("THE TAKEAWAY"),
                BoxRect {
                    h: inner.h * 0.13,
                    ..inner
                },
                size * 0.24,
                "sans",
                Role::Tag,
                &secondary,
                false,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.19,
                    h: inner.h * 0.56,
                    ..inner
                },
                size * 1.05,
                family,
                Role::Primary,
                &fg,
                true,
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.82,
                    h: inner.h * 0.16,
                    ..inner
                },
                size * 0.32,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::EditorialOpener => {
            b.rect(
                BoxRect { h: rule, ..inner },
                0.0,
                &fg,
                1.0,
                Role::Decoration,
            );
            b.text(
                tag.unwrap_or("THE EDIT"),
                BoxRect {
                    y: py + inner.h * 0.06,
                    w: inner.w * 0.72,
                    h: inner.h * 0.12,
                    ..inner
                },
                size * 0.23,
                "sans",
                Role::Tag,
                &accent,
                false,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.23,
                    h: inner.h * 0.52,
                    ..inner
                },
                size * 1.15,
                if family == "sans" { "serif" } else { family },
                Role::Primary,
                &fg,
                false,
            );
            b.rect(
                BoxRect {
                    x: px,
                    y: py + inner.h * 0.85,
                    w: inner.w * 0.12,
                    h: rule,
                },
                0.0,
                &accent,
                1.0,
                Role::Decoration,
            );
            b.text(
                subtitle,
                BoxRect {
                    x: px + inner.w * 0.18,
                    y: py + inner.h * 0.80,
                    w: inner.w * 0.82,
                    h: inner.h * 0.18,
                },
                size * 0.30,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::KineticHook => {
            b.rect(
                BoxRect {
                    x: w - rule * 2.0,
                    y: 0.0,
                    w: rule * 2.0,
                    h,
                },
                0.0,
                &accent,
                1.0,
                Role::Decoration,
            );
            b.text(
                tag.unwrap_or("WATCH THIS"),
                BoxRect {
                    w: inner.w * 0.75,
                    h: inner.h * 0.13,
                    ..inner
                },
                size * 0.24,
                "mono",
                Role::Tag,
                &accent,
                false,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.19,
                    h: inner.h * 0.60,
                    w: inner.w * 0.93,
                    ..inner
                },
                size * 1.25,
                if family == "sans" { "heading" } else { family },
                Role::Primary,
                &fg,
                false,
            );
            b.rect(
                BoxRect {
                    x: px,
                    y: py + inner.h * 0.85,
                    w: inner.w * 0.18,
                    h: rule * 2.0,
                },
                0.0,
                &accent,
                1.0,
                Role::Decoration,
            );
            b.text(
                subtitle,
                BoxRect {
                    x: px + inner.w * 0.23,
                    y: py + inner.h * 0.82,
                    w: inner.w * 0.72,
                    h: inner.h * 0.17,
                },
                size * 0.30,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::ChapterMarker => {
            b.text(
                tag.unwrap_or("01"),
                BoxRect {
                    y: py + inner.h * 0.16,
                    w: inner.w * 0.23,
                    h: inner.h * 0.62,
                    ..inner
                },
                size * 1.8,
                "heading",
                Role::Tag,
                &accent,
                false,
            );
            b.rect(
                BoxRect {
                    x: px + inner.w * 0.29,
                    y: py + inner.h * 0.08,
                    w: rule,
                    h: inner.h * 0.82,
                },
                0.0,
                &accent,
                0.6,
                Role::Decoration,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    x: px + inner.w * 0.36,
                    y: py + inner.h * 0.15,
                    w: inner.w * 0.64,
                    h: inner.h * 0.49,
                },
                size,
                family,
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    x: px + inner.w * 0.36,
                    y: py + inner.h * 0.72,
                    w: inner.w * 0.64,
                    h: inner.h * 0.19,
                },
                size * 0.33,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::SpeakerId => {
            b.rect(
                BoxRect {
                    x: 0.0,
                    y: 0.0,
                    w: rule * 2.0,
                    h,
                },
                0.0,
                &accent,
                1.0,
                Role::Decoration,
            );
            b.rect(
                BoxRect {
                    x: px,
                    y: py + inner.h * 0.1,
                    w: inner.h * 0.11,
                    h: inner.h * 0.11,
                },
                inner.h * 0.055,
                &accent,
                1.0,
                Role::Decoration,
            );
            b.text(
                tag.unwrap_or("MEET THE MAKER"),
                BoxRect {
                    x: px + inner.h * 0.16,
                    y: py + inner.h * 0.08,
                    w: inner.w - inner.h * 0.16,
                    h: inner.h * 0.15,
                },
                size * 0.24,
                "sans",
                Role::Tag,
                &secondary,
                false,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.32,
                    h: inner.h * 0.35,
                    ..inner
                },
                size,
                family,
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.77,
                    h: inner.h * 0.20,
                    ..inner
                },
                size * 0.36,
                "sans",
                Role::Secondary,
                &accent,
                false,
            );
        }
        TitleTemplate::SourceCredit => {
            b.text(
                tag.unwrap_or("SOURCE / CREDIT"),
                BoxRect {
                    h: inner.h * 0.16,
                    ..inner
                },
                size * 0.23,
                "mono",
                Role::Tag,
                &accent,
                false,
            );
            b.rect(
                BoxRect {
                    y: py + inner.h * 0.25,
                    h: rule * 0.5,
                    ..inner
                },
                0.0,
                &secondary,
                0.5,
                Role::Decoration,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.37,
                    h: inner.h * 0.32,
                    ..inner
                },
                size * 0.70,
                "serif",
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.79,
                    h: inner.h * 0.17,
                    ..inner
                },
                size * 0.28,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::StepGuide => {
            let badge = inner.h.min(inner.w * 0.20) * 0.75;
            b.rect(
                BoxRect {
                    x: px,
                    y: py + inner.h * 0.1,
                    w: badge,
                    h: badge,
                },
                badge * 0.25,
                &accent,
                0.18,
                Role::Decoration,
            );
            b.text(
                tag.unwrap_or("01"),
                BoxRect {
                    x: px + badge * 0.16,
                    y: py + inner.h * 0.1 + badge * 0.12,
                    w: badge * 0.68,
                    h: badge * 0.75,
                },
                size * 0.70,
                "mono",
                Role::Tag,
                &accent,
                false,
            );
            b.rect(
                BoxRect {
                    x: px + badge * 0.5,
                    y: py + inner.h * 0.1 + badge + rule * 2.0,
                    w: rule * 0.6,
                    h: (inner.h * 0.78 - badge).max(0.0),
                },
                0.0,
                &accent,
                0.45,
                Role::Decoration,
            );
            let x = px + badge + inner.w * 0.07;
            b.text(
                &d.primary_text,
                BoxRect {
                    x,
                    y: py + inner.h * 0.14,
                    w: w - px - x,
                    h: inner.h * 0.48,
                },
                size * 0.90,
                family,
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    x,
                    y: py + inner.h * 0.72,
                    w: w - px - x,
                    h: inner.h * 0.24,
                },
                size * 0.33,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::Shortcut => {
            b.text(
                tag.unwrap_or("WORK SMARTER"),
                BoxRect {
                    h: inner.h * 0.14,
                    ..inner
                },
                size * 0.24,
                "sans",
                Role::Tag,
                &accent,
                false,
            );
            b.keycaps(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.27,
                    h: inner.h * 0.43,
                    ..inner
                },
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.81,
                    h: inner.h * 0.18,
                    ..inner
                },
                size * 0.33,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::CommandLine => {
            for i in 0..3 {
                b.rect(
                    BoxRect {
                        x: px + f64::from(i) * rule * 4.0,
                        y: py,
                        w: rule * 2.0,
                        h: rule * 2.0,
                    },
                    rule,
                    &accent,
                    0.35 + f64::from(i) * 0.25,
                    Role::Decoration,
                );
            }
            b.text(
                tag.unwrap_or("TERMINAL"),
                BoxRect {
                    x: px + rule * 14.0,
                    y: py,
                    w: (inner.w - rule * 14.0).max(1.0),
                    h: inner.h * 0.13,
                },
                size * 0.22,
                "mono",
                Role::Tag,
                &secondary,
                false,
            );
            b.rect(
                BoxRect {
                    y: py + inner.h * 0.22,
                    h: rule * 0.5,
                    ..inner
                },
                0.0,
                &secondary,
                0.25,
                Role::Decoration,
            );
            b.text(
                ">",
                BoxRect {
                    y: py + inner.h * 0.34,
                    w: inner.w * 0.05,
                    h: inner.h * 0.41,
                    ..inner
                },
                size * 0.60,
                "mono",
                Role::Decoration,
                &accent,
                false,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    x: px + inner.w * 0.08,
                    y: py + inner.h * 0.34,
                    w: inner.w * 0.92,
                    h: inner.h * 0.41,
                },
                size * 0.62,
                "mono",
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.85,
                    h: inner.h * 0.13,
                    ..inner
                },
                size * 0.25,
                "mono",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::Note => {
            let label = match design.note_tone {
                NoteTone::Note => "NOTE",
                NoteTone::Tip => "PRO TIP",
                NoteTone::Warning => "CAUTION",
            };
            let icon = BoxRect {
                x: px,
                y: py,
                w: inner.h * 0.16,
                h: inner.h * 0.16,
            };
            if design.note_tone == NoteTone::Warning {
                b.path(
                    format!(
                        "M{} {}L{} {}L{} {}Z",
                        icon.x + icon.w * 0.5,
                        icon.y,
                        icon.x + icon.w,
                        icon.y + icon.h,
                        icon.x,
                        icon.y + icon.h
                    ),
                    &accent,
                    0.25,
                    Role::Decoration,
                    Some(icon.clip()),
                );
            } else {
                b.rect(
                    icon,
                    if design.note_tone == NoteTone::Tip {
                        icon.h * 0.5
                    } else {
                        icon.h * 0.15
                    },
                    &accent,
                    0.25,
                    Role::Decoration,
                );
            }
            b.text(
                if design.note_tone == NoteTone::Tip {
                    "+"
                } else {
                    "!"
                },
                BoxRect {
                    x: icon.x + icon.w * 0.30,
                    y: icon.y + icon.h * 0.15,
                    w: icon.w * 0.40,
                    h: icon.h * 0.7,
                },
                size * 0.25,
                "mono",
                Role::Tag,
                &accent,
                false,
            );
            b.text(
                tag.unwrap_or(label),
                BoxRect {
                    x: px + icon.w * 1.4,
                    y: py,
                    w: inner.w - icon.w * 1.4,
                    h: inner.h * 0.16,
                },
                size * 0.25,
                "sans",
                Role::Tag,
                &accent,
                false,
            );
            b.rect(
                BoxRect {
                    x: px,
                    y: py + inner.h * 0.30,
                    w: rule,
                    h: inner.h * 0.68,
                },
                0.0,
                &accent,
                if design.note_tone == NoteTone::Warning {
                    1.0
                } else {
                    0.4
                },
                Role::Decoration,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    x: px + inner.w * 0.055,
                    y: py + inner.h * 0.32,
                    w: inner.w * 0.945,
                    h: inner.h * 0.40,
                },
                size * 0.85,
                family,
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    x: px + inner.w * 0.055,
                    y: py + inner.h * 0.80,
                    w: inner.w * 0.945,
                    h: inner.h * 0.18,
                },
                size * 0.31,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::PullQuote => {
            b.text(
                "“",
                BoxRect {
                    x: px,
                    y: py,
                    w: inner.w * 0.12,
                    h: inner.h * 0.45,
                },
                size * 1.9,
                "serif",
                Role::Decoration,
                &accent,
                false,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    x: px + inner.w * 0.15,
                    y: py + inner.h * 0.06,
                    w: inner.w * 0.85,
                    h: inner.h * 0.61,
                },
                size,
                if family == "sans" { "serif" } else { family },
                Role::Primary,
                &fg,
                false,
            );
            b.rect(
                BoxRect {
                    x: px + inner.w * 0.15,
                    y: py + inner.h * 0.77,
                    w: inner.w * 0.09,
                    h: rule,
                },
                0.0,
                &accent,
                1.0,
                Role::Decoration,
            );
            b.text(
                tag.unwrap_or("IN THEIR WORDS"),
                BoxRect {
                    x: px + inner.w * 0.29,
                    y: py + inner.h * 0.72,
                    w: inner.w * 0.71,
                    h: inner.h * 0.12,
                },
                size * 0.23,
                "sans",
                Role::Tag,
                &accent,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    x: px + inner.w * 0.29,
                    y: py + inner.h * 0.86,
                    w: inner.w * 0.71,
                    h: inner.h * 0.12,
                },
                size * 0.27,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::Metric => {
            b.text(
                tag.unwrap_or("BY THE NUMBERS"),
                BoxRect {
                    h: inner.h * 0.12,
                    ..inner
                },
                size * 0.23,
                "sans",
                Role::Tag,
                &accent,
                false,
            );
            b.metric(BoxRect {
                y: py + inner.h * 0.22,
                h: inner.h * 0.43,
                ..inner
            });
            b.rect(
                BoxRect {
                    y: py + inner.h * 0.71,
                    h: rule,
                    ..inner
                },
                0.0,
                &accent,
                0.55,
                Role::Decoration,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.77,
                    h: inner.h * 0.12,
                    ..inner
                },
                size * 0.34,
                family,
                Role::Primary,
                &fg,
                false,
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.92,
                    h: inner.h * 0.08,
                    ..inner
                },
                size * 0.24,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
        TitleTemplate::CallToAction => {
            b.text(
                tag.unwrap_or("YOUR NEXT MOVE"),
                BoxRect {
                    w: inner.w * 0.82,
                    h: inner.h * 0.14,
                    ..inner
                },
                size * 0.24,
                "sans",
                Role::Tag,
                &accent,
                false,
            );
            b.text(
                &d.primary_text,
                BoxRect {
                    y: py + inner.h * 0.24,
                    w: inner.w * 0.78,
                    h: inner.h * 0.43,
                    ..inner
                },
                size,
                family,
                Role::Primary,
                &fg,
                false,
            );
            let a = BoxRect {
                x: px + inner.w * 0.84,
                y: py + inner.h * 0.26,
                w: inner.w * 0.14,
                h: inner.h * 0.39,
            };
            b.rect(a, a.w.min(a.h) * 0.5, &accent, 1.0, Role::Decoration);
            let (cx, cy, s) = (a.x + a.w * 0.5, a.y + a.h * 0.5, a.w.min(a.h) * 0.24);
            b.path(
                format!(
                    "M{} {}L{} {}L{} {}L{} {}L{} {}L{} {}L{} {}L{} {}L{} {}Z",
                    cx - s,
                    cy - s * 0.16,
                    cx + s * 0.25,
                    cy - s * 0.16,
                    cx - s * 0.2,
                    cy - s * 0.62,
                    cx + s * 0.03,
                    cy - s * 0.85,
                    cx + s * 0.88,
                    cy,
                    cx + s * 0.03,
                    cy + s * 0.85,
                    cx - s * 0.2,
                    cy + s * 0.62,
                    cx + s * 0.25,
                    cy + s * 0.16,
                    cx - s,
                    cy + s * 0.16
                ),
                &b.surface.clone(),
                1.0,
                Role::Decoration,
                Some(a.clip()),
            );
            b.text(
                subtitle,
                BoxRect {
                    y: py + inner.h * 0.80,
                    h: inner.h * 0.17,
                    ..inner
                },
                size * 0.33,
                "sans",
                Role::Secondary,
                &secondary,
                false,
            );
        }
    }
    b.layout
}

impl Builder<'_> {
    fn path(
        &mut self,
        path: String,
        fill: &str,
        opacity: f64,
        role: Role,
        clip: Option<TitleClip>,
    ) {
        self.layout.parts.push(Part {
            element: TitleSceneElement {
                path,
                fill: fill.into(),
                opacity,
                translate_x: 0.0,
                translate_y: 0.0,
                scale_x: 1.0,
                scale_y: 1.0,
                clip,
            },
            role,
            order: 0.0,
            typing: None,
        });
    }
    fn rect(&mut self, r: BoxRect, radius: f64, fill: &str, opacity: f64, role: Role) {
        if r.w <= 0.0 || r.h <= 0.0 {
            return;
        }
        self.path(rounded_rect(r, radius), fill, opacity, role, Some(r.clip()));
    }
    fn backdrop(&mut self, r: BoxRect) {
        if self.layout.design.appearance == TitleAppearance::Transparent
            || self.details.backdrop_style == "none"
        {
            return;
        }
        let radius = if self.details.backdrop_style == "pill" {
            r.h * 0.5
        } else {
            self.details.backdrop_border_radius
        };
        let outline = self.details.backdrop_style == "outline";
        if self.details.shadow_enabled {
            for i in (1..=4).rev() {
                let spread = f64::from(i) * self.details.shadow_blur.min(r.h * 0.1) * 0.15;
                self.rect(
                    BoxRect {
                        x: spread,
                        y: spread,
                        w: r.w - spread,
                        h: r.h - spread,
                    },
                    radius,
                    &self.details.shadow_color,
                    0.06,
                    Role::Backdrop,
                );
            }
        }
        self.rect(
            r,
            radius,
            &self.surface.clone(),
            self.details.backdrop_opacity * if outline { 0.06 } else { 1.0 },
            Role::Backdrop,
        );
        if outline || self.details.backdrop_style == "glass" {
            let thickness = r.h.min(r.w) * 0.005;
            let inset = BoxRect {
                x: thickness,
                y: thickness,
                w: r.w - thickness * 2.0,
                h: r.h - thickness * 2.0,
            };
            self.path(
                format!(
                    "{}{}",
                    rounded_rect(r, radius),
                    reverse_rounded_rect(inset, (radius - thickness).max(0.0))
                ),
                &self.accent.clone(),
                0.4,
                Role::Backdrop,
                Some(r.clip()),
            );
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn text(
        &mut self,
        text: &str,
        rect: BoxRect,
        size: f64,
        family: &str,
        role: Role,
        color: &str,
        emphasis: bool,
    ) {
        if text.is_empty() || rect.w <= 0.0 || rect.h <= 0.0 {
            return;
        }
        let face = glyphs::face(
            family,
            if role == Role::Primary {
                &self.details.font_weight
            } else if role == Role::Tag {
                "600"
            } else {
                "400"
            },
        );
        let design = &self.layout.design;
        let spacing = if role == Role::Tag {
            design.letter_spacing.max(0.06)
        } else {
            design.letter_spacing
        };
        let line_height = design.line_height;
        let lines = glyphs::wrap(&face, text, rect.w, size, spacing);
        let max_width = lines
            .iter()
            .map(|line| glyphs::measure(&face, line, size, spacing))
            .fold(0.0_f64, f64::max);
        let natural_height = size * (1.2 + lines.len().saturating_sub(1) as f64 * line_height);
        let fit = (rect.w / max_width.max(1.0))
            .min(rect.h / natural_height)
            .min(1.0);
        let size = size * fit;
        let block_height = natural_height * fit;
        let typing = design.template == TitleTemplate::CommandLine && role == Role::Primary;
        let total_graphemes = text.graphemes(true).count().max(1);
        let selected = if emphasis {
            text.find(&design.emphasis_text)
                .filter(|_| !design.emphasis_text.is_empty())
                .map(|start| (start, start + design.emphasis_text.len()))
        } else {
            None
        };
        let mut consumed = 0;
        let mut graphemes = 0;
        for (line_index, line) in lines.iter().enumerate() {
            // Wrapping trims separators; recover source offsets so phrase selection spans line breaks.
            let source_start = text[consumed..]
                .find(line.as_str())
                .map_or(consumed, |offset| consumed + offset);
            let width = glyphs::measure(&face, line, size, spacing);
            let x = rect.x
                + match self.details.alignment.as_str() {
                    "center" => (rect.w - width) * 0.5,
                    "right" => rect.w - width,
                    _ => 0.0,
                };
            let baseline = rect.y
                + (rect.h - block_height) * 0.5
                + size * 0.95
                + line_index as f64 * size * line_height;
            let clip = TitleClip {
                x: rect.x,
                y: baseline - size,
                width: rect.w,
                height: size * 1.25,
            };
            for run in glyphs::runs(&face, line, size, spacing, typing) {
                let selected_run = selected.is_some_and(|(start, end)| {
                    source_start + run.end > start && source_start + run.start < end
                });
                if selected_run && !run.path.is_empty() {
                    self.rect(
                        BoxRect {
                            x: x + run.x - size * 0.04,
                            y: baseline - size * 0.77,
                            w: run.width + size * 0.08,
                            h: size * 0.92,
                        },
                        size * 0.07,
                        &self.accent.clone(),
                        0.26,
                        Role::Primary,
                    );
                    self.rect(
                        BoxRect {
                            x: x + run.x,
                            y: baseline + size * 0.15,
                            w: run.width,
                            h: size * 0.045,
                        },
                        0.0,
                        &self.accent.clone(),
                        1.0,
                        Role::Decoration,
                    );
                }
                if run.path.is_empty() {
                    continue;
                }
                let order = if self.layout.design.template == TitleTemplate::KineticHook {
                    (line_index as f64 + run.x / rect.w) / lines.len() as f64
                } else {
                    line_index as f64 / lines.len() as f64
                };
                let threshold = (graphemes + line[..run.end].graphemes(true).count()) as f64
                    / total_graphemes as f64;
                self.layout.parts.push(Part {
                    element: TitleSceneElement {
                        path: run.path,
                        fill: color.into(),
                        opacity: 1.0,
                        translate_x: x,
                        translate_y: baseline,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        clip: Some(clip),
                    },
                    role,
                    order,
                    typing: typing.then_some(0.18 + threshold * 0.78),
                });
            }
            graphemes += line.graphemes(true).count();
            consumed = source_start + line.len();
        }
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
        let face = glyphs::face("mono", &self.details.font_weight);
        let size = self.details.font_size * 0.57;
        let gap = size * 0.8;
        let widths: Vec<f64> = keys
            .iter()
            .map(|key| glyphs::measure(&face, key, size, 0.0) + size * 0.9)
            .collect();
        let total = widths.iter().sum::<f64>() + keys.len().saturating_sub(1) as f64 * gap;
        let scale = (rect.w / total).min(rect.h / (size * 1.8)).min(1.0);
        let key_h = size * 1.8 * scale;
        let mut x = rect.x
            + match self.details.alignment.as_str() {
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
            self.text(
                key,
                BoxRect {
                    x: x + size * 0.4 * scale,
                    y: r.y + size * 0.15 * scale,
                    w: r.w - size * 0.8 * scale,
                    h: r.h - size * 0.3 * scale,
                },
                size * scale,
                "mono",
                Role::Primary,
                &self.foreground.clone(),
                false,
            );
            x += r.w;
            if index + 1 < keys.len() {
                self.text(
                    "+",
                    BoxRect {
                        x: x + gap * scale * 0.25,
                        y: r.y,
                        w: gap * scale * 0.5,
                        h: key_h,
                    },
                    size * scale * 0.7,
                    "mono",
                    Role::Decoration,
                    &self.secondary.clone(),
                    false,
                );
                x += gap * scale;
            }
        }
    }
    fn metric(&mut self, rect: BoxRect) {
        let metric = &self.layout.design.metric;
        let face = glyphs::face("mono", &self.details.font_weight);
        let cells = format!("{:.*}", metric.decimals as usize, metric.from)
            .len()
            .max(format!("{:.*}", metric.decimals as usize, metric.to).len());
        let prefix = metric.prefix.clone();
        let suffix = metric.suffix.clone();
        let advance = glyphs::measure(&face, "0", 1.0, 0.0);
        let prefix_w = glyphs::measure(&face, &prefix, 1.0, 0.0);
        let suffix_w = glyphs::measure(&face, &suffix, 1.0, 0.0);
        let units = cells as f64 * advance + prefix_w + suffix_w;
        let size = (self.details.font_size * 1.7)
            .min(rect.h / 1.2)
            .min(rect.w / units.max(1.0));
        let x = rect.x
            + match self.details.alignment.as_str() {
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
            self.layout.parts.push(Part {
                element: TitleSceneElement {
                    path: glyphs::glyph_path(&face, text),
                    fill: self.accent.clone(),
                    opacity: 1.0,
                    translate_x: x,
                    translate_y: baseline,
                    scale_x: size,
                    scale_y: size,
                    clip: Some(rect.clip()),
                },
                role: Role::Primary,
                order: 0.0,
                typing: None,
            });
        }
        self.layout.metric = Some(MetricLayout {
            glyphs: "0123456789.-"
                .chars()
                .map(|c| (c, glyphs::glyph_path(&face, &c.to_string())))
                .collect(),
            cells,
            x: x + prefix_w * size,
            y: baseline,
            size,
            advance: advance * size,
            fill: self.foreground.clone(),
        });
    }
}
fn rounded_rect(b: BoxRect, radius: f64) -> String {
    let r = radius.min(b.w * 0.5).min(b.h * 0.5).max(0.0);
    let (x, y, right, bottom) = (b.x, b.y, b.x + b.w, b.y + b.h);
    format!("M{} {y}H{}Q{right} {y} {right} {}V{}Q{right} {bottom} {} {bottom}H{}Q{x} {bottom} {x} {}V{}Q{x} {y} {} {y}Z",x+r,right-r,y+r,bottom-r,right-r,x+r,bottom-r,y+r,x+r)
}
fn reverse_rounded_rect(b: BoxRect, radius: f64) -> String {
    let r = radius.min(b.w * 0.5).min(b.h * 0.5).max(0.0);
    let (x, y, right, bottom) = (b.x, b.y, b.x + b.w, b.y + b.h);
    format!("M{} {y}Q{x} {y} {x} {}V{}Q{x} {bottom} {} {bottom}H{}Q{right} {bottom} {right} {}V{}Q{right} {y} {} {y}Z",x+r,y+r,bottom-r,x+r,right-r,bottom-r,y+r,right-r)
}
