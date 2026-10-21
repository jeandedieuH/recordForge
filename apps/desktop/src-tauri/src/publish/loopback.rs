//! Loopback+PKCE plumbing shared by the Google Drive and YouTube OAuth flows.
//!
//! Both flows bind an ephemeral `127.0.0.1` port, open the provider consent
//! URL in the browser, and wait for the redirect `GET /?code=…&state=…`.
//! This module owns the parts that were previously duplicated (and buggy in
//! the same way twice):
//!
//! - one OAuth flow at a time (`OAuthGuard`) — a second Connect click returns
//!   `oauth_in_progress` instead of spawning a competing listener;
//! - a real deadline — an abandoned sign-in no longer leaks a blocked thread;
//! - spec-correct query decoding — `code`/`state`/`error` values are
//!   percent-decoded (Google auth codes contain `/`, which arrives as `%2F`);
//! - non-callback connections (browser prefetch, favicon probes) get a 204
//!   and the wait continues instead of killing the flow;
//! - `?error=access_denied` surfaces as a distinct outcome.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::errors::{AppError, ErrorCategory, Result};

/// How long the loopback listener waits for the browser redirect.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

static OAUTH_ACTIVE: AtomicBool = AtomicBool::new(false);

/// RAII single-flight slot for OAuth flows — only one consent tab at a time.
pub struct OAuthGuard;

pub fn try_begin_oauth() -> Result<OAuthGuard> {
    if OAUTH_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err(AppError::new(
            ErrorCategory::Storage,
            "oauth_in_progress",
            "a sign-in is already in progress — finish or dismiss the browser tab first",
        ));
    }
    Ok(OAuthGuard)
}

impl Drop for OAuthGuard {
    fn drop(&mut self) {
        OAUTH_ACTIVE.store(false, Ordering::SeqCst);
    }
}

/// Bound listener + PKCE verifier + anti-CSRF state for one OAuth attempt.
pub struct LoopbackFlow {
    pub listener: TcpListener,
    pub port: u16,
    pub state: String,
    pub verifier: String,
    pub challenge: String,
}

pub fn begin_loopback_flow() -> Result<LoopbackFlow> {
    let verifier = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        hasher.finalize(),
    );
    let state = uuid::Uuid::new_v4().to_string();
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| {
        AppError::new(
            ErrorCategory::Storage,
            "oauth_listener_failed",
            format!("failed to bind loopback TCP server: {e}"),
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| {
            AppError::new(
                ErrorCategory::Storage,
                "oauth_listener_failed",
                format!("failed to get local addr: {e}"),
            )
        })?
        .port();
    Ok(LoopbackFlow {
        listener,
        port,
        state,
        verifier,
        challenge,
    })
}

/// What the redirect callback carried. The caller owns `stream` in each case
/// so it can answer the browser after the token exchange settles.
pub enum Callback {
    /// `code` + matching `state` — safe to exchange.
    Code { code: String, stream: TcpStream },
    /// The provider denied the grant (`?error=…`) — no exchange possible.
    Denied { error: String, stream: TcpStream },
    /// `state` mismatch on a code-bearing request — possible CSRF; the flow
    /// dies rather than keep listening.
    StateMismatch { stream: TcpStream },
    /// Deadline passed with no usable callback.
    TimedOut,
}

/// Poll the listener until the OAuth redirect arrives or the deadline hits.
/// Non-callback connections are answered with 204 and the wait continues.
pub fn accept_callback(
    listener: &TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<Callback> {
    listener.set_nonblocking(true).map_err(|e| {
        AppError::new(
            ErrorCategory::Storage,
            "oauth_listener_failed",
            format!("loopback listener setup failed: {e}"),
        )
    })?;
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let request = match read_http_request(&mut stream) {
                    Some(request) => request,
                    None => continue,
                };
                match parse_callback(&request, expected_state) {
                    ParsedCallback::NotCallback => {
                        respond_empty(&mut stream);
                    }
                    ParsedCallback::Code(code) => return Ok(Callback::Code { code, stream }),
                    ParsedCallback::Denied(error) => return Ok(Callback::Denied { error, stream }),
                    ParsedCallback::StateMismatch => return Ok(Callback::StateMismatch { stream }),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Ok(Callback::TimedOut);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                return Err(AppError::new(
                    ErrorCategory::Storage,
                    "oauth_listener_failed",
                    format!("loopback accept failed: {error}"),
                ));
            }
        }
    }
}

enum ParsedCallback {
    NotCallback,
    Code(String),
    Denied(String),
    StateMismatch,
}

/// Parse `GET /?code=…&state=…` with real percent-decoding (via reqwest's URL
/// parser — no new dependency). A request without OAuth params is ignored.
fn parse_callback(request: &str, expected_state: &str) -> ParsedCallback {
    let Some(path) = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
    else {
        return ParsedCallback::NotCallback;
    };
    if !path.contains('?') {
        return ParsedCallback::NotCallback;
    }
    let Ok(url) = reqwest::Url::parse(&format!("http://localhost{path}")) else {
        return ParsedCallback::NotCallback;
    };
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    if let Some(error) = error {
        return ParsedCallback::Denied(error);
    }
    let Some(code) = code else {
        return ParsedCallback::NotCallback;
    };
    if state.as_deref() != Some(expected_state) {
        return ParsedCallback::StateMismatch;
    }
    ParsedCallback::Code(code)
}

/// Read one HTTP request head — enough for the OAuth `GET` line + headers.
fn read_http_request(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = [0u8; 8192];
    let n = stream.read(&mut buffer).unwrap_or(0);
    if n == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buffer[..n]).into_owned())
}

/// Answer-and-forget for connections that aren't the OAuth callback.
fn respond_empty(stream: &mut TcpStream) {
    let _ = stream
        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = stream.flush();
}

/// Final HTML answer for the browser tab once the exchange outcome is known.
pub fn respond_html(stream: &mut TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_code_and_decodes_percent_encoding() {
        let req = "GET /?code=4%2F0AfFakeCode&state=abc-123 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        match parse_callback(req, "abc-123") {
            ParsedCallback::Code(code) => assert_eq!(code, "4/0AfFakeCode"),
            _ => panic!("expected code"),
        }
    }

    #[test]
    fn state_mismatch_rejects_the_code() {
        let req = "GET /?code=x&state=wrong HTTP/1.1\r\n\r\n";
        assert!(matches!(
            parse_callback(req, "expected"),
            ParsedCallback::StateMismatch
        ));
    }

    #[test]
    fn provider_denial_surfaces_the_error() {
        let req = "GET /?error=access_denied&state=abc HTTP/1.1\r\n\r\n";
        match parse_callback(req, "abc") {
            ParsedCallback::Denied(error) => assert_eq!(error, "access_denied"),
            _ => panic!("expected denial"),
        }
    }

    #[test]
    fn favicon_and_bare_requests_are_not_callbacks() {
        assert!(matches!(
            parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n", "s"),
            ParsedCallback::NotCallback
        ));
        assert!(matches!(
            parse_callback("GET / HTTP/1.1\r\n\r\n", "s"),
            ParsedCallback::NotCallback
        ));
    }

    #[test]
    fn single_flight_blocks_a_second_flow() {
        let guard = try_begin_oauth().unwrap();
        assert!(try_begin_oauth().is_err());
        drop(guard);
        assert!(try_begin_oauth().is_ok());
    }
}
