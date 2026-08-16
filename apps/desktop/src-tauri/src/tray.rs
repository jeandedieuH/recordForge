use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::capture::manifest::RecorderState;
use crate::errors::{InternalError, Result};
use crate::state::AppState;

const TRAY_ID: &str = "main-tray";

fn map_tauri_err(e: tauri::Error) -> InternalError {
    InternalError::Unknown(format!("{e:?}"))
}

/// Snapshot of recorder state used to render the tray menu. `Copy` so it can
/// cross to the main thread without holding any locks there (menu APIs must
/// not block on the recorder mutex while a stop/finalize is in flight).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrayMenuState {
    can_start: bool,
    can_pause: bool,
    can_resume: bool,
    is_recording: bool,
    is_countdown: bool,
}

impl TrayMenuState {
    fn from_recorder_state(state: RecorderState) -> Self {
        Self {
            can_start: matches!(
                state,
                RecorderState::Idle | RecorderState::Completed | RecorderState::Failed
            ),
            can_pause: state == RecorderState::Recording,
            can_resume: state == RecorderState::Paused,
            is_recording: matches!(state, RecorderState::Recording | RecorderState::Paused),
            is_countdown: state == RecorderState::Countdown,
        }
    }
}

/// Create the system tray icon and menu for recordForge.
pub fn create_tray(app: &tauri::App) -> Result<()> {
    let menu = build_menu(
        app.handle(),
        &TrayMenuState::from_recorder_state(RecorderState::Idle),
    )?;

    let icon = app
        .default_window_icon()
        .ok_or(InternalError::Unknown("no default window icon".into()))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
        .tooltip("recordForge")
        .menu(&menu)
        // Left-click focuses the app instead of opening the menu (Windows
        // convention); the menu stays available on right-click.
        .show_menu_on_left_click(false)
        .on_menu_event(handle_tray_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)
        .map_err(map_tauri_err)?;

    Ok(())
}

/// Rebuild the tray menu so labels and enabled state match the recorder.
///
/// Called on every `recorder-status` broadcast (see `events::emit_recorder_status`).
/// The recorder snapshot is read on the calling thread, then the menu is
/// rebuilt on the main thread — tray/menu APIs are main-thread oriented and
/// must never block on the recorder mutex.
pub fn refresh_tray_menu(app: &tauri::AppHandle) {
    let (menu_state, tooltip, badge) = {
        let state = app.state::<AppState>();
        let Ok(guard) = state.recorder.lock() else {
            return;
        };
        let Ok(status) = guard.status() else {
            return;
        };
        (
            TrayMenuState::from_recorder_state(status.state),
            tray_tooltip(status.state),
            tray_badge_color(status.state),
        )
    };

    let app = app.clone();
    let thread_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(tray) = thread_app.tray_by_id(TRAY_ID) else {
            return;
        };
        match build_menu(&thread_app, &menu_state) {
            Ok(menu) => {
                if let Err(error) = tray.set_menu(Some(menu)) {
                    tracing::warn!(error = ?error, "failed to refresh tray menu");
                }
            }
            Err(error) => {
                tracing::warn!(error = ?error, "failed to build refreshed tray menu");
            }
        }

        // Passive status cues: the tooltip always names the state, and the icon
        // gains a colored corner dot while a session is live. Both are reset to
        // the plain defaults for idle states so no stale badge survives a stop.
        if let Err(error) = tray.set_tooltip(Some(tooltip)) {
            tracing::warn!(error = ?error, "failed to refresh tray tooltip");
        }
        let Some(base) = thread_app.default_window_icon() else {
            return;
        };
        match badge {
            Some(color) => {
                // Only composite when the buffer is a well-formed RGBA grid;
                // a malformed embedded icon falls back to leaving it untouched.
                let expected = (base.width() as usize) * (base.height() as usize) * 4;
                let mut rgba = base.rgba().to_vec();
                if rgba.len() == expected {
                    paint_status_badge(&mut rgba, base.width(), base.height(), color);
                    let badge_icon = tauri::image::Image::new(&rgba, base.width(), base.height());
                    if let Err(error) = tray.set_icon(Some(badge_icon)) {
                        tracing::warn!(error = ?error, "failed to set tray status icon");
                    }
                } else {
                    tracing::warn!(
                        expected,
                        actual = rgba.len(),
                        "default icon is not a valid RGBA grid; skipping status badge"
                    );
                }
            }
            None => {
                let base_icon = tauri::image::Image::new(base.rgba(), base.width(), base.height());
                if let Err(error) = tray.set_icon(Some(base_icon)) {
                    tracing::warn!(error = ?error, "failed to reset tray icon");
                }
            }
        }
    }) {
        tracing::warn!(error = ?error, "failed to schedule tray menu refresh");
    }
}

