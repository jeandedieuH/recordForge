use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{info, instrument};

use super::audio::wav::{
    align_wav_to_duration, frames_to_duration, read_wav_format, snap_wav_to_whole_frames,
    WAV_HEADER_SIZE,
};
use super::config::builtin_profiles;
use super::disk;

use super::manifest::{RecorderState, RecordingManifest};
use super::media;
use super::session::MAX_VIDEO_STARTUP_GAP_MS;

/// Result of scanning the sessions directory for recoverable recordings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryScanResult {
    pub session_id: String,
    pub state: RecorderState,
    pub manifest_path: String,
    pub output_path: Option<String>,
    pub output_size_bytes: u64,
    pub is_recoverable: bool,
    pub cursor_telemetry_available: bool,
    pub validation_error: Option<String>,
}

/// Scan the sessions directory for manifests whose state is not completed.
///
/// This is the core of force-quit recovery: every recording writes a manifest
/// incrementally, so even if FFmpeg is killed, the manifest and any finalized
/// MP4 fragments remain on disk.
#[instrument]
pub fn scan_recovery(sessions_dir: &Path) -> crate::errors::Result<Vec<RecoveryScanResult>> {
    let mut results = Vec::new();

    if !sessions_dir.exists() {
        return Ok(results);
    }

    for entry in std::fs::read_dir(sessions_dir)
        .map_err(|e| crate::errors::InternalError::Storage(format!("read sessions dir: {e}")))?
    {
        let entry = entry.map_err(|e| {
            crate::errors::InternalError::Storage(format!("session dir entry: {e}"))
        })?;

        let dir_name = entry.file_name().to_string_lossy().to_string();
        // Only consider UUID-named session directories. Other names are not part
        // of the recovery surface and may be user-created or malicious.
        if uuid::Uuid::parse_str(&dir_name).is_err() {
            continue;
        }

        let manifest_path = entry.path().join("session.json");
        if !manifest_path.exists() {
            continue;
        }

        let manifest = match RecordingManifest::read(&manifest_path) {
            Ok(m) => m,
            Err(e) => {
                let session_id = entry.file_name().to_string_lossy().to_string();
                results.push(RecoveryScanResult {
                    session_id,
                    state: RecorderState::Failed,
                    manifest_path: manifest_path.to_string_lossy().to_string(),
                    output_path: None,
                    output_size_bytes: 0,
                    is_recoverable: false,
                    cursor_telemetry_available: false,
                    validation_error: Some(format!("manifest unreadable: {e}")),
                });
                continue;
            }
        };

        if manifest.state == RecorderState::Completed {
            continue;
        }

        let work_dir = entry.path();
        let (fragment_size, fragment_count, fragment_error) =
            validate_fragments(&work_dir, &manifest);
        let total_size = fragment_size;

        let output = work_dir.join("output.mp4");
        let (output_path, output_size, validation_error) =
            if output.exists() && output_size_valid(&output) {
                (
                    Some(output.to_string_lossy().to_string()),
                    std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0),
                    None,
                )
            } else {
                let err = if fragment_count == 0 {
                    Some("no valid fragments found".into())
                } else {
                    Some("final output not yet concatenated; recovery will finalize".into())
                };
                (None, total_size, err.or(fragment_error))
            };
        let is_recoverable = fragment_count > 0 || output_path.is_some();
        let cursor_telemetry_available = super::cursor_v2::read_any_telemetry(&work_dir).is_some();

        results.push(RecoveryScanResult {
            session_id: manifest.session_id,
            state: manifest.state,
            manifest_path: manifest_path.to_string_lossy().to_string(),
            output_path,
            output_size_bytes: output_size,
            is_recoverable,
            cursor_telemetry_available,
            validation_error,
        });
    }

    info!(count = results.len(), "recovery scan complete");
    Ok(results)
}

