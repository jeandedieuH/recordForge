//! Completed-export source resolution for publishing.
//!
//! Publishing NEVER accepts a caller-supplied media path, captions path, or
//! measurement array: every share/YouTube request names a finished `export`
//! job and the source is resolved from its persisted outputs. New exports
//! carry a frozen `outputs.artifact` manifest; legacy jobs can be inspected
//! ONCE from their present file + frozen request with `legacy=true` — the
//! provenance notice is theirs, original bytes are never retroactively
//! claimed as verified.

use std::path::{Path, PathBuf};

use crate::database::media::{self as media_db, MediaJob, MediaJobKind, MediaJobStatus};
use crate::errors::{AppError, ErrorCategory, Result};
use crate::exports::delivery_metadata::{
    capture_export_artifact, file_version, CaptureArtifactInput, ExportArtifactInfo,
};
use crate::jobs::ExportRequest as JobsExportRequest;

fn source_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::Storage, code, message.into())
}

/// A completed export's publishable source — validated file + frozen facts.
#[derive(Debug)]
pub struct ResolvedExportSource {
    pub job: MediaJob,
    pub path: PathBuf,
    /// Captions sidecar validated against the manifest's stored stamp — a
    /// stale or foreign sibling is never uploaded as this export's captions.
    pub captions_path: Option<PathBuf>,
    pub artifact: ExportArtifactInfo,
}

/// The persisted export request blob — needed for legacy backfill (plan,
/// settings, frozen project name).
fn persisted_request(job: &MediaJob) -> Result<JobsExportRequest> {
    serde_json::from_value(job.options.clone()).map_err(|error| {
        source_error(
            "export_source_invalid",
            format!("stored export request is unreadable: {error}"),
        )
    })
}

/// Resolve and authorize a finished export for publishing. `conn` must NOT
/// be held by the caller — the artifact backfill probes the file, which is
/// IO the DB lock should never wait on.
pub fn resolve_export_source(
    conn: &rusqlite::Connection,
    ffprobe_path: &Path,
    export_job_id: &str,
) -> Result<ResolvedExportSource> {
    let job = media_db::get_job(conn, export_job_id)?;
    if job.kind != MediaJobKind::Export || job.preview {
        return Err(source_error(
            "export_source_unsupported",
            "only real export outputs can be published",
        ));
    }
    if job.status != MediaJobStatus::Completed {
        return Err(source_error(
            "export_not_finished",
            "only a completed export can be published",
        ));
    }
    let output = job.outputs.output_path.as_deref().ok_or_else(|| {
        source_error(
            "export_source_missing",
            "the export record has no output file",
        )
    })?;
    let path = crate::path_policy::canonicalize_path(Path::new(output)).map_err(|error| {
        source_error(
            "export_source_invalid",
            format!("export path is not readable: {error}"),
        )
    })?;
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
    {
        return Err(source_error(
            "share_format_unsupported",
            "publishing supports MP4 exports only",
        ));
    }

    // Captions: ONLY the job's recorded generated sidecar — the sibling of
    // the published output, a regular file, matching the manifest stamp.
    let expected_sibling = path.with_extension("srt");
    let captions_path = resolve_recorded_captions(&job, &path, &expected_sibling)?;

    let artifact = match &job.outputs.artifact {
        Some(manifest) => {
            // A changed/missing output is actionable — never silently treated
            // as the recorded export.
            let current = file_version(&path).map_err(|_| {
                source_error(
                    "export_source_changed",
                    "the exported file changed since it finished — publish it again from the current file",
                )
            })?;
            if current != manifest.file_version {
                return Err(source_error(
                    "export_source_changed",
                    "the exported file changed since it finished — publish it again from the current file",
                ));
            }
            if let Some(captions_stamp) = &manifest.captions_version {
                match captions_path.as_deref().and_then(|p| file_version(p).ok()) {
                    Some(current_captions) if *captions_stamp == current_captions => {}
                    _ => {
                        return Err(source_error(
                            "export_captions_changed",
                            "the recorded captions sidecar changed — re-export to attach captions",
                        ))
                    }
                }
            }
            manifest.clone()
        }
        None => {
            // Legacy backfill: measure the present file ONCE with the frozen
            // request — provenance is honest (`legacy`), never a claim the
            // original bytes were verified.
            let request = persisted_request(&job)?;
            capture_export_artifact(CaptureArtifactInput {
                export_job_id: &job.id,
                project_name: request.project_name.as_deref().unwrap_or("Untitled export"),
                output_path: &path,
                captions_path: captions_path.as_deref(),
                ffprobe_path,
                plan: &request.plan,
                settings: &request.settings,
                legacy: true,
            })?
        }
    };

    Ok(ResolvedExportSource {
        job,
        path,
        captions_path,
        artifact,
    })
}

