use tauri::Manager;
use crate::errors::{InternalError, Result};

/// Floating transport controls window management module.
pub struct FloatingWindow;

impl FloatingWindow {
    /// Open or focus the floating transport controls toolbar window.
    pub fn open_or_focus(app: &tauri::AppHandle) -> Result<()> {
        if let Some(window) = app.get_webview_window("floating") {
            tracing::info!("floating window already exists, showing and focusing");
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }

        tracing::info!("creating new floating controls window");

        let mut builder = tauri::WebviewWindowBuilder::new(
            app,
            "floating",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .initialization_script("window.__RECORD_FORGE_WINDOW_KIND = 'floating';")
        .title("recordForge Transport Controls")
        .inner_size(440.0, 72.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false);

        // Position near top-center of the primary monitor
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let screen_w = size.width as f64 / scale;
            let x = (screen_w - 440.0) / 2.0;
            let y = 32.0;
            tracing::info!(screen_w, x, y, scale, "floating window position calculated");
            builder = builder.position(x, y);
        } else {
            tracing::warn!("no primary monitor detected for floating window positioning");
        }

        match builder.build() {
            Ok(_window) => {
                tracing::info!("floating controls window created successfully");
                Ok(())
            }
            Err(e) => {
                tracing::error!(error = ?e, "failed to create floating window");
                Err(InternalError::Unknown(format!("failed to create floating window: {e:?}")).into())
            }
        }
    }

    /// Hide the floating controls window.
    pub fn hide(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("floating") {
            tracing::info!("hiding floating controls window");
            let _ = window.hide();
        }
    }
}

/// Screen boundary outline window management module.
pub struct BoundaryWindow;

impl BoundaryWindow {
    /// Open or focus the transparent screen boundary overlay window.
    pub fn open_or_focus(app: &tauri::AppHandle) -> Result<()> {
        if let Some(window) = app.get_webview_window("boundary") {
            tracing::info!("boundary window already exists, showing");
            let _ = window.show();
            return Ok(());
        }

        tracing::info!("creating new boundary overlay window");

        let mut builder = tauri::WebviewWindowBuilder::new(
            app,
            "boundary",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .initialization_script("window.__RECORD_FORGE_WINDOW_KIND = 'boundary';")
        .title("recordForge Capture Boundary")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false);

        // Set position(0, 0) and inner_size to match monitor resolution (preserves DWM transparency)
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let w = size.width as f64 / scale;
            let h = size.height as f64 / scale;
            tracing::info!(w, h, scale, "boundary window size calculated");
            builder = builder.position(0.0, 0.0).inner_size(w, h);
        } else {
            tracing::warn!("no primary monitor detected for boundary window sizing");
        }

        match builder.build() {
            Ok(window) => {
                tracing::info!("boundary overlay window created successfully");
                // Make the boundary overlay fully click-through at the OS level.
                // CSS `pointer-events: none` only affects the webview layer; this
                // ensures native mouse events pass through to the desktop beneath.
                let _ = window.set_ignore_cursor_events(true);
                Ok(())
            }
            Err(e) => {
                tracing::error!(error = ?e, "failed to create boundary window");
                Err(InternalError::Unknown(format!("failed to create boundary window: {e:?}")).into())
            }
        }
    }

    /// Hide the capture boundary overlay window.
    pub fn hide(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("boundary") {
            tracing::info!("hiding boundary overlay window");
            let _ = window.hide();
        }
    }
}

