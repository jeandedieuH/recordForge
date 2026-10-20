//! Keystroke overlay capture — records modifier-combination key presses during
//! a recording so the editor preview and export can draw "Ctrl+S" style keycap
//! badges (Pro).
//!
//! Privacy by design:
//! - Only key presses with at least one held modifier (Ctrl/Alt/Shift/Win/Cmd)
//!   are recorded; plain typing (passwords, text) never produces events.
//! - The event log contains key *names* and modifier flags, never focus
//!   targets or window titles.
//! - The file lives only inside the session's work dir — it is never uploaded.
//! - Opt-in via `RecordingConfig.capture_keystrokes`.
//!
//! Event format v2: `{tMs, key, modifiers[], platform}` — structured enough
//! for the shared display model to render platform-aware keycap glyphs.
//! Version 1 files (`{tMs, label}`) still load via the fallback parser.
//!
//! Platform support: Windows (GetAsyncKeyState polling) and macOS
//! (CGEventTap on a dedicated run loop — needs Accessibility trust, else the
//! tap silently fails to create and the event file stays empty). Linux still
//! needs an X11/Wayland input hook and emits an empty event file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// Normalized modifier identity — `Meta` is Cmd on macOS, Win on Windows,
/// Super on Linux. The display layer picks the platform-appropriate glyph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeystrokeModifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

/// A recorded modifier-combo press, timestamped on the video timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeystrokeEvent {
    pub t_ms: u64,
    pub key: String,
    pub modifiers: Vec<KeystrokeModifier>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeystrokeFile {
    pub version: u32,
    pub platform: String,
    pub events: Vec<KeystrokeEvent>,
}

/// V1 event shape (`{tMs, label: "Ctrl+Shift+S"}`) accepted on load.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawKeystrokeEvent {
    V2 {
        #[serde(rename = "tMs")]
        t_ms: u64,
        key: String,
        modifiers: Vec<KeystrokeModifier>,
    },
    V1 {
        #[serde(rename = "tMs")]
        t_ms: u64,
        label: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawKeystrokeFile {
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    events: Vec<RawKeystrokeEvent>,
}

pub fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// Normalize a v1 `label` ("Ctrl+Shift+S") into the structured shape — the
/// last `+`-separated token is the key, the rest are modifiers.
fn normalize_v1_label(t_ms: u64, label: &str) -> Option<KeystrokeEvent> {
    let tokens: Vec<&str> = label.split('+').filter(|token| !token.is_empty()).collect();
    if tokens.len() < 2 {
        return None;
    }
    let mut modifiers = Vec::with_capacity(4);
    for token in &tokens[..tokens.len() - 1] {
        let modifier = match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => KeystrokeModifier::Ctrl,
            "alt" | "option" => KeystrokeModifier::Alt,
            "shift" => KeystrokeModifier::Shift,
            "win" | "cmd" | "command" | "meta" | "super" => KeystrokeModifier::Meta,
            _ => continue,
        };
        if !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }
    if modifiers.is_empty() {
        return None;
    }
    Some(KeystrokeEvent {
        t_ms,
        key: tokens[tokens.len() - 1].to_string(),
        modifiers,
    })
}