/// Finalize and recover a single session, returning the library record.
///
/// `work_dir` must already have been validated as a UUID-named directory
/// inside the sessions root (see `path_policy::validate_session_dir`).
#[instrument]
pub fn recover_session(
    work_dir: &Path,
    ffmpeg_path: &str,
    ffprobe_path: &str,
    conn: &mut rusqlite::Connection,
) -> crate::errors::Result<crate::database::library::LibraryRecording> {
    let manifest_path = work_dir.join("session.json");

    if !manifest_path.exists() {
        return Err(crate::errors::InternalError::Storage("manifest not found".into()).into());
    }

    let mut manifest = RecordingManifest::read(&manifest_path)?;

    // A completed session is already in the library. Re-running recovery would
    // concatenate the fragments again and insert a duplicate row, so reject
    // stale client retries outright.
    if manifest.state == RecorderState::Completed {
        return Err(
            crate::errors::InternalError::Storage("session is already recovered".into()).into(),
        );
    }

    manifest.set_state(RecorderState::Recovering);
    manifest.write()?;

    let finalize = recover_session_inner(work_dir, &mut manifest, ffmpeg_path, ffprobe_path, conn);

    match finalize {
        Ok(recording) => Ok(recording),
        Err(error) => {
            // Mark the manifest failed so the recovery UI stops offering an
            // unrecoverable session and the user can delete it. Files are left
            // untouched; a future FFmpeg/ffprobe fix could still salvage them.
            // Storage/permission errors keep the Recovering state because a
            // retry may legitimately succeed once the underlying issue clears.
            if matches!(
                error.category,
                crate::errors::ErrorCategory::Media | crate::errors::ErrorCategory::Capture
            ) {
                manifest.set_state(RecorderState::Failed);
                manifest.write()?;
            }
            Err(error)
        }
    }
}

fn recover_session_inner(
    work_dir: &Path,
    manifest: &mut RecordingManifest,
    ffmpeg_path: &str,
    ffprobe_path: &str,
    conn: &mut rusqlite::Connection,
) -> crate::errors::Result<crate::database::library::LibraryRecording> {
    let output = work_dir.join("output.mp4");
    let mut output_size = std::fs::metadata(&output)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let output_is_valid = output_size > 1024 && validate_media_file(ffprobe_path, &output);

    if !output_is_valid {
        let segment_files = recovery_segments(work_dir, manifest)
            .into_iter()
            .filter(|path| validate_media_file(ffprobe_path, path))
            .collect::<Vec<_>>();

        if segment_files.is_empty() {
            return Err(crate::errors::InternalError::Media(
                "no valid fragments to recover".into(),
            )
            .into());
        }

        // Mux any un-muxed WASAPI audio tracks into each segment before concatenation
        for segment in &segment_files {
            mux_orphaned_segment_audio(work_dir, segment, manifest, ffmpeg_path, ffprobe_path);
        }

        let partial_output = work_dir.join("output.partial.mp4");
        if partial_output.exists() {
            std::fs::remove_file(&partial_output).map_err(|error| {
                crate::errors::InternalError::Storage(format!(
                    "remove partial recovery output: {error}"
                ))
            })?;
        }
        media::concatenate_segments(ffmpeg_path, work_dir, &segment_files, &partial_output)?;
        disk::atomic_replace(&partial_output, &output)?;
        output_size = std::fs::metadata(&output)
            .map(|metadata| metadata.len())
            .map_err(|error| {
                crate::errors::InternalError::Storage(format!("recovered output metadata: {error}"))
            })?;
        disk::sync_file(&output)?;
    }

    if output_size <= 1024 || !validate_media_file(ffprobe_path, &output) {
        return Err(crate::errors::InternalError::Media(
            "recovered output failed media validation".into(),
        )
        .into());
    }

    if let Some(webcam_path) = recover_webcam_asset(work_dir, manifest, ffmpeg_path, ffprobe_path)?
    {
        manifest.set_webcam_path(webcam_path.to_string_lossy());
    }
    manifest.set_output_path(output.to_string_lossy());
    manifest.set_state(RecorderState::Finalizing);
    manifest.write()?;
    let recording =
        crate::database::library::insert_recovered_recording(conn, manifest, output_size)?;
    manifest.set_state(RecorderState::Completed);
    manifest.write()?;

    Ok(recording)
}

