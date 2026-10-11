use super::layout_plan::{CaptionLayoutPage, CaptionLayoutPlan, CaptionLayoutWord};
use super::measure::{ass_family_for, font_file_for, measure_line_px, metrics_for, FontMetrics};
use super::{escape_ass_text, format_ass_time_cs};
use crate::exports::RenderPlanCaption;
use std::fmt::Write;

// The px-resolved caption writer. The editor-core layout engine has already
// decided font size, wrapping, page splits, and word timing — this writer only
// has to reproduce that geometry inside libass. Two libass quirks drive the
// structure (measured against the bundled ffmpeg's libass 0.17.5,
// DirectWrite):
//
//  * `Fontsize` is not the CSS em — libass scales the font by the OS/2 win
//    metrics, so `em_px = Fontsize * upem / (usWinAscent + usWinDescent)`. The
//    per-event `\fs` carries `FontMetrics::ass_font_size(fontPx)`.
//  * A `\an5` event vertically centers on the win-metrics line box, while the
//    preview centers text in a CSS `line-height` box (hhea metrics). A single
//    multi-line `\N` event therefore lands ~0.03 em lower per line AND pitches
//    lines at 1.43 em instead of 1.25. So EVERY line is its own event at its
//    own `\pos`; `baseline_shift_px` removes the residual offset.
//
// `WrapStyle: 2` disables libass auto-wrap — re-wrapping would fight the
// measured chip width.
//
// Calibrated on this tree's bundled ffmpeg/libass 0.17.5 (see the
// `blur_unit_calibration` render test): one `\blur` unit behaves like a
// Gaussian σ ≈ 0.839 → a 10→90% edge of ≈ 2.15 px. A CSS blur of `blurPx`
// wants σ = blurPx/2 → edge ≈ 1.28·blurPx, so the emitted tag is
// `blurPx × (1.28/2.15) ≈ blurPx × 0.6`.
const BLUR_SIGMA_PER_UNIT: f64 = 0.839;

