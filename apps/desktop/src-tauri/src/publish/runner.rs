//! Runs one admitted publication job: owns the status transitions and emits
//! `publication-job-update` after every registry write so the jobs drawer,
//! toasts, and delivery cards all observe the SAME job row.

use std::future::Future;

use tracing::warn;

use crate::publish::hosted::WorkerOutcome;
use crate::publish::jobs::{CancelToken, PublicationJob, PublicationRegistry, PublicationStatus};

pub const PUBLICATION_JOB_EVENT: &str = "publication-job-update";

/// Spawn `worker` on the Tauri async runtime; every registry update emits
/// `publication-job-update` on `app`. The registry is the single ownership
/// row — the worker future returns an outcome, this runner applies it.
pub fn spawn_worker<F>(
    app: tauri::AppHandle,
    registry: std::sync::Arc<PublicationRegistry>,
    job_id: String,
    cancel: CancelToken,
    worker: F,
) where
    F: Future<Output = WorkerOutcome> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let outcome = worker.await;
        let updated = match outcome {
            WorkerOutcome::Completed(result, warnings) => {
                registry.complete(&job_id, result, warnings)
            }
            WorkerOutcome::Cancelled => registry.set_cancelled(&job_id),
            WorkerOutcome::Uncertain(message) => registry.set_uncertain(&job_id, message),
            WorkerOutcome::Failed(error) => registry.fail(&job_id, &error.code, error.message),
        };
        if let Some(job) = updated {
            emit(&app, &job);
        } else {
            warn!(job_id, "publication worker finished for an evicted job");
        }
        let _ = cancel;
    });
}

/// Push a status/byte progress step through the registry + event. Used as
/// the `ProgressSink` workers report into.
pub fn progress_sink(
    app: tauri::AppHandle,
    registry: std::sync::Arc<PublicationRegistry>,
    job_id: String,
) -> super::hosted::ProgressSink {
    std::sync::Arc::new(
        move |status: PublicationStatus, uploaded: u64, total: u64| {
            if let Some(job) = registry.set_status(&job_id, status, uploaded, total) {
                emit(&app, &job);
            }
        },
    )
}

fn emit(app: &tauri::AppHandle, job: &PublicationJob) {
    use tauri::Emitter;
    let _ = app.emit(PUBLICATION_JOB_EVENT, job);
}

/// Emit the initial admitted job so listeners see it before the worker's
/// first progress step.
pub fn emit_job(app: &tauri::AppHandle, job: &PublicationJob) {
    emit(app, job);
}
