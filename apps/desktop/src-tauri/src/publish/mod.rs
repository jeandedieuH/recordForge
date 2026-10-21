//! External publishing destinations. Distinct from `storage` — these are
//! one-shot publishes of finished exports, not storage profiles.
//!
//! `share` is the Instant Share engine (hosted + BYO bucket), `youtube` the
//! YouTube Data API uploader, `loopback` the shared OAuth callback server.

pub mod loopback;
pub mod share;
pub mod youtube;
