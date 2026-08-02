pub mod database;
pub mod errors;

use errors::Result;
use tauri::Manager;
use tracing::{info, instrument};

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
        .setup(|app| {
            if let Err(err) = initialize_database(app) {
                tracing::error!(error = ?err, "failed to initialize database");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn initialize_database(app: &tauri::App) -> errors::Result<()> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| errors::InternalError::Unknown(format!("app data dir: {e}")))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| errors::InternalError::Unknown(format!("create app data dir: {e}")))?;

    let db_path = app_data_dir.join("app.db");
    database::initialize(&db_path)
        .map_err(|e| errors::InternalError::Unknown(format!("open database: {e}")))?;

    info!(db_path = %db_path.display(), "database initialized");
    Ok(())
}
