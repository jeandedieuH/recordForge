pub mod capture;
pub mod commands;
pub mod database;
pub mod errors;
pub mod events;
pub mod exports;
pub mod jobs;
pub mod media;
pub mod path_policy;
pub mod shortcuts;
pub mod state;
pub mod storage;
pub mod tray;
pub mod validation;
pub mod window;
pub mod window_effects;

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
            // Frameless chrome: apply the Mica backdrop per the stored setting
            // (falls back to opaque on failure or when disabled).
            window_effects::apply_startup_effects(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::recording::list_capture_sources,
            commands::recording::list_audio_devices,
            commands::recording::list_video_devices,
            commands::recording::list_builtin_profiles,
            commands::recording::start_recording,
            commands::recording::prepare_recording,
            commands::recording::confirm_recording_start,
            commands::recording::cancel_recording_start,
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
            commands::recording::get_cursor_telemetry,
            commands::recording::run_encoder_benchmark,
            commands::recording::list_recordings,
            commands::recording::delete_recording,
            commands::recording::reveal_recording,
            commands::recording::add_recording_tag,
            commands::recording::remove_recording_tag,
            commands::recording::trim_recording,
            commands::recording::export_recording,
            commands::recording::open_floating_controls,
            commands::media::prepare_media,
            commands::media::cancel_media_job,
            commands::media::get_media_job,
            commands::media::list_media_jobs,
            commands::media::get_media_metadata,
            commands::media::delete_derivatives,
            commands::media::estimate_prepare_disk_space,
            commands::exports::export_timeline,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::set_window_transparency,
            commands::settings::window_transparency_active,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
