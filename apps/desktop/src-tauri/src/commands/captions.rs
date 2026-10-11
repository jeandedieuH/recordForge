use crate::errors::{InternalError, Result};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tracing::{instrument, warn};

use crate::state::AppState;
use crate::transcript::{self, Transcript};
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

/// Parameters for a word-level transcription job (`transcribe_audio`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscribeRequest {
    /// UI-generated uuid — identifies the job for progress events and cancel.
    pub job_id: String,
    pub recording_id: String,
    /// One of `whisper::WHISPER_MODELS` ids ("base" | "small" | "medium" | "large").
    pub model: String,
    /// "auto" or a 2–3 letter lowercase ISO-639 code.
    pub language: String,
    /// Absolute ffprobe stream index of one audio stream; `None` = first audio.
    pub stream_index: Option<i32>,
    /// Ignore the on-disk transcript cache.
    pub force: bool,
}

/// "auto" or a lowercase ISO-639 code. Never forward unvalidated strings to
/// the whisper-cli command line.
fn is_valid_language(language: &str) -> bool {
    language == "auto"
        || ((2..=3).contains(&language.len()) && language.chars().all(|c| c.is_ascii_lowercase()))
}

fn emit_progress(app: &AppHandle, job_id: &str, phase: &str, percent: u8) {
    use tauri::Emitter;
    let _ = app.emit(
        transcript::PROGRESS_EVENT,
        serde_json::json!({
            "jobId": job_id,
            "phase": phase,
            "percent": percent,
        }),
    );
}

