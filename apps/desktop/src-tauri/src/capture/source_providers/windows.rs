//! Windows display and window source provider.

use std::collections::HashSet;
use tracing::instrument;

use crate::capture::source::{parse_window_handle, Bounds, CaptureSource};
use crate::capture::traits::SourceProvider;
use crate::errors::Result;

#[derive(Debug, Default)]
pub struct WindowsSourceProvider;

#[cfg(windows)]
impl SourceProvider for WindowsSourceProvider {
    fn enumerate_sources(&self) -> Result<Vec<CaptureSource>> {
        enumerate_windows_sources()
    }

    fn refresh_window_bounds(&self, source: &CaptureSource) -> Option<Bounds> {
        refresh_windows_window_bounds(source)
    }
}

#[cfg(not(windows))]
impl SourceProvider for WindowsSourceProvider {
    fn enumerate_sources(&self) -> Result<Vec<CaptureSource>> {
        Ok(Vec::new())
    }

    fn refresh_window_bounds(&self, _source: &CaptureSource) -> Option<Bounds> {
        None
    }
}

#[cfg(windows)]
fn enumerate_windows_sources() -> Result<Vec<CaptureSource>> {
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
    fn collect_displays() -> Result<Vec<CaptureSource>> {
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
    fn collect_windows() -> Result<Vec<CaptureSource>> {
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

        let mut window_process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut window_process_id));
        if window_process_id == std::process::id() {
            return BOOL(1);
        }

        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if ex_style & WS_EX_TOOLWINDOW.0 as i32 != 0 {
            return BOOL(1);
        }

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

    let mut seen: HashSet<String> = HashSet::new();
    windows.retain(|w| seen.insert(w.id.clone()));

    displays.append(&mut windows);
    Ok(displays)
}

#[cfg(windows)]
fn refresh_windows_window_bounds(source: &CaptureSource) -> Option<Bounds> {
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
