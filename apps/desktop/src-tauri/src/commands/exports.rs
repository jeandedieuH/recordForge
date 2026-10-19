use std::path::{Path, PathBuf};
use tauri::{Manager, State};
use tracing::instrument;

use crate::database::media::MediaJob;
use crate::errors::{InternalError, Result};
use crate::exports::{ExportSettings, RenderPlan};
use crate::jobs::ExportRequest;
use crate::state::AppState;

/// Directory (inside the recording work dir) that owns processed previews —
/// derived media the app may prune, never user-selected output.
pub(crate) const GENERATED_PREVIEW_DIR: &str = "generated-preview";

/// Export input contains a project identity and an explicit destination. Rust
/// resolves every source asset from the saved project before starting FFmpeg.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTimelineOptions {
    pub project_id: String,
    pub output_path: String,
    pub plan: RenderPlan,
    pub settings: ExportSettings,
    /// The project title frozen at admission — persisted into the export
    /// request so publishing reads it, not the mutable project name.
    #[serde(default)]
    pub project_name: Option<String>,
    /// Optional multi-format batch identity.
    #[serde(default)]
    pub batch: Option<ExportBatchOptions>,
}

/// Batch-grouping fields the frontend sends per format variant.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBatchOptions {
    pub id: String,
    pub aspect_ratio: String,
    pub is_primary: bool,
}

/// Start one durable export job. The manager persists the request before the
/// worker thread starts, so the returned job id is authoritative end-to-end.
#[tauri::command]
#[instrument(skip(options))]
pub fn export_timeline(
    options: ExportTimelineOptions,
    state: State<'_, AppState>,
) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if options.project_id.trim().is_empty() {
        return Err(InternalError::Project("project id is required for export".into()).into());
    }
    if options.plan.project_id != options.project_id {
        return Err(InternalError::Project(
            "render plan project does not match export project".into(),
        )
        .into());
    }
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.start_export(ExportRequest {
        project_id: options.project_id,
        output_path: options.output_path,
        plan: options.plan,
        settings: options.settings,
        preview: false,
        project_name: options.project_name,
        batch: options
            .batch
            .map(|batch| crate::database::media::ExportBatchMetadata {
                id: batch.id,
                aspect_ratio: batch.aspect_ratio,
                is_primary: batch.is_primary,
            }),
    })
}

/// Options for an on-demand processed preview. The destination is always
/// derived natively under the recording's work dir — the frontend never
/// provides a filesystem path.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTimelineOptions {
    pub project_id: String,
    pub plan: RenderPlan,
    pub settings: ExportSettings,
}

/// Start a processed-preview job: the same renderer as export, forced to
/// MP4/h264 capped at 720p inside `generated-preview/`. Preview is Pro-aware —
/// the normal `enforce_export` check still runs inside `start_export`.
#[tauri::command]
#[instrument(skip(state, options))]
pub fn preview_timeline(
    options: PreviewTimelineOptions,
    state: State<'_, AppState>,
) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    if options.project_id.trim().is_empty() {
        return Err(InternalError::Project("project id is required for preview".into()).into());
    }
    if options.plan.project_id != options.project_id {
        return Err(InternalError::Project(
            "render plan project does not match preview project".into(),
        )
        .into());
    }

    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let project = crate::database::projects::get_project(&conn, &options.project_id)?
        .ok_or_else(|| InternalError::Project("preview project was not found".into()))?;
    let recording = crate::database::library::get_recording(&conn, &project.recording_id)?;
    drop(conn);

    // One unique output per job avoids file locks on Windows and keeps a
    // finished preview intact if its job row is cancelled late. A symlink or
    // junction planted at the cache path must never redirect a write outside
    // the recording's work dir — junctions aren't FileType::is_symlink, so
    // ownership is proven by canonical-path comparison, checked before
    // create AND before the write.
    let preview_dir = owned_preview_dir(Path::new(&recording.work_dir))?;
    std::fs::create_dir_all(&preview_dir)
        .map_err(|error| InternalError::Storage(format!("create preview dir: {error}")))?;
    let preview_dir = owned_preview_dir(Path::new(&recording.work_dir))?;
    let output_path = preview_dir.join(format!("preview-{}.mp4", uuid::Uuid::new_v4()));

    // Coerced delivery profile: the deliverable keeps the chosen settings;
    // the preview is a fast 720p MP4. Chapters are meaningless inside the
    // app player (forced off in BOTH plan and settings); caption sidecars
    // are kept so a VTT companion can be made.
    let mut settings = options.settings;
    settings.preset = "fast-share".into();
    settings.codec = "h264".into();
    settings.container = "mp4".into();
    settings.chapter_mode = "none".into();
    let mut plan = options.plan;
    plan.chapter_mode = "none".into();

    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    let job = manager.start_export(ExportRequest {
        project_id: options.project_id,
        output_path: output_path.to_string_lossy().to_string(),
        plan,
        settings,
        preview: true,
        project_name: None,
        batch: None,
    })?;
    drop(manager);

    if let Err(error) = prune_preview_outputs(&state, &recording.id, 2) {
        // Pruning is best-effort cache hygiene — never fail the job for it.
        tracing::warn!(error = %error, "preview cache prune failed");
    }
    Ok(job)
}

