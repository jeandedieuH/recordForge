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
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Enumerate all available capture sources on Windows.
///
/// This is the first step of Phase 1: prove we can discover displays
/// and windows before attempting to record them. The implementation is
/// gated to Windows because recordForge v1 targets Windows 11.
#[cfg(windows)]
pub fn enumerate_sources() -> crate::errors::Result<Vec<CaptureSource>> {
    use std::collections::HashMap;
    use tracing::instrument;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextW, IsWindowVisible,
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

        if IsWindowVisible(hwnd).as_bool() {
            let mut text: [u16; 256] = [0; 256];
            let len = GetWindowTextW(hwnd, &mut text);
            if len > 0 {
                let name = String::from_utf16_lossy(&text[..len as usize])
                    .trim_end_matches('\0')
                    .to_string();
                if !name.is_empty() {
                    let mut rect = RECT::default();
                    if GetWindowRect(hwnd, &mut rect).is_ok() {
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
                    }
                }
            }
        }

        BOOL(1)
    }

    let mut displays = collect_displays()?;
    let mut windows = collect_windows()?;

    // Deduplicate windows by id to avoid transient duplicates.
    let mut seen: HashMap<String, bool> = HashMap::new();
    windows.retain(|w| {
        if seen.contains_key(&w.id) {
            false
        } else {
            seen.insert(w.id.clone(), true);
            true
        }
    });

    displays.append(&mut windows);
    Ok(displays)
}

/// Non-Windows fallback returns an empty list.
#[cfg(not(windows))]
pub fn enumerate_sources() -> crate::errors::Result<Vec<CaptureSource>> {
    tracing::warn!("capture source enumeration is only implemented for Windows");
    Ok(Vec::new())
}
