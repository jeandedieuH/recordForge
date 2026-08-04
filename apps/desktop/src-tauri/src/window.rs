use tauri::{LogicalPosition, LogicalSize, Manager, Position, Size};

use crate::capture::source::Bounds;
use crate::errors::{InternalError, Result};

/// Main application window lifecycle helpers used by the recorder.
pub struct MainWindow;

impl MainWindow {
    pub fn minimize(app: &tauri::AppHandle) -> Result<()> {
        if let Some(window) = app.get_webview_window("main") {
            window.minimize().map_err(|error| {
                InternalError::Unknown(format!("minimize main window: {error}"))
            })?;
        }
        Ok(())
    }

    pub fn restore(app: &tauri::AppHandle) -> Result<()> {
        if let Some(window) = app.get_webview_window("main") {
            window
                .show()
                .map_err(|error| InternalError::Unknown(format!("show main window: {error}")))?;
            window
                .unminimize()
                .map_err(|error| InternalError::Unknown(format!("restore main window: {error}")))?;
            window
                .set_focus()
                .map_err(|error| InternalError::Unknown(format!("focus main window: {error}")))?;
        }
        Ok(())
    }
}

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
            tauri::WebviewUrl::App("index.html?floating=1".into()),
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
            Err(error) => {
                tracing::error!(error = ?error, "failed to create floating window");
                Err(
                    InternalError::Unknown(format!("failed to create floating window: {error:?}"))
                        .into(),
                )
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
    /// Open or focus a transparent overlay positioned exactly over the capture bounds.
    pub fn open_or_focus(app: &tauri::AppHandle, bounds: Bounds) -> Result<()> {
        let (position, size) = logical_capture_rect(app, bounds);
        if let Some(window) = app.get_webview_window("boundary") {
            tracing::info!("boundary window already exists, updating bounds");
            window.set_position(position).map_err(|error| {
                InternalError::Unknown(format!("position boundary window: {error}"))
            })?;
            window.set_size(size).map_err(|error| {
                InternalError::Unknown(format!("size boundary window: {error}"))
            })?;
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.show();
            return Ok(());
        }

        tracing::info!("creating new boundary overlay window");
        let logical_position = match position {
            Position::Logical(position) => position,
            Position::Physical(position) => position.to_logical(1.0),
        };
        let logical_size = match size {
            Size::Logical(size) => size,
            Size::Physical(size) => size.to_logical(1.0),
        };

        let builder = tauri::WebviewWindowBuilder::new(
            app,
            "boundary",
            tauri::WebviewUrl::App("index.html?boundary=1".into()),
        )
        .initialization_script("window.__RECORD_FORGE_WINDOW_KIND = 'boundary';")
        .title("recordForge Capture Boundary")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .position(logical_position.x, logical_position.y)
        .inner_size(logical_size.width, logical_size.height);

        match builder.build() {
            Ok(window) => {
                tracing::info!("boundary window created successfully");
                // Make the boundary overlay fully click-through at the OS level.
                let _ = window.set_ignore_cursor_events(true);
                Ok(())
            }
            Err(error) => {
                tracing::error!(error = ?error, "failed to create boundary window");
                Err(
                    InternalError::Unknown(format!("failed to create boundary window: {error:?}"))
                        .into(),
                )
            }
        }
    }

    /// Hide the capture boundary outline window.
    pub fn hide(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("boundary") {
            tracing::info!("hiding boundary overlay window");
            let _ = window.hide();
        }
    }
}

/// Dedicated countdown window shown while the main application is minimized.
pub struct CountdownWindow;

impl CountdownWindow {
    pub fn open_or_focus(
        app: &tauri::AppHandle,
        session_id: &str,
        seconds: u8,
        source_name: &str,
        bounds: Bounds,
    ) -> Result<()> {
        if let Some(window) = app.get_webview_window("countdown") {
            let _ = window.close();
        }

        let (position, size) = logical_capture_rect(app, bounds);
        let logical_position = match position {
            Position::Logical(position) => position,
            Position::Physical(position) => position.to_logical(1.0),
        };
        let logical_size = match size {
            Size::Logical(size) => size,
            Size::Physical(size) => size.to_logical(1.0),
        };
        let url = format!(
            "index.html?countdown=1&sessionId={}&seconds={}&sourceName={}",
            query_component(session_id),
            seconds,
            query_component(source_name),
        );

        tauri::WebviewWindowBuilder::new(app, "countdown", tauri::WebviewUrl::App(url.into()))
            .initialization_script("window.__RECORD_FORGE_WINDOW_KIND = 'countdown';")
            .title("recordForge Starting Recording")
            .inner_size(logical_size.width, logical_size.height)
            .position(logical_position.x, logical_position.y)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .build()
            .map_err(|error| {
                InternalError::Unknown(format!("create countdown window: {error:?}"))
            })?;

        Ok(())
    }

    pub fn hide(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("countdown") {
            let _ = window.close();
        }
    }
}

fn logical_capture_rect(app: &tauri::AppHandle, bounds: Bounds) -> (Position, Size) {
    let center_x = bounds.x + bounds.width / 2;
    let center_y = bounds.y + bounds.height / 2;
    let scale = app
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                center_x >= position.x
                    && center_x < position.x + size.width as i32
                    && center_y >= position.y
                    && center_y < position.y + size.height as i32
            })
        })
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);

    (
        Position::Logical(LogicalPosition::new(
            bounds.x as f64 / scale,
            bounds.y as f64 / scale,
        )),
        Size::Logical(LogicalSize::new(
            bounds.width as f64 / scale,
            bounds.height as f64 / scale,
        )),
    )
}

fn query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