/// Case-insensitive path comparison on Windows — canonicalized paths still
/// differ by drive-letter/segment case between callers.
fn paths_equal_normalized(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Canonical owned preview-cache dir for `work_dir`. The WORK dir is
/// canonicalized first; the expected cache path is its lexical join (never
/// canonicalized THROUGH a possibly-planted link). When the cache path
/// already exists its own canonical form must equal that expected path —
/// junctions/symlinks that resolve elsewhere are rejected. Returns the
/// expected canonical path whether or not the dir exists yet.
fn owned_preview_dir(work_dir: &Path) -> Result<PathBuf> {
    let canonical_work = crate::path_policy::canonicalize_path(work_dir)
        .map_err(|error| InternalError::Storage(format!("resolve recording work dir: {error}")))?;
    let expected = canonical_work.join(GENERATED_PREVIEW_DIR);
    let preview_dir = work_dir.join(GENERATED_PREVIEW_DIR);
    match crate::path_policy::canonicalize_path(&preview_dir) {
        Ok(actual) if !paths_equal_normalized(&actual, &expected) => Err(InternalError::Storage(
            "preview cache path redirects outside the recording directory".into(),
        )
        .into()),
        Ok(_) => Ok(expected),
        Err(_) if preview_dir.symlink_metadata().is_ok() => Err(InternalError::Storage(
            "preview cache path exists but cannot be resolved".into(),
        )
        .into()),
        Err(_) => Ok(expected),
    }
}

/// Keep at most `keep` finished preview outputs per recording. Deletes only
/// top-level `preview-*.mp4` files plus their matching srt/vtt inside the
/// EXACT canonical `generated-preview` directory — never source media, never
/// user-selected destinations, never active jobs, never symlinks, and only
/// readable COMPLETED previews count toward the keep limit (a dead row with
/// no file doesn't consume a slot).
fn prune_preview_outputs(
    state: &State<'_, AppState>,
    recording_id: &str,
    keep: usize,
) -> Result<()> {
    let conn = state
        .db
        .lock()
        .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
    let jobs = crate::database::media::list_jobs(&conn, recording_id)?;
    drop(conn);

    let mut finished: Vec<&MediaJob> = jobs
        .iter()
        .filter(|job| {
            job.kind == crate::database::media::MediaJobKind::Export
                && job
                    .options
                    .get("preview")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
                && matches!(
                    job.status,
                    crate::database::media::MediaJobStatus::Completed
                        | crate::database::media::MediaJobStatus::Failed
                        | crate::database::media::MediaJobStatus::Cancelled
                )
        })
        .collect();
    finished.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));

    let preview_dir = {
        let conn = state
            .db
            .lock()
            .map_err(|_| InternalError::Storage("database mutex poisoned".into()))?;
        let recording = crate::database::library::get_recording(&conn, recording_id)?;
        drop(conn);
        // A redirected cache dir owns nothing — canonicalizing through the
        // link would make an outside directory look prunable.
        let preview_dir = match owned_preview_dir(Path::new(&recording.work_dir)) {
            Ok(dir) => dir,
            Err(_) => return Ok(()),
        };
        if !preview_dir.is_dir() {
            return Ok(());
        }
        preview_dir
    };

    let candidates: Vec<(PathBuf, bool)> = finished
        .iter()
        .filter_map(|job| {
            // Failed/cancelled jobs often have no outputs row — fall back to
            // the validated persisted request so their disposable preview
            // files can still be pruned.
            job.outputs
                .output_path
                .as_deref()
                .or_else(|| {
                    job.options
                        .get("outputPath")
                        .and_then(|value| value.as_str())
                })
                .map(|output| {
                    (
                        PathBuf::from(output),
                        job.status == crate::database::media::MediaJobStatus::Completed,
                    )
                })
        })
        .collect();
    prune_preview_files(&preview_dir, &candidates, keep);
    Ok(())
}