/// Remove a recovery session directory from disk.
#[instrument]
pub fn delete_recovery_session(session_id: &str, sessions_dir: &Path) -> crate::errors::Result<()> {
    // 1. Validate UUID format to prevent path traversal via relative components (P0.7)
    if uuid::Uuid::parse_str(session_id).is_err() {
        return Err(crate::errors::InternalError::Permissions(format!(
            "invalid session ID format for deletion: {session_id}"
        ))
        .into());
    }

    let work_dir = sessions_dir.join(session_id);
    if work_dir.exists() {
        // 2. Canonicalize target and parent to enforce containment
        let canonical_target = crate::path_policy::canonicalize_path(&work_dir).map_err(|e| {
            crate::errors::InternalError::Storage(format!(
                "failed to canonicalize session path: {e}"
            ))
        })?;

        let canonical_root = crate::path_policy::canonicalize_path(sessions_dir).map_err(|e| {
            crate::errors::InternalError::Storage(format!(
                "failed to canonicalize sessions root: {e}"
            ))
        })?;

        if !canonical_target.starts_with(&canonical_root) {
            return Err(crate::errors::InternalError::Permissions(format!(
                "path traversal blocked: {session_id}"
            ))
            .into());
        }

        std::fs::remove_dir_all(&canonical_target).map_err(|e| {
            crate::errors::InternalError::Storage(format!("delete recovery session: {e}"))
        })?;
    }
    Ok(())
}

fn recover_webcam_asset(
    work_dir: &Path,
    manifest: &RecordingManifest,
    ffmpeg_path: &str,
    ffprobe_path: &str,
) -> crate::errors::Result<Option<PathBuf>> {
    let Some(existing) = manifest.webcam_path.as_ref() else {
        if manifest.webcam_fragments.is_empty() {
            return Ok(None);
        }
        let Some(profile) = builtin_profiles()
            .into_iter()
            .find(|profile| profile.id == manifest.profile_name)
        else {
            return Ok(None);
        };
        let mut segments = Vec::with_capacity(manifest.webcam_fragments.len());
        for fragment in &manifest.webcam_fragments {
            let Some(path) = safe_fragment_path(work_dir, &fragment.file_name) else {
                return Ok(None);
            };
            if !path.is_file() || !validate_media_file(ffprobe_path, &path) {
                return Ok(None);
            }
            segments.push(media::WebcamSegmentInput {
                path,
                duration: std::time::Duration::from_millis(fragment.duration_ms),
                offset_ms: fragment.offset_ms,
            });
        }

        let output = work_dir.join("webcam.mp4");
        let partial = work_dir.join("webcam.partial.mp4");
        if partial.exists() {
            let _ = std::fs::remove_file(&partial);
        }
        media::concatenate_webcam_segments(ffmpeg_path, &segments, &partial, &profile)?;
        disk::atomic_replace(&partial, &output)?;
        return Ok(Some(output));
    };

    let path = PathBuf::from(existing);
    if !path.is_file() || !validate_media_file(ffprobe_path, &path) {
        return Ok(None);
    }
    let canonical_root = crate::path_policy::canonicalize_path(work_dir).map_err(|error| {
        crate::errors::InternalError::Storage(format!("canonicalize session: {error}"))
    })?;
    let canonical_path = crate::path_policy::canonicalize_path(&path).map_err(|error| {
        crate::errors::InternalError::Storage(format!("canonicalize webcam asset: {error}"))
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Ok(None);
    }
    Ok(Some(canonical_path))
}

fn recovery_segments(work_dir: &Path, manifest: &RecordingManifest) -> Vec<PathBuf> {
    let mut paths = manifest
        .fragments
        .iter()
        .filter_map(|fragment| safe_fragment_path(work_dir, &fragment.file_name))
        .filter(|path| {
            std::fs::metadata(path)
                .map(|metadata| metadata.len() > 1024)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    if let Ok(entries) = std::fs::read_dir(work_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.starts_with("seg_") || name.starts_with("segment_"))
                && name.ends_with(".mp4")
                && std::fs::metadata(&path)
                    .map(|metadata| metadata.len() > 1024)
                    .unwrap_or(false)
                && !paths.contains(&path)
            {
                paths.push(path);
            }
        }
    }

    paths.sort_by_key(|path| segment_index(path).unwrap_or(u32::MAX));
    paths
}

fn safe_fragment_path(work_dir: &Path, file_name: &str) -> Option<PathBuf> {
    let relative = Path::new(file_name);
    if relative.components().count() != 1 || relative.extension()?.to_str()? != "mp4" {
        return None;
    }
    Some(work_dir.join(relative))
}

fn segment_index(path: &Path) -> Option<u32> {
    path.file_stem()?
        .to_string_lossy()
        .rsplit('_')
        .next()?
        .parse()
        .ok()
}

fn validate_media_file(ffprobe_path: &str, path: &Path) -> bool {
    let output = crate::process::create_command(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output();

    output
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false)
}

fn validate_fragments(
    work_dir: &Path,
    manifest: &RecordingManifest,
) -> (u64, usize, Option<String>) {
    let paths = recovery_segments(work_dir, manifest);
    let total = paths
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum();
    let count = paths.len();
    let error = if count == 0 {
        Some("no valid fragments found".into())
    } else {
        None
    };

    (total, count, error)
}

fn output_size_valid(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() > 1024)
        .unwrap_or(false)
}

