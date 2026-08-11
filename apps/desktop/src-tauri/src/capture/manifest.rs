use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::cursor::{CursorCaptureBounds, CursorDpiScale, CursorTelemetryTimebase};
use super::disk;
use super::source::CaptureSource;

/// Recorder state mirrored from the shared contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecorderState {
    Idle,
    SelectingSource,
    Configuring,
    Countdown,
    Recording,
    Paused,
    Finalizing,
    Completed,
    Failed,
    Recovering,
    RecoveryRequired,
}

impl RecorderState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecorderState::Idle => "idle",
            RecorderState::SelectingSource => "selecting-source",
            RecorderState::Configuring => "configuring",
            RecorderState::Countdown => "countdown",
            RecorderState::Recording => "recording",
            RecorderState::Paused => "paused",
            RecorderState::Finalizing => "finalizing",
            RecorderState::Completed => "completed",
            RecorderState::Failed => "failed",
            RecorderState::Recovering => "recovering",
            RecorderState::RecoveryRequired => "recovery-required",
        }
    }
}

/// A user-defined marker placed during a recording session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMarker {
    pub id: String,
    pub label: String,
    pub timestamp_ms: u64,
    pub created_at: String,
}

/// Stats captured from the FFmpeg stderr at stop time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStats {
    pub frames_processed: Option<i64>,
    pub fps: Option<f64>,
    pub speed: Option<f64>,
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub output_size_bytes: u64,
}

/// A single finalized fragment of a recording session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFragment {
    pub index: u32,
    pub file_name: String,
    pub started_at: String,
    pub stopped_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<u64>,
    pub validated: bool,
}

/// A finalized webcam sidecar segment. Its offset is relative to the matching
/// screen segment and is used to build one continuous, standalone camera asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingWebcamFragment {
    pub index: u32,
    pub file_name: String,
    pub duration_ms: u64,
    pub offset_ms: i64,
    pub validated: bool,
}

/// Checkpoint metadata for the immutable cursor telemetry asset. Event data
/// remains in the asset file; the manifest only carries recovery identity.
///
/// Phase 5 extends the asset with V2 fields (coordinate transform, topology,
/// shape table, health, and the binary event file path). V1-only readers ignore
/// the new optional fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryAsset {
    pub asset_id: String,
    pub path: String,
    pub schema_version: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub capture_bounds: CursorCaptureBounds,
    pub dpi_scale: CursorDpiScale,
    pub timebase: CursorTelemetryTimebase,
    #[serde(default)]
    pub coordinate_transform: Option<super::cursor_v2::CursorCoordinateTransform>,
    #[serde(default)]
    pub topology: Option<super::cursor_v2::CursorTopology>,
    #[serde(default)]
    pub shapes: Vec<super::cursor_v2::CursorShapeInfo>,
    #[serde(default)]
    pub event_file: Option<String>,
    #[serde(default)]
    pub health: Option<super::cursor_v2::CursorTelemetryHealth>,
}

/// On-disk manifest for a recording session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingManifest {
    pub version: i32,
    pub session_id: String,
    pub state: RecorderState,
    pub created_at: String,
    pub updated_at: String,
    pub source: CaptureSource,
    pub profile_name: String,
    pub work_dir: String,
    pub output_path: Option<String>,
    #[serde(default)]
    pub webcam_path: Option<String>,
    #[serde(default)]
    pub webcam_fragments: Vec<RecordingWebcamFragment>,
    pub fragments: Vec<RecordingFragment>,
    #[serde(default)]
    pub markers: Vec<RecordingMarker>,
    #[serde(default)]
    pub total_recorded_ms: u64,
    #[serde(default)]
    pub cursor_telemetry: Option<CursorTelemetryAsset>,
    pub stats: Option<RecordingStats>,
}

impl RecordingManifest {
    pub fn new(
        session_id: impl Into<String>,
        work_dir: impl Into<String>,
        source: CaptureSource,
        profile_name: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            version: 1,
            session_id: session_id.into(),
            state: RecorderState::Recording,
            created_at: now.clone(),
            updated_at: now,
            source,
            profile_name: profile_name.into(),
            work_dir: work_dir.into(),
            output_path: None,
            webcam_path: None,
            webcam_fragments: Vec::new(),
            fragments: Vec::new(),
            markers: Vec::new(),
            total_recorded_ms: 0,
            cursor_telemetry: None,
            stats: None,
        }
    }

    /// Path to the manifest file inside the working directory.
    pub fn manifest_path(&self) -> PathBuf {
        Path::new(&self.work_dir).join("session.json")
    }

    /// Atomically update the manifest on disk. This is the recovery primitive:
    /// even if the app is killed, the last written manifest is valid.
    pub fn write(&self) -> crate::errors::Result<()> {
        let path = self.manifest_path();
        let temp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self).map_err(|e| {
            crate::errors::InternalError::Storage(format!("serialize manifest: {e}"))
        })?;

        std::fs::write(&temp, json).map_err(|e| {
            crate::errors::InternalError::Storage(format!("write manifest temp: {e}"))
        })?;
        disk::sync_file(&temp)?;
        disk::atomic_replace(&temp, &path)?;

        Ok(())
    }

    /// Read a manifest from a session directory.
    pub fn read(path: impl AsRef<Path>) -> crate::errors::Result<Self> {
        let data = std::fs::read_to_string(path.as_ref())
            .map_err(|e| crate::errors::InternalError::Storage(format!("read manifest: {e}")))?;
        let manifest: Self = serde_json::from_str(&data)
            .map_err(|e| crate::errors::InternalError::Storage(format!("parse manifest: {e}")))?;
        Ok(manifest)
    }

    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    pub fn add_fragment(&mut self, fragment: RecordingFragment) {
        self.fragments.push(fragment);
        self.touch();
    }

    pub fn set_state(&mut self, state: RecorderState) {
        self.state = state;
        self.touch();
    }

    pub fn set_output_path(&mut self, path: impl Into<String>) {
        self.output_path = Some(path.into());
        self.touch();
    }

    pub fn set_webcam_path(&mut self, path: impl Into<String>) {
        self.webcam_path = Some(path.into());
        self.touch();
    }

    pub fn add_webcam_fragment(&mut self, fragment: RecordingWebcamFragment) {
        self.webcam_fragments.push(fragment);
        self.touch();
    }

    pub fn set_stats(&mut self, stats: RecordingStats) {
        self.stats = Some(stats);
        self.touch();
    }

    pub fn set_total_recorded_ms(&mut self, ms: u64) {
        self.total_recorded_ms = ms;
        self.touch();
    }

    pub fn set_cursor_telemetry(&mut self, metadata: CursorTelemetryAsset) {
        self.cursor_telemetry = Some(metadata);
        self.touch();
    }

    pub fn add_marker(&mut self, marker: RecordingMarker) {
        self.markers.push(marker);
        self.touch();
    }
}
