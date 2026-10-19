mod ass_layout;
mod layout_plan;
mod legacy;
mod measure;
#[cfg(test)]
mod render_tests;

pub(crate) use layout_plan::CaptionLayoutPlan;

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
// Two writers live here: the legacy per-cue style-table writer (`legacy`) and
// the px-resolved writer (`ass_layout`) that consumes the editor-core layout
// so burn-in matches the preview. The layout writer is selected only when
// EVERY caption carries a layout — resumed jobs from older versions stay on
// the legacy path.
//
// Inter is embedded and written next to the generated .ass file so libass can
// resolve it via `fontsdir` even on systems without the font installed or
// without fontconfig (common for the pinned Linux/macOS sidecar builds).
const CAPTION_FONT_FILE_NAME: &str = "Inter.ttf";
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
        "default" | "minimal" | "boxed" | "highlight" | "pop" | "focus"
    ) {
        return Err(InternalError::Media("caption style is unsupported".into()).into());
    }
    if !matches!(caption.placement.as_str(), "top" | "center" | "bottom") {
        return Err(InternalError::Media("caption placement is unsupported".into()).into());
    }
    if let Some(layout) = &caption.layout {
        layout_plan::validate_layout(caption, layout)?;
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

/// Convert a finished SRT sidecar into a WebVTT companion. Processed
/// previews show captions through a browser `<track>`, which needs VTT —
/// the source is the already-published (already intro-shifted) SRT.
pub(super) fn write_vtt_companion(srt_path: &Path) -> Result<PathBuf> {
    let srt = std::fs::read_to_string(srt_path)
        .map_err(|error| InternalError::Storage(format!("read caption sidecar: {error}")))?;
    let vtt_path = srt_path.with_extension("vtt");
    std::fs::write(&vtt_path, srt_to_vtt(&srt))
        .map_err(|error| InternalError::Storage(format!("write vtt companion: {error}")))?;
    Ok(vtt_path)
}

/// SRT → WebVTT: identical cues, `,`→`.` decimal in the timestamp line only,
/// and cue TEXT escaped for `&`, `<`, `>` — a literal `<div>` in a caption
/// would otherwise be parsed as markup by the browser's VTT cue renderer.
/// Timestamp lines keep their literal ` --> ` arrow untouched. Shared by the
/// preview companion and the publishing paths — the share/YouTube code must
/// not keep its own unsafe copy.
pub(crate) fn srt_to_vtt(srt: &str) -> String {
    let mut vtt = String::with_capacity(srt.len() + 8);
    vtt.push_str("WEBVTT\n\n");
    for line in srt.lines() {
        if is_srt_timestamp_line(line) {
            vtt.push_str(&line.replace(',', "."));
        } else {
            // `&` first so produced entities aren't double-escaped.
            vtt.push_str(
                &line
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;"),
            );
        }
        vtt.push('\n');
    }
    vtt
}

/// A timestamp line is `HH:MM:SS,mmm --> HH:MM:SS,mmm` — caption text that
/// merely contains " --> " never matches (no comma-separated decimals).
fn is_srt_timestamp_line(line: &str) -> bool {
    let Some((start, end)) = line.split_once(" --> ") else {
        return false;
    };
    let end = end.trim_start();
    start.len() == 12
        && start.contains(',')
        && end.len() >= 12
        && end.chars().next().is_some_and(|c| c.is_ascii_digit())
        && end.contains(',')
}

#[cfg(test)]
mod vtt_tests {
    use super::*;

    #[test]
    fn srt_to_vtt_converts_timestamps_and_keeps_text() {
        let vtt = srt_to_vtt("1\n00:00:01,000 --> 00:00:03,500\nHello, world --> indeed\n\n");
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:01.000 --> 00:00:03.500"));
        // Commas inside caption text stay untouched; the arrow in TEXT is
        // escaped so the browser can't misparse it as a timestamp.
        assert!(vtt.contains("Hello, world --&gt; indeed"));
    }

    #[test]
    fn srt_to_vtt_escapes_markup_in_cue_text() {
        let vtt = srt_to_vtt("1\n00:00:01,000 --> 00:00:03,500\nUse <div> & <span>\n\n");
        assert!(vtt.contains("Use &lt;div&gt; &amp; &lt;span&gt;"));
        assert!(!vtt.contains("<div>"));
        // Timestamps and real newlines are preserved verbatim.
        assert!(vtt.contains("00:00:01.000 --> 00:00:03.500\n"));
    }
}

/// Writes `captions.ass` plus the fonts the chosen writer needs into `dir`
/// (which the caller creates and cleans up) and returns the script path.
/// The px-resolved writer runs when every caption carries a layout; otherwise
/// the legacy style-table writer renders the whole cue set.
pub(super) fn write_burn_in_assets(
    dir: &Path,
    captions: &[RenderPlanCaption],
    canvas_width: u32,
    canvas_height: u32,
) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|error| InternalError::Storage(format!("create caption dir: {error}")))?;

    let use_layout_writer =
        !captions.is_empty() && captions.iter().all(|caption| caption.layout.is_some());
    let (script, fonts): (String, Vec<(&'static str, &'static [u8])>) = if use_layout_writer {
        (
            ass_layout::build_ass_script(captions, canvas_width, canvas_height),
            ass_layout::required_font_files(captions),
        )
    } else {
        (
            legacy::build_ass_script(captions, canvas_width, canvas_height),
            vec![(CAPTION_FONT_FILE_NAME, legacy::CAPTION_FONT_BYTES)],
        )
    };
    for (name, bytes) in fonts {
        std::fs::write(dir.join(name), bytes)
            .map_err(|error| InternalError::Storage(format!("write caption font: {error}")))?;
    }

    let script_path = dir.join(CAPTION_SCRIPT_FILE_NAME);
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

/// Escapes a filesystem path for use inside a single-quoted option value of a
/// `-/filter_complex` script entry. The option parser runs one unescape pass
/// on the quoted value, so a `:` separator needs a single backslash (`\:`) and
/// an embedded quote needs `\'`. A doubled backslash there de-escapes to a
/// bare `\` before a real separator and the value splits mid-path.
pub(crate) fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "\\'")
        .replace(':', "\\:")
}

/// libass treats `{…}` as override-tag blocks and `\N`/`\h` as control
/// sequences, so braces are swapped for fullwidth lookalikes and backslashes
/// are escaped before newlines become hard breaks.
pub(super) fn escape_ass_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\\N")
        .replace('{', "\u{FF5B}")
        .replace('}', "\u{FF5D}")
}

/// Milliseconds → `h:mm:ss.cc`, rounded to the nearest centisecond (the
/// layout writer's page/word windows carry integer ms that must not
/// systematically lag).
fn format_ass_time_cs(milliseconds: u64) -> String {
    let total_cs = (milliseconds as f64 / 10.0).round() as u64;
    let hours = total_cs / 360_000;
    let minutes = (total_cs / 6_000) % 60;
    let seconds = (total_cs / 100) % 60;
    let centiseconds = total_cs % 100;
    format!("{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}")
}
