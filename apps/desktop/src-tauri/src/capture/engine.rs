use serde::{Deserialize, Serialize};

use super::source::CaptureSource;

/// Capture engine selection per capture source class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureEngineKind {
    /// Desktop Duplication API via FFmpeg ddagrab filter (lowest overhead for D3D11 displays).
    Ddagrab,
    /// GDI Screen Capture via FFmpeg gdigrab filter (compatible fallback for displays/windows/regions).
    Gdigrab,
    /// Window capture via specific crop/window handle.
    Window,
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