/// Tooltip text for the tray icon. State-only by design: tooltips update on
/// state transitions, so an elapsed timer here would go stale between them.
fn tray_tooltip(state: RecorderState) -> String {
    match state {
        RecorderState::Recording => "recordForge — Recording",
        RecorderState::Paused => "recordForge — Paused",
        RecorderState::Countdown => "recordForge — Starting…",
        RecorderState::Finalizing | RecorderState::Recovering => "recordForge — Saving…",
        _ => "recordForge",
    }
    .into()
}

/// Corner-dot color for live sessions. RGB values mirror the design tokens
/// `--color-recording` (#ef4444) and `--color-warning` (#f59e0b) from
/// packages/ui theme.css — keep them in sync when the palette changes.
fn tray_badge_color(state: RecorderState) -> Option<[u8; 3]> {
    match state {
        RecorderState::Recording => Some([239, 68, 68]),
        RecorderState::Paused => Some([245, 158, 11]),
        _ => None,
    }
}

/// Paint an anti-aliased status dot in the bottom-right corner of an RGBA
/// buffer (row-major, 4 bytes per pixel): a light ring for contrast against
/// any taskbar, filled with the status color. In-place and allocation-free so
/// the geometry and blending stay unit-testable.
fn paint_status_badge(rgba: &mut [u8], width: u32, height: u32, color: [u8; 3]) {
    if width == 0 || height == 0 {
        return;
    }
    let size = width.min(height);
    // Badge proportions relative to the icon: ~28% dot radius with a ring
    // about a third of it, anchored one ring-thickness from the corner.
    let radius = ((size as f32) * 0.28).round().max(2.0);
    let ring = (radius / 3.0).max(1.0);
    let center = (
        (width as f32) - radius - ring + 0.5,
        (height as f32) - radius - ring + 0.5,
    );

    // Only visit pixels the badge can touch; icons are tiny so this loop is
    // negligible next to the tray IPC itself.
    let min_x = (center.0 - radius - 1.0).floor().max(0.0) as u32;
    let max_x = (center.0 + radius + 1.0).ceil().min(width as f32) as u32;
    let min_y = (center.1 - radius - 1.0).floor().max(0.0) as u32;
    let max_y = (center.1 + radius + 1.0).ceil().min(height as f32) as u32;

    for y in min_y..max_y {
        for x in min_x..max_x {
            let dx = x as f32 + 0.5 - center.0;
            let dy = y as f32 + 0.5 - center.1;
            let distance = (dx * dx + dy * dy).sqrt();

            // Alpha coverage of the outer ring circle and the inner fill
            // circle; 0.5 px of feathering removes jaggies at tray sizes.
            let ring_cov = (radius - distance + 0.5).clamp(0.0, 1.0);
            let fill_cov = ((radius - ring) - distance + 0.5).clamp(0.0, 1.0);

            if ring_cov <= 0.0 {
                continue;
            }

            let index = ((y * width + x) * 4) as usize;
            if index + 3 >= rgba.len() {
                return; // Malformed buffer; leave the rest untouched.
            }

            // White ring first (source-over), then the status fill on top.
            blend_pixel(&mut rgba[index..index + 4], [255, 255, 255], ring_cov);
            if fill_cov > 0.0 {
                blend_pixel(&mut rgba[index..index + 4], color, fill_cov);
            }
        }
    }
}

/// Source-over blend of an opaque color with `coverage` alpha onto one pixel.
fn blend_pixel(pixel: &mut [u8], color: [u8; 3], coverage: f32) {
    let alpha = coverage;
    for channel in 0..3 {
        let dst = f32::from(pixel[channel]);
        let src = f32::from(color[channel]);
        pixel[channel] = (src * alpha + dst * (1.0 - alpha)).round() as u8;
    }
    let dst_alpha = f32::from(pixel[3]) / 255.0;
    let out_alpha = alpha + dst_alpha * (1.0 - alpha);
    pixel[3] = (out_alpha * 255.0).round() as u8;
}

