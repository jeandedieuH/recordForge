use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tracing::{error, info};

// Re-export V2 types and helpers so consumers can find them under the cursor
// module while the legacy V1 tracker and V1 file type remain available.
pub use super::cursor_v2::{
    check_cursor_capture_health, enumerate_topologies, probe_cursor_topology, read_any_telemetry,
    read_v2_telemetry, write_v2_telemetry, CursorCaptureBounds, CursorCaptureMode,
    CursorCoordinateTransform, CursorDpiScale, CursorEventIndexEntry, CursorTelemetryEventV2,
    CursorTelemetryFileV2, CursorTelemetryHealth, CursorTelemetryMetadata, CursorTelemetryTimebase,
    CursorTopology, CursorTrackerV2,
};

const CURSOR_TELEMETRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryEvent {
    pub t_ms: u64,
    pub x: f64,
    pub y: f64,
    pub clicked: bool,
    pub button: String,
    #[serde(default = "default_button_event")]
    pub button_event: String,
    pub visible: bool,
    #[serde(default)]
    pub shape_id: Option<String>,
    #[serde(default)]
    pub shape_changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryFile {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub asset_id: String,
    pub recording_id: String,
    pub source_width: u32,
    pub source_height: u32,
    #[serde(default)]
    pub capture_bounds: Option<CursorCaptureBounds>,
    #[serde(default)]
    pub dpi_scale: Option<CursorDpiScale>,
    #[serde(default)]
    pub timebase: Option<CursorTelemetryTimebase>,
    #[serde(default = "default_sample_rate")]
    pub sample_rate_hz: u32,
    pub events: Vec<CursorTelemetryEvent>,
}

fn default_schema_version() -> u32 {
    CURSOR_TELEMETRY_SCHEMA_VERSION
}

fn default_button_event() -> String {
    "none".into()
}

fn default_sample_rate() -> u32 {
    60
}

impl CursorTelemetryFile {
    pub(crate) fn new(
        recording_id: String,
        source_width: u32,
        source_height: u32,
        capture_bounds: CursorCaptureBounds,
        events: Vec<CursorTelemetryEvent>,
    ) -> Self {
        Self {
            schema_version: CURSOR_TELEMETRY_SCHEMA_VERSION,
            asset_id: format!("cursor-events:{recording_id}"),
            recording_id,
            source_width,
            source_height,
            capture_bounds: Some(capture_bounds),
            dpi_scale: Some(CursorDpiScale { x: 1.0, y: 1.0 }),
            timebase: Some(CursorTelemetryTimebase {
                unit: "ms".into(),
                ticks_per_second: 1_000,
            }),
            sample_rate_hz: 60,
            events,
        }
    }

    pub fn normalize(mut self) -> Self {
        if self.schema_version == 0 {
            self.schema_version = CURSOR_TELEMETRY_SCHEMA_VERSION;
        }
        if self.asset_id.is_empty() {
            self.asset_id = format!("cursor-events:{}", self.recording_id);
        }
        if self.capture_bounds.is_none() {
            self.capture_bounds = Some(CursorCaptureBounds {
                x: 0,
                y: 0,
                width: self.source_width,
                height: self.source_height,
            });
        }
        if self.dpi_scale.is_none() {
            self.dpi_scale = Some(CursorDpiScale { x: 1.0, y: 1.0 });
        }
        if self.timebase.is_none() {
            self.timebase = Some(CursorTelemetryTimebase {
                unit: "ms".into(),
                ticks_per_second: 1_000,
            });
        }
        self.events.sort_by_key(|event| event.t_ms);
        self
    }
}

#[derive(Debug)]
pub struct CursorTracker {
    stop_signal: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl CursorTracker {
    pub fn start(
        recording_id: String,
        work_dir: PathBuf,
        offset_x: i32,
        offset_y: i32,
        width: u32,
        height: u32,
        time_offset_ms: u64,
    ) -> Self {
        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_signal_clone = stop_signal.clone();
        let existing_events = read_existing_events(&work_dir);

        let handle = thread::spawn(move || {
            let start_instant = Instant::now();
            let capture_bounds = CursorCaptureBounds {
                x: offset_x,
                y: offset_y,
                width,
                height,
            };
            let mut telemetry = existing_events
                .map(CursorTelemetryFile::normalize)
                .unwrap_or_else(|| {
                    CursorTelemetryFile::new(
                        recording_id.clone(),
                        width,
                        height,
                        capture_bounds,
                        Vec::with_capacity(3600),
                    )
                });
            let sample_interval = Duration::from_millis(16); // ~60Hz sample rate
            let mut previous_button = "none";
            let mut last_checkpoint = Instant::now();

            info!("cursor telemetry tracking started");

            while !stop_signal_clone.load(Ordering::Relaxed) {
                let elapsed_ms =
                    time_offset_ms.saturating_add(start_instant.elapsed().as_millis() as u64);
                let (raw_x, raw_y, is_button_down, button, is_visible) = capture_mouse_state();

                // Convert screen coordinates to relative capture bounds coordinates.
                let rel_x = raw_x - offset_x as f64;
                let rel_y = raw_y - offset_y as f64;
                let button_event = button_event_for_sample(previous_button, button, is_button_down);
                previous_button = if is_button_down { button } else { "none" };

                telemetry.events.push(CursorTelemetryEvent {
                    t_ms: elapsed_ms,
                    x: rel_x,
                    y: rel_y,
                    clicked: button_event == "down",
                    button: button.to_string(),
                    button_event: button_event.to_string(),
                    visible: is_visible,
                    shape_id: None,
                    shape_changed: false,
                });

                // Checkpointing makes cursor metadata recoverable even when the
                // process is terminated before the recording reaches stop().
                if last_checkpoint.elapsed() >= Duration::from_secs(1) {
                    if let Err(error) = write_telemetry(&work_dir, &telemetry) {
                        error!(error = %error, "failed to checkpoint cursor telemetry");
                    }
                    last_checkpoint = Instant::now();
                }
                thread::sleep(sample_interval);
            }

            if let Err(error) = write_telemetry(&work_dir, &telemetry) {
                error!(error = %error, "failed to publish cursor telemetry json");
            } else {
                info!("saved cursor telemetry file");
            }
        });

        Self {
            stop_signal,
            handle: Some(handle),
        }
    }

    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for CursorTracker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_existing_events(work_dir: &std::path::Path) -> Option<CursorTelemetryFile> {
    let path = work_dir.join("cursor_telemetry.json");
    let text = std::fs::read_to_string(path).ok()?;
    let telemetry: CursorTelemetryFile = serde_json::from_str(&text).ok()?;
    Some(telemetry)
}

fn write_telemetry(
    work_dir: &std::path::Path,
    telemetry: &CursorTelemetryFile,
) -> Result<(), String> {
    let out_path = work_dir.join("cursor_telemetry.json");
    let temp_path = out_path.with_extension("json.tmp");
    let json = serde_json::to_string(telemetry).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, json).map_err(|error| error.to_string())?;
    super::disk::sync_file(&temp_path).map_err(|error| error.to_string())?;
    super::disk::atomic_replace(&temp_path, &out_path).map_err(|error| error.to_string())
}

fn button_event_for_sample(previous_button: &str, _button: &str, is_down: bool) -> &'static str {
    if is_down && previous_button == "none" {
        "down"
    } else if is_down {
        "held"
    } else if previous_button != "none" {
        "up"
    } else {
        "none"
    }
}

#[cfg(target_os = "windows")]
fn capture_mouse_state() -> (f64, f64, bool, &'static str, bool) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut pt = POINT { x: 0, y: 0 };
    let pos_ok = unsafe { GetCursorPos(&mut pt) }.is_ok();
    let x = if pos_ok { pt.x as f64 } else { 0.0 };
    let y = if pos_ok { pt.y as f64 } else { 0.0 };

    let l_down = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 };
    let r_down = unsafe { (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0 };
    let m_down = unsafe { (GetAsyncKeyState(VK_MBUTTON.0 as i32) as u16 & 0x8000) != 0 };

    let clicked = l_down || r_down || m_down;
    let button = if l_down {
        "left"
    } else if r_down {
        "right"
    } else if m_down {
        "middle"
    } else {
        "none"
    };

    (x, y, clicked, button, pos_ok)
}

#[cfg(not(target_os = "windows"))]
fn capture_mouse_state() -> (f64, f64, bool, &'static str, bool) {
    (0.0, 0.0, false, "none", false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_existing_events_for_pause_resume() {
        let work_dir = tempfile::tempdir().expect("create cursor telemetry directory");
        let telemetry = CursorTelemetryFile::new(
            "recording".into(),
            1920,
            1080,
            CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            vec![CursorTelemetryEvent {
                t_ms: 250,
                x: 100.0,
                y: 200.0,
                clicked: false,
                button: "none".into(),
                button_event: "none".into(),
                visible: true,
                shape_id: None,
                shape_changed: false,
            }],
        );
        let path = work_dir.path().join("cursor_telemetry.json");
        std::fs::write(
            &path,
            serde_json::to_string(&telemetry).expect("serialize telemetry"),
        )
        .expect("write telemetry");

        let events = read_existing_events(work_dir.path()).expect("read telemetry");
        assert_eq!(events.events.len(), 1);
        assert_eq!(events.events[0].t_ms, 250);
    }

    #[test]
    fn distinguishes_button_edges_from_held_samples() {
        assert_eq!(button_event_for_sample("none", "left", true), "down");
        assert_eq!(button_event_for_sample("left", "left", true), "held");
        assert_eq!(button_event_for_sample("left", "none", false), "up");
        assert_eq!(button_event_for_sample("none", "none", false), "none");
    }

    #[test]
    fn normalizes_legacy_metadata_for_recovery() {
        let telemetry: CursorTelemetryFile = serde_json::from_value(serde_json::json!({
            "recordingId": "recording",
            "sourceWidth": 100,
            "sourceHeight": 80,
            "sampleRateHz": 60,
            "events": [],
        }))
        .expect("legacy telemetry should parse");
        let normalized = telemetry.normalize();
        assert_eq!(normalized.schema_version, CURSOR_TELEMETRY_SCHEMA_VERSION);
        assert_eq!(normalized.asset_id, "cursor-events:recording");
        assert_eq!(normalized.capture_bounds.expect("bounds").width, 100);
    }
}
