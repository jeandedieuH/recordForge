//! Live & Session Metrics Collector
//!
//! Collects real-time performance telemetry during recording sessions:
//! frames processed, dropped frames, actual vs requested FPS, CPU/memory
//! utilization, and disk write throughput.

use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetrics {
    pub requested_fps: u32,
    pub actual_fps: f64,
    pub frames_processed: u64,
    pub dropped_frames: Option<u64>,
    pub cpu_usage_percent: Option<f64>,
    pub memory_working_set_mb: Option<f64>,
    pub disk_write_rate_mbps: Option<f64>,
    pub audio_underruns: Option<u32>,
    pub av_drift_ms: Option<f64>,
}

pub struct MetricsCollector {
    requested_fps: u32,
    start_time: Instant,
    last_frame_count: u64,
}

impl MetricsCollector {
    pub fn new(requested_fps: u32) -> Self {
        Self {
            requested_fps,
            start_time: Instant::now(),
            last_frame_count: 0,
        }
    }

    pub fn snapshot(&mut self, current_frames: u64) -> SessionMetrics {
        let elapsed_sec = self.start_time.elapsed().as_secs_f64().max(0.001);
        let actual_fps = current_frames as f64 / elapsed_sec;

        self.last_frame_count = current_frames;

        SessionMetrics {
            requested_fps: self.requested_fps,
            actual_fps,
            frames_processed: current_frames,
            dropped_frames: None,
            cpu_usage_percent: None,
            memory_working_set_mb: None,
            disk_write_rate_mbps: None,
            audio_underruns: None,
            av_drift_ms: None,
        }
    }
}

/// One FFmpeg `-progress` block, accumulated from `key=value` lines.
///
/// Frame, FPS, and duplicate/drop counters describe the first video output.
/// FPS is an average since transcoding started, not instantaneous sensor FPS.
/// Speed and output time describe FFmpeg's process-level progress timeline.
/// Missing, negative, and non-finite values remain unavailable, never estimated.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProgress {
    pub output_frames: Option<u64>,
    pub output_fps: Option<f64>,
    pub speed: Option<f64>,
    pub duplicated_frames: Option<u64>,
    pub dropped_frames: Option<u64>,
    /// Output timestamp in microseconds as reported by FFmpeg (`out_time_us`).
    pub output_time_us: Option<u64>,
}

impl CaptureProgress {
    /// Fold one `key=value` progress line into this accumulator.
    ///
    /// Returns `true` only on the `progress=continue|end` terminator that
    /// completes a block, so the caller knows when to publish the pending
    /// values as one consistent snapshot.
    pub fn update(&mut self, line: &str) -> bool {
        let Some((key, value)) = line.trim().split_once('=') else {
            return false;
        };
        let value = value.trim();
        match key {
            "frame" => self.output_frames = value.parse().ok(),
            "fps" => self.output_fps = finite_nonnegative(value),
            "speed" => self.speed = finite_nonnegative(value.trim_end_matches('x')),
            "dup_frames" => self.duplicated_frames = value.parse().ok(),
            "drop_frames" => self.dropped_frames = value.parse().ok(),
            "out_time_us" => self.output_time_us = value.parse().ok(),
            "progress" => return matches!(value, "continue" | "end"),
            _ => {}
        }
        false
    }
}

fn finite_nonnegative(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
}

