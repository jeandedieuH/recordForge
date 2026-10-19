//! Native publication-job registry.
//!
//! Every Instant Share / BYO / YouTube operation is admitted here BEFORE the
//! worker starts: the command returns the admitted job immediately and the
//! worker owns updates for its whole lifetime. `operationId` is an
//! idempotency key — the same id with the same frozen request returns the
//! existing job; a different request reusing the id is invalid. One active
//! operation per provider; at most `MAX_TERMINAL` terminal results retained,
//! never evicting active work.
//!
//! Cancellation is a shared token (`AtomicBool` flag + `Notify`) so an
//! in-flight HTTP send or a backoff sleep aborts promptly, not only between
//! 8 MiB chunks. Cancelling an operation whose provider work already
//! completed surfaces the CONFIRMED result, never a fabricated cancellation.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, ErrorCategory, InternalError, Result};

/// Providers the publication surface distinguishes in events/UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PublicationProvider {
    Hosted,
    S3,
    YouTube,
}

/// Lifecycle — mirrors PublicationJob in packages/contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PublicationStatus {
    Checking,
    Uploading,
    Finalizing,
    AttachingCaptions,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    /// Provider state could not be determined — e.g. the finalization
    /// response was lost. Never auto-retried; the user decides.
    Uncertain,
}

