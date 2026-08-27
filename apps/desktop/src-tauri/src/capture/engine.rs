use serde::{Deserialize, Serialize};

use super::source::CaptureSource;

/// Capture engine selection per capture source class and platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureEngineKind {
    /// Desktop Duplication API via FFmpeg ddagrab filter (lowest overhead for D3D11 displays on Windows).
    Ddagrab,
    /// GDI Screen Capture via FFmpeg gdigrab filter (compatible fallback for Windows).
    Gdigrab,
    /// Window capture via specific crop/window handle.
    Window,
    /// Native macOS ScreenCaptureKit framework (macOS 12.3+ high-performance capture).
    ScreenCaptureKit,
    /// macOS AVFoundation framework fallback.
    Avfoundation,
}

/// Capability report returned by engine probing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEngineCapabilities {
    pub ddagrab_available: bool,
    pub gdigrab_available: bool,
    pub selected_engine: CaptureEngineKind,
    pub reason: String,
}

/// Select the optimal capture engine based on source kind and system probing results.
pub fn select_engine(source: &CaptureSource, ddagrab_available: bool) -> CaptureEngineCapabilities {
    #[cfg(target_os = "macos")]
    {
        let _ = (source, ddagrab_available);
        if super::screencapturekit::is_screencapturekit_available() {
            return CaptureEngineCapabilities {
                ddagrab_available: false,
                gdigrab_available: false,
                selected_engine: CaptureEngineKind::ScreenCaptureKit,
                reason: "Selected macOS ScreenCaptureKit for low-CPU hardware capture and independent window capture".into(),
            };
        } else {
            return CaptureEngineCapabilities {
                ddagrab_available: false,
                gdigrab_available: false,
                selected_engine: CaptureEngineKind::Avfoundation,
                reason: "ScreenCaptureKit unavailable; falling back to macOS AVFoundation screen capture".into(),
            };
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        match source.kind.as_str() {
            "display" => {
                if ddagrab_available {
                    CaptureEngineCapabilities {
                        ddagrab_available: true,
                        gdigrab_available: true,
                        selected_engine: CaptureEngineKind::Ddagrab,
                        reason: "Selected Desktop Duplication API (ddagrab) for low CPU hardware display capture".into(),
                    }
                } else {
                    CaptureEngineCapabilities {
                        ddagrab_available: false,
                        gdigrab_available: true,
                        selected_engine: CaptureEngineKind::Gdigrab,
                        reason: "ddagrab not supported by FFmpeg build; falling back to GDI capture (gdigrab)".into(),
                    }
                }
            }
            "window" => CaptureEngineCapabilities {
                ddagrab_available,
                gdigrab_available: true,
                selected_engine: CaptureEngineKind::Window,
                reason: "Selected Window capture mode with coordinate bounds and crop".into(),
            },
            _ => CaptureEngineCapabilities {
                ddagrab_available: false,
                gdigrab_available: true,
                selected_engine: CaptureEngineKind::Gdigrab,
                reason: "Selected GDI region capture fallback".into(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::source::Bounds;

    #[test]
    fn test_select_engine_display_ddagrab() {
        let source = CaptureSource {
            kind: "display".into(),
            id: "display-0".into(),
            name: "Primary Display".into(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        };

        if cfg!(target_os = "macos") {
            let caps = select_engine(&source, false);
            assert_eq!(caps.selected_engine, CaptureEngineKind::ScreenCaptureKit);
        } else {
            let caps = select_engine(&source, true);
            assert_eq!(caps.selected_engine, CaptureEngineKind::Ddagrab);
            assert!(caps.ddagrab_available);

            let caps_fallback = select_engine(&source, false);
            assert_eq!(caps_fallback.selected_engine, CaptureEngineKind::Gdigrab);
            assert!(!caps_fallback.ddagrab_available);
        }
    }

    #[test]
    fn test_select_engine_window() {
        let source = CaptureSource {
            kind: "window".into(),
            id: "win-123".into(),
            name: "Test Window".into(),
            bounds: Bounds {
                x: 100,
                y: 100,
                width: 800,
                height: 600,
            },
        };

        let caps = select_engine(&source, true);
        if cfg!(target_os = "macos") {
            assert_eq!(caps.selected_engine, CaptureEngineKind::ScreenCaptureKit);
        } else {
            assert_eq!(caps.selected_engine, CaptureEngineKind::Window);
        }
    }
}