fn media_has_audio(ffprobe_path: &str, path: &Path) -> bool {
    let output = crate::process::create_command(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output();

    output
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false)
}

fn probe_video_duration_ms(ffprobe_path: &str, path: &Path) -> Option<u64> {
    crate::media::probe::probe_media(ffprobe_path, path, "recovery-probe")
        .ok()
        .and_then(|metadata| {
            // Prefer the video stream duration like live finalization; the
            // container duration of a killed fragmented MP4 can trail it.
            metadata
                .streams
                .iter()
                .find(|stream| stream.kind == "video")
                .and_then(|stream| stream.duration_ms)
                .or(metadata.format.duration_ms)
                .or((metadata.duration_ms > 0).then_some(metadata.duration_ms))
        })
        .filter(|duration_ms| *duration_ms > 0)
}

fn mux_orphaned_segment_audio(
    work_dir: &Path,
    segment_path: &Path,
    manifest: &RecordingManifest,
    ffmpeg_path: &str,
    ffprobe_path: &str,
) {
    if media_has_audio(ffprobe_path, segment_path) {
        return;
    }

    let Some(idx) = segment_index(segment_path) else {
        return;
    };

    let mic_path = work_dir.join(format!("mic_{:03}.wav", idx));
    let sys_path = work_dir.join(format!("sys_{:03}.wav", idx));

    let _ = crate::capture::audio::repair_wav_header_if_needed(&mic_path);
    let _ = crate::capture::audio::repair_wav_header_if_needed(&sys_path);

    let candidate_tracks = [
        (mic_path, "Microphone", media::AudioTrackKind::Microphone),
        (sys_path, "System Audio", media::AudioTrackKind::System),
    ];
    let candidates = candidate_tracks
        .into_iter()
        .filter(|(path, _, _)| {
            std::fs::metadata(path)
                .map(|metadata| metadata.len() > WAV_HEADER_SIZE)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return;
    }

    // The probed video duration is the recovered segment's timeline authority,
    // exactly as in live finalization.
    let Some(video_duration) = probe_video_duration_ms(ffprobe_path, segment_path)
        .filter(|duration_ms| *duration_ms > 0)
        .map(Duration::from_millis)
    else {
        return;
    };

    // Each orphaned WAV is aligned in place before muxing so the raw stream
    // map in `mux_audio_tracks` lands it on the video timeline. This is the
    // same duration-based fallback the live path uses when microphone QPC
    // timing is unavailable.
    let mut tracks = Vec::new();
    for (path, title, kind) in candidates {
        align_orphaned_wav(&path, video_duration);
        tracks.push(media::AudioTrackInput {
            path,
            title,
            kind,
            alignment: None,
        });
    }

    let (audio_codec, audio_bitrate) = builtin_profiles()
        .into_iter()
        .find(|profile| profile.id == manifest.profile_name)
        .map(|p| (p.audio_codec, p.audio_bitrate_kbps))
        .unwrap_or_else(|| ("aac".to_string(), 128));

    let stem = segment_path
        .file_stem()
        .map(|v| v.to_string_lossy())
        .unwrap_or_else(|| "seg".into());
    let muxed_path = work_dir.join(format!("audio_mux_{stem}.mp4"));

    if let Err(error) = media::mux_audio_tracks(
        ffmpeg_path,
        segment_path,
        &tracks,
        &muxed_path,
        &audio_codec,
        audio_bitrate,
        video_duration,
    ) {
        tracing::warn!(error = ?error, "failed to mux audio tracks during recovery; continuing with silent video");
        return;
    }

    if let Err(error) = disk::atomic_replace(&muxed_path, segment_path) {
        tracing::warn!(error = ?error, "failed to replace video segment with audio-muxed segment during recovery");
    }
}

/// Align an orphaned crash-session WAV to the recovered segment's video
/// timeline before muxing.
///
/// The WAV head is anchored at the segment's timeline origin — the audio
/// worker pads its own startup with synthetic silence — while the video's
/// first frame trails the origin by the encoder startup gap. Without the
/// live timing snapshot, the WAV payload length is the only surviving
/// wall-clock record of the segment, so the startup gap is estimated as the
/// WAV-minus-video duration delta and trimmed from the head; the remainder
/// is silence-padded or tail-trimmed to the video duration. Failures only
/// downgrade that track to today's unaligned mux instead of dropping it.
fn align_orphaned_wav(path: &Path, video_duration: Duration) {
    let format = match read_wav_format(path) {
        Ok(Some(format)) => format,
        Ok(None) => {
            tracing::warn!(
                path = %path.display(),
                "orphaned WAV is not a canonical PCM track; muxing unaligned audio"
            );
            return;
        }
        Err(error) => {
            tracing::warn!(
                error = ?error,
                path = %path.display(),
                "failed to read orphaned WAV header; muxing unaligned audio"
            );
            return;
        }
    };

    let Some(block_align) = usize::from(format.channels)
        .checked_mul(usize::from(format.sample_format.bytes_per_sample()))
        .filter(|block_align| *block_align > 0)
    else {
        tracing::warn!(
            path = %path.display(),
            "orphaned WAV block alignment overflow; muxing unaligned audio"
        );
        return;
    };

    // A hard kill can leave a partially written trailing frame; the duration
    // alignment below requires a whole-frame payload.
    let data_bytes = match snap_wav_to_whole_frames(path, block_align) {
        Ok(data_bytes) => data_bytes,
        Err(error) => {
            tracing::warn!(
                error = ?error,
                path = %path.display(),
                "failed to snap orphaned WAV tail; muxing unaligned audio"
            );
            return;
        }
    };

    let wav_duration = frames_to_duration(data_bytes / block_align as u64, format.sample_rate);
    let head_trim = compute_recovery_head_trim(wav_duration, video_duration);
    if wav_duration.saturating_sub(video_duration) > Duration::from_millis(MAX_VIDEO_STARTUP_GAP_MS)
    {
        tracing::warn!(
            path = %path.display(),
            wav_duration_ms = wav_duration.as_millis() as u64,
            video_duration_ms = video_duration.as_millis() as u64,
            "orphaned WAV wall span is implausible; keeping an untrimmed head"
        );
    }

    match align_wav_to_duration(
        path,
        format.sample_rate,
        format.channels,
        format.sample_format,
        head_trim,
        video_duration,
    ) {
        Ok(_) => tracing::info!(
            path = %path.display(),
            head_trim_ms = head_trim.as_millis() as u64,
            wav_duration_ms = wav_duration.as_millis() as u64,
            video_duration_ms = video_duration.as_millis() as u64,
            "aligned orphaned WAV to the recovered video timeline"
        ),
        Err(error) => {
            tracing::warn!(
                error = ?error,
                path = %path.display(),
                "failed to align orphaned WAV; muxing unaligned audio"
            );
        }
    }
}

/// Estimate the head trim for an orphaned WAV from the recovered segment's
/// clocks. The WAV spans the timeline origin to the audio worker's last
/// write, and the video spans its first frame to its last, so the delta is
/// the video startup gap. It is clamped to zero when the audio worker died
/// before the video ended, and rejected outright when it exceeds the
/// plausible startup window (a clock anomaly such as FFmpeg dying long
/// before the app), matching the live path's rejection rule.
fn compute_recovery_head_trim(wav_duration: Duration, video_duration: Duration) -> Duration {
    let delta = wav_duration.saturating_sub(video_duration);
    if delta > Duration::from_millis(MAX_VIDEO_STARTUP_GAP_MS) {
        return Duration::ZERO;
    }
    delta
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::source::{Bounds, CaptureSource};
    use std::io::{Seek, SeekFrom, Write};
    use std::path::PathBuf;

    fn completed_manifest(work_dir: &Path) {
        let source = CaptureSource {
            kind: "display".into(),
            id: "display-0".into(),
            name: "Display 1".into(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        };
        let mut manifest = RecordingManifest::new(
            "11111111-1111-4111-8111-111111111111",
            work_dir.to_string_lossy(),
            source,
            "balanced",
        );
        manifest.set_state(RecorderState::Completed);
        manifest.write().expect("write completed manifest");
    }

    // Re-running recovery on a completed session must fail fast instead of
    // inserting a duplicate library row.
    #[test]
    fn recover_session_rejects_already_completed_manifest() {
        let temp_dir = tempfile::tempdir().expect("create temp sessions dir");
        let work_dir = temp_dir.path().join("11111111-1111-4111-8111-111111111111");
        std::fs::create_dir_all(&work_dir).expect("create work dir");
        completed_manifest(&work_dir);

        let mut conn = rusqlite::Connection::open_in_memory().expect("open db");
        let result = recover_session(&work_dir, "ffmpeg", "ffprobe", &mut conn);
        let error = result.expect_err("completed session must be rejected");
        assert!(error.message.contains("already recovered"));
    }

    #[test]
    fn recovery_head_trim_estimates_the_video_startup_gap() {
        // The WAV is a 4.5 s wall-clock record for a 4.0 s video: the first
        // 500 ms are the startup window before the first video frame.
        assert_eq!(
            compute_recovery_head_trim(Duration::from_millis(4_500), Duration::from_millis(4_000)),
            Duration::from_millis(500)
        );
        assert_eq!(
            compute_recovery_head_trim(Duration::from_millis(4_000), Duration::from_millis(4_000)),
            Duration::ZERO
        );
        // The audio worker died before the video ended: nothing to trim.
        assert_eq!(
            compute_recovery_head_trim(Duration::from_millis(2_800), Duration::from_millis(4_000)),
            Duration::ZERO
        );
    }

    #[test]
    fn recovery_head_trim_rejects_implausible_wall_spans() {
        // A WAV far outliving the video is a clock anomaly (e.g. FFmpeg died
        // long before the app); trimming that much would discard real audio.
        assert_eq!(
            compute_recovery_head_trim(Duration::from_millis(12_000), Duration::from_millis(4_000)),
            Duration::ZERO
        );
        // The largest plausible startup gap is still applied.
        assert_eq!(
            compute_recovery_head_trim(Duration::from_millis(9_000), Duration::from_millis(4_000)),
            Duration::from_millis(5_000)
        );
    }

    const MARKER_SAMPLE_RATE: u32 = 48_000;
    /// Loud-burst detection threshold for decoded marker audio.
    const MARKER_AMPLITUDE: u16 = 15_000;
    /// Marker bursts are 480 samples (10 ms) of full-scale PCM.
    const MARKER_FRAMES: usize = 480;
    /// The segment mux encodes AAC with `-avoid_negative_ts make_zero`, so the
    /// decoder emits one encoder-delay frame (~1024 samples at 48 kHz) before
    /// the first real sample. Marker expectations include this constant bias.
    const AAC_PRIMING_MS: u64 = 21;

    fn test_source() -> CaptureSource {
        CaptureSource {
            kind: "display".into(),
            id: "display-0".into(),
            name: "Display 1".into(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        }
    }

    /// Locate the pinned FFmpeg/FFprobe sidecars for generated-media tests,
    /// skipping the test when no binary is available.
    fn locate_media_binaries() -> Option<(PathBuf, PathBuf)> {
        use std::process::Stdio;

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg_candidates = [
            manifest_dir.join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe"),
            manifest_dir.join("target/debug/ffmpeg.exe"),
            PathBuf::from("ffmpeg"),
        ];
        let ffprobe_candidates = [
            manifest_dir.join("binaries/ffprobe-x86_64-pc-windows-msvc.exe"),
            manifest_dir.join("target/debug/ffprobe.exe"),
            PathBuf::from("ffprobe"),
        ];
        fn available(path: &Path) -> bool {
            crate::process::create_command(path.as_os_str())
                .arg("-version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }

        let ffmpeg = ffmpeg_candidates.into_iter().find(|c| available(c))?;
        let ffprobe = ffprobe_candidates.into_iter().find(|c| available(c))?;
        Some((ffmpeg, ffprobe))
    }

    /// Generate a 4-second 60 fps video-only MP4 segment.
    fn generate_video_segment(ffmpeg: &Path, path: &Path) {
        let status = crate::process::create_command(ffmpeg.as_os_str())
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=64x64:r=60:d=4",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .status()
            .expect("generate video fixture");
        assert!(status.success(), "generate video fixture");
    }

    /// Write a mono 16-bit 48 kHz WAV mirroring a crashed WASAPI worker: it
    /// starts with `synthetic_leading_ms` of startup silence, carries loud
    /// markers at the given real-capture positions, and spans `total_ms`.
    fn write_marker_wav(path: &Path, synthetic_leading_ms: u64, total_ms: u64, marker_ms: &[u64]) {
        use crate::capture::audio::{finalize_wav, write_wav_header, AudioSampleFormat};

        let synthetic_frames = (synthetic_leading_ms * u64::from(MARKER_SAMPLE_RATE)) / 1_000;
        let total_frames = (total_ms * u64::from(MARKER_SAMPLE_RATE)) / 1_000;
        let mut samples = vec![0i16; total_frames as usize];
        for marker in marker_ms {
            let start = synthetic_frames + (*marker * u64::from(MARKER_SAMPLE_RATE)) / 1_000;
            let end = (start + MARKER_FRAMES as u64).min(total_frames);
            samples[start as usize..end as usize].fill(i16::MAX);
        }
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .expect("open WAV fixture");
        write_wav_header(&mut file, MARKER_SAMPLE_RATE, 1, AudioSampleFormat::Pcm16)
            .expect("write WAV fixture header");
        file.seek(SeekFrom::End(0)).expect("seek WAV fixture");
        file.write_all(&bytes).expect("write WAV fixture samples");
        finalize_wav(&mut file, bytes.len() as u64).expect("finalize WAV fixture");
    }

    /// Decode the first audio stream of `media` and return the marker centers
    /// (in ms) plus the total decoded duration (in ms).
    fn decode_audio_markers(ffmpeg: &Path, media: &Path) -> (Vec<u64>, u64) {
        let decoded = crate::process::create_command(ffmpeg.as_os_str())
            .args(["-v", "error"])
            .arg("-i")
            .arg(media)
            .args([
                "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1",
            ])
            .output()
            .expect("decode recovered audio");
        assert!(decoded.status.success(), "decode recovered audio");

        let (sample_bytes, _) = decoded.stdout.as_chunks::<2>();
        let samples = sample_bytes
            .iter()
            .map(|bytes| i16::from_le_bytes(*bytes))
            .collect::<Vec<_>>();
        let duration_ms =
            (samples.len() as u64).saturating_mul(1_000) / u64::from(MARKER_SAMPLE_RATE);

        let mut markers = Vec::new();
        let mut index = 0usize;
        while index < samples.len() {
            if samples[index].unsigned_abs() < MARKER_AMPLITUDE {
                index += 1;
                continue;
            }
            let start = index;
            while index < samples.len() && samples[index].unsigned_abs() >= MARKER_AMPLITUDE {
                index += 1;
            }
            if index - start >= MARKER_FRAMES / 4 {
                let center_samples = (start + index) / 2;
                markers.push(center_samples as u64 * 1_000 / u64::from(MARKER_SAMPLE_RATE));
            }
        }

        (markers, duration_ms)
    }

    fn orphaned_wav_manifest(work_dir: &Path) -> RecordingManifest {
        RecordingManifest::new(
            "22222222-2222-4222-8222-222222222222",
            work_dir.to_string_lossy(),
            test_source(),
            "balanced",
        )
    }

    // A crash-recovered session's orphaned microphone WAV must be aligned to
    // the segment's video timeline before muxing: the startup window before
    // the first captured video frame is trimmed from the head.
    #[test]
    #[cfg(windows)]
    fn recovered_orphaned_audio_is_head_trimmed_to_the_video_timeline() {
        let Some((ffmpeg, ffprobe)) = locate_media_binaries() else {
            eprintln!("skipping: FFmpeg is unavailable");
            return;
        };
        let directory = tempfile::tempdir().expect("create recovery test directory");
        let work_dir = directory.path();
        let segment = work_dir.join("seg_000.mp4");
        generate_video_segment(&ffmpeg, &segment);

        // 300 ms of synthetic WASAPI startup silence plus 4.2 s of captured
        // audio: the WAV is a 4.5 s wall-clock record for a 4.0 s video, so
        // the first 500 ms (the video startup gap) must be head-trimmed.
        write_marker_wav(
            &work_dir.join("mic_000.wav"),
            300,
            4_500,
            &[1_000, 2_000, 3_000],
        );

        let manifest = orphaned_wav_manifest(work_dir);
        mux_orphaned_segment_audio(
            work_dir,
            &segment,
            &manifest,
            &ffmpeg.to_string_lossy(),
            &ffprobe.to_string_lossy(),
        );

        assert!(
            media_has_audio(&ffprobe.to_string_lossy(), &segment),
            "recovery must mux the orphaned audio track"
        );
        let (markers, _duration_ms) = decode_audio_markers(&ffmpeg, &segment);
        assert_eq!(markers.len(), 3, "all markers must survive recovery muxing");
        let expected_markers = [
            805 + AAC_PRIMING_MS,
            1_805 + AAC_PRIMING_MS,
            2_805 + AAC_PRIMING_MS,
        ];
        for (actual, expected) in markers.iter().zip(expected_markers) {
            assert!(
                actual.abs_diff(expected) <= 17,
                "marker at {actual}ms should be within one frame of {expected}ms"
            );
        }
    }

    // When the audio worker died before the video ended, the orphaned WAV must
    // be silence-padded to the segment's video duration instead of ending
    // early.
    #[test]
    #[cfg(windows)]
    fn recovered_orphaned_audio_is_padded_to_the_video_duration() {
        let Some((ffmpeg, ffprobe)) = locate_media_binaries() else {
            eprintln!("skipping: FFmpeg is unavailable");
            return;
        };
        let directory = tempfile::tempdir().expect("create recovery test directory");
        let work_dir = directory.path();
        let segment = work_dir.join("seg_000.mp4");
        generate_video_segment(&ffmpeg, &segment);

        // The audio worker died at 2.8 s while the video ran the full 4.0 s.
        write_marker_wav(&work_dir.join("mic_000.wav"), 300, 2_800, &[1_000, 2_000]);

        let manifest = orphaned_wav_manifest(work_dir);
        mux_orphaned_segment_audio(
            work_dir,
            &segment,
            &manifest,
            &ffmpeg.to_string_lossy(),
            &ffprobe.to_string_lossy(),
        );

        assert!(
            media_has_audio(&ffprobe.to_string_lossy(), &segment),
            "recovery must mux the orphaned audio track"
        );
        let (markers, duration_ms) = decode_audio_markers(&ffmpeg, &segment);
        assert_eq!(markers.len(), 2, "all markers must survive recovery muxing");
        // No head trim applies when the WAV is shorter than the video, so the
        // markers stay at their WAV positions (synthetic silence included).
        let expected_markers = [1_305 + AAC_PRIMING_MS, 2_305 + AAC_PRIMING_MS];
        for (actual, expected) in markers.iter().zip(expected_markers) {
            assert!(
                actual.abs_diff(expected) <= 17,
                "marker at {actual}ms should be within one frame of {expected}ms"
            );
        }
        // The padded tail also carries the AAC encoder-delay frame.
        assert!(
            (3_950..=4_060).contains(&duration_ms),
            "padded audio duration {duration_ms}ms should match the 4000ms video segment"
        );
    }
}