impl PublicationStatus {
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            PublicationStatus::Checking
                | PublicationStatus::Uploading
                | PublicationStatus::Finalizing
                | PublicationStatus::AttachingCaptions
                | PublicationStatus::Cancelling
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationShareResult {
    pub share_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationYouTubeResult {
    pub video_id: String,
    pub url: String,
    pub captions_attached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PublicationResult {
    #[serde(rename = "share")]
    Share(PublicationShareResult),
    #[serde(rename = "youtube")]
    YouTube(PublicationYouTubeResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationJob {
    pub id: String,
    pub export_job_id: String,
    pub provider: PublicationProvider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub status: PublicationStatus,
    pub uploaded_bytes: u64,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<PublicationResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PublicationError>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// The idempotency key — returned for correlation, never user-visible.
    pub operation_id: String,
    /// Admission time (epoch ms) — the only chronological ordering the
    /// registry has; job ids are random UUIDs.
    pub admitted_at_ms: u64,
}

/// Shared cancellation — an atomic flag for cheap polling plus a Notify so
/// async waits (backoff sleeps, uploads) abort immediately.
#[derive(Clone, Debug)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl CancelToken {
    fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Race a cancellable wait: returns true when the sleep elapsed, false
    /// when cancellation landed first.
    pub async fn wait(&self, duration: std::time::Duration) -> bool {
        tokio::time::timeout(duration, self.notify.notified())
            .await
            .is_err()
    }
}

const MAX_TERMINAL: usize = 100;

struct PublicationInner {
    jobs: HashMap<String, PublicationJob>,
    /// operationId → jobId — idempotency map.
    by_operation: HashMap<String, String>,
    /// operationId → frozen request fingerprint — a reused id with a
    /// DIFFERENT request is invalid, not idempotent.
    op_fingerprints: HashMap<String, String>,
    /// provider → active jobId — one running operation per provider.
    active: HashMap<PublicationProvider, String>,
    tokens: HashMap<String, CancelToken>,
    terminal_order: VecDeque<String>,
}

pub struct PublicationRegistry {
    inner: Mutex<PublicationInner>,
}

impl std::fmt::Debug for PublicationRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublicationRegistry")
            .finish_non_exhaustive()
    }
}

fn publication_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::Storage, code, message.into())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PublicationRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(PublicationInner {
                jobs: HashMap::new(),
                by_operation: HashMap::new(),
                op_fingerprints: HashMap::new(),
                active: HashMap::new(),
                tokens: HashMap::new(),
                terminal_order: VecDeque::new(),
            }),
        }
    }

    /// Admit a publication operation. Returns `(job, token, is_new)` — a
    /// replayed identical request returns the existing job with `is_new =
    /// false` and the caller must NOT spawn a second worker.
    pub fn begin(
        &self,
        operation_id: &str,
        export_job_id: &str,
        provider: PublicationProvider,
        profile_id: Option<String>,
        request_fingerprint: &str,
        total_bytes: u64,
    ) -> Result<(PublicationJob, CancelToken, bool)> {
        if uuid::Uuid::parse_str(operation_id).is_err() {
            return Err(publication_error(
                "publication_operation_invalid",
                "publication operation id must be a UUID",
            ));
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| InternalError::Unknown("publication registry poisoned".into()))?;

        if let Some(existing_id) = inner.by_operation.get(operation_id) {
            if inner.op_fingerprints.get(operation_id).map(String::as_str)
                != Some(request_fingerprint)
            {
                return Err(publication_error(
                    "publication_operation_conflict",
                    "this operation id was already used for a different publish request",
                ));
            }
            let job = inner
                .jobs
                .get(existing_id)
                .cloned()
                .ok_or_else(|| InternalError::Storage("publication job lost".into()))?;
            let token = inner
                .tokens
                .get(existing_id)
                .cloned()
                .unwrap_or_else(CancelToken::new);
            return Ok((job, token, false));
        }

        // One active operation per provider — a second provider job gets an
        // honest busy error, never silently cancels the first.
        if let Some(running) = inner.active.get(&provider) {
            return Err(publication_error(
                "publication_busy",
                format!(
                    "a {provider:?} publish is already running ({running}) — wait for it or cancel it first"
                ),
            ));
        }

        let job = PublicationJob {
            id: uuid::Uuid::new_v4().to_string(),
            export_job_id: export_job_id.to_string(),
            provider,
            profile_id,
            status: PublicationStatus::Checking,
            uploaded_bytes: 0,
            total_bytes,
            result: None,
            error: None,
            warnings: Vec::new(),
            operation_id: operation_id.to_string(),
            admitted_at_ms: now_ms(),
        };
        let token = CancelToken::new();
        inner.jobs.insert(job.id.clone(), job.clone());
        inner
            .by_operation
            .insert(operation_id.to_string(), job.id.clone());
        inner
            .op_fingerprints
            .insert(operation_id.to_string(), request_fingerprint.to_string());
        inner.active.insert(provider, job.id.clone());
        inner.tokens.insert(job.id.clone(), token.clone());
        Ok((job, token, true))
    }

    fn update_with<F>(&self, job_id: &str, mutate: F) -> Option<PublicationJob>
    where
        F: FnOnce(&mut PublicationJob),
    {
        let mut inner = self.inner.lock().ok()?;
        let job = inner.jobs.get_mut(job_id)?;
        mutate(job);
        Some(job.clone())
    }

    pub fn set_status(
        &self,
        job_id: &str,
        status: PublicationStatus,
        uploaded_bytes: u64,
        total_bytes: u64,
    ) -> Option<PublicationJob> {
        self.update_with(job_id, |job| {
            job.status = status;
            job.uploaded_bytes = uploaded_bytes;
            job.total_bytes = total_bytes;
        })
    }

    /// Drive `job` to a terminal state and release the provider slot. A
    /// cancel requested while the worker runs resolves to `Cancelled` here;
    /// a cancel AFTER confirmed completion resolves to `Completed` with the
    /// real result.
    fn finish_with<F>(
        &self,
        job_id: &str,
        status: PublicationStatus,
        mutate: F,
    ) -> Option<PublicationJob>
    where
        F: FnOnce(&mut PublicationJob),
    {
        let mut inner = self.inner.lock().ok()?;
        {
            let job = inner.jobs.get_mut(job_id)?;
            job.status = status;
            mutate(job);
        }
        let provider = inner.jobs.get(job_id)?.provider;
        if inner.active.get(&provider).map(String::as_str) == Some(job_id) {
            inner.active.remove(&provider);
        }
        // Terminal results are bounded; active work is never evicted.
        inner.terminal_order.push_back(job_id.to_string());
        while inner.terminal_order.len() > MAX_TERMINAL {
            if let Some(oldest) = inner.terminal_order.pop_front() {
                if inner
                    .jobs
                    .get(&oldest)
                    .is_some_and(|job| !job.status.is_active())
                {
                    inner.jobs.remove(&oldest);
                    inner.tokens.remove(&oldest);
                    inner.op_fingerprints.retain(|_, id| *id != oldest);
                    inner.by_operation.retain(|_, id| *id != oldest);
                }
            } else {
                break;
            }
        }
        inner.jobs.get(job_id).cloned()
    }

    pub fn complete(
        &self,
        job_id: &str,
        result: PublicationResult,
        warnings: Vec<String>,
    ) -> Option<PublicationJob> {
        self.finish_with(job_id, PublicationStatus::Completed, |job| {
            job.result = Some(result);
            job.warnings = warnings;
        })
    }

    pub fn fail(
        &self,
        job_id: &str,
        code: &str,
        message: impl Into<String>,
    ) -> Option<PublicationJob> {
        let message = message.into();
        self.finish_with(job_id, PublicationStatus::Failed, |job| {
            job.error = Some(PublicationError {
                code: code.to_string(),
                message,
            });
        })
    }

    pub fn set_uncertain(
        &self,
        job_id: &str,
        message: impl Into<String>,
    ) -> Option<PublicationJob> {
        let message = message.into();
        self.finish_with(job_id, PublicationStatus::Uncertain, |job| {
            job.error = Some(PublicationError {
                code: "publication_uncertain".to_string(),
                message,
            });
        })
    }

    pub fn set_cancelled(&self, job_id: &str) -> Option<PublicationJob> {
        self.finish_with(job_id, PublicationStatus::Cancelled, |_job| {})
    }

    /// Request cancellation: flips status to `cancelling` while the worker
    /// still owns the job (the operation remains active until its worker
    /// ends), then signals the shared token.
    pub fn request_cancel(&self, job_id: &str) -> Result<PublicationJob> {
        let token = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| InternalError::Unknown("publication registry poisoned".into()))?;
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return Err(publication_error(
                    "publication_job_missing",
                    "publication job not found",
                ));
            };
            if !job.status.is_active() {
                return Ok(job.clone());
            }
            if job.status != PublicationStatus::Cancelling {
                job.status = PublicationStatus::Cancelling;
            }
            inner.tokens.get(job_id).cloned()
        };
        if let Some(token) = token {
            token.cancel();
        }
        self.get(job_id)
            .ok_or_else(|| InternalError::Storage("publication job lost".into()).into())
    }

    pub fn get(&self, job_id: &str) -> Option<PublicationJob> {
        let inner = self.inner.lock().ok()?;
        inner.jobs.get(job_id).cloned()
    }

    pub fn list(&self) -> Vec<PublicationJob> {
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        let mut jobs: Vec<PublicationJob> = inner.jobs.values().cloned().collect();
        // Newest first — UUIDs are random, so the admitted timestamp orders.
        jobs.sort_by(|a, b| {
            b.admitted_at_ms
                .cmp(&a.admitted_at_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        jobs
    }
}

impl Default for PublicationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin(
        registry: &PublicationRegistry,
        op: &str,
        provider: PublicationProvider,
        fingerprint: &str,
    ) -> Result<(PublicationJob, CancelToken, bool)> {
        registry.begin(op, "exp-1", provider, None, fingerprint, 1024)
    }

    #[test]
    fn same_operation_replays_the_admitted_job() {
        let registry = PublicationRegistry::new();
        let op = uuid::Uuid::new_v4().to_string();
        let (job, _, is_new) = begin(&registry, &op, PublicationProvider::Hosted, "req-a").unwrap();
        assert!(is_new);
        let (replayed, _, is_new2) =
            begin(&registry, &op, PublicationProvider::Hosted, "req-a").unwrap();
        assert!(!is_new2);
        assert_eq!(job.id, replayed.id);
    }

    #[test]
    fn a_reused_operation_id_with_a_different_request_is_invalid() {
        let registry = PublicationRegistry::new();
        let op = uuid::Uuid::new_v4().to_string();
        begin(&registry, &op, PublicationProvider::Hosted, "req-a").unwrap();
        let err = begin(&registry, &op, PublicationProvider::Hosted, "req-b")
            .expect_err("different request must conflict");
        assert!(err.to_string().contains("publication_operation_conflict"));
    }

    #[test]
    fn one_active_operation_per_provider() {
        let registry = PublicationRegistry::new();
        begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "a",
        )
        .unwrap();
        let err = begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "b",
        )
        .expect_err("second hosted op must be busy");
        assert!(err.to_string().contains("publication_busy"));
        // A different provider is independent.
        begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::YouTube,
            "c",
        )
        .unwrap();
    }

    #[test]
    fn completion_releases_the_provider_slot() {
        let registry = PublicationRegistry::new();
        let (job, _, _) = begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "a",
        )
        .unwrap();
        registry.complete(
            &job.id,
            PublicationResult::Share(PublicationShareResult {
                share_id: "s".into(),
                url: "https://example/s".into(),
            }),
            Vec::new(),
        );
        begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "b",
        )
        .unwrap();
    }

    #[test]
    fn terminal_results_are_bounded_but_active_work_is_never_evicted() {
        let registry = PublicationRegistry::new();
        let mut ids = Vec::new();
        for _ in 0..(MAX_TERMINAL + 3) {
            let (job, _, _) = begin(
                &registry,
                &uuid::Uuid::new_v4().to_string(),
                PublicationProvider::Hosted,
                "x",
            )
            .unwrap();
            registry.set_cancelled(&job.id);
            ids.push(job.id);
        }
        // Only the newest 100 terminal jobs are retained.
        assert!(registry.get(&ids[0]).is_none());
        assert!(registry.get(&ids[2]).is_none());
        assert!(registry.get(ids.last().unwrap()).is_some());

        // An ACTIVE job is never evicted no matter how many terminal jobs
        // pile up behind it.
        let (active, _, _) = begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "still-running",
        )
        .unwrap();
        for _ in 0..MAX_TERMINAL {
            let (job, _, _) = begin(
                &registry,
                &uuid::Uuid::new_v4().to_string(),
                PublicationProvider::YouTube,
                "y",
            )
            .unwrap();
            registry.set_cancelled(&job.id);
        }
        assert!(registry.get(&active.id).is_some());
    }

    #[test]
    fn cancel_keeps_ownership_until_the_worker_ends() {
        let registry = PublicationRegistry::new();
        let (job, token, _) = begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "a",
        )
        .unwrap();
        let mid = registry.request_cancel(&job.id).unwrap();
        assert_eq!(mid.status, PublicationStatus::Cancelling);
        assert!(token.is_cancelled());
        // The provider slot stays occupied — a second op is still busy
        // while the worker unwinds.
        let err = begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "b",
        )
        .expect_err("cancel in flight still busy");
        assert!(err.to_string().contains("publication_busy"));
        registry.set_cancelled(&job.id);
        begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "b",
        )
        .unwrap();
    }

    #[test]
    fn cancel_on_a_terminal_job_is_a_noop_returning_that_job() {
        let registry = PublicationRegistry::new();
        let (job, _, _) = begin(
            &registry,
            &uuid::Uuid::new_v4().to_string(),
            PublicationProvider::Hosted,
            "a",
        )
        .unwrap();
        registry.set_cancelled(&job.id);
        let after = registry.request_cancel(&job.id).unwrap();
        assert_eq!(after.status, PublicationStatus::Cancelled);
    }
}