fn num(value: f64) -> String {
    // Two decimals are plenty for PlayRes-space geometry; trimming keeps the
    // script readable.
    let formatted = format!("{value:.2}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}

/// `#RRGGBB` → ASS `&HBBGGRR&` (validated upstream; malformed input falls
/// back to white rather than aborting a render).
fn ass_color(hex: &str) -> String {
    let body = hex.get(1..).unwrap_or("FFFFFF");
    if body.len() == 6 {
        format!("&H{}{}{}&", &body[4..6], &body[2..4], &body[0..2])
    } else {
        "&HFFFFFF&".to_string()
    }
}

/// ASS alpha byte: `&HAA&` with 00 opaque — stores `1 − opacity`.
fn ass_alpha(opacity: f64) -> String {
    let byte = ((1.0 - opacity.clamp(0.0, 1.0)) * 255.0).round() as u8;
    format!("&H{byte:02X}&")
}

fn pos_tag(x: f64, y: f64) -> String {
    format!("\\an5\\pos({},{})", num(x), num(y))
}

fn blur_tag(blur_px: f64) -> String {
    if blur_px <= 0.0 {
        "\\blur0".to_string()
    } else {
        // target σ = blurPx/2; one blur unit ≈ σ 0.839 → ×0.5/0.839 ≈ ×0.6.
        format!("\\blur{}", num(blur_px * 0.5 / BLUR_SIGMA_PER_UNIT))
    }
}

/// Shared text-shaping override block: alignment+position, scaled font size,
/// letter spacing, primary color/alpha, outline, no style-level shadow/blur.
fn text_tags(layout: &CaptionLayoutPlan, metrics: &FontMetrics, x: f64, y: f64) -> String {
    let mut tags = pos_tag(x, y);
    let _ = write!(tags, "\\fs{}", num(metrics.ass_font_size(layout.font_px)));
    if layout.letter_spacing_px.abs() > 0.005 {
        let _ = write!(tags, "\\fsp{}", num(layout.letter_spacing_px));
    }
    let _ = write!(
        tags,
        "\\1c{}\\1a{}",
        ass_color(&layout.text_color),
        ass_alpha(1.0)
    );
    match &layout.outline {
        Some(outline) => {
            let _ = write!(
                tags,
                "\\bord{}\\3c{}\\3a{}",
                num(outline.width_px),
                ass_color(&outline.color),
                ass_alpha(outline.opacity)
            );
        }
        None => tags.push_str("\\bord0"),
    }
    tags.push_str("\\shad0\\blur0");
    tags
}

/// Fade/scale tags for one event. `fade_in`/`fade_out` are the durations (0
/// when the page flag or the look disables them); `scale_in` adds the
/// ease-out scale-in transform.
fn animation_tags(
    fade_in: u64,
    fade_out: u64,
    scale_in: bool,
    layout: &CaptionLayoutPlan,
) -> String {
    let mut tags = String::new();
    if fade_in > 0 || fade_out > 0 {
        let _ = write!(tags, "\\fad({fade_in},{fade_out})");
    }
    if scale_in {
        let pct = num(layout.animation.from_scale * 100.0);
        // \t accel 0.5 ≈ the ease-out curve the preview uses.
        let _ = write!(
            tags,
            "\\fscx{pct}\\fscy{pct}\\t(0,{},0.5,\\fscx100\\fscy100)",
            layout.animation.in_ms
        );
    }
    tags
}

/// Rounded-rect Bezier path in a `w × h` box, radius clamped to half the
/// smaller side. `\an5` centers the drawing's bounding box on `\pos` —
/// verified against libass to land the box exactly on the expected rect.
fn rounded_rect_path(width: f64, height: f64, radius: f64) -> String {
    let w = width.max(1.0);
    let h = height.max(1.0);
    let r = radius.clamp(0.0, w.min(h) / 2.0);
    let c = 0.5523 * r;
    format!(
        "m {r} 0 l {wrm} 0 b {wrc} 0 {w} {rc} {w} {r} l {w} {hrm} b {w} {hrc} {wrc} {h} {wrm} {h} l {r} {h} b {rc} {h} 0 {hrc} 0 {hrm} l 0 {r} b 0 {rc} {rc} 0 {r} 0",
        r = num(r),
        w = num(w),
        h = num(h),
        wrm = num(w - r),
        wrc = num(w - r + c),
        rc = num(r - c),
        hrm = num(h - r),
        hrc = num(h - r + c),
    )
}

/// Mirrors `SPACELESS_CHAR` in caption-text.ts — CJK/Kana/Thai/Khmer/Lao/
/// Myanmar script joins happen without a space.
fn is_spaceless(ch: char) -> bool {
    matches!(ch as u32,
        0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xF900..=0xFAFF | 0x0E00..=0x0E7F | 0x0E80..=0x0EFF | 0x1780..=0x17FF
        | 0x1000..=0x109F)
}

/// Rebuild a line from its word runs, matching `joinCaptionWords` — a single
/// space between words except across spaceless-script boundaries.
fn join_words(words: &[CaptionLayoutWord]) -> String {
    let mut out = String::new();
    for (index, word) in words.iter().enumerate() {
        if index > 0 {
            let prev = words[index - 1].text.chars().last();
            let next = word.text.chars().next();
            let spaceless = prev.is_some_and(is_spaceless) || next.is_some_and(is_spaceless);
            if !spaceless {
                out.push(' ');
            }
        }
        out.push_str(&word.text);
    }
    out
}

/// Word-boundary windows for a highlighted page: the union of every word's
/// start/end splits the page into intervals that each mark exactly one word
/// per line active.
fn highlight_windows(page: &CaptionLayoutPage) -> Vec<(u64, u64)> {
    let mut bounds = Vec::new();
    for line in &page.lines {
        for word in &line.words {
            bounds.push(word.start_ms);
            bounds.push(word.end_ms);
        }
    }
    bounds.sort_unstable();
    bounds.dedup();
    let mut windows = Vec::new();
    for pair in bounds.windows(2) {
        let (start, end) = (pair[0].max(page.start_ms), pair[1].min(page.end_ms));
        if start < end {
            windows.push((start, end));
        }
    }
    if windows.is_empty() {
        windows.push((page.start_ms, page.end_ms));
    }
    windows
}

fn word_active(word: &CaptionLayoutWord, window_start: u64) -> bool {
    word.start_ms <= window_start && window_start < word.end_ms
}

/// One text event for a highlighted window: every word is a color run, the
/// space after a word lives inside that word's run.
fn highlight_line_text(
    words: &[CaptionLayoutWord],
    window_start: u64,
    layout: &CaptionLayoutPlan,
) -> String {
    let mut out = String::new();
    for (index, word) in words.iter().enumerate() {
        let active = word_active(word, window_start);
        if active {
            let _ = write!(
                out,
                "{{\\1c{}\\1a{}}}",
                ass_color(match &layout.highlight {
                    Some(h) => &h.active_color,
                    None => &layout.text_color,
                }),
                ass_alpha(1.0),
            );
        } else {
            let inactive = layout
                .highlight
                .as_ref()
                .map(|h| h.inactive_opacity)
                .unwrap_or(1.0);
            let _ = write!(
                out,
                "{{\\1c{}\\1a{}}}",
                ass_color(&layout.text_color),
                ass_alpha(inactive),
            );
        }
        out.push_str(&escape_ass_text(&word.text));
        if index + 1 < words.len() {
            let next = &words[index + 1];
            let spaceless = word.text.chars().last().is_some_and(is_spaceless)
                || next.text.chars().next().is_some_and(is_spaceless);
            if !spaceless {
                out.push(' ');
            }
        }
    }
    out
}

struct EventContext<'a> {
    layout: &'a CaptionLayoutPlan,
    metrics: &'a FontMetrics,
    style: &'static str,
    fade_in: u64,
    fade_out: u64,
    scale_in: bool,
    // Text-block centre in PlayRes px — the \org anchor for scale-in text
    // events so multi-line pages scale about the block like the chip does.
    block_center: (f64, f64),
}

struct TextEvent<'a> {
    start_ms: u64,
    end_ms: u64,
    x: f64,
    y: f64,
    text: &'a str,
    first: bool,
    last: bool,
}

