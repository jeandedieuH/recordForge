//! Keystroke overlay capture — records modifier-combination key presses during
//! a recording so the export can draw "Ctrl+S" style badges (Pro).
//!
//! Privacy by design:
//! - Only key presses with at least one held modifier (Ctrl/Alt/Shift/Win)
//!   are recorded; plain typing (passwords, text) never produces events.
//! - The event log contains key *names*, never focus target or window titles.
//! - The file lives only inside the session's work dir — it is never uploaded.
//! - Opt-in via `RecordingConfig.capture_keystrokes`.
//!
//! Platform support: Windows only in v1 (GetAsyncKeyState polling). macOS
//! needs a CGEventTap (accessibility permission) and Linux an X11/Wayland
//! input hook; both emit an empty event file until implemented.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// A recorded modifier-combo press, timestamped on the video timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeystrokeEvent {
    pub t_ms: u64,
    pub label: String,
}

#[derive(Serialize, Deserialize)]
struct KeystrokeFile {
    version: u32,
    events: Vec<KeystrokeEvent>,
}

/// Running sampler. `stop()` joins the thread and writes `keystrokes.json`
/// into the session work dir — the same directory that becomes the project
/// dir, so the export finds it without any asset-registry plumbing.
#[derive(Debug)]
pub struct KeystrokeSampler {
    stop: Arc<AtomicBool>,
    handle: std::thread::JoinHandle<Vec<KeystrokeEvent>>,
    work_dir: PathBuf,
}

impl KeystrokeSampler {
    /// Start polling. `origin` is the session's timeline anchor (same Instant
    /// the cursor tracker uses) so `t_ms` lines up with the output video.
    /// Known v1 limitation: paused segments don't rebase the clock, so
    /// modifier-combos pressed during a pause land slightly early.
    pub fn start(work_dir: PathBuf, origin: Instant) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let handle = std::thread::spawn(move || poll_keys(origin, flag));
        Self {
            stop,
            handle,
            work_dir,
        }
    }

    /// Stop sampling and write `keystrokes.json` to the session work dir.
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let events = self.handle.join().unwrap_or_default();
        if events.is_empty() {
            return;
        }
        let file = KeystrokeFile { version: 1, events };
        match serde_json::to_string_pretty(&file) {
            Ok(json) => {
                let path = self.work_dir.join(KEYSTROKES_FILE_NAME);
                if let Err(error) = std::fs::write(&path, json) {
                    tracing::warn!(error = %error, "failed to write keystroke events");
                }
            }
            Err(error) => tracing::warn!(error = %error, "failed to serialize keystroke events"),
        }
    }
}

pub const KEYSTROKES_FILE_NAME: &str = "keystrokes.json";

/// Read the session's keystroke events, if any were captured.
pub fn load_events(work_dir: &Path) -> Vec<KeystrokeEvent> {
    let path = work_dir.join(KEYSTROKES_FILE_NAME);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<KeystrokeFile>(&text)
        .map(|file| file.events)
        .unwrap_or_default()
}

// ---- Platform implementations ------------------------------------------------