/// Captions come only from the job's recorded sidecar — never a caller path
/// or a same-named older file. An unrecorded or unreadable sidecar yields
/// None (captions are optional), but a RECORDED path that no longer matches
/// the expected sibling is an inconsistency worth surfacing.
fn resolve_recorded_captions(
    job: &MediaJob,
    output: &Path,
    expected_sibling: &Path,
) -> Result<Option<PathBuf>> {
    let Some(recorded) = job.outputs.captions_path.as_deref() else {
        return Ok(None);
    };
    let recorded_path = Path::new(recorded);
    // The persisted path must name the published output's OWN sibling — a
    // foreign or merely similarly-named file is never trusted.
    if !crate::exports::paths_refer_to_same_file(recorded_path, expected_sibling) {
        return Err(source_error(
            "export_captions_changed",
            "the recorded captions path does not belong to this export",
        ));
    }
    let canonical = crate::path_policy::canonicalize_path(recorded_path).map_err(|error| {
        source_error(
            "export_captions_changed",
            format!("the recorded captions sidecar is unreadable: {error}"),
        )
    })?;
    let metadata = std::fs::symlink_metadata(&canonical).map_err(|error| {
        source_error(
            "export_captions_changed",
            format!("the recorded captions sidecar is missing: {error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(source_error(
            "export_captions_changed",
            "the recorded captions path is not a regular file",
        ));
    }
    let _ = output;
    Ok(Some(canonical))
}

/// The current artifact manifest for one finished export — the read-only
/// `get_export_artifact` command path. Backfills legacy manifests without
/// writing them back (inspection, not persistence).
pub fn export_artifact_for_job(
    conn: &rusqlite::Connection,
    ffprobe_path: &Path,
    export_job_id: &str,
) -> Result<ExportArtifactInfo> {
    Ok(resolve_export_source(conn, ffprobe_path, export_job_id)?.artifact)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::media::{complete_job, insert_job, MediaJobKind, MediaJobOutputs};

    fn test_conn() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::database::migrations::run_migrations(&mut conn).unwrap();
        conn
    }

    fn fake_ffprobe() -> PathBuf {
        // Guard rails below never reach ffprobe — a missing binary is fine.
        PathBuf::from("no-such-ffprobe")
    }

    #[test]
    fn a_nonexistent_job_is_a_source_error_not_a_panic() {
        let conn = test_conn();
        let err = export_artifact_for_job(&conn, Path::new("ffprobe"), "missing-job")
            .expect_err("missing job must fail");
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn rejects_non_export_kind_even_when_completed() {
        let conn = test_conn();
        let job = insert_job(&conn, "recording-1", MediaJobKind::Prepare).expect("insert prepare");
        complete_job(&conn, &job.id, &MediaJobOutputs::default()).expect("complete prepare");
        let err =
            resolve_export_source(&conn, &fake_ffprobe(), &job.id).expect_err("kind must fail");
        assert_eq!(err.code, "export_source_unsupported");
    }

    #[test]
    fn rejects_an_export_job_that_is_not_completed() {
        let conn = test_conn();
        let job = insert_job(&conn, "recording-1", MediaJobKind::Export).expect("insert export");
        let err =
            resolve_export_source(&conn, &fake_ffprobe(), &job.id).expect_err("status must fail");
        assert_eq!(err.code, "export_not_finished");
    }

    #[test]
    fn rejects_an_export_job_with_a_missing_output() {
        let conn = test_conn();
        let job = insert_job(&conn, "recording-1", MediaJobKind::Export).expect("insert export");
        complete_job(
            &conn,
            &job.id,
            &MediaJobOutputs {
                output_path: Some("C:/definitely/missing/output.mp4".to_string()),
                ..Default::default()
            },
        )
        .expect("complete export");
        let err =
            resolve_export_source(&conn, &fake_ffprobe(), &job.id).expect_err("file must fail");
        assert_eq!(err.code, "export_source_invalid");
    }

    #[test]
    fn file_version_stamps_change_with_bytes_not_time() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("captions.srt");
        std::fs::write(&path, b"1\n00:00:01,000 --> 00:00:02,000\nHi\n").expect("write srt");
        let v1 = file_version(&path).expect("stamp");
        assert_eq!(file_version(&path).expect("restamp"), v1);
        // Same bytes → same stamp; different bytes → different stamp.
        std::fs::write(&path, b"1\n00:00:01,000 --> 00:00:02,000\nBye\n").expect("rewrite srt");
        assert_ne!(file_version(&path).expect("stamp2"), v1);
        // A missing file fails — stamps never invent a file.
        assert!(file_version(&dir.path().join("gone.srt")).is_err());
    }
}
