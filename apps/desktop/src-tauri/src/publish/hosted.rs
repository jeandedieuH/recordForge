//! Hosted Instant Share worker — multipart upload → complete.
//!
//! The protocol invariants are checked BEFORE a byte is uploaded: the part
//! count must match `ceil(bytes/PART_SIZE)` exactly (a bogus plan is
//! `share_upload_invalid`, never a mid-flight surprise), each part URL must
//! be HTTPS (loopback HTTP accepted for tests), and every part PUT must
//! return a nonempty `ETag` or the upload fails — a missing ETag means the
//! object was never persisted and completing would corrupt the share.
//!
//! The complete-multipart reply is parsed structurally (roxmltree), not
//! string-matched: `NoSuchUpload`/`AccessDenied`/`MalformedXML`/`InvalidPart`
//! bodies all fail, and a 200 reply with no `<CompleteMultipartUploadResult>`
//! is a protocol violation. When the finalization reply is lost the worker
//! queries the owner share list — a share that appears completes the job; a
//! missing share reports `Uncertain`, never silently retried.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use reqwest::StatusCode;
use tracing::{info, warn};

use crate::errors::{AppError, ErrorCategory, Result};
use crate::licensing::client::{LicenseClient, ShareCreateResponse};
use crate::publish::jobs::{
    CancelToken, PublicationResult, PublicationShareResult, PublicationStatus,
};

/// Multipart chunk size — MUST stay in sync with `SHARE_PART_SIZE` in
/// recordforge-cloud/convex/r2.ts; the server presigns exactly
/// `ceil(bytes/SHARE_PART_SIZE)` part URLs.
pub const SHARE_PART_SIZE: u64 = 8 * 1024 * 1024;
/// Presigned plans never exceed this bound — the product budget is far
/// below S3's 10 000-part limit.
const MAX_PARTS: u64 = 1_024;
/// Manifest product caps — checked before reserving so an oversized export
/// fails fast instead of uploading into a 413.
pub const SHARE_MAX_DURATION_MS: u64 = 600_000;
pub const SHARE_MAX_PIXELS: u64 = 1920 * 1080;
pub const SHARE_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const RETRY_ATTEMPTS: u32 = 3;
const MAX_RETRY_AFTER_SECS: u64 = 30;

fn share_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::Storage, code, message.into())
}

fn is_cancelled_error(error: &AppError) -> bool {
    error.code == "publication_cancelled"
}

/// What a share worker reports back to the runner that owns the job row.
pub enum WorkerOutcome {
    Completed(PublicationResult, Vec<String>),
    Cancelled,
    Failed(AppError),
    /// Provider state could not be determined — surfaced verbatim to the
    /// user; never auto-retried.
    Uncertain(String),
}

/// Progress step reported through the registry: `(status, uploaded, total)`.
pub type ProgressSink = Arc<dyn Fn(PublicationStatus, u64, u64) + Send + Sync>;

/// Everything the worker needs — the reservation is made at ADMISSION so a
/// retried operation never double-reserves.
pub struct HostedShareInput {
    pub client: LicenseClient,
    pub license_token: String,
    pub video_path: PathBuf,
    pub captions_path: Option<PathBuf>,
    pub created: ShareCreateResponse,
    pub bytes: u64,
    pub progress: ProgressSink,
    pub cancel: CancelToken,
}

fn ensure_not_cancelled(cancel: &CancelToken) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(share_error(
            "publication_cancelled",
            "publish was cancelled",
        ));
    }
    Ok(())
}

/// The part-URL plan must be self-consistent with the measured byte count —
/// a server bug or a tampered response that presigns the wrong count would
/// otherwise corrupt the object at completion.
pub fn validate_upload_plan(plan: &ShareCreateResponse, bytes: u64) -> Result<u32> {
    let want = bytes.div_ceil(SHARE_PART_SIZE);
    let got = plan.upload.part_urls.len() as u64;
    if got == 0 || got > MAX_PARTS || got != want {
        return Err(share_error(
            "share_upload_invalid",
            format!("share plan presigns {got} parts but {bytes} bytes requires {want}"),
        ));
    }
    for url in &plan.upload.part_urls {
        let https = url.starts_with("https://");
        let loopback = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
        if !https && !loopback {
            return Err(share_error(
                "share_upload_invalid",
                "share plan contains a non-HTTPS part URL",
            ));
        }
    }
    Ok(got as u32)
}

/// Retry-After hint → a bounded sleep. Missing/unparseable → default backoff.
fn retry_after(response: &reqwest::Response) -> Option<std::time::Duration> {
    let raw = response.headers().get("retry-after")?.to_str().ok()?;
    let secs = raw.parse::<u64>().ok()?;
    Some(std::time::Duration::from_secs(
        secs.min(MAX_RETRY_AFTER_SECS),
    ))
}

