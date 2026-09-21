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

/// Snapshot of the smart-zoom preference used to create a recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSmartZoom {
    pub enabled: bool,
    pub preset: String,
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
    /// Wall-clock span from timeline origin to the instant the quit signal was
    /// sent. Unlike `duration_ms` (measured at process exit) this excludes the
    /// encoder flush and trailer write, so it tracks the captured frames.
    #[serde(default)]
    pub quit_span_ms: u64,
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
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub selected_encoder: Option<String>,
    pub work_dir: String,
    pub output_path: Option<String>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    #[serde(default)]
    pub webcam_path: Option<String>,
    #[serde(default)]
    pub webcam_fragments: Vec<RecordingWebcamFragment>,
    #[serde(default)]
    pub capture_diagnostics: Vec<super::metrics::CaptureSegmentDiagnostics>,
    pub fragments: Vec<RecordingFragment>,
    #[serde(default)]
    pub markers: Vec<RecordingMarker>,
    #[serde(default)]
    pub smart_zoom: Option<RecordingSmartZoom>,
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
        let host_platform = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unknown"
        };

        Self {
            version: 1,
            session_id: session_id.into(),
            state: RecorderState::Recording,
            created_at: now.clone(),
            updated_at: now,
            source,
            profile_name: profile_name.into(),
            platform: Some(host_platform.into()),
            backend: None,
            selected_encoder: None,
            work_dir: work_dir.into(),
            output_path: None,
            thumbnail_path: None,
            webcam_path: None,
            webcam_fragments: Vec::new(),
            capture_diagnostics: Vec::new(),
            fragments: Vec::new(),
            markers: Vec::new(),
            smart_zoom: None,
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

    pub fn set_thumbnail_path(&mut self, path: impl Into<String>) {
        self.thumbnail_path = Some(path.into());
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

    pub fn set_smart_zoom(&mut self, smart_zoom: RecordingSmartZoom) {
        self.smart_zoom = Some(smart_zoom);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::metrics::CaptureDiagnostics;
    use crate::capture::source::Bounds;

    fn sample_source() -> CaptureSource {
        CaptureSource {
            kind: "display".into(),
            id: "display-0".into(),
            name: "Display 1".into(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        }
    }

    fn sample_diagnostics(encoder: &str) -> CaptureDiagnostics {
        CaptureDiagnostics {
            process_id: 1234,
            encoder: encoder.into(),
            backend: "lavfi-testsrc".into(),
            requested_fps: 30.0,
            startup_ready_ms: Some(180),
            preview_fps: None,
            requested_camera_mode: None,
            fallback_reason: None,
            progress: super::super::metrics::CaptureProgress {
                output_frames: Some(120),
                output_fps: Some(29.97),
                speed: Some(1.0),
                duplicated_frames: Some(0),
                dropped_frames: None,
                output_time_us: Some(4_000_000),
            },
            progress_age_ms: Some(50),
            exited: true,
        }
    }

    #[test]
    fn manifest_without_capture_diagnostics_loads_empty() {
        // Session manifests written before capture diagnostics existed must
        // still load — the field defaults to an empty list, never an error.
        let json = r#"{
            "version": 1,
            "sessionId": "session-1",
            "state": "completed",
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
            "source": {"kind": "display", "id": "display-0", "name": "Display 1",
                "bounds": {"x": 0, "y": 0, "width": 1920, "height": 1080}},
            "profileName": "balanced",
            "workDir": "work",
            "fragments": []
        }"#;
        let manifest: RecordingManifest =
            serde_json::from_str(json).expect("legacy manifest parses");
        assert!(manifest.capture_diagnostics.is_empty());
    }

    #[test]
    fn capture_diagnostics_serialize_camel_case_and_roundtrip() {
        let mut manifest = RecordingManifest::new("session-1", "work", sample_source(), "balanced");
        super::super::metrics::upsert_capture_diagnostics(
            &mut manifest.capture_diagnostics,
            0,
            false,
            sample_diagnostics("libx264"),
        );
        super::super::metrics::upsert_capture_diagnostics(
            &mut manifest.capture_diagnostics,
            0,
            true,
            sample_diagnostics("h264_mf"),
        );

        let json = serde_json::to_string(&manifest).expect("serialize manifest");
        assert!(json.contains("\"captureDiagnostics\""));
        assert!(json.contains("\"startupReadyMs\""));
        assert!(json.contains("\"previewFps\""));
        assert!(json.contains("\"requestedCameraMode\""));
        assert!(json.contains("\"outputFrames\""));
        // Missing counters stay null — never a fabricated zero metric name.
        assert!(!json.contains("sensorFps"));

        let back: RecordingManifest = serde_json::from_str(&json).expect("roundtrip manifest");
        assert_eq!(back.capture_diagnostics.len(), 1);
        let segment = &back.capture_diagnostics[0];
        assert_eq!(segment.index, 0);
        assert_eq!(
            segment.screen.as_ref().map(|d| d.encoder.as_str()),
            Some("libx264")
        );
        assert_eq!(
            segment.camera.as_ref().map(|d| d.encoder.as_str()),
            Some("h264_mf")
        );
    }
}