/// Canonical modifier ordering for display/serialization (Ctrl, Alt, Shift,
/// Meta — matches the shared display model in `packages/editor-core`).
pub(crate) fn ordered_modifiers(mut modifiers: Vec<KeystrokeModifier>) -> Vec<KeystrokeModifier> {
    const ORDER: [KeystrokeModifier; 4] = [
        KeystrokeModifier::Ctrl,
        KeystrokeModifier::Alt,
        KeystrokeModifier::Shift,
        KeystrokeModifier::Meta,
    ];
    modifiers.sort_by_key(|m| ORDER.iter().position(|o| o == m).unwrap_or(ORDER.len()));
    modifiers.dedup();
    modifiers
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
        let file = KeystrokeFile {
            version: 2,
            platform: platform_name().to_string(),
            events,
        };
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

/// Read the session's keystroke event file (v1 or v2), normalized into v2
/// events. Missing/unparseable files return `None` — absence is normal when
/// capture was disabled.
pub fn load_events(work_dir: &Path) -> Option<KeystrokeFile> {
    let path = work_dir.join(KEYSTROKES_FILE_NAME);
    let text = std::fs::read_to_string(&path).ok()?;
    let raw = serde_json::from_str::<RawKeystrokeFile>(&text).ok()?;
    let events = raw
        .events
        .into_iter()
        .filter_map(|event| match event {
            RawKeystrokeEvent::V2 {
                t_ms,
                key,
                modifiers,
            } => Some(KeystrokeEvent {
                t_ms,
                key,
                modifiers: ordered_modifiers(modifiers),
            }),
            RawKeystrokeEvent::V1 { t_ms, label } => normalize_v1_label(t_ms, &label),
        })
        .collect();
    Some(KeystrokeFile {
        version: 2,
        platform: raw.platform.unwrap_or_else(|| "unknown".to_string()),
        events,
    })
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

    // High bit = currently held; low bit = pressed since the previous call —
    // the low bit catches taps shorter than the 25 ms poll interval.
    let key_state = |vk: i32| unsafe { GetAsyncKeyState(vk) as u16 };
    let is_down = |vk: i32| (key_state(vk) & 0x8000) != 0;

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
            let state = key_state(*vk);
            let down_now = any_modifier && (state & 0x8001) != 0;
            // Edge-triggered: only the up→down transition records an event,
            // which naturally debounces auto-repeat.
            if down_now && !previous[index] {
                let mut modifiers = Vec::with_capacity(4);
                if ctrl {
                    modifiers.push(KeystrokeModifier::Ctrl);
                }
                if alt {
                    modifiers.push(KeystrokeModifier::Alt);
                }
                if shift {
                    modifiers.push(KeystrokeModifier::Shift);
                }
                if win {
                    modifiers.push(KeystrokeModifier::Meta);
                }
                events.push(KeystrokeEvent {
                    t_ms,
                    key: (*name).to_string(),
                    modifiers,
                });
            }
            previous[index] = down_now;
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    }
    events
}

#[cfg(target_os = "macos")]
fn poll_keys(origin: Instant, stop: Arc<AtomicBool>) -> Vec<KeystrokeEvent> {
    // The tap runs until `stop` flips; without Accessibility trust it returns
    // immediately with no events (logged inside `run_key_tap`).
    super::macos_native::run_key_tap(origin, stop)
        .into_iter()
        .map(|press| KeystrokeEvent {
            t_ms: press.t_ms,
            key: press.key.to_string(),
            modifiers: press.modifiers,
        })
        .collect()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn poll_keys(_origin: Instant, stop: Arc<AtomicBool>) -> Vec<KeystrokeEvent> {
    // Linux needs an X11/Wayland input hook; emit nothing until implemented
    // rather than faking capture.
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_events_returns_none_when_missing() {
        assert!(load_events(Path::new("does-not-exist")).is_none());
    }

    #[test]
    fn load_events_reads_v2_file() {
        let dir = std::env::temp_dir().join(format!("rf-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = KeystrokeFile {
            version: 2,
            platform: "windows".into(),
            events: vec![KeystrokeEvent {
                t_ms: 1500,
                key: "C".into(),
                modifiers: vec![KeystrokeModifier::Ctrl],
            }],
        };
        std::fs::write(
            dir.join(KEYSTROKES_FILE_NAME),
            serde_json::to_string(&file).unwrap(),
        )
        .unwrap();
        let loaded = load_events(&dir).unwrap();
        assert_eq!(loaded.version, 2);
        assert_eq!(loaded.platform, "windows");
        assert_eq!(loaded.events.len(), 1);
        assert_eq!(loaded.events[0].key, "C");
        assert_eq!(loaded.events[0].modifiers, vec![KeystrokeModifier::Ctrl]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_events_normalizes_v1_labels() {
        let dir = std::env::temp_dir().join(format!("rf-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(KEYSTROKES_FILE_NAME),
            r#"{"version":1,"events":[{"tMs":1500,"label":"Ctrl+Shift+S"},{"tMs":2000,"label":"Cmd+Q"},{"tMs":3000,"label":"S"}]}"#,
        )
        .unwrap();
        let loaded = load_events(&dir).unwrap();
        assert_eq!(loaded.events.len(), 2);
        assert_eq!(loaded.events[0].key, "S");
        assert_eq!(
            loaded.events[0].modifiers,
            vec![KeystrokeModifier::Ctrl, KeystrokeModifier::Shift]
        );
        assert_eq!(loaded.events[1].key, "Q");
        assert_eq!(loaded.events[1].modifiers, vec![KeystrokeModifier::Meta]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ordered_modifiers_canonicalizes() {
        assert_eq!(
            ordered_modifiers(vec![
                KeystrokeModifier::Meta,
                KeystrokeModifier::Shift,
                KeystrokeModifier::Ctrl,
            ]),
            vec![
                KeystrokeModifier::Ctrl,
                KeystrokeModifier::Shift,
                KeystrokeModifier::Meta
            ]
        );
    }
}