enum SendResult {
    Ok(reqwest::Response),
    /// Transport-level failure where the reply never arrived — callers that
    /// depend on confirmation (finalize) must treat this as possibly
    /// persisted.
    LostResponse,
}

/// One request with the shared retry policy: bounded attempts, cancellable
/// backoff, Retry-After honoring on 429/5xx. A cancelled sleep aborts.
async fn send_with_retries<F>(
    cancel: &CancelToken,
    build: F,
    label: &str,
) -> std::result::Result<SendResult, AppError>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut last_error: Option<AppError> = None;
    let mut lost = false;
    for attempt in 1..=RETRY_ATTEMPTS {
        if cancel.is_cancelled() {
            return Err(share_error(
                "publication_cancelled",
                "publish was cancelled",
            ));
        }
        match build().send().await {
            Ok(response) if response.status().is_success() => return Ok(SendResult::Ok(response)),
            Ok(response) => {
                let status = response.status();
                let retry_hint = retry_after(&response);
                let body = response.text().await.unwrap_or_default();
                last_error = Some(share_error(
                    "share_upload_failed",
                    format!("{label} rejected ({status}): {body}"),
                ));
                let retryable = status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
                if !retryable || attempt == RETRY_ATTEMPTS {
                    break;
                }
                let delay = retry_hint
                    .unwrap_or_else(|| std::time::Duration::from_millis(500 * attempt as u64));
                if !cancel.wait(delay).await {
                    return Err(share_error(
                        "publication_cancelled",
                        "publish was cancelled",
                    ));
                }
            }
            Err(error) => {
                lost = true;
                last_error = Some(share_error(
                    "share_upload_failed",
                    format!("{label} upload failed: {error}"),
                ));
                if attempt == RETRY_ATTEMPTS {
                    break;
                }
                if !cancel
                    .wait(std::time::Duration::from_millis(500 * attempt as u64))
                    .await
                {
                    return Err(share_error(
                        "publication_cancelled",
                        "publish was cancelled",
                    ));
                }
            }
        }
    }
    if lost && last_error.is_none() {
        return Ok(SendResult::LostResponse);
    }
    if lost {
        return Ok(SendResult::LostResponse);
    }
    Err(last_error.unwrap_or_else(|| share_error("share_upload_failed", format!("{label} failed"))))
}

/// Upload the video's multipart parts — each bounded to its declared size
/// and requiring a nonempty ETag. Returns the ordered ETags for the
/// complete-multipart XML.
#[allow(clippy::too_many_arguments)]
async fn upload_parts(
    http: &reqwest::Client,
    file_path: &Path,
    bytes: u64,
    part_urls: &[String],
    progress: &ProgressSink,
    token: &str,
    client: &LicenseClient,
    share_id: &str,
    cancel: &CancelToken,
) -> Result<Vec<String>> {
    use std::io::Read;
    let file = std::fs::File::open(file_path).map_err(|error| {
        share_error(
            "share_file_missing",
            format!("export is not readable: {error}"),
        )
    })?;
    let mut reader = std::io::BufReader::new(file);
    let mut etags = Vec::with_capacity(part_urls.len());

    for (index, part_url) in part_urls.iter().enumerate() {
        ensure_not_cancelled(cancel)?;
        let is_last = index == part_urls.len() - 1;
        let want = if is_last {
            bytes - (index as u64 * SHARE_PART_SIZE)
        } else {
            SHARE_PART_SIZE
        };
        // Bounded read — exactly the part size the plan declared.
        let mut chunk = vec![0u8; want as usize];
        reader.read_exact(&mut chunk).map_err(|error| {
            share_error(
                "share_read_failed",
                format!("could not read export data: {error}"),
            )
        })?;

        let response = match send_with_retries(
            cancel,
            || {
                http.put(part_url)
                    .timeout(UPLOAD_TIMEOUT)
                    .header("Content-Type", "video/mp4")
                    .body(chunk.clone())
            },
            &format!("part {}", index + 1),
        )
        .await?
        {
            SendResult::Ok(response) => response,
            SendResult::LostResponse => {
                return Err(share_error(
                    "share_upload_failed",
                    format!("part {} upload reply was lost", index + 1),
                ))
            }
        };

        // A PUT without an ETag did not persist the object — completing the
        // upload with an empty ETag would corrupt the share.
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                share_error(
                    "share_upload_failed",
                    format!("part {} returned no ETag", index + 1),
                )
            })?;
        etags.push(etag);

        let parts_done = index as u32 + 1;
        let uploaded = ((parts_done as u64) * SHARE_PART_SIZE).min(bytes);
        progress(PublicationStatus::Uploading, uploaded, bytes);
        // Best-effort viewer progress — a failed report never fails the job.
        if let Err(error) = client.share_progress(token, share_id, parts_done).await {
            warn!(error = %error, "share progress report failed");
        }
    }
    Ok(etags)
}