fn emit_text_event(script: &mut String, ctx: &EventContext<'_>, event: &TextEvent<'_>) {
    let fade_in = if event.first { ctx.fade_in } else { 0 };
    let fade_out = if event.last { ctx.fade_out } else { 0 };
    let scale = event.first && ctx.scale_in;
    // \org anchors the scale-in transform at the block centre — without it
    // each line would scale about its own \pos and diverge from the chip,
    // which scales about block centre by construction.
    let org = if scale {
        format!(
            "\\org({},{})",
            num(ctx.block_center.0),
            num(ctx.block_center.1)
        )
    } else {
        String::new()
    };
    let _ = writeln!(
        script,
        "Dialogue: 2,{},{},{},,0,0,0,,{{{}{}{}}}{}",
        format_ass_time_cs(event.start_ms),
        format_ass_time_cs(event.end_ms),
        ctx.style,
        text_tags(ctx.layout, ctx.metrics, event.x, event.y),
        animation_tags(fade_in, fade_out, scale, ctx.layout),
        org,
        event.text,
    );
}

struct DrawingEvent<'a> {
    layer: u8,
    start_ms: u64,
    end_ms: u64,
    x: f64,
    y: f64,
    color: &'a str,
    opacity: f64,
    blur_px: f64,
    path: &'a str,
}

fn emit_chip_like(script: &mut String, ctx: &EventContext<'_>, event: &DrawingEvent<'_>) {
    let _ = writeln!(
        script,
        "Dialogue: {},{},{},{},,0,0,0,,{{{}{}\\bord0\\shad0\\1c{}\\1a{}{}\\p1}}{}{{\\p0}}",
        event.layer,
        format_ass_time_cs(event.start_ms),
        format_ass_time_cs(event.end_ms),
        ctx.style,
        pos_tag(event.x, event.y),
        animation_tags(ctx.fade_in, ctx.fade_out, ctx.scale_in, ctx.layout),
        ass_color(event.color),
        ass_alpha(event.opacity),
        blur_tag(event.blur_px),
        event.path,
    );
}