fn build_menu(
    app: &tauri::AppHandle,
    state: &TrayMenuState,
) -> std::result::Result<Menu<tauri::Wry>, InternalError> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>).map_err(map_tauri_err)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>).map_err(map_tauri_err)?;
    let start = MenuItem::with_id(app, "start", "Start Recording", true, None::<&str>)
        .map_err(map_tauri_err)?;
    let pause = MenuItem::with_id(
        app,
        "pause",
        if state.can_resume {
            "Resume Recording"
        } else {
            "Pause Recording"
        },
        state.can_pause || state.can_resume,
        None::<&str>,
    )
    .map_err(map_tauri_err)?;
    let stop = MenuItem::with_id(
        app,
        "stop",
        if state.is_countdown {
            "Cancel Countdown"
        } else {
            "Stop Recording"
        },
        state.is_recording || state.is_countdown,
        None::<&str>,
    )
    .map_err(map_tauri_err)?;
    let marker = MenuItem::with_id(
        app,
        "marker",
        "Insert Marker",
        state.is_recording,
        None::<&str>,
    )
    .map_err(map_tauri_err)?;
    let discard = MenuItem::with_id(
        app,
        "discard",
        "Discard Recording…",
        state.is_recording,
        None::<&str>,
    )
    .map_err(map_tauri_err)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(map_tauri_err)?;

    // "Start" is hidden rather than disabled while a session is active: a
    // disabled entry next to Stop/Pause reads as broken rather than busy.
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&show, &hide];
    if state.can_start {
        items.push(&start);
    }
    items.push(&pause);
    items.push(&stop);
    items.push(&marker);
    items.push(&discard);
    items.push(&quit);

    Menu::with_items(app, &items).map_err(map_tauri_err)
}