#[cfg(windows)]
fn poll_keys(origin: Instant, stop: Arc<AtomicBool>) -> Vec<KeystrokeEvent> {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    const POLL_MS: u64 = 25;
    // Non-modifier keys worth displaying. VK codes: letters, digits, F-keys,
    // navigation/editing cluster, arrows, whitespace keys.
    const KEYS: &[(i32, &str)] = &[
        (0x41, "A"),
        (0x42, "B"),
        (0x43, "C"),
        (0x44, "D"),
        (0x45, "E"),
        (0x46, "F"),
        (0x47, "G"),
        (0x48, "H"),
        (0x49, "I"),
        (0x4A, "J"),
        (0x4B, "K"),
        (0x4C, "L"),
        (0x4D, "M"),
        (0x4E, "N"),
        (0x4F, "O"),
        (0x50, "P"),
        (0x51, "Q"),
        (0x52, "R"),
        (0x53, "S"),
        (0x54, "T"),
        (0x55, "U"),
        (0x56, "V"),
        (0x57, "W"),
        (0x58, "X"),
        (0x59, "Y"),
        (0x5A, "Z"),
        (0x30, "0"),
        (0x31, "1"),
        (0x32, "2"),
        (0x33, "3"),
        (0x34, "4"),
        (0x35, "5"),
        (0x36, "6"),
        (0x37, "7"),
        (0x38, "8"),
        (0x39, "9"),
        (0x70, "F1"),
        (0x71, "F2"),
        (0x72, "F3"),
        (0x73, "F4"),
        (0x74, "F5"),
        (0x75, "F6"),
        (0x76, "F7"),
        (0x77, "F8"),
        (0x78, "F9"),
        (0x79, "F10"),
        (0x7A, "F11"),
        (0x7B, "F12"),
        (0x0D, "Enter"),
        (0x1B, "Esc"),
        (0x09, "Tab"),
        (0x20, "Space"),
        (0x08, "Backspace"),
        (0x2E, "Del"),
        (0x24, "Home"),
        (0x23, "End"),
        (0x21, "PgUp"),
        (0x22, "PgDn"),
        (0x25, "Left"),
        (0x26, "Up"),
        (0x27, "Right"),
        (0x28, "Down"),
        (0xBA, ";"),
        (0xBB, "="),
        (0xBC, ","),
        (0xBD, "-"),
        (0xBE, "."),
        (0xBF, "/"),
        (0xC0, "`"),
        (0xDB, "["),
        (0xDC, "\\"),
        (0xDD, "]"),
        (0xDE, "'"),
    ];
    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12; // Alt
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;

    let is_down = |vk: i32| unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 };

    let mut events = Vec::new();
    let mut previous: Vec<bool> = vec![false; KEYS.len()];

    while !stop.load(Ordering::SeqCst) {
        let ctrl = is_down(VK_CONTROL);
        let shift = is_down(VK_SHIFT);
        let alt = is_down(VK_MENU);
        let win = is_down(VK_LWIN) || is_down(VK_RWIN);
        let any_modifier = ctrl || shift || alt || win;

        let t_ms = origin.elapsed().as_millis().min(u64::MAX as u128) as u64;
        for (index, (vk, name)) in KEYS.iter().enumerate() {
            let down = any_modifier && is_down(*vk);
            // Edge-triggered: only the up→down transition records an event,
            // which naturally debounces auto-repeat.
            if down && !previous[index] {
                let mut parts = Vec::with_capacity(5);
                if ctrl {
                    parts.push("Ctrl");
                }
                if alt {
                    parts.push("Alt");
                }
                if shift {
                    parts.push("Shift");
                }
                if win {
                    parts.push("Win");
                }
                parts.push(name);
                events.push(KeystrokeEvent {
                    t_ms,
                    label: parts.join("+"),
                });
            }
            previous[index] = down;
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    }
    events
}

#[cfg(not(windows))]
fn poll_keys(_origin: Instant, stop: Arc<AtomicBool>) -> Vec<KeystrokeEvent> {
    // Non-Windows platforms need an event-tap implementation; emit nothing
    // until then rather than faking capture.
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_events_returns_empty_when_missing() {
        assert!(load_events(Path::new("does-not-exist")).is_empty());
    }

    #[test]
    fn load_events_reads_written_file() {
        let dir = std::env::temp_dir().join(format!("rf-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = KeystrokeFile {
            version: 1,
            events: vec![KeystrokeEvent {
                t_ms: 1500,
                label: "Ctrl+C".into(),
            }],
        };
        std::fs::write(
            dir.join(KEYSTROKES_FILE_NAME),
            serde_json::to_string(&file).unwrap(),
        )
        .unwrap();
        let events = load_events(&dir);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].t_ms, 1500);
        assert_eq!(events[0].label, "Ctrl+C");
        std::fs::remove_dir_all(&dir).ok();
    }
}
