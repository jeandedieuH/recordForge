use super::escape_ass_text;
use crate::exports::RenderPlanCaption;
use std::fmt::Write;

// Legacy per-cue writer: one ASS style row per caption preset with libass
// auto-wrap (`WrapStyle 0`). Kept for plans without px-resolved layouts —
// resumed jobs from versions before the layout engine existed.

pub(super) const CAPTION_FONT_BYTES: &[u8] =
    include_bytes!("../../../../../../packages/overlay-engine/fonts/inter.ttf");
const CAPTION_FONT_FAMILY: &str = "Inter";

pub(super) fn build_ass_script(
    captions: &[RenderPlanCaption],
    canvas_width: u32,
    canvas_height: u32,
) -> String {
    // Font size and margins are expressed in PlayRes pixels so the output
    // scales with the canvas like the preview's canvas-relative sizing.
    let font_size = ((canvas_height as f64) * 0.038).round().clamp(16.0, 120.0) as u64;
    let margin_x = ((canvas_width as f64) * 0.06).round() as u64;

    let mut script = String::with_capacity(2_048 + captions.len() * 160);
    let _ = writeln!(
        script,
        "[Script Info]\nTitle: RecordForge captions\nScriptType: v4.00+\nPlayResX: {canvas_width}\nPlayResY: {canvas_height}\nScaledBorderAndShadow: yes\nWrapStyle: 0\nYCbCr Matrix: TV.709\n"
    );
    let _ = writeln!(
        script,
        "[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding"
    );
    for style in caption_styles(font_size, margin_x) {
        let _ = writeln!(script, "Style: {style}");
    }
    script.push_str(
        "\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n",
    );

    let mut sorted = captions.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|caption| (caption.start_ms, caption.id.as_str()));
    for caption in sorted {
        let margin_v = caption
            .safe_area_margin
            .min((canvas_height as u64 / 3).max(1));
        // \an8 = top, \an5 = centered; bottom (2) is each style's default.
        let alignment = match caption.placement.as_str() {
            "top" => "{\\an8}",
            "center" => "{\\an5}",
            _ => "",
        };
        let _ = writeln!(
            script,
            "Dialogue: 0,{},{},rf-{},,0,0,{margin_v},,{alignment}{}",
            format_ass_time(caption.start_ms),
            format_ass_time(caption.end_ms),
            ass_style_name(&caption.style),
            escape_ass_text(&caption.text),
        );
    }
    script
}

/// Legacy-path style mapping: the newer preset ids render through the
/// closest existing ASS style row — `pop` ≈ outlined minimal, `focus` ≈ the
/// soft-chip default.
fn ass_style_name(style: &str) -> &str {
    match style {
        "pop" => "minimal",
        "focus" => "default",
        other => other,
    }
}

/// ASS `V4+ Styles` rows matching the editor preview presets. With
/// BorderStyle=3 (box per line) libass paints the box in OutlineColour and
/// `Outline` becomes the padding in PlayRes pixels; BorderStyle=1 is the
/// classic text outline + drop shadow.
fn caption_styles(font_size: u64, margin_x: u64) -> [String; 4] {
    let row = |name: &str,
               primary: &str,
               outline: &str,
               border_style: u8,
               outline_size: u64,
               shadow: u64| {
        format!(
            "{name},{CAPTION_FONT_FAMILY},{font_size},{primary},{primary},{outline},&H80000000,-1,0,0,0,100,100,0,0,{border_style},{outline_size},{shadow},2,{margin_x},{margin_x},48,1"
        )
    };
    [
        // black box at ~62% opacity
        row("rf-default", "&H00FFFFFF", "&H61000000", 3, 8, 0),
        // soft dark text outline, no box
        row("rf-minimal", "&H00FFFFFF", "&H99000000", 1, 2, 1),
        // black box at ~72% opacity
        row("rf-boxed", "&H00FFFFFF", "&H47000000", 3, 12, 0),
        // black text on amber #F59E0B at ~90% opacity
        row("rf-highlight", "&H00000000", "&H190B9EF5", 3, 10, 0),
    ]
}

fn format_ass_time(milliseconds: u64) -> String {
    // Kept as truncation for stability: this writer's historical output.
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let centiseconds = (milliseconds % 1_000) / 10;
    format!("{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caption() -> RenderPlanCaption {
        RenderPlanCaption {
            id: "caption-1".into(),
            text: "Private: 100%".into(),
            start_ms: 1_000,
            end_ms: 2_500,
            style: "boxed".into(),
            placement: "bottom".into(),
            safe_area_margin: 48,
            layout: None,
        }
    }

    #[test]
    fn ass_script_emits_one_dialogue_per_cue() {
        let script = build_ass_script(&[caption()], 1_920, 1_080);
        assert!(script.contains("PlayResX: 1920"));
        assert!(script.contains("rf-boxed"));
        assert!(script.contains("Dialogue: 0,0:00:01.00,0:00:02.50,rf-boxed"));
        assert!(script.contains("Private: 100%"));
    }

    #[test]
    fn ass_script_overrides_alignment_for_placement() {
        let mut top = caption();
        top.placement = "top".into();
        let script = build_ass_script(&[top], 1_920, 1_080);
        assert!(script.contains("{\\an8}"));
    }

    #[test]
    fn ass_text_neutralizes_override_braces_and_breaks_lines() {
        let mut value = caption();
        value.text = "line one\nline {two}".into();
        let script = build_ass_script(&[value], 1_920, 1_080);
        assert!(script.contains("line one\\Nline \u{FF5B}two\u{FF5D}"));
        assert!(!script.contains("{two}"));
    }
}