/// Transcribe one audio stream of a recording into a word-level transcript
/// (AI Captions — Pro). Runs whisper.cpp locally with VAD; times are in the
/// recording asset's container timeline (see `transcript` module docs).
/// Results are cached under the recording's work dir keyed by
/// model/language/stream so repeated requests are instant.
#[tauri::command]
#[instrument(skip(app, state, request), fields(job_id = %request.job_id, model = %request.model))]
pub async fn transcribe_audio(
    request: TranscribeRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Transcript> {
    if !state.license.entitlements().pro_enabled {
        return Err(ai_captions_pro_required());
    }
    // Single-slot busy gate; the registration also owns the cancel channel.
    // Dropping it deregisters the job on every exit path.
    let registration = state.transcription.begin(&request.job_id)?;

    if request.job_id.trim().is_empty() || request.recording_id.trim().is_empty() {
        return Err(InternalError::Media("jobId and recordingId are required".into()).into());
    }
    if whisper::model_spec(&request.model).is_none() {
        return Err(
            InternalError::Media(format!("unknown speech model '{}'", request.model)).into(),
        );
    }
    if !is_valid_language(&request.language) {
        return Err(
            InternalError::Media(format!("invalid language code '{}'", request.language)).into(),
        );
    }
    if request.stream_index.is_some_and(|index| index < 0) {
        return Err(InternalError::Media("invalid audio stream index".into()).into());
    }

    let (output_path, work_dir, stream_index, stream_start_ms) = {
        let db = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let recording = crate::database::library::get_recording(&db, &request.recording_id)?;
        let output_path = recording
            .output_path
            .clone()
            .ok_or_else(|| InternalError::Media("recording has no output path".into()))?;
        let audio_streams: Vec<crate::database::media::MediaStream> =
            crate::database::media::get_metadata(&db, &request.recording_id)?
                .map(|metadata| {
                    metadata
                        .streams
                        .into_iter()
                        .filter(|s| s.kind == "audio")
                        .collect()
                })
                .unwrap_or_default();
        if audio_streams.is_empty() {
            return Err(InternalError::Media("recording has no audio track".into()).into());
        }
        let index = request.stream_index.unwrap_or(audio_streams[0].index);
        let stream = audio_streams
            .iter()
            .find(|s| s.index == index)
            .ok_or_else(|| {
                InternalError::Media("the requested audio stream does not exist".into())
            })?;
        (
            output_path,
            recording.work_dir.clone(),
            index,
            stream.start_ms,
        )
    };

    let app_data_dir = state.path_policy.app_data_dir().to_path_buf();
    let status = whisper::status(&app_data_dir);
    if !status.binary_ready {
        return Err(InternalError::Media("Download the speech engine first".into()).into());
    }
    if !status
        .models
        .iter()
        .any(|m| m.id == request.model && m.downloaded)
    {
        return Err(
            InternalError::Media("the selected speech model is not downloaded yet".into()).into(),
        );
    }

    // Cache invalidates on the recording file's size + mtime.
    let file_meta = std::fs::metadata(&output_path)
        .map_err(|e| InternalError::Storage(format!("stat recording: {e}")))?;
    let source_len = file_meta.len();
    let source_modified_ms = file_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let cache_file = transcript::cache_path(
        &PathBuf::from(&work_dir),
        &request.model,
        &request.language,
        stream_index,
    );
    if !request.force {
        if let Some(mut cached) =
            transcript::read_cached(&cache_file, source_len, source_modified_ms)
        {
            cached.cached = true;
            emit_progress(&app, &request.job_id, transcript::PHASE_FINALIZING, 100);
            return Ok(cached);
        }
    }

    emit_progress(&app, &request.job_id, transcript::PHASE_PREPARING, 0);

    // Lazy VAD fetch — best-effort, transcription proceeds without it.
    let engine_dir = whisper::engine_dir(&app_data_dir);
    if !status.vad_ready {
        if let Err(error) = whisper::download_vad_model(&engine_dir).await {
            warn!(error = %error, "VAD model download failed; transcribing without VAD");
        }
    }

    let ffmpeg_path = state.ffmpeg_path.clone();
    let job = registration.job().clone();
    let language = request.language.clone();
    let model = request.model.clone();
    let job_id = request.job_id.clone();
    let app_for_events = app.clone();

    let transcript = tauri::async_runtime::spawn_blocking(move || {
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let work_dir = std::env::temp_dir().join(format!("rf-whisper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work_dir)
            .map_err(|e| InternalError::Storage(format!("create whisper workdir: {e}")))?;
        let _guard = Cleanup(work_dir.clone());
        let wav_path = work_dir.join("audio.wav");
        let out_base = work_dir.join("transcript");

        whisper::extract_stream_transcribe_audio(
            &ffmpeg_path,
            Path::new(&output_path),
            &wav_path,
            stream_index,
            stream_start_ms,
        )?;
        if job.is_cancelled() {
            return Err(transcript::transcription_cancelled());
        }

        emit_progress(&app_for_events, &job_id, transcript::PHASE_TRANSCRIBING, 0);
        let progress_app = app_for_events.clone();
        let progress_job = job_id.clone();
        let run = whisper::run_whisper_transcribe(
            &app_data_dir,
            &model,
            &wav_path,
            &out_base,
            &language,
            &job,
            move |percent| {
                emit_progress(
                    &progress_app,
                    &progress_job,
                    transcript::PHASE_TRANSCRIBING,
                    percent,
                )
            },
        )?;

        emit_progress(&app_for_events, &job_id, transcript::PHASE_FINALIZING, 100);
        let content = std::fs::read_to_string(&run.json_path)
            .map_err(|e| InternalError::Storage(format!("read transcript: {e}")))?;
        let parsed = transcript::parse_transcript_json(&content, &run.token_time_map, &language)?;
        let duration_ms = whisper::wav_duration_ms(&wav_path)?;
        let result = Transcript {
            language: parsed.language,
            model,
            stream_index,
            duration_ms,
            words: parsed.words,
            cached: false,
        };
        // A cache write failure must not fail the transcription itself.
        if let Err(error) =
            transcript::write_cache(&cache_file, source_len, source_modified_ms, &result)
        {
            warn!(error = %error, "transcript cache write failed");
        }
        Ok(result)
    })
    .await
    .map_err(|e| InternalError::Media(format!("transcribe task: {e}")))??;

    Ok(transcript)
}

/// Cancel a running `transcribe_audio` job — kills the whisper process.
/// Unknown or finished jobs are a no-op.
#[tauri::command]
pub fn cancel_transcription(job_id: String, state: State<'_, AppState>) -> Result<()> {
    state.transcription.cancel(&job_id);
    Ok(())
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

    #[test]
    fn language_validation_accepts_auto_and_iso_codes() {
        assert!(is_valid_language("auto"));
        assert!(is_valid_language("en"));
        assert!(is_valid_language("deu"));
        assert!(!is_valid_language("EN"));
        assert!(!is_valid_language("en-US"));
        assert!(!is_valid_language("english"));
        assert!(!is_valid_language("e"));
        assert!(!is_valid_language(""));
        assert!(!is_valid_language("-rf"));
    }

    #[test]
    fn transcribe_request_deserializes_camel_case() {
        let request: TranscribeRequest = serde_json::from_str(
            r#"{"jobId":"j1","recordingId":"r1","model":"base","language":"auto","streamIndex":1,"force":true}"#,
        )
        .unwrap();
        assert_eq!(request.job_id, "j1");
        assert_eq!(request.stream_index, Some(1));
        assert!(request.force);
        // Unknown fields are rejected so typos can't silently change behavior.
        assert!(serde_json::from_str::<TranscribeRequest>(
            r#"{"jobId":"j1","recordingId":"r1","model":"base","language":"en","force":false,"modelId":"x"}"#
        )
        .is_err());
    }
}
