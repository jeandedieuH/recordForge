use serde::{Deserialize, Serialize};

use crate::errors::Result;

/// Capture source passed between Rust and the React UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub bounds: Bounds,
}

/// Pixel bounds for a display, window, or selected region.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Bounds {
    /// Compute aspect-preserving scale and pad filter string for FFmpeg (fixes P0.5 aspect distortion).
    pub fn build_aspect_fit_filter(&self, target_width: i32, target_height: i32) -> String {
        format!(
            "scale=w={target_width}:h={target_height}:force_original_aspect_ratio=decrease,pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
    }
}

/// Enumerate all available capture sources on the active platform.
pub fn enumerate_sources() -> Result<Vec<CaptureSource>> {
    super::source_providers::get_source_provider().enumerate_sources()
}

/// Parse a window handle from a capture source id (`win-<hwnd>`).
///
/// Pure so the id format contract stays testable.
pub fn parse_window_handle(source_id: &str) -> Option<usize> {
    source_id.strip_prefix("win-")?.parse::<usize>().ok()
}

/// Re-read a window source's current physical frame bounds so capture
/// segments follow a window that moved or was resized since enumeration.
pub fn refresh_window_bounds(source: &CaptureSource) -> Option<Bounds> {
    super::source_providers::get_source_provider().refresh_window_bounds(source)
}

#[cfg(test)]
mod tests {
    use super::parse_window_handle;

    #[test]
    fn parse_window_handle_accepts_enumerated_ids() {
        assert_eq!(parse_window_handle("win-197212"), Some(197212));
    }

    #[test]
    fn parse_window_handle_rejects_foreign_ids() {
        assert_eq!(parse_window_handle("display-0"), None);
        assert_eq!(parse_window_handle("win-not-a-number"), None);
        assert_eq!(parse_window_handle("win-"), None);
        assert_eq!(parse_window_handle("region-abc"), None);
    }
}
