use std::fmt::Debug;
use std::path::Path;
use std::time::{Duration, Instant};

use super::cursor_v2::CursorTelemetryHealth;
use super::source::{Bounds, CaptureSource};
use crate::errors::Result;

#[derive(Debug, Clone, Copy)]
pub struct TimelineAnchor {
    pub instant: Instant,
    pub qpc_100ns: Option<u64>,
}

impl TimelineAnchor {
    pub fn now() -> Self {
        let instant = Instant::now();
        Self {
            instant,
            qpc_100ns: performance_counter_100ns(),
        }
    }
}

#[cfg(windows)]
fn performance_counter_100ns() -> Option<u64> {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    let mut counter = 0i64;
    let mut frequency = 0i64;
    // SAFETY: Both pointers reference initialized, writable i64 values for the duration of the calls.
    unsafe {
        QueryPerformanceCounter(&mut counter).ok()?;
        QueryPerformanceFrequency(&mut frequency).ok()?;
    }
    if counter < 0 || frequency <= 0 {
        return None;
    }

    let value = (counter as u128)
        .saturating_mul(10_000_000)
        .checked_div(frequency as u128)?;
    u64::try_from(value).ok()
}

#[cfg(not(windows))]
fn performance_counter_100ns() -> Option<u64> {
    None
}

#[derive(Debug, Clone, Copy)]
pub struct AudioCaptureTiming {
    pub sample_rate: u32,
    pub synthetic_leading_frames: u64,
    pub captured_frames: u64,
    pub timeline_origin_qpc_100ns: u64,
    pub first_packet_qpc_100ns: u64,
    pub last_packet_qpc_100ns: u64,
    pub last_packet_frames: u32,
    pub timestamp_errors: u32,
    pub discontinuities: u32,
}

/// Platform-neutral contract for a running audio capture track (microphone or system loopback).
pub trait AudioTrack: Debug + Send + Sync {
    /// Monotonic timestamp when the track began capturing or was ready.
    fn started_at(&self) -> Instant;

    /// Non-blocking request to signal the audio worker thread to stop recording.
    fn request_stop(&self);

    /// Stop the capture worker, finalize the WAV container, and return total payload bytes written.
    fn stop(&mut self) -> Result<u64>;

    fn timing(&self) -> Option<AudioCaptureTiming> {
        None
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn timeline_anchor_includes_a_windows_performance_counter() {
        let first = TimelineAnchor::now();
        let second = TimelineAnchor::now();

        assert!(first.qpc_100ns.is_some());
        assert!(second.qpc_100ns >= first.qpc_100ns);
        assert!(second.instant >= first.instant);
    }
}
