use tauri::{LogicalPosition, LogicalSize, Manager, Position, Size};

use crate::capture::source::Bounds;
use crate::errors::{InternalError, Result};

const FLOATING_WINDOW_WIDTH: f64 = 620.0;
const FLOATING_WINDOW_HEIGHT: f64 = 88.0;
const FLOATING_WINDOW_BOTTOM_MARGIN: f64 = 28.0;

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
            window.set_content_protected(true).map_err(|error| {
                InternalError::Unknown(format!("protect floating window from capture: {error}"))
            })?;
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
        .title("RecordForge Transport Controls")
        .inner_size(FLOATING_WINDOW_WIDTH, FLOATING_WINDOW_HEIGHT)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .content_protected(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false);

        // Position at the bottom-center of the primary monitor so the toolbar
        // stays close to the pointer without covering the user's main content.
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let size = monitor.size();
            let position = monitor.position();
            let scale = monitor.scale_factor();
            let screen_w = size.width as f64 / scale;
            let screen_h = size.height as f64 / scale;
            let monitor_x = position.x as f64 / scale;
            let monitor_y = position.y as f64 / scale;
            let x = monitor_x + (screen_w - FLOATING_WINDOW_WIDTH) / 2.0;
            let y = monitor_y + screen_h - FLOATING_WINDOW_HEIGHT - FLOATING_WINDOW_BOTTOM_MARGIN;
            tracing::info!(
                screen_w,
                screen_h,
                x,
                y,
                scale,
                "floating window position calculated"
            );
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
            window.set_content_protected(true).map_err(|error| {
                InternalError::Unknown(format!("protect boundary window from capture: {error}"))
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
            tauri::WebviewUrl::App("index.html".into()),
        )
        .initialization_script("window.__RECORD_FORGE_WINDOW_KIND = 'boundary';")
        .title("RecordForge Capture Boundary")
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .content_protected(true)
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

/// Fullscreen region selection window. It covers a single monitor so the
/// frontend can convert CSS-pixel selections into absolute physical desktop
/// coordinates (window origin + devicePixelRatio) for gdigrab/ddagrab.
pub struct RegionPickerWindow;

impl RegionPickerWindow {
    /// Open the region picker on the monitor that currently holds the cursor,
    /// falling back to the primary monitor.
    pub fn open(app: &tauri::AppHandle) -> Result<()> {
        if let Some(window) = app.get_webview_window("region-picker") {
            tracing::info!("region picker already exists, focusing it");
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }

        let monitor_bounds = monitor_under_cursor().or_else(|| primary_monitor_bounds(app));
        let Some(bounds) = monitor_bounds else {
            return Err(
                InternalError::Unknown("no monitor available for region picker".into()).into(),
            );
        };

        let (position, size) = logical_capture_rect(app, bounds);
        let logical_position = match position {
            Position::Logical(position) => position,
            Position::Physical(position) => position.to_logical(1.0),
        };
        let logical_size = match size {
            Size::Logical(size) => size,
            Size::Physical(size) => size.to_logical(1.0),
        };

        tracing::info!(?bounds, "creating region picker window over monitor");

        tauri::WebviewWindowBuilder::new(
            app,
            "region-picker",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .initialization_script("window.__RECORD_FORGE_WINDOW_KIND = 'region-picker';")
        .title("RecordForge Select Region")
        .inner_size(logical_size.width, logical_size.height)
        .position(logical_position.x, logical_position.y)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .content_protected(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .fullscreen(false)
        .build()
        .map_err(|error| {
            InternalError::Unknown(format!("create region picker window: {error:?}"))
        })?;
        Ok(())
    }

    pub fn close(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("region-picker") {
            let _ = window.close();
        }
    }
}

/// Physical desktop rect of the monitor under the cursor, if any.
#[cfg(windows)]
fn monitor_under_cursor() -> Option<Bounds> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_err() {
        return None;
    }

    let monitor: HMONITOR = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_invalid() {
        return None;
    }

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return None;
    }

    let RECT {
        left,
        top,
        right,
        bottom,
    } = info.rcMonitor;
    Some(Bounds {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

#[cfg(not(windows))]
fn monitor_under_cursor() -> Option<Bounds> {
    None
}

fn primary_monitor_bounds(app: &tauri::AppHandle) -> Option<Bounds> {
    let monitor = app.primary_monitor().ok()??;
    let position = monitor.position();
    let size = monitor.size();
    Some(Bounds {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    })
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
        let script = format!(
            "window.__RECORD_FORGE_WINDOW_KIND = 'countdown'; window.__RECORD_FORGE_COUNTDOWN_PARAMS = {{ sessionId: {:?}, seconds: {}, sourceName: {:?} }};",
            session_id, seconds, source_name
        );

        let window = tauri::WebviewWindowBuilder::new(
            app,
            "countdown",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .initialization_script(&script)
        .title("RecordForge Starting Recording")
        .inner_size(logical_size.width, logical_size.height)
        .position(logical_position.x, logical_position.y)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .content_protected(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .build()
        .map_err(|error| InternalError::Unknown(format!("create countdown window: {error:?}")))?;

        // A blank or stalled countdown must never become a full-screen input trap.
        if let Err(error) = window.set_ignore_cursor_events(true) {
            let _ = window.close();
            return Err(InternalError::Unknown(format!(
                "make countdown window click-through: {error:?}"
            ))
            .into());
        }
        let _ = window.set_focus();

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

#[allow(dead_code)]
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

#[cfg(test)]
mod tests {
    use super::query_component;

    #[test]
    fn query_component_preserves_window_query_boundaries() {
        assert_eq!(
            query_component("Display 1 & 100%"),
            "Display%201%20%26%20100%25"
        );
    }
}