/// Resolve `path` to its canonical form ONLY if it is a real, directly
/// contained `preview-*.mp4` inside `preview_dir` — symlink rejection comes
/// first so a planted link can't redirect a delete outside the cache.
fn owned_preview_file(preview_dir: &Path, path: &Path) -> Option<PathBuf> {
    if path.symlink_metadata().ok()?.file_type().is_symlink() {
        return None;
    }
    let canonical = crate::path_policy::canonicalize_path(path).ok()?;
    if canonical.parent() != Some(preview_dir) || !canonical.is_file() {
        return None;
    }
    // The name must be exactly `preview-<uuid>.mp4` — loose prefixes let a
    // user's own `preview-notes.mp4` get pruned.
    let name = canonical.file_name()?.to_string_lossy();
    let uuid = name
        .strip_prefix("preview-")
        .and_then(|stem| stem.strip_suffix(".mp4"))?;
    uuid::Uuid::parse_str(uuid).ok()?;
    Some(canonical)
}

/// Pure filesystem pruning: `candidates` are terminal-job outputs newest
/// first with a "completed" flag. Only completed candidates that resolve to
/// owned files count toward `keep`; everything else owned gets deleted with
/// its srt/vtt. Returns the deleted output count (best-effort).
fn prune_preview_files(preview_dir: &Path, candidates: &[(PathBuf, bool)], keep: usize) -> usize {
    let mut kept = 0usize;
    let mut deleted = 0usize;
    for (output, completed) in candidates {
        let Some(canonical) = owned_preview_file(preview_dir, output) else {
            continue;
        };
        if *completed && kept < keep {
            kept += 1;
            continue;
        }
        if std::fs::remove_file(&canonical).is_ok() {
            deleted += 1;
            // Sidecars go only when their output went — a failed output
            // delete must not strand orphaned captions of a kept file.
            for ext in ["srt", "vtt"] {
                let sidecar = canonical.with_extension(ext);
                // Owned sidecar names can't escape the dir even if they are
                // links — deleting the link never follows to a target.
                if sidecar.exists() {
                    let _ = std::fs::remove_file(&sidecar);
                }
            }
        }
    }
    deleted
}

/// Retry a failed/cancelled export with the persisted request and job identity.
#[tauri::command]
#[instrument]
pub fn retry_export(job_id: String, state: State<'_, AppState>) -> Result<MediaJob> {
    let _update_operation = state.update_gate.acquire_operation()?;
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    manager.retry_export(&job_id)
}

