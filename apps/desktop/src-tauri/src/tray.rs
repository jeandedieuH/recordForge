use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

use crate::capture::manifest::RecorderState;
use crate::errors::{InternalError, Result};
use crate::state::AppState;

fn map_tauri_err(e: tauri::Error) -> InternalError {
    InternalError::Unknown(format!("{e:?}"))
}

/// Create the system tray icon and menu for recordForge.
pub fn create_tray(app: &tauri::App) -> Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>).map_err(map_tauri_err)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>).map_err(map_tauri_err)?;
    let start = MenuItem::with_id(app, "start", "Start Recording", true, None::<&str>)
        .map_err(map_tauri_err)?;
    let pause = MenuItem::with_id(app, "pause", "Pause / Resume", true, None::<&str>)
        .map_err(map_tauri_err)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Recording", true, None::<&str>)
        .map_err(map_tauri_err)?;
    let marker = MenuItem::with_id(app, "marker", "Insert Marker", true, None::<&str>)
        .map_err(map_tauri_err)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(map_tauri_err)?;

    let menu = Menu::with_items(app, &[&show, &hide, &start, &pause, &stop, &marker, &quit])
        .map_err(map_tauri_err)?;

    let icon = app
        .default_window_icon()
        .ok_or(InternalError::Unknown("no default window icon".into()))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon.clone())
        .tooltip("recordForge")
        .menu(&menu)
        .on_menu_event(handle_tray_event)
        .build(app)
        .map_err(map_tauri_err)?;

    Ok(())
}

fn handle_tray_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let state = app.state::<AppState>();

    match event.id().as_ref() {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "hide" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "start" => {
            let _ = start_or_focus(&state, app);
        }
        "pause" => {
            let _ = toggle_pause_resume(&state);
        }
        "stop" => {
            let _ = stop_recording(&state);
        }
        "marker" => {
            let _ = insert_marker(&state);
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn start_or_focus(state: &tauri::State<AppState>, app: &tauri::AppHandle) -> Result<()> {
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
            guard.start(config.clone())?;
            return Ok(());
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

fn stop_recording(state: &tauri::State<AppState>) -> Result<()> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
    guard.stop().map(|_| ())
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

fn insert_marker(state: &tauri::State<AppState>) -> Result<()> {
    let guard = state
        .recorder
        .lock()
        .map_err(|_| crate::errors::InternalError::Capture("recorder mutex poisoned".into()))?;
    guard.insert_marker("tray marker".into()).map(|_| ())
}
