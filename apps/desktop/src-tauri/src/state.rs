use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::capture::config::RecordingConfig;
use crate::capture::session::Recorder;

/// Application state shared between Tauri commands and the Tauri setup hook.
///
/// The recorder and database connection live here so that any command can
/// access the current capture session or persist library metadata.
#[derive(Debug)]
pub struct AppState {
    pub recorder: Arc<Mutex<Recorder>>,
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub sessions_dir: PathBuf,
    pub ffmpeg_path: PathBuf,
    /// Last-used quick-start config for global shortcuts and the tray menu.
    pub quick_config: Arc<Mutex<Option<RecordingConfig>>>,
}
