pub mod capture;
pub mod commands;
pub mod database;
pub mod errors;
pub mod events;
pub mod exports;
pub mod jobs;
pub mod media;
pub mod path_policy;
pub mod process;
pub mod projects;
pub mod shortcuts;
pub mod state;
pub mod storage;
pub mod tray;
pub mod validation;
pub mod window;
pub mod window_effects;

use tauri::Manager;
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
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();
                    let state = app.state::<state::AppState>();
                    let minimize_to_tray = state
                        .db
                        .lock()
                        .ok()
                        .and_then(|db| {
                            crate::database::settings::get_setting(&db, "minimizeToTray")
                                .ok()
                                .flatten()
                                .or_else(|| {
                                    crate::database::settings::get_setting(&db, "startMinimized")
                                        .ok()
                                        .flatten()
                                })
                        })
                        .map(|val| val == "true")
                        .unwrap_or(false);

                    if minimize_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
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
            commands::recording::discard_recording,
            commands::recording::recording_status,
            commands::recording::insert_marker,
            commands::recording::detect_hardware_encoders,
            commands::recording::get_diagnostics_report,
            commands::recording::scan_recovery_sessions,
            commands::recording::recover_session,
            commands::recording::delete_recovery_session,
            commands::recording::get_cursor_telemetry,
            commands::recording::get_recording_smart_zoom,
            commands::recording::run_encoder_benchmark,
            commands::recording::list_recordings,
            commands::recording::delete_recording,
            commands::recording::reveal_recording,
            commands::recording::add_recording_tag,
            commands::recording::remove_recording_tag,
            commands::recording::trim_recording,
            commands::recording::export_recording,
            commands::recording::open_floating_controls,
            commands::recording::hide_floating_controls,
            commands::recording::open_boundary_overlay,
            commands::recording::hide_boundary_overlay,
            commands::recording::open_region_picker,
            commands::recording::cancel_region_picker,
            commands::recording::show_main_window,
            commands::media::prepare_media,
            commands::media::cancel_media_job,
            commands::media::get_media_job,
            commands::media::list_media_jobs,
            commands::media::get_media_metadata,
            commands::media::delete_derivatives,
            commands::media::estimate_prepare_disk_space,
            commands::projects::load_project_for_recording,
            commands::projects::list_projects,
            commands::projects::save_project,
            commands::projects::create_project,
            commands::projects::create_bootstrap_project,
            commands::projects::rename_project,
            commands::projects::duplicate_project,
            commands::projects::delete_project,
            commands::projects::relink_project_asset,
            commands::projects::snapshot_project,
            commands::projects::get_project_asset_paths,
            commands::assets::import_assets,
            commands::assets::delete_asset,
            commands::assets::relink_asset,
            commands::assets::probe_asset,
            commands::assets::start_derivative_job,
            commands::exports::export_timeline,
            commands::exports::retry_export,
            commands::exports::reveal_export,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::set_window_transparency,
            commands::settings::window_transparency_active,
            commands::storage::list_storage_profiles,
            commands::storage::save_s3_profile,
            commands::storage::save_google_drive_profile,
            commands::storage::save_local_profile,
            commands::storage::delete_storage_profile,
            commands::storage::test_storage_profile,
            commands::storage::test_s3_credentials,
            commands::storage::start_google_drive_oauth,
            commands::storage::start_upload_job,
            commands::storage::cancel_upload_job,
            commands::storage::retry_upload_job,
            commands::storage::list_upload_jobs,
            commands::storage::delete_upload_job,
            commands::updates::get_update_readiness,
            commands::updates::begin_update_install,
            commands::updates::cancel_update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
