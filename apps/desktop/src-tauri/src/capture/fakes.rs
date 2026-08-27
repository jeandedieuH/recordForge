//! Deterministic fake adapters for unit and integration testing.
//!
//! These adapters allow testing the entire capture lifecycle (start, pause,
//! resume, stop, alignment, recovery) deterministically without depending
//! on the host OS audio drivers, display servers, or physical monitors.

use std::fmt::Debug;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::audio::wav::{
    align_wav_to_duration, finalize_wav, write_wav_header, AudioSampleFormat, DEFAULT_CHANNELS,
    DEFAULT_SAMPLE_RATE,
};
use super::cursor_v2::CursorTelemetryHealth;
use super::source::{Bounds, CaptureSource};
use super::traits::{AudioTrack, CursorTelemetryAdapter, SourceProvider};
use crate::errors::Result;

/// A deterministic fake audio track that writes valid WAV headers and sample data.
#[derive(Debug)]
pub struct FakeAudioTrack {
    output_path: PathBuf,
    started_at: Instant,
    sample_rate: u32,
    channels: u16,
    sample_format: AudioSampleFormat,
    stop_requested: Arc<AtomicBool>,
    bytes_written: u64,
}

impl FakeAudioTrack {
    /// Create and initialize a new fake audio track at the specified path.
    pub fn new(output_path: PathBuf, timeline_origin: Instant) -> Result<Self> {
        if let Some(parent) = output_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&output_path)
            .map_err(|e| crate::errors::InternalError::Storage(e.to_string()))?;

        write_wav_header(
            &mut file,
            DEFAULT_SAMPLE_RATE,
            DEFAULT_CHANNELS,
            AudioSampleFormat::Pcm16,
        )
        .map_err(|e| crate::errors::InternalError::Capture(e.to_string()))?;

        // Write 100ms of deterministic audio data
        let sample_bytes = (DEFAULT_SAMPLE_RATE / 10) * u32::from(DEFAULT_CHANNELS) * 2;
        let data = vec![0x10u8; sample_bytes as usize];
        use std::io::Write;
        file.write_all(&data)
            .map_err(|e| crate::errors::InternalError::Storage(e.to_string()))?;

        finalize_wav(&mut file, sample_bytes as u64)
            .map_err(|e| crate::errors::InternalError::Capture(e.to_string()))?;

        Ok(Self {
            output_path,
            started_at: timeline_origin,
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            sample_format: AudioSampleFormat::Pcm16,
            stop_requested: Arc::new(AtomicBool::new(false)),
            bytes_written: sample_bytes as u64,
        })
    }
}

impl AudioTrack for FakeAudioTrack {
    fn started_at(&self) -> Instant {
        self.started_at
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }

    fn stop(&mut self) -> Result<u64> {
        self.stop_requested.store(true, Ordering::Release);
        Ok(self.bytes_written)
    }

    fn align_to_timeline(&self, head_trim: Duration, duration: Duration) -> Result<u64> {
        align_wav_to_duration(
            &self.output_path,
            self.sample_rate,
            self.channels,
            self.sample_format,
            head_trim,
            duration,
        )
        .map_err(|e| crate::errors::InternalError::Capture(e.to_string()).into())
    }

    fn output_path(&self) -> &Path {
        &self.output_path
    }
}

/// Deterministic fake source provider for tests.
#[derive(Debug, Default)]
pub struct FakeSourceProvider {
    pub displays: Vec<CaptureSource>,
    pub windows: Vec<CaptureSource>,
}

impl FakeSourceProvider {
    pub fn standard_dual_monitor() -> Self {
        Self {
            displays: vec![
                CaptureSource {
                    kind: "display".into(),
                    id: "display-0".into(),
                    name: "Primary Display".into(),
                    bounds: Bounds {
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                    },
                },
                CaptureSource {
                    kind: "display".into(),
                    id: "display-1".into(),
                    name: "Secondary Display".into(),
                    bounds: Bounds {
                        x: 1920,
                        y: 0,
                        width: 2560,
                        height: 1440,
                    },
                },
            ],
            windows: vec![CaptureSource {
                kind: "window".into(),
                id: "win-1001".into(),
                name: "Test Editor Window".into(),
                bounds: Bounds {
                    x: 100,
                    y: 100,
                    width: 1200,
                    height: 800,
                },
            }],
        }
    }
}

impl SourceProvider for FakeSourceProvider {
    fn enumerate_sources(&self) -> Result<Vec<CaptureSource>> {
        let mut all = self.displays.clone();
        all.extend(self.windows.clone());
        Ok(all)
    }

    fn refresh_window_bounds(&self, source: &CaptureSource) -> Option<Bounds> {
        self.windows
            .iter()
            .find(|w| w.id == source.id)
            .map(|w| w.bounds)
    }
}

/// Deterministic fake cursor adapter for tests.
#[derive(Debug)]
pub struct FakeCursorAdapter {
    pub health: CursorTelemetryHealth,
}

impl Default for FakeCursorAdapter {
    fn default() -> Self {
        Self {
            health: CursorTelemetryHealth::Healthy,
        }
    }
}

impl CursorTelemetryAdapter for FakeCursorAdapter {
    fn check_health(&self) -> CursorTelemetryHealth {
        self.health
    }
}
