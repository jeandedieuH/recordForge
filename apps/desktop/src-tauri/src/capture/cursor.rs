use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tracing::{error, info};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryEvent {
    pub t_ms: u64,
    pub x: f64,
    pub y: f64,
    pub clicked: bool,
    pub button: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryFile {
    pub recording_id: String,
    pub source_width: u32,
    pub source_height: u32,
    pub sample_rate_hz: u32,
    pub events: Vec<CursorTelemetryEvent>,
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
            let mut events = existing_events.unwrap_or_else(|| Vec::with_capacity(3600));
            let sample_interval = Duration::from_millis(16); // ~60Hz sample rate

            info!("cursor telemetry tracking started");

            while !stop_signal_clone.load(Ordering::Relaxed) {
                let elapsed_ms =
                    time_offset_ms.saturating_add(start_instant.elapsed().as_millis() as u64);
                let (raw_x, raw_y, is_clicked, button, is_visible) = capture_mouse_state();

                // Convert screen coordinates to relative capture bounds coordinates.
                let rel_x = raw_x - offset_x as f64;
                let rel_y = raw_y - offset_y as f64;

                events.push(CursorTelemetryEvent {
                    t_ms: elapsed_ms,
                    x: rel_x,
                    y: rel_y,
                    clicked: is_clicked,
                    button: button.to_string(),
                    visible: is_visible,
                });

                thread::sleep(sample_interval);
            }

            let file_data = CursorTelemetryFile {
                recording_id,
                source_width: width,
                source_height: height,
                sample_rate_hz: 60,
                events,
            };

            let out_path = work_dir.join("cursor_telemetry.json");
            let temp_path = out_path.with_extension("json.tmp");
            match serde_json::to_string(&file_data) {
                Ok(json_str) => {
                    let result = std::fs::write(&temp_path, json_str)
                        .map_err(|error| error.to_string())
                        .and_then(|_| {
                            super::disk::sync_file(&temp_path).map_err(|error| error.to_string())
                        })
                        .and_then(|_| {
                            super::disk::atomic_replace(&temp_path, &out_path)
                                .map_err(|error| error.to_string())
                        });
                    if let Err(error) = result {
                        error!(error = %error, "failed to publish cursor telemetry json");
                    } else {
                        info!("saved cursor telemetry file");
                    }
                }
                Err(error) => {
                    error!(error = %error, "failed to serialize cursor telemetry file");
                }
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

fn read_existing_events(work_dir: &std::path::Path) -> Option<Vec<CursorTelemetryEvent>> {
    let path = work_dir.join("cursor_telemetry.json");
    let text = std::fs::read_to_string(path).ok()?;
    let telemetry: CursorTelemetryFile = serde_json::from_str(&text).ok()?;
    Some(telemetry.events)
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
        let telemetry = CursorTelemetryFile {
            recording_id: "recording".into(),
            source_width: 1920,
            source_height: 1080,
            sample_rate_hz: 60,
            events: vec![CursorTelemetryEvent {
                t_ms: 250,
                x: 100.0,
                y: 200.0,
                clicked: false,
                button: "none".into(),
                visible: true,
            }],
        };
        let path = work_dir.path().join("cursor_telemetry.json");
        std::fs::write(
            &path,
            serde_json::to_string(&telemetry).expect("serialize telemetry"),
        )
        .expect("write telemetry");

        let events = read_existing_events(work_dir.path()).expect("read telemetry");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].t_ms, 250);
    }
}
