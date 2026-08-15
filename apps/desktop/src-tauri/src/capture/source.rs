use serde::{Deserialize, Serialize};

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

/// Enumerate all available capture sources on Windows.
///
/// This is the first step of Phase 1: prove we can discover displays
/// and windows before attempting to record them. The implementation is
/// gated to Windows because recordForge v1 targets Windows 11.
#[cfg(windows)]
pub fn enumerate_sources() -> crate::errors::Result<Vec<CaptureSource>> {
    use std::collections::HashSet;
    use tracing::instrument;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    #[derive(Default)]
    struct DisplayState {
        sources: Vec<CaptureSource>,
        index: u32,
    }

    #[instrument]
    fn collect_displays() -> crate::errors::Result<Vec<CaptureSource>> {
        let mut state = DisplayState::default();

        unsafe {
            if !EnumDisplayMonitors(
                None,
                None,
                Some(display_callback),
                LPARAM(&mut state as *mut _ as isize),
            )
            .as_bool()
            {
                return Err(crate::errors::InternalError::Capture(
                    "EnumDisplayMonitors failed".into(),
                )
                .into());
            }
        }

        if state.sources.is_empty() {
            tracing::warn!("no displays found via EnumDisplayMonitors");
            // Fallback to the primary monitor using a default-sized display.
            state.sources.push(CaptureSource {
                kind: "display".into(),
                id: "display-0".into(),
                name: "Primary Display".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            });
        }

        Ok(state.sources)
    }

    unsafe extern "system" fn display_callback(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let state = &mut *(lparam.0 as *mut DisplayState);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if GetMonitorInfoW(hmonitor, &mut info).as_bool() {
            let name = format!("Display {}", state.index + 1);
            state.sources.push(CaptureSource {
                kind: "display".into(),
                id: format!("display-{}", state.index),
                name,
                bounds: Bounds {
                    x: info.rcMonitor.left,
                    y: info.rcMonitor.top,
                    width: info.rcMonitor.right - info.rcMonitor.left,
                    height: info.rcMonitor.bottom - info.rcMonitor.top,
                },
            });
            state.index += 1;
        }

        BOOL(1)
    }

    #[instrument]
    fn collect_windows() -> crate::errors::Result<Vec<CaptureSource>> {
        let mut sources: Vec<CaptureSource> = Vec::new();

        unsafe {
            if let Err(e) = EnumWindows(
                Some(window_callback),
                LPARAM(&mut sources as *mut _ as isize),
            ) {
                return Err(crate::errors::InternalError::Capture(format!(
                    "EnumWindows failed: {e}"
                ))
                .into());
            }
        }

        Ok(sources)
    }

    unsafe extern "system" fn window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let sources = &mut *(lparam.0 as *mut Vec<CaptureSource>);

        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }

        // Skip recordForge's own windows (transport controls, overlays, the
        // region picker): capturing the recorder's own chrome is never the
        // user's intent when picking a window source.
        let mut window_process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut window_process_id));
        if window_process_id == std::process::id() {
            return BOOL(1);
        }

        // Tool windows (tray ghosts, tooltips) are not real capture targets.
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if ex_style & WS_EX_TOOLWINDOW.0 as i32 != 0 {
            return BOOL(1);
        }

        // Cloaked windows (suspended UWP apps, windows on another virtual
        // desktop) report IsWindowVisible == true but render nothing.
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return BOOL(1);
        }

        let mut text: [u16; 256] = [0; 256];
        let len = GetWindowTextW(hwnd, &mut text);
        if len <= 0 {
            return BOOL(1);
        }
        let name = String::from_utf16_lossy(&text[..len as usize])
            .trim_end_matches('\0')
            .to_string();
        if name.is_empty() {
            return BOOL(1);
        }

        // Prefer DWM's extended frame bounds: GetWindowRect includes the
        // invisible drop-shadow borders, which would capture black edges.
        let mut rect = RECT::default();
        let has_frame_bounds = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        if !has_frame_bounds
            && windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect).is_err()
        {
            return BOOL(1);
        }

        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width > 10 && height > 10 {
            sources.push(CaptureSource {
                kind: "window".into(),
                id: format!("win-{:?}", hwnd.0 as usize),
                name,
                bounds: Bounds {
                    x: rect.left,
                    y: rect.top,
                    width,
                    height,
                },
            });
        }

        BOOL(1)
    }

    let mut displays = collect_displays()?;
    let mut windows = collect_windows()?;

    // Deduplicate windows by id to avoid transient duplicates.
    let mut seen: HashSet<String> = HashSet::new();
    windows.retain(|w| seen.insert(w.id.clone()));

    displays.append(&mut windows);
    Ok(displays)
}

/// Non-Windows fallback returns an empty list.
#[cfg(not(windows))]
pub fn enumerate_sources() -> crate::errors::Result<Vec<CaptureSource>> {
    tracing::warn!("capture source enumeration is only implemented for Windows");
    Ok(Vec::new())
}

/// Parse a window handle from a capture source id (`win-<hwnd>`).
///
/// Pure so the id format contract stays testable.
pub fn parse_window_handle(source_id: &str) -> Option<usize> {
    source_id.strip_prefix("win-")?.parse::<usize>().ok()
}

/// Re-read a window source's current DWM extended frame bounds so capture
/// segments follow a window that moved or was resized since enumeration.
/// Returns None for non-window sources, malformed ids, and closed windows.
#[cfg(windows)]
pub fn refresh_window_bounds(source: &CaptureSource) -> Option<Bounds> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    if source.kind != "window" {
        return None;
    }
    let handle = parse_window_handle(&source.id)?;
    let hwnd = HWND(handle as *mut core::ffi::c_void);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        tracing::warn!(id = %source.id, "window source no longer exists; keeping last bounds");
        return None;
    }

    let mut rect = RECT::default();
    let has_frame_bounds = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .is_ok();
    if !has_frame_bounds {
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect) }.ok()?;
    }

    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 10 || height <= 10 {
        return None;
    }
    Some(Bounds {
        x: rect.left,
        y: rect.top,
        width,
        height,
    })
}

#[cfg(not(windows))]
pub fn refresh_window_bounds(source: &CaptureSource) -> Option<Bounds> {
    let _ = source;
    None
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