/// Point-in-time diagnostics for one FFmpeg capture process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDiagnostics {
    pub process_id: u32,
    /// Encoder that actually produced this capture's output — after any
    /// startup fallback, not merely the requested candidate.
    pub encoder: String,
    /// Concrete input path used (e.g. `ddagrab-cpu`, `dshow-camera`).
    pub backend: String,
    pub requested_fps: f64,
    #[serde(default)]
    pub startup_ready_ms: Option<u64>,
    #[serde(default)]
    pub preview_fps: Option<i32>,
    /// Camera mode negotiated for a webcam capture, or `None` when the device
    /// defaults were used (probe failure or no advertised modes).
    pub requested_camera_mode: Option<super::webcam::CameraMode>,
    /// Generic reason code when a non-primary mode/encoder was selected
    /// (e.g. `encoder-fallback`); never carries stderr text or paths.
    pub fallback_reason: Option<String>,
    pub progress: CaptureProgress,
    /// Age of the last complete progress block; `None` before the first one.
    pub progress_age_ms: Option<u64>,
    /// True once the process's stderr reached EOF (process exited).
    pub exited: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSegmentDiagnostics {
    pub index: u32,
    pub screen: Option<CaptureDiagnostics>,
    pub camera: Option<CaptureDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCaptureDiagnostics {
    pub session_id: String,
    pub segments: Vec<CaptureSegmentDiagnostics>,
}

pub fn upsert_capture_diagnostics(
    segments: &mut Vec<CaptureSegmentDiagnostics>,
    index: u32,
    camera: bool,
    snapshot: CaptureDiagnostics,
) {
    let position = segments
        .iter()
        .position(|segment| segment.index == index)
        .unwrap_or_else(|| {
            segments.push(CaptureSegmentDiagnostics {
                index,
                ..Default::default()
            });
            segments.len() - 1
        });
    if camera {
        segments[position].camera = Some(snapshot);
    } else {
        segments[position].screen = Some(snapshot);
    }
}

/// Mutable runtime state behind each capture's progress tracking. `pending`
/// collects the in-flight progress block; `published` is the last complete
/// block committed by a `progress=` terminator line.
pub(crate) struct CaptureProgressState {
    pub pending: CaptureProgress,
    pub published: CaptureProgress,
    pub updated_at: Option<Instant>,
    pub exited: bool,
}

impl CaptureProgressState {
    pub(crate) fn new() -> Self {
        Self {
            pending: CaptureProgress::default(),
            published: CaptureProgress::default(),
            updated_at: None,
            exited: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_block_commits_only_on_terminator() {
        let mut progress = CaptureProgress::default();
        assert!(!progress.update("frame=42"));
        assert!(!progress.update("fps=29.97"));
        assert!(!progress.update("speed=1.0x"));
        assert!(!progress.update("dup_frames=2"));
        assert!(!progress.update("drop_frames=0"));
        assert!(!progress.update("out_time_us=1401334"));

        // Values are accumulated but the block is only complete when the
        // progress terminator arrives.
        assert!(progress.update("progress=continue"));
        assert_eq!(progress.output_frames, Some(42));
        assert_eq!(progress.output_fps, Some(29.97));
        assert_eq!(progress.speed, Some(1.0));
        assert_eq!(progress.duplicated_frames, Some(2));
        assert_eq!(progress.dropped_frames, Some(0));
        // out_time_us is FFmpeg's output timestamp in microseconds.
        assert_eq!(progress.output_time_us, Some(1_401_334));

        assert!(progress.update("progress=end"));
        assert!(!progress.update("progress=aborted"));
    }

    #[test]
    fn progress_rejects_invalid_and_missing_values() {
        let mut progress = CaptureProgress::default();
        progress.update("frame=N/A");
        progress.update("fps=N/A");
        progress.update("fps=-1.5");
        progress.update("fps=NaN");
        progress.update("fps=inf");
        progress.update("speed=N/A");
        progress.update("speed=-2x");
        progress.update("out_time_us=-5");
        progress.update("dup_frames=abc");

        // Nothing may be invented: rejected values stay None.
        assert_eq!(progress.output_frames, None);
        assert_eq!(progress.output_fps, None);
        assert_eq!(progress.speed, None);
        assert_eq!(progress.output_time_us, None);
        assert_eq!(progress.duplicated_frames, None);
    }

    #[test]
    fn progress_ignores_unknown_keys_and_non_key_value_lines() {
        let mut progress = CaptureProgress::default();
        assert!(!progress.update("Input #0, dshow, from 'camera':"));
        assert!(!progress.update("bitrate=N/A"));
        assert!(!progress.update("total_size=1048576"));
        assert_eq!(progress, CaptureProgress::default());
    }

    #[test]
    fn completing_blocks_clears_missing_values() {
        let mut state = CaptureProgressState::new();
        for line in [
            "frame=1",
            "speed=1.0x",
            "progress=continue",
            "frame=2",
            "progress=end",
        ] {
            if state.pending.update(line) {
                state.published = std::mem::take(&mut state.pending);
            }
        }
        assert_eq!(state.published.output_frames, Some(2));
        assert_eq!(state.published.speed, None);
    }

    fn sample_diagnostics(encoder: &str) -> CaptureDiagnostics {
        CaptureDiagnostics {
            process_id: 42,
            encoder: encoder.into(),
            backend: "lavfi-testsrc".into(),
            requested_fps: 30.0,
            startup_ready_ms: Some(150),
            preview_fps: None,
            requested_camera_mode: None,
            fallback_reason: None,
            progress: CaptureProgress {
                output_frames: Some(60),
                output_fps: Some(30.0),
                speed: Some(1.0),
                duplicated_frames: Some(0),
                dropped_frames: None,
                output_time_us: Some(2_000_000),
            },
            progress_age_ms: Some(40),
            exited: false,
        }
    }

    #[test]
    fn upsert_keeps_screen_and_camera_in_one_segment() {
        let mut segments = Vec::new();
        // Two snapshots for the same index — screen and camera — must share
        // one segment entry, each role retained independently.
        upsert_capture_diagnostics(&mut segments, 0, false, sample_diagnostics("libx264"));
        upsert_capture_diagnostics(&mut segments, 0, true, sample_diagnostics("h264_mf"));
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].index, 0);
        assert_eq!(
            segments[0].screen.as_ref().map(|d| d.encoder.as_str()),
            Some("libx264")
        );
        assert_eq!(
            segments[0].camera.as_ref().map(|d| d.encoder.as_str()),
            Some("h264_mf")
        );

        // A different index produces a second segment entry.
        upsert_capture_diagnostics(&mut segments, 1, false, sample_diagnostics("libx264"));
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[1].index, 1);
        assert!(segments[1].camera.is_none());
    }

    #[test]
    fn metrics_collector_snapshot_is_unchanged() {
        let mut collector = MetricsCollector::new(30);
        let snapshot = collector.snapshot(90);
        assert_eq!(snapshot.frames_processed, 90);
        assert_eq!(snapshot.requested_fps, 30);
        assert_eq!(snapshot.dropped_frames, None);
        assert_eq!(snapshot.cpu_usage_percent, None);
        assert_eq!(snapshot.memory_working_set_mb, None);
        assert_eq!(snapshot.disk_write_rate_mbps, None);
        assert_eq!(snapshot.audio_underruns, None);
        assert_eq!(snapshot.av_drift_ms, None);
    }
}
