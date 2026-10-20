//! Lead-authored delivery measurements. Copy into exports/delivery_metadata.rs
//! without changing the measurement rules; callers own job/path authorization.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, ErrorCategory, Result};

use super::RenderPlan;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryChapter {
    pub t: u64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactInfo {
    pub version: u32,
    pub export_job_id: String,
    pub title: String,
    pub file_name: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bytes: u64,
    /// A size/mtime concurrency stamp, not a content hash or authorization token.
    pub file_version: String,
    pub captions_version: Option<String>,
    pub chapters: Vec<DeliveryChapter>,
    /// Old jobs can only be verified from their present file, not retroactively.
    pub legacy: bool,
}

pub struct CaptureArtifactInput<'a> {
    pub export_job_id: &'a str,
    pub project_name: &'a str,
    pub output_path: &'a Path,
    pub captions_path: Option<&'a Path>,
    pub ffprobe_path: &'a Path,
    pub plan: &'a RenderPlan,
    pub legacy: bool,
}

fn measurement_error(message: &str) -> AppError {
    AppError::new(ErrorCategory::Media, "export_artifact_unavailable", message)
}

/// Call only after the caller resolves/authorizes a completed artifact path.
pub fn file_version(path: &Path) -> Result<String> {
    let stat = path.metadata().map_err(|_| {
        measurement_error("The exported file is unavailable. Restore or re-export it.")
    })?;
    if !stat.is_file() {
        return Err(measurement_error(
            "The exported artifact is not a regular file.",
        ));
    }
    let modified = stat
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .ok_or_else(|| measurement_error("The exported file version could not be verified."))?;
    Ok(format!(
        "1:{}:{}:{}",
        stat.len(),
        modified.as_secs(),
        modified.subsec_nanos()
    ))
}

#[derive(Deserialize)]
struct ChapterProbe {
    #[serde(default)]
    chapters: Vec<ProbedChapter>,
}

#[derive(Deserialize)]
struct ProbedChapter {
    start_time: String,
    #[serde(default)]
    tags: HashMap<String, String>,
}

fn parse_chapters(raw: &[u8], duration_ms: u64) -> Result<Vec<DeliveryChapter>> {
    let probe: ChapterProbe = serde_json::from_slice(raw)
        .map_err(|_| measurement_error("The exported chapter metadata could not be read."))?;
    if probe.chapters.len() > 1024 {
        return Err(measurement_error(
            "Publishing supports at most 1024 chapter entries.",
        ));
    }
    let mut chapters = Vec::with_capacity(probe.chapters.len());
    for chapter in probe.chapters {
        let seconds: f64 = chapter
            .start_time
            .parse()
            .map_err(|_| measurement_error("The exported chapter clock is invalid."))?;
        if !seconds.is_finite() || seconds < 0.0 || seconds * 1000.0 > duration_ms as f64 + 250.0 {
            return Err(measurement_error("The exported chapter clock is invalid."));
        }
        let label = chapter
            .tags
            .get("title")
            .or_else(|| chapter.tags.get("TITLE"))
            .filter(|title| !title.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| "Chapter".to_string());
        chapters.push(DeliveryChapter {
            t: (seconds * 1000.0).round() as u64,
            label,
        });
    }
    chapters.sort_by_key(|chapter| chapter.t);
    Ok(chapters)
}

fn embedded_chapters(
    ffprobe: &Path,
    output: &Path,
    duration_ms: u64,
) -> Result<Vec<DeliveryChapter>> {
    let probe = crate::process::create_command(ffprobe)
        .args([
            "-v",
            "error",
            "-show_chapters",
            "-show_entries",
            "chapter=start_time:chapter_tags=title",
            "-of",
            "json",
        ])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| measurement_error("The exported chapter metadata could not be inspected."))?;
    if !probe.status.success() || probe.stdout.len() > 2 * 1024 * 1024 {
        return Err(measurement_error(
            "The exported chapter metadata could not be inspected.",
        ));
    }
    parse_chapters(&probe.stdout, duration_ms)
}

/// Measure the finished MP4 once; never reconstruct delivery facts from live UI.
pub fn capture_export_artifact(input: CaptureArtifactInput<'_>) -> Result<ExportArtifactInfo> {
    let before = file_version(input.output_path)?;
    let probed = crate::media::probe::probe_media(
        &input.ffprobe_path.to_string_lossy(),
        input.output_path,
        input.export_job_id,
    )
    .map_err(|_| {
        measurement_error("The exported video could not be inspected. Try re-exporting it.")
    })?;
    let width = probed
        .width
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| measurement_error("The exported video width is unavailable."))?;
    let height = probed
        .height
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| measurement_error("The exported video height is unavailable."))?;
    let fps = probed
        .fps
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| measurement_error("The exported video frame rate is unavailable."))?;
    if probed.duration_ms == 0 {
        return Err(measurement_error(
            "The exported video duration is unavailable.",
        ));
    }
    let chapters = match input.plan.chapter_mode.as_str() {
        "embed" | "both" => {
            embedded_chapters(input.ffprobe_path, input.output_path, probed.duration_ms)?
        }
        "sidecar" => input
            .plan
            .chapters
            .iter()
            .map(|chapter| DeliveryChapter {
                t: chapter.start_ms,
                label: chapter.title.clone(),
            })
            .collect(),
        "none" => Vec::new(),
        _ => return Err(measurement_error("The exported chapter mode is invalid.")),
    };
    let caption_path = input
        .captions_path
        .filter(|_| input.plan.caption_mode == "sidecar" && !input.plan.captions.is_empty());
    let captions_version = caption_path.map(file_version).transpose()?;
    let stat = input
        .output_path
        .metadata()
        .map_err(|_| measurement_error("The exported file is unavailable."))?;
    if before != file_version(input.output_path)? || stat.len() == 0 {
        return Err(AppError::new(
            ErrorCategory::Media,
            "export_file_changed",
            "The exported file changed while it was being inspected. Inspect it again or re-export.",
        ));
    }
    Ok(ExportArtifactInfo {
        version: 1,
        export_job_id: input.export_job_id.to_string(),
        title: input.project_name.chars().take(200).collect(),
        file_name: input
            .output_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "export.mp4".to_string()),
        duration_ms: probed.duration_ms,
        width,
        height,
        fps,
        bytes: stat.len(),
        file_version: before,
        captions_version,
        chapters,
        legacy: input.legacy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_chapter_clock_is_measured_in_milliseconds() {
        let chapters = parse_chapters(
            br#"{"chapters":[{"start_time":"1.500","tags":{"title":"First"}},{"start_time":"3","tags":{"title":"Next"}}]}"#,
            6_000,
        ).expect("valid chapters");
        assert_eq!(
            chapters.iter().map(|chapter| chapter.t).collect::<Vec<_>>(),
            [1500, 3000]
        );
        assert_eq!(chapters[0].label, "First");
    }

    #[test]
    fn delivery_chapters_reject_invalid_clocks_instead_of_guessing() {
        for value in ["NaN", "inf", "-1", "50"] {
            let json = format!(r#"{{"chapters":[{{"start_time":"{value}","tags":{{}}}}]}}"#);
            assert!(parse_chapters(json.as_bytes(), 6_000).is_err());
        }
        assert!(parse_chapters(br#"{"chapters":[]}"#, 6_000)
            .expect("empty")
            .is_empty());
    }
}
