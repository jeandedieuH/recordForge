//! Star-rating + written review submission.
//!
//! Reviews land in the marketing site's `reviews` table (Convex) via
//! `POST /api/reviews` and stay invisible until moderated — nothing here is
//! security-sensitive. The webview CSP blocks external fetches, so like the
//! license client this runs in Rust; `tier`/`appVersion`/`os` are filled
//! server-side so a crafted IPC call can't spoof a Pro badge.

use tauri::State;
use tracing::instrument;

use crate::errors::{AppError, ErrorCategory, Result};
use crate::state::AppState;

/// Public ingest endpoint on the marketing site; dev builds may point at a
/// local server via `RECORD_FORGE_REVIEWS_URL`.
const REVIEWS_URL: &str = "https://recordforge.prestigetech.dev/api/reviews";
const REVIEWS_URL_ENV: &str = "RECORD_FORGE_REVIEWS_URL";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Mirrors `reviewSubmissionSchema` / `submitReviewResponseSchema` in
/// `packages/contracts/src/review.ts`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReviewResponse {
    pub ok: bool,
}

#[tauri::command]
#[instrument(skip(state))]
pub async fn submit_review(
    rating: u8,
    review_text: Option<String>,
    display_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<SubmitReviewResponse> {
    if !(1..=5).contains(&rating) {
        return Err(review_error(
            "review_invalid",
            "rating must be between 1 and 5 stars",
        ));
    }
    let text = review_text
        .map(|value| value.trim().chars().take(600).collect::<String>())
        .filter(|value| !value.is_empty());
    let name = display_name
        .map(|value| value.trim().chars().take(60).collect::<String>())
        .filter(|value| !value.is_empty());

    let url = std::env::var(REVIEWS_URL_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| REVIEWS_URL.to_string());

    let response = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
        .post(url)
        .json(&serde_json::json!({
            "rating": rating,
            "text": text,
            "name": name,
            "tier": state.license.status().tier,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "source": "app",
        }))
        .send()
        .await
        .map_err(|error| {
            review_error(
                "review_unreachable",
                format!("could not reach the review service: {error}"),
            )
        })?;
    if !response.status().is_success() {
        return Err(review_error(
            "review_rejected",
            format!(
                "the review service returned an error ({})",
                response.status()
            ),
        ));
    }
    Ok(SubmitReviewResponse { ok: true })
}

fn review_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::Unknown, code, message)
}