fn handle_tray_event(app: &tauri::AppHandle, event: MenuEvent) {
    // Menu events arrive on the main thread, but recorder transport actions
    // can block for seconds (FFmpeg teardown, probing, muxing). Run them on
    // the async runtime so tray interactions never freeze window input.
    let run_async = |app: &tauri::AppHandle, action: fn(tauri::AppHandle)| {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            action(app);
        });
    };

    match event.id().as_ref() {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        "hide" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "start" => run_async(app, tray_start),
        "pause" => run_async(app, tray_toggle_pause_resume),
        "stop" => run_async(app, tray_stop_recording),
        "marker" => {
            let state = app.state::<AppState>();
            let _ = crate::commands::recording::insert_marker_broadcast(
                app,
                &state,
                "tray marker".into(),
            );
        }
        "discard" => {
            // Destructive: never executed from the tray directly. Restore the
            // main window and let its confirmation dialog make the decision.
            if recorder_is_active(app) {
                if let Err(error) = crate::window::MainWindow::restore(app) {
                    tracing::warn!(error = ?error, "tray discard could not restore main window");
                }
                if let Err(error) = crate::events::emit_request_discard_confirmation(app) {
                    tracing::warn!(error = ?error, "tray discard request could not be delivered");
                }
            }
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn tray_start(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    let _ = start_or_focus(&state, &app);
    // Mirror shortcut behavior: push the new status to the UI at once.
    crate::commands::recording::emit_current_status(&app, &state);
}

fn tray_toggle_pause_resume(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    let _ = toggle_pause_resume(&state);
    crate::commands::recording::emit_current_status(&app, &state);
}

fn tray_stop_recording(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    // Delegate to the shared stop command so the tray gets full parity with
    // the UI: completion event, countdown cleanup, window restore.
    let _ = crate::commands::recording::stop_recording(app.clone(), state);
}

fn recorder_is_active(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    state
        .recorder
        .lock()
        .ok()
        .and_then(|guard| guard.status().ok())
        .map(|status| {
            matches!(
                status.state,
                RecorderState::Recording | RecorderState::Paused
            )
        })
        .unwrap_or(false)
}

fn start_or_focus(state: &tauri::State<AppState>, app: &tauri::AppHandle) -> Result<()> {
    let bounds = {
        let guard = state
            .recorder
            .lock()
            .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;

        let status = guard.status()?;
        if matches!(status.state, RecorderState::Idle) {
            let quick = state.quick_config.lock().map_err(|_| {
                crate::errors::InternalError::Capture("quick config mutex poisoned".into())
            })?;
            if let Some(config) = quick.as_ref() {
                let bounds = config.source.bounds;
                guard.start(config.clone())?;
                Some(bounds)
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(bounds) = bounds {
        if let Err(error) = crate::window::MainWindow::minimize(app) {
            tracing::warn!(error = ?error, "tray start could not minimize main window");
        }
        crate::commands::recording::open_recording_windows_async(app, bounds);
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

fn toggle_pause_resume(state: &tauri::State<AppState>) -> Result<()> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
    let status = guard.status()?;
    match status.state {
        RecorderState::Recording => guard.pause().map(|_| ()),
        RecorderState::Paused => guard.resume().map(|_| ()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_buffer(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            rgba.extend_from_slice(&[color[0], color[1], color[2], 255]);
        }
        rgba
    }

    #[test]
    fn tooltip_names_each_live_state() {
        assert_eq!(
            tray_tooltip(RecorderState::Recording),
            "recordForge — Recording"
        );
        assert_eq!(tray_tooltip(RecorderState::Paused), "recordForge — Paused");
        assert_eq!(
            tray_tooltip(RecorderState::Countdown),
            "recordForge — Starting…"
        );
        assert_eq!(
            tray_tooltip(RecorderState::Finalizing),
            "recordForge — Saving…"
        );
        assert_eq!(tray_tooltip(RecorderState::Idle), "recordForge");
        assert_eq!(tray_tooltip(RecorderState::Completed), "recordForge");
    }

    #[test]
    fn badge_marks_recording_and_pause_only() {
        assert_eq!(
            tray_badge_color(RecorderState::Recording),
            Some([239, 68, 68])
        );
        assert_eq!(
            tray_badge_color(RecorderState::Paused),
            Some([245, 158, 11])
        );
        assert_eq!(tray_badge_color(RecorderState::Idle), None);
        assert_eq!(tray_badge_color(RecorderState::Countdown), None);
        assert_eq!(tray_badge_color(RecorderState::Completed), None);
    }

    #[test]
    fn badge_paints_dot_center_and_leaves_rest_untouched() {
        let blue = [40, 80, 200];
        let red = [239, 68, 68];
        let mut rgba = solid_buffer(32, 32, blue);
        let original = rgba.clone();
        paint_status_badge(&mut rgba, 32, 32, red);

        assert_eq!(rgba.len(), original.len(), "buffer size must not change");

        // Badge center (geometry for 32px: radius 9, ring 3, center (20.5, 20.5))
        // is fully covered by the status fill.
        let center = ((20 * 32 + 20) * 4) as usize;
        assert_eq!(&rgba[center..center + 3], &red);
        assert_eq!(rgba[center + 3], 255);

        // Far corner is outside the badge and must be byte-identical.
        let far = 0; // pixel (0, 0)
        assert_eq!(&rgba[far..far + 4], &original[far..far + 4]);
        let far_top_right = 31 * 4; // pixel (31, 0)
        assert_eq!(
            &rgba[far_top_right..far_top_right + 4],
            &original[far_top_right..far_top_right + 4]
        );
    }

    #[test]
    fn badge_works_at_small_tray_sizes_without_panicking() {
        let mut rgba = solid_buffer(16, 16, [20, 20, 20]);
        let amber = [245, 158, 11];
        paint_status_badge(&mut rgba, 16, 16, amber);
        // Radius clamps to >= 2, so the corner region must contain badge pixels.
        assert!(
            rgba.chunks_exact(4)
                .any(|px| px[0] == amber[0] && px[1] == amber[1] && px[2] == amber[2]),
            "expected at least one fully-covered amber pixel"
        );
    }

    #[test]
    fn badge_ignores_degenerate_buffers() {
        // Zero dimensions and empty buffers must be no-ops, not panics.
        let mut empty: Vec<u8> = Vec::new();
        paint_status_badge(&mut empty, 0, 0, [1, 2, 3]);
        assert!(empty.is_empty());

        let mut short = vec![255u8; 16]; // Not a full pixel grid.
        let before = short.clone();
        paint_status_badge(&mut short, 32, 32, [1, 2, 3]);
        assert_eq!(short, before, "malformed buffer must be left untouched");
    }

    #[test]
    fn blend_pixel_composes_source_over() {
        let mut pixel = [10, 10, 10, 255];
        blend_pixel(&mut pixel, [100, 100, 100], 0.5);
        assert_eq!(pixel, [55, 55, 55, 255]);

        // Full coverage overwrites; zero coverage is a no-op.
        let mut pixel = [10, 20, 30, 255];
        blend_pixel(&mut pixel, [200, 210, 220], 1.0);
        assert_eq!(pixel, [200, 210, 220, 255]);
        let mut pixel = [10, 20, 30, 128];
        blend_pixel(&mut pixel, [200, 210, 220], 0.0);
        assert_eq!(pixel, [10, 20, 30, 128]);
    }
}
