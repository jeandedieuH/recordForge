//! Linux X11 and Wayland source provider.

use crate::capture::source::{Bounds, CaptureSource};
use crate::capture::traits::SourceProvider;
use crate::errors::Result;

#[derive(Debug, Default)]
pub struct LinuxSourceProvider;

impl SourceProvider for LinuxSourceProvider {
    fn enumerate_sources(&self) -> Result<Vec<CaptureSource>> {
        let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        let display_var = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());

        let mut sources = Vec::new();

        if is_wayland {
            // Under Wayland, screen & window selection is mediated by the xdg-desktop-portal ScreenCast interface
            sources.push(CaptureSource {
                kind: "display".into(),
                id: "wayland-portal-screen".into(),
                name: "Wayland Screen (Desktop Portal)".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            });
            sources.push(CaptureSource {
                kind: "window".into(),
                id: "wayland-portal-window".into(),
                name: "Wayland Window (Desktop Portal)".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1280,
                    height: 720,
                },
            });
        } else {
            // X11 source enumeration
            sources.push(CaptureSource {
                kind: "display".into(),
                id: format!("x11-display-0-{display_var}"),
                name: format!("X11 Display 1 ({display_var})"),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            });
        }

        tracing::info!(
            count = sources.len(),
            is_wayland,
            "enumerated Linux capture sources"
        );
        Ok(sources)
    }

    fn refresh_window_bounds(&self, _source: &CaptureSource) -> Option<Bounds> {
        None
    }
}
