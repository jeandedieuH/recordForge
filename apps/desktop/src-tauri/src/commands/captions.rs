use crate::errors::{InternalError, Result};
use std::path::Path;
use tauri::State;

use crate::state::AppState;
use crate::whisper;

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

/// AI Captions engine readiness (binary + model presence).
#[tauri::command]
pub fn get_ai_captions_status(state: State<'_, AppState>) -> Result<whisper::WhisperStatus> {
    Ok(whisper::status(state.path_policy.app_data_dir()))
}

/// Download the whisper.cpp engine binary (once) plus the chosen model into
/// the app-data whisper dir. Emits `ai-captions-setup` progress events.
#[tauri::command]
pub async fn download_ai_captions_engine(
    model: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    if !state.license.entitlements().pro_enabled {
        return Err(ai_captions_pro_required());
    }
    let dir = state.path_policy.app_data_dir().to_path_buf();
    whisper::download_engine(&dir, &app, &model).await
}

/// Delete a previously downloaded whisper model (models can be 1.5 GB+).
#[tauri::command]
pub async fn delete_ai_captions_model(model: String, state: State<'_, AppState>) -> Result<()> {
    if !state.license.entitlements().pro_enabled {
        return Err(ai_captions_pro_required());
    }
    whisper::delete_model(state.path_policy.app_data_dir(), &model)
}

/// A caption cue ready to import into the captions track.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedCue {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Transcribe a recording's audio into caption cues (AI Captions — Pro).
/// Runs whisper.cpp locally; nothing leaves the device.
#[tauri::command]
pub async fn transcribe_captions(
    recording_id: String,
    model: String,
    state: State<'_, AppState>,
) -> Result<Vec<TranscribedCue>> {
    if !state.license.entitlements().pro_enabled {
        return Err(ai_captions_pro_required());
    }

    let (output_path, audio_indices) = {
        let db = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let recording = crate::database::library::get_recording(&db, &recording_id)?;
        let output_path = recording
            .output_path
            .clone()
            .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;
        let audio_indices: Vec<i32> = crate::database::media::get_metadata(&db, &recording_id)?
            .map(|m| {
                m.streams
                    .iter()
                    .filter(|s| s.kind == "audio")
                    .map(|s| s.index)
                    .collect()
            })
            .unwrap_or_default();
        (output_path, audio_indices)
    };
    if audio_indices.is_empty() {
        return Err(InternalError::Media("recording has no audio track".into()).into());
    }
    let app_data_dir = state.path_policy.app_data_dir().to_path_buf();
    if !whisper::status(&app_data_dir).ready {
        return Err(InternalError::Media("Download the speech engine first".into()).into());
    }

    let ffmpeg_path = state.ffmpeg_path.clone();
    let work_dir = std::env::temp_dir().join(format!("rf-whisper-{}", uuid::Uuid::new_v4()));
    let wav_path = work_dir.join("audio.wav");
    let out_base = work_dir.join("captions");

    tauri::async_runtime::spawn_blocking(move || {
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        std::fs::create_dir_all(&work_dir)
            .map_err(|e| InternalError::Storage(format!("create whisper workdir: {e}")))?;
        let _guard = Cleanup(work_dir.clone());

        whisper::extract_transcribe_audio(
            &ffmpeg_path,
            Path::new(&output_path),
            &wav_path,
            &audio_indices,
        )?;
        let srt_path = whisper::run_whisper(&app_data_dir, &model, &wav_path, &out_base)?;
        let srt = std::fs::read_to_string(&srt_path)
            .map_err(|e| InternalError::Storage(format!("read transcript: {e}")))?;
        let cues = whisper::parse_srt(&srt)
            .into_iter()
            .map(|(start_ms, end_ms, text)| TranscribedCue {
                id: uuid::Uuid::new_v4().to_string(),
                start_ms,
                end_ms,
                text,
            })
            .collect();
        Ok(cues)
    })
    .await
    .map_err(|e| InternalError::Media(format!("transcribe task: {e}")))?
}

fn ai_captions_pro_required() -> crate::errors::AppError {
    crate::errors::AppError::new(
        crate::errors::ErrorCategory::Licensing,
        "pro_feature_required",
        "This feature requires RecordForge Pro",
    )
    .with_details(
        [("features".to_string(), serde_json::json!(["ai-captions"]))]
            .into_iter()
            .collect(),
    )
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
