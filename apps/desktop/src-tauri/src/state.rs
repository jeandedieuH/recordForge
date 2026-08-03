use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::capture::config::RecordingConfig;
use crate::capture::session::Recorder;
use crate::jobs::JobManager;
use crate::path_policy::PathPolicy;

/// Application state shared between Tauri commands and the Tauri setup hook.
///
/// The recorder, media job manager, and database connection live here so that
/// any command can access the current capture session, queue media jobs, or
/// persist library metadata.
#[derive(Debug)]
pub struct AppState {
    pub recorder: Arc<Mutex<Recorder>>,
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub job_manager: Arc<Mutex<JobManager>>,
    pub sessions_dir: PathBuf,
    pub ffmpeg_path: PathBuf,
    pub ffprobe_path: PathBuf,
    /// Last-used quick-start config for global shortcuts and the tray menu.
    pub quick_config: Arc<Mutex<Option<RecordingConfig>>>,
    /// Path authorization policy shared across commands.
    pub path_policy: PathPolicy,
}
