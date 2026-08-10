use super::RenderPlanCaption;
use crate::capture::disk::atomic_replace;
use crate::errors::{InternalError, Result};
use std::fmt::Write;
use std::path::{Path, PathBuf};

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

pub(super) fn drawtext_filter(
    caption: &RenderPlanCaption,
    input_label: &str,
    output_label: &str,
    canvas_height: u32,
) -> Result<String> {
    validate_caption(caption)?;
    let (font_color, box_enabled, box_color, border_width) = match caption.style.as_str() {
        "minimal" => ("white", "0", "black@0", "0"),
        "boxed" => ("white", "1", "black@0.72", "12"),
        "highlight" => ("yellow", "1", "black@0.55", "10"),
        _ => ("white", "1", "black@0.62", "8"),
    };
    let margin = caption
        .safe_area_margin
        .min((canvas_height as u64 / 3).max(1));
    let (y_expression, margin) = match caption.placement.as_str() {
        "top" => (format!("{margin}"), margin),
        "center" => ("(h-text_h)/2".to_string(), margin),
        _ => (format!("h-text_h-{margin}"), margin),
    };
    let text = escape_filter_text(&caption.text);
    let font_size = 32_u64.saturating_add(margin / 8).clamp(24, 72);
    Ok(format!(
        "[{input_label}]drawtext=font='Arial':text='{text}':expansion=none:fontcolor={font_color}:fontsize={font_size}:x=(w-text_w)/2:y={y_expression}:box={box_enabled}:boxcolor={box_color}:boxborderw={border_width}:enable='between(t,{start},{end})'[{output_label}]",
        start = caption.start_ms as f64 / 1000.0,
        end = caption.end_ms as f64 / 1000.0,
    ))
}

fn escape_filter_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace(',', "\\,")
        .replace('\'', "\\'")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('\n', "\\n")
        .replace('\r', "")
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
    fn drawtext_filter_does_not_expand_caption_text() {
        let filter = drawtext_filter(&caption(), "input", "output", 1_080).expect("valid caption");
        assert!(filter.contains("expansion=none"));
        assert!(filter.contains("Private"));
        assert!(filter.contains("between(t,1,2.5)"));
    }

    #[test]
    fn rejects_unknown_caption_styles() {
        let mut value = caption();
        value.style = "unknown".into();
        assert!(drawtext_filter(&value, "input", "output", 1_080).is_err());
    }
}