fn emit_caption(script: &mut String, caption: &RenderPlanCaption) {
    let Some(layout) = caption.layout.as_ref() else {
        return; // all-or-nothing is enforced by the caller
    };
    let metrics = metrics_for(layout.font_weight);
    let style = match layout.font_weight {
        700 => "rf-w700",
        800 => "rf-w800",
        _ => "rf-w600",
    };

    let mut pages: Vec<&CaptionLayoutPage> = layout.pages.iter().collect();
    pages.sort_by_key(|page| page.start_ms);

    for page in pages {
        // A whitespace-only cue resolves to a page with no lines — emit
        // nothing (it would otherwise draw a sliver chip with no text).
        if page.lines.is_empty() {
            continue;
        }
        let block = &page.block;
        let line_count = page.lines.len();
        let base_y = block.center_y - block.height / 2.0;
        let shift = metrics.baseline_shift_px(layout.font_px);
        let line_y: Vec<f64> = (0..line_count)
            .map(|i| base_y + (i as f64 + 0.5) * layout.line_height_px + shift)
            .collect();

        let line_text: Vec<String> = page
            .lines
            .iter()
            .map(|line| {
                if line.words.is_empty() {
                    line.text.clone()
                } else {
                    join_words(&line.words)
                }
            })
            .collect();
        let max_line_width = line_text
            .iter()
            .map(|text| {
                measure_line_px(
                    layout.font_weight,
                    text,
                    layout.font_px,
                    layout.letter_spacing_px,
                )
            })
            .fold(0.0_f64, f64::max);

        let fade_in = if page.animate_in {
            layout.animation.in_ms
        } else {
            0
        };
        let fade_out = if page.animate_out {
            layout.animation.out_ms
        } else {
            0
        };
        let scale_in = page.animate_in && layout.animation.from_scale < 1.0;
        let ctx = EventContext {
            layout,
            metrics: &metrics,
            style,
            fade_in,
            fade_out,
            scale_in,
            block_center: (block.center_x, block.center_y),
        };

        // Layer 0 — shadow. With a chip the shadow is the chip drawing
        // blurred and offset; without one each line emits a text silhouette
        // (fill + border forced to the shadow color at the shadow alpha so
        // the blur is a single uniform shape).
        if let Some(shadow) = &layout.shadow {
            if let Some(chip) = &layout.chip {
                let w = max_line_width + 2.0 * chip.pad_x_px;
                let h = block.height + 2.0 * chip.pad_y_px;
                let path = rounded_rect_path(w, h, chip.radius_px);
                emit_chip_like(
                    script,
                    &ctx,
                    &DrawingEvent {
                        layer: 0,
                        start_ms: page.start_ms,
                        end_ms: page.end_ms,
                        x: block.center_x,
                        y: block.center_y + shadow.offset_y_px,
                        color: &shadow.color,
                        opacity: shadow.opacity,
                        blur_px: shadow.blur_px,
                        path: &path,
                    },
                );
            } else {
                for (index, y) in line_y.iter().enumerate() {
                    let mut tags = pos_tag(block.center_x, y + shadow.offset_y_px);
                    let _ = write!(tags, "\\fs{}", num(metrics.ass_font_size(layout.font_px)));
                    if layout.letter_spacing_px.abs() > 0.005 {
                        let _ = write!(tags, "\\fsp{}", num(layout.letter_spacing_px));
                    }
                    let border = layout
                        .outline
                        .as_ref()
                        .map(|o| num(o.width_px))
                        .unwrap_or_else(|| "0".into());
                    let _ = write!(
                        tags,
                        "\\1c{}\\1a{}\\bord{}\\3c{}\\3a{}\\shad0{}",
                        ass_color(&shadow.color),
                        ass_alpha(shadow.opacity),
                        border,
                        ass_color(&shadow.color),
                        ass_alpha(shadow.opacity),
                        blur_tag(shadow.blur_px),
                    );
                    // Every silhouette line spans the whole page, so each
                    // carries the full fade/scale set.
                    let _ = writeln!(
                        script,
                        "Dialogue: 0,{},{},{},,0,0,0,,{{{}{}}}{}",
                        format_ass_time_cs(page.start_ms),
                        format_ass_time_cs(page.end_ms),
                        style,
                        tags,
                        animation_tags(fade_in, fade_out, scale_in, layout),
                        escape_ass_text(&line_text[index]),
                    );
                }
            }
        }

        // Layer 1 — chip drawing.
        if let Some(chip) = &layout.chip {
            let w = max_line_width + 2.0 * chip.pad_x_px;
            let h = block.height + 2.0 * chip.pad_y_px;
            let path = rounded_rect_path(w, h, chip.radius_px);
            emit_chip_like(
                script,
                &ctx,
                &DrawingEvent {
                    layer: 1,
                    start_ms: page.start_ms,
                    end_ms: page.end_ms,
                    x: block.center_x,
                    y: block.center_y,
                    color: &chip.color,
                    opacity: chip.opacity,
                    blur_px: 0.0,
                    path: &path,
                },
            );
        }

        // Layer 2 — text, one event per line per window.
        if layout.highlight.is_some() && page.lines.iter().any(|line| !line.words.is_empty()) {
            let windows = highlight_windows(page);
            let window_count = windows.len();
            for (window_index, (win_start, win_end)) in windows.iter().enumerate() {
                let first = window_index == 0;
                let last = window_index + 1 == window_count;
                for (index, line) in page.lines.iter().enumerate() {
                    let text = highlight_line_text(&line.words, *win_start, layout);
                    emit_text_event(
                        script,
                        &ctx,
                        &TextEvent {
                            start_ms: *win_start,
                            end_ms: *win_end,
                            x: block.center_x,
                            y: line_y[index],
                            text: &text,
                            first,
                            last,
                        },
                    );
                }
            }
        } else {
            for (index, text) in line_text.iter().enumerate() {
                emit_text_event(
                    script,
                    &ctx,
                    &TextEvent {
                        start_ms: page.start_ms,
                        end_ms: page.end_ms,
                        x: block.center_x,
                        y: line_y[index],
                        text: &escape_ass_text(text),
                        first: true,
                        last: true,
                    },
                );
            }
        }
    }
}