/// Upload the optional captions sidecar — `.srt` converts to WebVTT through
/// the SHARED export converter (cue text must stay `&` `<` `>`-escaped for
/// the browser `<track>` renderer).
async fn upload_captions(
    http: &reqwest::Client,
    captions_path: &Path,
    put_url: &str,
    cancel: &CancelToken,
) -> Result<()> {
    let raw = std::fs::read_to_string(captions_path)
        .map_err(|error| share_error("share_captions_failed", format!("{error}")))?;
    let body = if captions_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("srt"))
    {
        crate::exports::srt_to_vtt(&raw)
    } else {
        raw
    };
    send_with_retries(
        cancel,
        || {
            http.put(put_url)
                .timeout(UPLOAD_TIMEOUT)
                .header("Content-Type", "text/vtt")
                .body(body.clone())
        },
        "captions",
    )
    .await?;
    Ok(())
}

/// Parse the complete-multipart reply structurally: a success carries
/// `<CompleteMultipartUploadResult>`; an S3 error body carries `<Error>`;
/// anything else is a protocol violation.
fn complete_response_is_ok(body: &str) -> Result<()> {
    let document = roxmltree::Document::parse(body).map_err(|error| {
        share_error(
            "share_finalize_failed",
            format!("complete-multipart response is not valid XML: {error}"),
        )
    })?;
    if document
        .root_element()
        .has_tag_name("CompleteMultipartUploadResult")
    {
        return Ok(());
    }
    if document.root_element().has_tag_name("Error") {
        let code = document
            .descendants()
            .find(|node| node.has_tag_name("Code"))
            .and_then(|node| node.text())
            .unwrap_or("unknown");
        return Err(share_error(
            "share_finalize_failed",
            format!("R2 rejected the upload completion ({code})"),
        ));
    }
    Err(share_error(
        "share_finalize_failed",
        "complete-multipart response had no result document",
    ))
}

fn complete_xml(etags: &[String]) -> String {
    etags.iter().enumerate().fold(
        String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
        ),
        |mut acc, (index, etag)| {
            acc.push_str(&format!(
                "<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>",
                index + 1,
                etag
            ));
            acc
        },
    ) + "</CompleteMultipartUpload>"
}

/// The full hosted-share worker. Callers own the publication job row; the
/// worker returns an outcome, never mutates the registry itself.
pub async fn run_hosted_share(input: HostedShareInput) -> WorkerOutcome {
    let http = match reqwest::Client::builder().timeout(UPLOAD_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => {
            return WorkerOutcome::Failed(share_error(
                "share_upload_failed",
                format!("HTTP client: {error}"),
            ))
        }
    };

    match run_inner(&input, &http).await {
        Ok(FinalizeReply::Complete) => WorkerOutcome::Completed(
            PublicationResult::Share(PublicationShareResult {
                share_id: input.created.share_id.clone(),
                url: input.created.url.clone(),
            }),
            Vec::new(),
        ),
        Ok(FinalizeReply::Lost) => {
            // The finalization reply vanished — query the owner list ONCE.
            // A share that shows up persisted; a missing share is honest
            // uncertainty, never a fabricated failure or retry.
            match input.client.share_list(&input.license_token).await {
                Ok(shares)
                    if shares
                        .iter()
                        .any(|share| share.share_id == input.created.share_id) =>
                {
                    info!(share_id = %input.created.share_id, "lost finalize reply recovered via share list");
                    WorkerOutcome::Completed(
                        PublicationResult::Share(PublicationShareResult {
                            share_id: input.created.share_id.clone(),
                            url: input.created.url.clone(),
                        }),
                        Vec::new(),
                    )
                }
                _ => WorkerOutcome::Uncertain(
                    "the upload finished but the final confirmation was lost — check Shared links; the share may be live"
                        .to_string(),
                ),
            }
        }
        Err(error) if is_cancelled_error(&error) => WorkerOutcome::Cancelled,
        Err(error) => WorkerOutcome::Failed(error),
    }
}

enum FinalizeReply {
    Complete,
    /// At least one confirmation send lost its reply — the object may have
    /// persisted.
    Lost,
}

