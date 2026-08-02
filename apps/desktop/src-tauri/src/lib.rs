pub mod capture;
pub mod commands;
pub mod database;
pub mod errors;
pub mod shortcuts;
pub mod state;
pub mod tray;

use tracing::{info, instrument};

use errors::Result;

/// Greeting command used by the initial setup to verify React-to-Rust IPC.
#[tauri::command]
#[instrument]
fn greet(name: &str) -> Result<String> {
    if name.trim().is_empty() {
        return Err(errors::InternalError::Unknown("name is required".to_string()).into());
    }

    info!(name = name, "greet command invoked");
    Ok(format!("Hello, {}! You've been greeted from Rust.", name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing subscriber for structured logging.
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("recordForge desktop starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(err) = commands::recording::init(app) {
                tracing::error!(error = ?err, "failed to initialize recorder state");
            }
            if let Err(err) = tray::create_tray(app) {
                tracing::error!(error = ?err, "failed to create tray icon");
            }
            if let Err(err) = shortcuts::register_shortcuts(app) {
                tracing::error!(error = ?err, "failed to register global shortcuts");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::recording::list_capture_sources,
            commands::recording::list_audio_devices,
            commands::recording::list_video_devices,
            commands::recording::list_builtin_profiles,
            commands::recording::start_recording,
            commands::recording::pause_recording,
            commands::recording::resume_recording,
            commands::recording::stop_recording,
            commands::recording::recording_status,
            commands::recording::insert_marker,
            commands::recording::detect_hardware_encoders,
            commands::recording::get_diagnostics_report,
            commands::recording::scan_recovery_sessions,
            commands::recording::recover_session,
            commands::recording::delete_recovery_session,
            commands::recording::run_encoder_benchmark,
            commands::recording::list_recordings,
            commands::recording::delete_recording,
            commands::recording::reveal_recording,
            commands::recording::add_recording_tag,
            commands::recording::remove_recording_tag,
            commands::recording::trim_recording,
            commands::recording::export_recording,
            commands::recording::open_floating_controls,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