/// Fonts the plan actually uses — writes only the static weights present.
pub(super) fn required_font_files(
    captions: &[RenderPlanCaption],
) -> Vec<(&'static str, &'static [u8])> {
    let mut files: Vec<(&'static str, &'static [u8])> = Vec::new();
    for caption in captions {
        if let Some(layout) = &caption.layout {
            let file = font_file_for(layout.font_weight);
            if !files.iter().any(|(name, _)| *name == file.0) {
                files.push(file);
            }
        }
    }
    files
}

pub(super) fn build_ass_script(
    captions: &[RenderPlanCaption],
    canvas_width: u32,
    canvas_height: u32,
) -> String {
    let mut script = String::with_capacity(4_096 + captions.len() * 512);
    let _ = writeln!(
        script,
        "[Script Info]\nTitle: RecordForge captions\nScriptType: v4.00+\nPlayResX: {canvas_width}\nPlayResY: {canvas_height}\nScaledBorderAndShadow: yes\nWrapStyle: 2\nYCbCr Matrix: TV.709\n"
    );
    let _ = writeln!(
        script,
        "[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding"
    );
    // One row per static weight: named-instance resolution requires the exact
    // family names; \fs/\fsp/colors live per-event so rows stay minimal.
    for weight in [600u16, 700, 800] {
        let (family, bold) = ass_family_for(weight);
        let _ = writeln!(
            script,
            "Style: rf-w{weight},{family},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,{bold},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1"
        );
    }
    script.push_str(
        "\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n",
    );

    let mut sorted = captions.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|caption| (caption.start_ms, caption.id.as_str()));
    for caption in sorted {
        emit_caption(&mut script, caption);
    }
    script
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::captions::layout_plan::{
        CaptionLayoutAnimation, CaptionLayoutBlock, CaptionLayoutChip, CaptionLayoutHighlight,
        CaptionLayoutLine, CaptionLayoutOutline, CaptionLayoutPage, CaptionLayoutShadow,
        CaptionLayoutWord,
    };

    fn base_layout() -> CaptionLayoutPlan {
        CaptionLayoutPlan {
            look_id: "default".into(),
            font_px: 46.0,
            line_height_px: 57.5,
            font_weight: 600,
            letter_spacing_px: 0.0,
            text_color: "#FFFFFF".into(),
            chip: Some(CaptionLayoutChip {
                color: "#0B0F17".into(),
                opacity: 0.76,
                radius_px: 15.6,
                pad_x_px: 27.6,
                pad_y_px: 12.9,
            }),
            outline: None,
            shadow: Some(CaptionLayoutShadow {
                color: "#000000".into(),
                opacity: 0.3,
                blur_px: 13.8,
                offset_y_px: 4.6,
            }),
            highlight: None,
            animation: CaptionLayoutAnimation {
                in_ms: 140,
                out_ms: 100,
                from_scale: 0.96,
            },
            pages: vec![CaptionLayoutPage {
                start_ms: 1_000,
                end_ms: 4_000,
                animate_in: true,
                animate_out: true,
                lines: vec![CaptionLayoutLine {
                    text: "Welcome back".into(),
                    words: vec![],
                }],
                block: CaptionLayoutBlock {
                    center_x: 960.0,
                    center_y: 965.0,
                    height: 57.5,
                },
            }],
        }
    }

    fn caption_with(layout: CaptionLayoutPlan) -> RenderPlanCaption {
        RenderPlanCaption {
            id: "c".into(),
            text: "Welcome back".into(),
            start_ms: 1_000,
            end_ms: 4_000,
            style: "default".into(),
            placement: "bottom".into(),
            safe_area_margin: 48,
            layout: Some(layout),
        }
    }

    #[test]
    fn ass_color_swaps_to_bgr_and_alpha_inverts_opacity() {
        assert_eq!(ass_color("#FACC15"), "&H15CCFA&");
        assert_eq!(ass_alpha(1.0), "&H00&");
        assert_eq!(ass_alpha(0.0), "&HFF&");
        assert_eq!(ass_alpha(0.5), "&H80&");
    }

    #[test]
    fn rounded_rect_path_is_the_measured_bezier() {
        let path = rounded_rect_path(700.0, 84.0, 16.0);
        assert!(path.starts_with("m 16 0"));
        assert!(path.contains("b 692.84 0 700 7.16 700 16"));
        // r clamped to half the height for a thin chip.
        let thin = rounded_rect_path(700.0, 30.0, 60.0);
        assert!(thin.starts_with("m 15 0"));
    }

    #[test]
    fn font_metrics_derive_the_measured_scale_and_shift() {
        // Inter statics: upem 2048, hhea 1984/-494, OS/2 win 2269/660.
        let metrics = metrics_for(600);
        assert!((metrics.units_per_em - 2048.0).abs() < 0.5);
        assert!((metrics.hhea_ascender - 1984.0).abs() < 0.5);
        assert!((metrics.hhea_descender + 494.0).abs() < 0.5);
        assert!((metrics.win_ascender - 2269.0).abs() < 0.5);
        assert!((metrics.win_descender - 660.0).abs() < 0.5);
        for px in [30.0, 46.0, 60.0, 121.0] {
            assert!(
                (metrics.ass_font_size(px) / px - 1.4302).abs() < 0.001,
                "font_px {px}"
            );
            let shift = metrics.baseline_shift_px(px) / px;
            assert!((shift - (-0.02905)).abs() < 0.001, "font_px {px}");
        }
    }

    #[test]
    fn each_line_gets_its_own_event_at_the_css_line_center() {
        let mut layout = base_layout();
        layout.pages[0].lines.push(CaptionLayoutLine {
            text: "second line".into(),
            words: vec![],
        });
        layout.pages[0].block.height = 115.0;
        let script = build_ass_script(&[caption_with(layout)], 1_920, 1_080);
        assert!(!script.contains("\\N"), "writer must not use \\N");
        let lines: Vec<&str> = script
            .lines()
            .filter(|l| l.starts_with("Dialogue: 2"))
            .collect();
        assert_eq!(lines.len(), 2);
        // Line 0 center = 965 − 57.5 + 28.75 + shift(46) ≈ 934.91;
        // line 1 sits exactly lineHeightPx (57.5) below it.
        assert!(lines[0].contains("\\pos(960,934.91"), "{:?}", lines[0]);
        assert!(lines[1].contains("\\pos(960,992.41"), "{:?}", lines[1]);
    }

    #[test]
    fn chip_and_shadow_events_carry_drawings() {
        let script = build_ass_script(&[caption_with(base_layout())], 1_920, 1_080);
        let chip_line = script
            .lines()
            .find(|l| l.starts_with("Dialogue: 1"))
            .expect("chip event");
        assert!(chip_line.contains("\\p1"));
        assert!(chip_line.contains("m 15.6 0"));
        let shadow_line = script
            .lines()
            .find(|l| l.starts_with("Dialogue: 0"))
            .expect("shadow event");
        // blurPx 13.8 → tag ≈ 13.8 × 0.5/0.839 ≈ 8.22 (calibrated factor).
        assert!(shadow_line.contains("\\blur8.22"));
        assert!(shadow_line.contains("\\pos(960,969.6")); // centerY + offsetY
    }

    #[test]
    fn highlight_pages_split_into_word_windows() {
        let mut layout = base_layout();
        layout.chip = None;
        layout.shadow = None;
        layout.highlight = Some(CaptionLayoutHighlight {
            mode: "word".into(),
            active_color: "#FACC15".into(),
            inactive_opacity: 1.0,
        });
        let page = &mut layout.pages[0];
        page.lines[0].words = vec![
            CaptionLayoutWord {
                text: "Welcome".into(),
                start_ms: 1_000,
                end_ms: 2_500,
            },
            CaptionLayoutWord {
                text: "back".into(),
                start_ms: 2_500,
                end_ms: 4_000,
            },
        ];
        let script = build_ass_script(&[caption_with(layout)], 1_920, 1_080);
        // 2 windows × 1 line = 2 text events; windows tile the page exactly.
        let text_events: Vec<&str> = script
            .lines()
            .filter(|l| l.starts_with("Dialogue: 2"))
            .collect();
        assert_eq!(text_events.len(), 2);
        assert!(text_events[0].contains("0:00:01.00,0:00:02.50"));
        assert!(text_events[1].contains("0:00:02.50,0:00:04.00"));
        // First window: word 0 accent, word 1 plain. Second: the reverse.
        assert!(text_events[0].contains("{\\1c&H15CCFA&\\1a&H00&}Welcome"));
        assert!(text_events[0].contains("{\\1c&HFFFFFF&\\1a&H00&}back"));
        assert!(text_events[1].contains("{\\1c&HFFFFFF&\\1a&H00&}Welcome "));
        assert!(text_events[1].contains("{\\1c&H15CCFA&\\1a&H00&}back"));
    }

    #[test]
    fn focus_highlight_dims_inactive_words() {
        let mut layout = base_layout();
        layout.chip = None;
        layout.shadow = None;
        layout.highlight = Some(CaptionLayoutHighlight {
            mode: "focus".into(),
            active_color: "#FFFFFF".into(),
            inactive_opacity: 0.5,
        });
        let page = &mut layout.pages[0];
        page.lines[0].words = vec![
            CaptionLayoutWord {
                text: "A".into(),
                start_ms: 1_000,
                end_ms: 2_000,
            },
            CaptionLayoutWord {
                text: "B".into(),
                start_ms: 2_000,
                end_ms: 4_000,
            },
        ];
        let script = build_ass_script(&[caption_with(layout)], 1_920, 1_080);
        assert!(
            script.contains("\\1a&H80&"),
            "inactive words at 50% opacity"
        );
    }

    #[test]
    fn animation_tags_follow_page_flags() {
        let mut layout = base_layout();
        layout.chip = None;
        layout.shadow = None;
        let script = build_ass_script(&[caption_with(layout.clone())], 1_920, 1_080);
        assert!(script.contains("\\fad(140,100)"));
        assert!(script.contains("\\fscx96\\fscy96\\t(0,140,0.5"));

        layout.pages[0].animate_in = false;
        layout.pages[0].animate_out = false;
        let script = build_ass_script(&[caption_with(layout)], 1_920, 1_080);
        assert!(!script.contains("\\fad("));
        assert!(!script.contains("\\fscx"));
    }

    #[test]
    fn required_font_files_dedupes_and_skips_legacy() {
        let mut a = caption_with(base_layout());
        let mut b = caption_with(base_layout());
        b.layout.as_mut().expect("layout").font_weight = 800;
        let files = required_font_files(&[a.clone(), b]);
        assert_eq!(files.len(), 2);
        a.layout = None;
        assert_eq!(required_font_files(&[a]).len(), 0);
    }

    #[test]
    fn empty_pages_emit_nothing() {
        let mut layout = base_layout();
        layout.pages.insert(
            0,
            CaptionLayoutPage {
                start_ms: 0,
                end_ms: 900,
                animate_in: true,
                animate_out: false,
                lines: vec![],
                block: CaptionLayoutBlock {
                    center_x: 960.0,
                    center_y: 965.0,
                    height: 0.0,
                },
            },
        );
        let script = build_ass_script(&[caption_with(layout)], 1_920, 1_080);
        // Only the real page's events exist — no chip/shadow/text sliver for
        // the whitespace-only page.
        let events: Vec<&str> = script
            .lines()
            .filter(|l| l.starts_with("Dialogue:"))
            .collect();
        assert!(
            events.iter().all(|l| !l.contains("0:00:00.0")),
            "{events:?}"
        );
        assert_eq!(events.len(), 3); // shadow + chip + one text line
    }

    #[test]
    fn scale_in_text_events_get_org_anchor_at_block_centre() {
        let mut layout = base_layout();
        layout.chip = None;
        layout.shadow = None;
        layout.outline = Some(CaptionLayoutOutline {
            color: "#000000".into(),
            opacity: 1.0,
            width_px: 5.0,
        });
        layout.highlight = Some(CaptionLayoutHighlight {
            mode: "word".into(),
            active_color: "#FACC15".into(),
            inactive_opacity: 1.0,
        });
        layout.animation.from_scale = 0.9;
        let page = &mut layout.pages[0];
        page.lines[0].words = vec![
            CaptionLayoutWord {
                text: "Welcome".into(),
                start_ms: 1_000,
                end_ms: 2_500,
            },
            CaptionLayoutWord {
                text: "back".into(),
                start_ms: 2_500,
                end_ms: 4_000,
            },
        ];
        page.lines.push(CaptionLayoutLine {
            text: "again".into(),
            words: vec![CaptionLayoutWord {
                text: "again".into(),
                start_ms: 1_000,
                end_ms: 4_000,
            }],
        });
        let script = build_ass_script(&[caption_with(layout)], 1_920, 1_080);
        let org = "\\org(960,965)";
        // First-window text events carry \org at the block centre (both
        // lines); later windows and every other event don't.
        let first_window: Vec<&str> = script
            .lines()
            .filter(|l| l.contains("0:00:01.00,0:00:02.50"))
            .collect();
        assert_eq!(first_window.len(), 2);
        assert!(
            first_window.iter().all(|l| l.contains(org)),
            "{first_window:?}"
        );
        let later: Vec<&str> = script
            .lines()
            .filter(|l| l.contains("0:00:02.50,0:00:04.00"))
            .collect();
        assert_eq!(later.len(), 2);
        assert!(later.iter().all(|l| !l.contains("\\org(")), "{later:?}");
        // And a non-scale-in script has no \org anywhere.
        let mut still = base_layout();
        still.pages[0].animate_in = false;
        let script = build_ass_script(&[caption_with(still)], 1_920, 1_080);
        assert!(!script.contains("\\org("));
    }

    #[test]
    fn outline_events_emit_border_tags() {
        let mut layout = base_layout();
        layout.chip = None;
        layout.shadow = None;
        layout.outline = Some(CaptionLayoutOutline {
            color: "#000000".into(),
            opacity: 0.95,
            width_px: 3.5,
        });
        let script = build_ass_script(&[caption_with(layout)], 1_920, 1_080);
        assert!(script.contains("\\bord3.5\\3c&H000000&\\3a&H0D&"));
    }
}
