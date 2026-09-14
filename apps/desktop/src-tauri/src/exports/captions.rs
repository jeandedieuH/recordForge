use super::RenderPlanCaption;
use crate::capture::disk::atomic_replace;
use crate::errors::{InternalError, Result};
use std::fmt::Write;
use std::path::{Path, PathBuf};

// Burned-in captions are rendered through libass (`subtitles` filter) rather
// than one `drawtext` filter per cue: a single filter pass keeps large cue
// files fast, wraps long lines within the safe margins, and matches the editor
// preview's box/outline looks far more closely.
//
// Inter is embedded and written next to the generated .ass file so libass can
// resolve it via `fontsdir` even on systems without the font installed or
// without fontconfig (common for the pinned Linux/macOS sidecar builds).
const CAPTION_FONT_BYTES: &[u8] =
    include_bytes!("../../../../../packages/overlay-engine/fonts/inter.ttf");
const CAPTION_FONT_FILE_NAME: &str = "Inter.ttf";
const CAPTION_FONT_FAMILY: &str = "Inter";
const CAPTION_SCRIPT_FILE_NAME: &str = "captions.ass";

pub(super) fn validate_captions(captions: &[RenderPlanCaption]) -> Result<()> {
    let mut sorted = captions.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|caption| (caption.start_ms, caption.id.as_str()));
    for (index, caption) in sorted.iter().enumerate() {
        validate_caption(caption)?;
        if index > 0 && caption.start_ms < sorted[index - 1].end_ms {
            return Err(InternalError::Media(
                "caption cues overlap and cannot be rendered safely".into(),
            )
            .into());
        }
    }
    Ok(())
}

pub(super) fn validate_caption(caption: &RenderPlanCaption) -> Result<()> {
    if caption.start_ms >= caption.end_ms
        || caption.text.trim().is_empty()
        || caption.text.chars().count() > 10_000
    {
        return Err(InternalError::Media("caption has invalid timing or text".into()).into());
    }
    if !matches!(
        caption.style.as_str(),
        "default" | "minimal" | "boxed" | "highlight"
    ) {
        return Err(InternalError::Media("caption style is unsupported".into()).into());
    }
    if !matches!(caption.placement.as_str(), "top" | "center" | "bottom") {
        return Err(InternalError::Media("caption placement is unsupported".into()).into());
    }
    Ok(())
}

pub(super) fn write_sidecar(output_path: &Path, captions: &[RenderPlanCaption]) -> Result<PathBuf> {
    let sidecar_path = output_path.with_extension("srt");
    let partial_path = sidecar_path.with_extension("srt.partial");
    let mut content = String::new();
    let mut sorted = captions.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|caption| (caption.start_ms, caption.id.as_str()));

    for (index, caption) in sorted.iter().enumerate() {
        validate_caption(caption)?;
        writeln!(&mut content, "{}", index + 1)
            .map_err(|error| InternalError::Media(format!("write caption sidecar: {error}")))?;
        writeln!(
            &mut content,
            "{} --> {}",
            format_srt_time(caption.start_ms),
            format_srt_time(caption.end_ms)
        )
        .map_err(|error| InternalError::Media(format!("write caption sidecar: {error}")))?;
        writeln!(&mut content, "{}\n", caption.text)
            .map_err(|error| InternalError::Media(format!("write caption sidecar: {error}")))?;
    }

    std::fs::write(&partial_path, content)
        .map_err(|error| InternalError::Storage(format!("write caption sidecar: {error}")))?;
    atomic_replace(&partial_path, &sidecar_path)?;
    Ok(sidecar_path)
}

fn format_srt_time(milliseconds: u64) -> String {
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let millis = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

/// Writes `captions.ass` plus the embedded caption font into `dir` (which the
/// caller creates and cleans up) and returns the script path for `subtitles=`.
pub(super) fn write_burn_in_assets(
    dir: &Path,
    captions: &[RenderPlanCaption],
    canvas_width: u32,
    canvas_height: u32,
) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|error| InternalError::Storage(format!("create caption dir: {error}")))?;
    std::fs::write(dir.join(CAPTION_FONT_FILE_NAME), CAPTION_FONT_BYTES)
        .map_err(|error| InternalError::Storage(format!("write caption font: {error}")))?;

    let script_path = dir.join(CAPTION_SCRIPT_FILE_NAME);
    let script = build_ass_script(captions, canvas_width, canvas_height);
    std::fs::write(&script_path, script)
        .map_err(|error| InternalError::Storage(format!("write caption script: {error}")))?;
    Ok(script_path)
}

/// `[in]subtitles=…[out]` — one libass pass for every cue. `fontsdir` points at
/// the directory that also holds the .ass file, where Inter was written.
pub(super) fn subtitles_filter(
    input_label: &str,
    output_label: &str,
    script_path: &Path,
) -> String {
    let fonts_dir = script_path.parent().unwrap_or_else(|| Path::new("."));
    format!(
        "[{input_label}]subtitles=filename='{}':fontsdir='{}'[{output_label}]",
        escape_filter_path(script_path),
        escape_filter_path(fonts_dir),
    )
}

/// Escapes a filesystem path for use inside a quoted value of a
/// `-/filter_complex` script entry. The script file and the option parser each
/// run one unescape pass, so separators need double backslashes (`\\:`).
fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "\\\\'")
        .replace(':', "\\\\:")
}

fn build_ass_script(
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
        "[Script Info]\nTitle: recordForge captions\nScriptType: v4.00+\nPlayResX: {canvas_width}\nPlayResY: {canvas_height}\nScaledBorderAndShadow: yes\nWrapStyle: 0\nYCbCr Matrix: TV.709\n"
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
            caption.style,
            escape_ass_text(&caption.text),
        );
    }
    script
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
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let centiseconds = (milliseconds % 1_000) / 10;
    format!("{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}")
}

/// libass treats `{…}` as override-tag blocks and `\N`/`\h` as control
/// sequences, so braces are swapped for fullwidth lookalikes and backslashes
/// are escaped before newlines become hard breaks.
fn escape_ass_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\\N")
        .replace('{', "\u{FF5B}")
        .replace('}', "\u{FF5D}")
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

    #[test]
    fn filter_path_escapes_drive_colon() {
        // The -/filter_complex script and the option parser each strip one
        // escape level, so a literal colon needs a double backslash.
        let escaped = escape_filter_path(Path::new("C:\\Users\\rf\\captions.ass"));
        assert_eq!(escaped, "C\\\\:/Users/rf/captions.ass");
    }

    #[test]
    fn rejects_unknown_caption_styles() {
        let mut value = caption();
        value.style = "unknown".into();
        assert!(validate_caption(&value).is_err());
    }
}
