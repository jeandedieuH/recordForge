//! macOS ScreenCaptureKit shareable content and display/window source provider.

use crate::capture::screencapturekit;
use crate::capture::source::{Bounds, CaptureSource};
use crate::capture::traits::SourceProvider;
use crate::errors::Result;

#[derive(Debug, Default)]
pub struct MacosSourceProvider;

impl SourceProvider for MacosSourceProvider {
    fn enumerate_sources(&self) -> Result<Vec<CaptureSource>> {
        let content = screencapturekit::get_shareable_content()?;
        let sources = screencapturekit::sck_content_to_capture_sources(&content);
        if sources.is_empty() {
            return Ok(vec![CaptureSource {
                kind: "display".into(),
                id: "display-0".into(),
                name: "Primary Display".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            }]);
        }
        Ok(sources)
    }

    fn refresh_window_bounds(&self, source: &CaptureSource) -> Option<Bounds> {
        if source.kind != "window" {
            return None;
        }

        // Re-read ScreenCaptureKit shareable content to find the updated window bounds
        if let Ok(content) = screencapturekit::get_shareable_content() {
            let window_id_str = source.id.strip_prefix("win-")?;
            let window_id = window_id_str.parse::<u32>().ok()?;
            if let Some(w) = content.windows.iter().find(|w| w.window_id == window_id) {
                if w.is_on_screen && w.bounds.width > 10 && w.bounds.height > 10 {
                    return Some(w.bounds);
                }
            }
        }
        None
    }
}
