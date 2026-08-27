use std::fmt::Debug;
use std::path::Path;
use std::time::{Duration, Instant};

use super::cursor_v2::CursorTelemetryHealth;
use super::source::{Bounds, CaptureSource};
use crate::errors::Result;

/// Platform-neutral contract for a running audio capture track (microphone or system loopback).
pub trait AudioTrack: Debug + Send + Sync {
    /// Monotonic timestamp when the track began capturing or was ready.
    fn started_at(&self) -> Instant;

    /// Non-blocking request to signal the audio worker thread to stop recording.
    fn request_stop(&self);

    /// Stop the capture worker, finalize the WAV container, and return total payload bytes written.
    fn stop(&mut self) -> Result<u64>;

    /// Align the finalized audio track to the video timeline duration with optional head trim.
    fn align_to_timeline(&self, head_trim: Duration, duration: Duration) -> Result<u64>;

    /// Path to the recorded WAV audio file.
    fn output_path(&self) -> &Path;
}

/// Platform-neutral contract for discovering and refreshing capture sources (displays, windows, regions).
pub trait SourceProvider: Send + Sync {
    /// Enumerate all shareable displays and windows on the host system.
    fn enumerate_sources(&self) -> Result<Vec<CaptureSource>>;

    /// Re-query the current physical bounds of an existing window source.
    fn refresh_window_bounds(&self, source: &CaptureSource) -> Option<Bounds>;
}

/// Platform-neutral contract for cursor telemetry health checks and capture.
pub trait CursorTelemetryAdapter: Send + Sync {
    /// Check whether cursor position, buttons, shapes, and topology are accessible.
    fn check_health(&self) -> CursorTelemetryHealth;
}
