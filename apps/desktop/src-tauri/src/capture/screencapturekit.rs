//! macOS shareable-content discovery — display and window enumeration that
//! feeds the source picker.
//!
//! Real capture lives in `macos_sck.rs` (`SCStream` via the `screencapturekit`
//! crate); this module only owns the `Sck*` discovery types and the mapping
//! onto `CaptureSource`s, backed by CoreGraphics in `macos_native.rs` (macOS
//! 12.3+).

use super::source::{Bounds, CaptureSource};
use crate::errors::Result;
use serde::{Deserialize, Serialize};

/// Discovered display from ScreenCaptureKit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SckDisplay {
    pub display_id: u32,
    pub width: u32,
    pub height: u32,
    pub point_width: f64,
    pub point_height: f64,
    pub scale_factor: f64,
    pub bounds: Bounds,
}

/// Discovered application from ScreenCaptureKit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SckRunningApplication {
    pub process_id: i32,
    pub bundle_identifier: String,
    pub application_name: String,
}

/// Discovered window from ScreenCaptureKit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SckWindow {
    pub window_id: u32,
    pub title: String,
    pub owning_app_name: String,
    pub owning_app_bundle_id: Option<String>,
    pub owning_app_pid: i32,
    pub bounds: Bounds,
    pub window_layer: i32,
    pub is_on_screen: bool,
    pub is_active: bool,
}

/// Aggregated shareable content discovered on macOS.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SckShareableContent {
    pub displays: Vec<SckDisplay>,
    pub windows: Vec<SckWindow>,
    pub applications: Vec<SckRunningApplication>,
}

/// Fetch all shareable content on macOS (displays, windows, running applications).
pub fn get_shareable_content() -> Result<SckShareableContent> {
    #[cfg(target_os = "macos")]
    {
        get_macos_shareable_content()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(SckShareableContent {
            displays: vec![SckDisplay {
                display_id: 1,
                width: 1920,
                height: 1080,
                point_width: 1920.0,
                point_height: 1080.0,
                scale_factor: 1.0,
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            }],
            windows: Vec::new(),
            applications: Vec::new(),
        })
    }
}

#[cfg(target_os = "macos")]
fn get_macos_shareable_content() -> Result<SckShareableContent> {
    // Real CoreGraphics enumeration (displays + on-screen windows) lives in
    // macos_native; SCShareableContent itself is a Phase-1 item.
    let mut content = crate::capture::macos_native::enumerate_shareable_content();

    // A headless/SSH session can yield an empty display list — keep the
    // synthetic primary so the source picker never goes fully blank.
    if content.displays.is_empty() {
        content.displays.push(SckDisplay {
            display_id: 1,
            width: 1920,
            height: 1080,
            point_width: 1920.0,
            point_height: 1080.0,
            scale_factor: 2.0,
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        });
    }

    tracing::info!(
        display_count = content.displays.len(),
        window_count = content.windows.len(),
        "discovered macOS shareable content"
    );
    Ok(content)
}

/// Map discovered ScreenCaptureKit displays and windows to RecordForge `CaptureSource`s.
pub fn sck_content_to_capture_sources(content: &SckShareableContent) -> Vec<CaptureSource> {
    let mut sources = Vec::new();

    for (index, display) in content.displays.iter().enumerate() {
        sources.push(CaptureSource {
            kind: "display".into(),
            id: format!("display-{}", index),
            name: format!(
                "Display {} ({}x{})",
                index + 1,
                display.width,
                display.height
            ),
            bounds: display.bounds,
        });
    }

    for window in &content.windows {
        if !window.is_on_screen || window.bounds.width <= 10 || window.bounds.height <= 10 {
            continue;
        }

        let name = if window.title.trim().is_empty() {
            window.owning_app_name.clone()
        } else {
            format!("{} — {}", window.owning_app_name, window.title)
        };

        sources.push(CaptureSource {
            kind: "window".into(),
            id: format!("win-{}", window.window_id),
            name,
            bounds: window.bounds,
        });
    }

    sources
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sck_content_mapping_to_capture_sources() {
        let content = SckShareableContent {
            displays: vec![
                SckDisplay {
                    display_id: 1,
                    width: 2560,
                    height: 1440,
                    point_width: 2560.0,
                    point_height: 1440.0,
                    scale_factor: 1.0,
                    bounds: Bounds {
                        x: 0,
                        y: 0,
                        width: 2560,
                        height: 1440,
                    },
                },
                SckDisplay {
                    display_id: 2,
                    width: 1920,
                    height: 1080,
                    point_width: 1920.0,
                    point_height: 1080.0,
                    scale_factor: 1.0,
                    bounds: Bounds {
                        x: 2560,
                        y: 0,
                        width: 1920,
                        height: 1080,
                    },
                },
            ],
            windows: vec![
                SckWindow {
                    window_id: 42,
                    title: "Editor".into(),
                    owning_app_name: "Code".into(),
                    owning_app_bundle_id: Some("com.microsoft.VSCode".into()),
                    owning_app_pid: 1234,
                    bounds: Bounds {
                        x: 100,
                        y: 100,
                        width: 1200,
                        height: 800,
                    },
                    window_layer: 0,
                    is_on_screen: true,
                    is_active: true,
                },
                SckWindow {
                    window_id: 99,
                    title: "Offscreen".into(),
                    owning_app_name: "Hidden".into(),
                    owning_app_bundle_id: None,
                    owning_app_pid: 5678,
                    bounds: Bounds {
                        x: -500,
                        y: -500,
                        width: 100,
                        height: 100,
                    },
                    window_layer: 0,
                    is_on_screen: false,
                    is_active: false,
                },
            ],
            applications: Vec::new(),
        };

        let sources = sck_content_to_capture_sources(&content);
        assert_eq!(sources.len(), 3); // 2 displays + 1 visible window
        assert_eq!(sources[0].id, "display-0");
        assert_eq!(sources[0].kind, "display");
        assert_eq!(sources[1].id, "display-1");
        assert_eq!(sources[2].id, "win-42");
        assert_eq!(sources[2].kind, "window");
        assert_eq!(sources[2].name, "Code — Editor");
    }
}