async fn run_inner(input: &HostedShareInput, http: &reqwest::Client) -> Result<FinalizeReply> {
    let created = &input.created;
    let parts_total = validate_upload_plan(created, input.bytes)?;
    info!(share_id = %created.share_id, parts_total, bytes = input.bytes, "share upload started");
    (input.progress)(PublicationStatus::Uploading, 0, input.bytes);

    let etags = upload_parts(
        http,
        &input.video_path,
        input.bytes,
        &created.upload.part_urls,
        &input.progress,
        &input.license_token,
        &input.client,
        &created.share_id,
        &input.cancel,
    )
    .await?;

    if let (Some(caption_path), Some(put_url)) = (
        input.captions_path.as_ref(),
        created.upload.captions_put_url.as_ref(),
    ) {
        upload_captions(http, caption_path, put_url, &input.cancel).await?;
    }

    // Finalize on R2: structural XML check under the shared retry policy; a
    // lost reply is recoverable information, not an automatic failure.
    (input.progress)(PublicationStatus::Finalizing, input.bytes, input.bytes);
    let mut reply_lost = false;
    match send_with_retries(
        &input.cancel,
        || {
            http.post(&created.upload.complete_url)
                .timeout(UPLOAD_TIMEOUT)
                .header("Content-Type", "application/xml")
                .body(complete_xml(&etags))
        },
        "complete-multipart",
    )
    .await?
    {
        SendResult::Ok(response) => {
            let body = response
                .text()
                .await
                .map_err(|error| share_error("share_finalize_failed", format!("{error}")))?;
            complete_response_is_ok(&body)?;
        }
        SendResult::LostResponse => reply_lost = true,
    }

    // Flip the share live on the license server — the final owned step.
    if let Err(error) = input
        .client
        .share_complete(&input.license_token, &created.share_id, input.bytes)
        .await
    {
        // `share_complete` transport failure is the same lost-confirmation
        // shape: the R2 object may already be assembled.
        if error.to_string().contains("publication_cancelled") {
            return Err(error);
        }
        reply_lost = true;
    }
    info!(share_id = %created.share_id, "share upload complete");
    Ok(if reply_lost {
        FinalizeReply::Lost
    } else {
        FinalizeReply::Complete
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_validation_requires_exact_part_count() {
        let make = |urls: Vec<String>| ShareCreateResponse {
            share_id: "s".into(),
            url: "https://example/s".into(),
            upload: crate::licensing::client::ShareUploadPlan {
                upload_id: String::new(),
                part_urls: urls,
                complete_url: "https://r2/complete".into(),
                captions_put_url: None,
            },
        };
        // 8 MiB + 1 byte → exactly 2 parts.
        assert_eq!(
            validate_upload_plan(
                &make(vec!["https://r2/1".into(), "https://r2/2".into()]),
                SHARE_PART_SIZE + 1
            )
            .unwrap(),
            2
        );
        assert!(
            validate_upload_plan(&make(vec!["https://r2/1".into()]), SHARE_PART_SIZE + 1).is_err()
        );
        assert!(validate_upload_plan(&make(vec![]), 1).is_err());
        // HTTP part URLs are rejected (loopback test origin excepted).
        assert!(validate_upload_plan(&make(vec!["http://r2/1".into()]), SHARE_PART_SIZE).is_err());
        assert!(
            validate_upload_plan(&make(vec!["http://127.0.0.1:9/1".into()]), SHARE_PART_SIZE)
                .is_ok()
        );
    }

    #[test]
    fn complete_reply_parsing_is_structural() {
        assert!(complete_response_is_ok(
            r#"<CompleteMultipartUploadResult><ETag>abc</ETag></CompleteMultipartUploadResult>"#
        )
        .is_ok());
        // S3 error bodies fail even at HTTP 200.
        assert!(complete_response_is_ok("<Error><Code>NoSuchUpload</Code></Error>").is_err());
        assert!(complete_response_is_ok("<Error><Code>InvalidPart</Code></Error>").is_err());
        // Malformed XML and unrelated documents fail.
        assert!(complete_response_is_ok("<CompleteMultipartUploadResult>").is_err());
        assert!(complete_response_is_ok("<html>nope</html>").is_err());
        assert!(complete_response_is_ok("").is_err());
    }

    #[test]
    fn complete_xml_is_well_formed() {
        let xml = complete_xml(&["\"etag-a\"".into(), "\"etag-b\"".into()]);
        let doc = roxmltree::Document::parse(&xml).unwrap();
        assert!(doc.root_element().has_tag_name("CompleteMultipartUpload"));
        let parts: Vec<_> = doc
            .descendants()
            .filter(|node| node.has_tag_name("PartNumber"))
            .collect();
        assert_eq!(parts.len(), 2);
    }
}
