use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::errors::{InternalError, Result};

use super::svg::is_svg_path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivativeRecipe {
    pub kind: &'static str,
    pub outputs: &'static [&'static str],
}

pub fn recipe_for_kind(kind: &str) -> Option<DerivativeRecipe> {
    match kind {
        "audio" => Some(DerivativeRecipe {
            kind: "audio",
            outputs: &["audioPreview", "waveform", "waveformImage"],
        }),
        "image" => Some(DerivativeRecipe {
            kind: "image",
            outputs: &["thumbnail"],
        }),
        "video" => Some(DerivativeRecipe {
            kind: "video",
            outputs: &["proxy", "thumbnail", "thumbnailManifest"],
        }),
        _ => None,
    }
}

/// Generate an image thumbnail with FFmpeg. SVG sources are already directly
/// displayable and are retained as the thumbnail source after validation.
pub fn generate_image_thumbnail(
    ffmpeg_path: &str,
    input: &Path,
    output: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    if cancel.load(Ordering::Relaxed) {
        return Err(InternalError::Media("asset derivative cancelled".into()).into());
    }
    if is_svg_path(input) {
        return Ok(input.to_path_buf());
    }
    if !input.is_file() {
        return Err(InternalError::Media("image source does not exist".into()).into());
    }

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InternalError::Storage(format!("create image thumbnail dir: {error}"))
        })?;
    }

    let result = Command::new(ffmpeg_path)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .args([
            "-vf",
            "scale=320:320:force_original_aspect_ratio=decrease",
            "-frames:v",
            "1",
            "-f",
            "image2",
        ])
        .arg(output)
        .output()
        .map_err(|error| InternalError::Media(format!("image thumbnail run: {error}")))?;

    if cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(output);
        return Err(InternalError::Media("asset derivative cancelled".into()).into());
    }
    if !result.status.success() || !output.is_file() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let _ = std::fs::remove_file(output);
        return Err(InternalError::Media(format!("image thumbnail failed: {stderr}")).into());
    }

    Ok(output.to_path_buf())
}

pub fn copy_audio_preview(input: &Path, output: &Path) -> Result<PathBuf> {
    if !input.is_file() {
        return Err(InternalError::Media("audio source does not exist".into()).into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InternalError::Storage(format!("create audio preview dir: {error}"))
        })?;
    }
    std::fs::copy(input, output)
        .map_err(|error| InternalError::Storage(format!("copy audio preview: {error}")))?;
    Ok(output.to_path_buf())
}

pub fn normalize_derivative_paths(
    project_dir: &Path,
    paths: impl IntoIterator<Item = (String, PathBuf)>,
) -> HashMap<String, String> {
    paths
        .into_iter()
        .map(|(kind, path)| {
            let value = crate::projects::make_project_relative(project_dir, &path);
            (kind, value.replace('\\', "/"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_recipes_for_supported_asset_kinds() {
        assert_eq!(
            recipe_for_kind("audio").unwrap().outputs,
            ["audioPreview", "waveform", "waveformImage"]
        );
        assert_eq!(recipe_for_kind("image").unwrap().outputs, ["thumbnail"]);
        assert_eq!(
            recipe_for_kind("video").unwrap().outputs,
            ["proxy", "thumbnail", "thumbnailManifest"]
        );
        assert!(recipe_for_kind("caption").is_none());
    }

    #[test]
    fn normalizes_paths_relative_to_the_project() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let output = project.join("derivatives").join("asset").join("thumb.png");
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        std::fs::write(&output, b"thumbnail").unwrap();

        let paths = normalize_derivative_paths(&project, [("thumbnail".into(), output)]);
        assert_eq!(
            paths.get("thumbnail"),
            Some(&"derivatives/asset/thumb.png".to_string())
        );
    }
}
