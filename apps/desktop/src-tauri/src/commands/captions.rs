use crate::errors::{InternalError, Result};
use std::path::Path;

/// Upper bound for a caption file — matches the frontend parser's limit.
const MAX_CAPTION_FILE_BYTES: u64 = 2_000_000;

/// Reads a user-supplied `.srt`/`.vtt` file for the caption import drop zone.
///
/// This command exists because Tauri drag-drop delivers filesystem paths, not
/// `File` handles; keeping the read in Rust avoids widening the webview's fs
/// permissions. The file is never written or executed — extension and size are
/// validated before its text is returned for the frontend parser.
#[tauri::command]
pub async fn read_caption_source(path: String) -> Result<String> {
    read_caption_source_inner(Path::new(&path))
}

fn read_caption_source_inner(path: &Path) -> Result<String> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    if !matches!(extension.as_deref(), Some("srt") | Some("vtt")) {
        return Err(InternalError::Media("choose an SRT or VTT caption file".into()).into());
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| InternalError::Storage(format!("read caption file: {error}")))?;
    if !metadata.is_file() || metadata.len() > MAX_CAPTION_FILE_BYTES {
        return Err(InternalError::Media("caption file is too large".into()).into());
    }
    std::fs::read_to_string(path)
        .map_err(|error| InternalError::Storage(format!("read caption file: {error}")).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_caption_extensions() {
        assert!(read_caption_source_inner(Path::new("notes.txt")).is_err());
    }

    #[test]
    fn rejects_missing_files() {
        assert!(read_caption_source_inner(Path::new("missing.srt")).is_err());
    }
}