/// Reveal a completed export without allowing the UI to provide an arbitrary path.
#[tauri::command]
#[instrument(skip(state))]
pub fn reveal_export(job_id: String, state: State<'_, AppState>) -> Result<()> {
    let manager = state
        .job_manager
        .lock()
        .map_err(|_| InternalError::Unknown("job manager mutex poisoned".into()))?;
    let job = manager.get_job(&job_id)?;
    let path = job
        .outputs
        .output_path
        .ok_or_else(|| InternalError::Media("export has no published output".into()))?;
    let validated = state
        .path_policy
        .validate_export_destination(Path::new(&path))?;
    if !validated.is_file() {
        return Err(InternalError::Storage("published export is missing".into()).into());
    }

    tauri_plugin_opener::reveal_item_in_dir(&validated)
        .map_err(|error| InternalError::Media(format!("reveal export: {error}")))?;
    Ok(())
}

/// Flash taskbar or request dock attention when an export finishes in the background.
#[tauri::command]
#[instrument(skip(app))]
pub fn request_export_attention(app: tauri::AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    Ok(())
}

#[cfg(test)]
mod preview_cache_tests {
    use super::*;

    /// Seed a real file inside the preview dir; returns its path.
    fn preview_file(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"video").expect("seed preview file");
        path
    }

    #[test]
    fn preview_cache_keeps_only_newest_completed_outputs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let preview_dir = dir.path().join(GENERATED_PREVIEW_DIR);
        std::fs::create_dir_all(&preview_dir).unwrap();
        let canonical_dir = crate::path_policy::canonicalize_path(&preview_dir).unwrap();

        let newest = preview_file(
            &preview_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        let middle = preview_file(
            &preview_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        let oldest = preview_file(
            &preview_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        // Newest-first candidates, all completed — keep=2 deletes the oldest.
        let deleted = prune_preview_files(
            &canonical_dir,
            &[
                (newest.clone(), true),
                (middle.clone(), true),
                (oldest.clone(), true),
            ],
            2,
        );
        assert_eq!(deleted, 1);
        assert!(newest.exists() && middle.exists());
        assert!(!oldest.exists());
    }

    #[test]
    fn preview_cache_failed_jobs_do_not_consume_keep_slots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let preview_dir = dir.path().join(GENERATED_PREVIEW_DIR);
        std::fs::create_dir_all(&preview_dir).unwrap();
        let canonical_dir = crate::path_policy::canonicalize_path(&preview_dir).unwrap();

        let failed = preview_file(
            &preview_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        let good_a = preview_file(
            &preview_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        let good_b = preview_file(
            &preview_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        // A failed job's leftover file is prunable but doesn't eat a slot.
        let deleted = prune_preview_files(
            &canonical_dir,
            &[
                (failed.clone(), false),
                (good_a.clone(), true),
                (good_b.clone(), true),
            ],
            2,
        );
        assert_eq!(deleted, 1);
        assert!(!failed.exists());
        assert!(good_a.exists() && good_b.exists());
    }

    #[test]
    fn preview_cache_never_deletes_outside_or_non_preview_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let preview_dir = dir.path().join(GENERATED_PREVIEW_DIR);
        std::fs::create_dir_all(&preview_dir).unwrap();
        let canonical_dir = crate::path_policy::canonicalize_path(&preview_dir).unwrap();

        let sibling = dir.path().join("source.mp4");
        std::fs::write(&sibling, b"source").unwrap();
        let nested_dir = preview_dir.join("nested");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let nested = preview_file(
            &nested_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        let odd_name = preview_file(&preview_dir, "user-file.mp4");

        let deleted = prune_preview_files(
            &canonical_dir,
            &[
                (sibling.clone(), false),
                (nested.clone(), false),
                (odd_name.clone(), false),
            ],
            0,
        );
        assert_eq!(deleted, 0);
        assert!(sibling.exists() && nested.exists() && odd_name.exists());
    }

    #[cfg(unix)]
    #[test]
    fn preview_cache_rejects_symlinked_candidates() {
        let dir = tempfile::tempdir().expect("tempdir");
        let preview_dir = dir.path().join(GENERATED_PREVIEW_DIR);
        std::fs::create_dir_all(&preview_dir).unwrap();
        let canonical_dir = crate::path_policy::canonicalize_path(&preview_dir).unwrap();

        let outside = dir.path().join("outside.mp4");
        std::fs::write(&outside, b"keep").unwrap();
        let link = preview_dir.join(format!("preview-{}.mp4", uuid::Uuid::new_v4()));
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let deleted = prune_preview_files(&canonical_dir, &[(link.clone(), false)], 0);
        assert_eq!(deleted, 0);
        assert_eq!(std::fs::read(&outside).unwrap(), b"keep");
    }

    #[test]
    fn preview_cache_removes_owned_sidecars_with_output() {
        let dir = tempfile::tempdir().expect("tempdir");
        let preview_dir = dir.path().join(GENERATED_PREVIEW_DIR);
        std::fs::create_dir_all(&preview_dir).unwrap();
        let canonical_dir = crate::path_policy::canonicalize_path(&preview_dir).unwrap();

        let output = preview_file(
            &preview_dir,
            &format!("preview-{}.mp4", uuid::Uuid::new_v4()),
        );
        let srt = output.with_extension("srt");
        let vtt = output.with_extension("vtt");
        std::fs::write(&srt, b"srt").unwrap();
        std::fs::write(&vtt, b"vtt").unwrap();
        let orphan_sidecar = preview_dir.join("preview-other.srt");
        std::fs::write(&orphan_sidecar, b"orphan").unwrap();

        let deleted = prune_preview_files(&canonical_dir, &[(output.clone(), false)], 0);
        assert_eq!(deleted, 1);
        assert!(!output.exists() && !srt.exists() && !vtt.exists());
        // Sidecars without a matching owned output are never touched.
        assert!(orphan_sidecar.exists());
    }

    #[test]
    fn owned_preview_file_rejects_non_uuid_preview_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let preview_dir = dir.path().join(GENERATED_PREVIEW_DIR);
        std::fs::create_dir_all(&preview_dir).unwrap();
        let canonical_dir = crate::path_policy::canonicalize_path(&preview_dir).unwrap();

        // Prefix match but no UUID — a user's own preview-named file must
        // never be claimed by the cache prune.
        for name in ["preview-notes.mp4", "preview-.mp4", "preview-old"] {
            let file = preview_dir.join(name);
            std::fs::write(&file, b"user").unwrap();
            assert!(
                owned_preview_file(&canonical_dir, &file).is_none(),
                "{name} must not be owned"
            );
            assert!(file.exists());
        }
        let real = preview_dir.join(format!("preview-{}.mp4", uuid::Uuid::new_v4()));
        std::fs::write(&real, b"preview").unwrap();
        assert!(owned_preview_file(&canonical_dir, &real).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn owned_preview_dir_rejects_junction_redirect() {
        // mklink /J needs no elevation and is exactly the Windows reparse
        // point FileType::is_symlink misses.
        let dir = tempfile::tempdir().expect("tempdir");
        let work_dir = dir.path().join("work");
        std::fs::create_dir_all(&work_dir).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();

        let link = work_dir.join(GENERATED_PREVIEW_DIR);
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status()
            .expect("mklink /J");
        assert!(status.success());
        // Whether the reparse point reports `is_symlink` is toolchain-
        // dependent — the CANONICAL comparison is what proves the redirect:
        // the junction resolves to `outside`, not the lexical expected path.
        assert!(
            owned_preview_dir(&work_dir).is_err(),
            "junction redirect must be rejected"
        );
        std::fs::remove_dir(&link).unwrap();

        // Same for a junction pointing at ANOTHER child of the work dir.
        let inner = work_dir.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&inner)
            .status()
            .expect("mklink /J");
        assert!(status.success());
        assert!(
            owned_preview_dir(&work_dir).is_err(),
            "junction to a sibling dir must be rejected"
        );
        std::fs::remove_dir(&link).unwrap();

        // A real directory at the expected path is accepted.
        std::fs::create_dir_all(&link).unwrap();
        assert!(owned_preview_dir(&work_dir).is_ok());
    }
}
