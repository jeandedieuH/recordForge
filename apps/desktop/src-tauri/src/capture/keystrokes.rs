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
//! Platform support: Windows (GetAsyncKeyState polling) and macOS
//! (CGEventTap on a dedicated run loop — needs Accessibility trust, else the
//! tap silently fails to create and the event file stays empty). Linux still
//! needs an X11/Wayland input hook and emits an empty event file.

use std::path::Path;
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

/// Labels are built from a fixed token table at capture; anything carrying
/// other bytes (hand-edited file, hostile fixture, legacy punctuation
/// labels) is dropped rather than escaped into a drawtext/export context.
pub fn label_is_safe(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 64
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == ' ')
}

/// Held modifiers at a physical key edge. `alt_gr` is the Windows-specific
/// right-Alt+Ctrl synthesis — real left-Ctrl+left-Alt shortcuts still pass.
/// Only the Windows and macOS samplers construct this; the Linux stub emits
/// no events, so gate it (and `combo_is_allowed`) to keep the Linux build
/// dead-code-clean while tests still exercise the policy.
#[cfg(any(windows, target_os = "macos", test))]
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ModifierState {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Windows key on Windows, Cmd on macOS — the "action" modifier.
    pub win: bool,
    /// Physical AltGr (right Alt + Ctrl). False on macOS/Linux.
    pub alt_gr: bool,
}

/// The privacy allowlist: a combo is captured only when it is plausibly a
/// shortcut, not typing.
///
/// - Shift-only (or Shift+Alt) on a *printable* key is shifted typing —
///   letters, digits, accented characters, and passwords typed with Caps
///   off/on. Never captured.
/// - Alt/Option-only on a printable key is alternate-glyph typing (e.g.
///   Option+E on macOS). Never captured.
/// - Physical AltGr on a printable key is AltGr typing. Never captured —
///   but a real left-Ctrl+left-Alt combo on a printable key IS a shortcut.
/// - Ctrl/Command/Win combos are real shortcuts; Alt or Shift with
///   non-printable keys (navigation, function keys, Enter/Esc/Tab) are
///   shortcuts too (Alt+Tab, Shift+Tab, Ctrl+Alt+Del).
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn combo_is_allowed(mods: ModifierState, key_is_printable: bool) -> bool {
    if !(mods.ctrl || mods.alt || mods.shift || mods.win) {
        return false;
    }
    if key_is_printable {
        if mods.alt_gr {
            return false;
        }
        if !mods.ctrl && !mods.win {
            // Shift-only, Alt-only, or Shift+Alt typing.
            return false;
        }
    }
    true
}

// ---- Canonical label parsing --------------------------------------------------

/// Printable keys produce characters: letters, digits, symbol-name tokens,
/// and Space (Shift+Space is still typing).
fn key_is_printable_token(key: &str) -> Option<bool> {
    if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() {
        return Some(true);
    }
    match key {
        "Space" | "Semicolon" | "Equal" | "Comma" | "Minus" | "Period" | "Slash" | "Backquote"
        | "LeftBracket" | "Backslash" | "RightBracket" | "Quote" => Some(true),
        "Enter" | "Esc" | "Tab" | "Backspace" | "Del" | "Home" | "End" | "PgUp" | "PgDn"
        | "Left" | "Up" | "Right" | "Down" => Some(false),
        _ => {
            // F1..F12.
            let digits = key.strip_prefix('F')?;
            match digits.parse::<u32>() {
                Ok(n) if (1..=12).contains(&n) => Some(false),
                _ => None,
            }
        }
    }
}

/// A parsed canonical combo: unique known modifiers + exactly one known
/// key. Only the flags the privacy policy reads are kept.
#[derive(Debug, Clone, Copy)]
struct ParsedCombo {
    ctrl: bool,
    alt: bool,
    win: bool,
    cmd: bool,
    printable: bool,
}

/// Strict canonical parser — the mirror of the TS badge mapper's concept:
/// known modifier tokens, one known key token, no duplicates, no arbitrary
/// labels. Returns None for anything else ("Hello", "Ctrl+Ctrl+A", "Ctrl+;").
fn parse_combo_label(label: &str) -> Option<ParsedCombo> {
    if !label_is_safe(label) {
        return None;
    }
    let parts: Vec<&str> = label.split('+').collect();
    if parts.len() < 2 || parts.len() > 6 {
        return None;
    }
    let printable = key_is_printable_token(parts[parts.len() - 1])?;
    let (mut ctrl, mut alt, mut shift, mut win, mut cmd) = (false, false, false, false, false);
    for token in &parts[..parts.len() - 1] {
        match *token {
            "Ctrl" if !ctrl => ctrl = true,
            "Alt" if !alt => alt = true,
            "Shift" if !shift => shift = true,
            "Win" if !win => win = true,
            "Cmd" if !cmd => cmd = true,
            _ => return None,
        }
    }
    Some(ParsedCombo {
        ctrl,
        alt,
        win,
        cmd,
        printable,
    })
}

/// Privacy check for a LOADED label — the same policy as live capture, with
/// one conservative addition: version-1 files can't tell a real Ctrl+Alt
/// printable shortcut from AltGr typing, so those combos are always dropped.
fn combo_label_is_privacy_safe(combo: &ParsedCombo, file_version: u32) -> bool {
    if !combo.printable {
        // Any modifier + non-printable key (Alt+Tab, Shift+F10, Ctrl+Alt+Del).
        return true;
    }
    if !(combo.ctrl || combo.win || combo.cmd) {
        // Shift/Option-only printable labels are typing — never a capture
        // at ANY file version.
        return false;
    }
    if file_version == 1 && combo.ctrl && combo.alt {
        // AltGr provenance is unknowable in v1 — drop conservatively.
        return false;
    }
    true
}

/// Drop unsafe/legacy/privacy-unsafe labels from events read back off disk —
/// the file can be hand-edited or predate the canonical token table.
pub(crate) fn sanitize_events(
    events: Vec<KeystrokeEvent>,
    file_version: u32,
) -> Vec<KeystrokeEvent> {
    events
        .into_iter()
        .filter(|event| {
            parse_combo_label(&event.label)
                .map(|combo| combo_label_is_privacy_safe(&combo, file_version))
                .unwrap_or(false)
        })
        .collect()
}

/// Rebase one captured segment's events onto the session timeline: drop the
/// startup head trim, keep only presses inside the rendered segment window,
/// and shift survivors by the total recorded duration before this segment —
/// the same alignment the cursor telemetry path applies.
pub(crate) fn rebase_segment_events(
    events: Vec<KeystrokeEvent>,
    segment_start_ms: u64,
    head_trim_ms: u64,
    duration_ms: u64,
) -> Vec<KeystrokeEvent> {
    let mut rebased: Vec<KeystrokeEvent> = events
        .into_iter()
        .filter_map(|event| {
            let local = event.t_ms.checked_sub(head_trim_ms)?;
            (local < duration_ms).then(|| KeystrokeEvent {
                t_ms: segment_start_ms.saturating_add(local),
                label: event.label,
            })
        })
        .collect();
    rebased.sort_by_key(|event| event.t_ms);
    rebased.dedup_by(|a, b| a.t_ms == b.t_ms && a.label == b.label);
    rebased
}

/// Append a finished segment's rebased events to `keystrokes.json`, keeping
/// the file sorted by timestamp across segments. Writes are version 2 and
/// atomic (temp file + rename); an existing corrupt file is preserved as
/// `keystrokes.corrupt.json` rather than overwritten with a partial file.
pub(crate) fn append_events(work_dir: &Path, events: Vec<KeystrokeEvent>) {
    if events.is_empty() {
        return;
    }
    let path = work_dir.join(KEYSTROKES_FILE_NAME);
    let mut all = match read_key_file(&path) {
        KeyFileState::Missing => Vec::new(),
        KeyFileState::Valid(file) => sanitize_events(file.events, file.version),
        KeyFileState::Corrupt => {
            // Never quarantine unknown bytes ourselves: renaming the file to
            // a FIXED backup name would overwrite an older preserved backup
            // (or a user file that happens to share the name). The corrupt
            // original and any existing `keystrokes.corrupt.json` stay
            // byte-for-byte untouched; `load_events` already surfaces the
            // corruption to the user.
            tracing::warn!("corrupt keystrokes file left untouched; append skipped");
            return;
        }
    };
    all.extend(events);
    all.sort_by_key(|event| event.t_ms);
    let file = KeystrokeFile {
        version: 2,
        events: all,
    };
    let Ok(json) = serde_json::to_string_pretty(&file) else {
        tracing::warn!("failed to serialize keystroke events");
        return;
    };
    let tmp = work_dir.join(KEYSTROKES_TMP_FILE_NAME);
    if let Err(error) = std::fs::write(&tmp, json) {
        tracing::warn!(error = %error, "failed to write keystroke events");
        return;
    }
    // Same-directory rename = atomic publish on every supported platform.
    if let Err(error) = std::fs::rename(&tmp, &path) {
        tracing::warn!(error = %error, "failed to publish keystroke events");
        let _ = std::fs::remove_file(&tmp);
    }
}

#[derive(Serialize, Deserialize)]
struct KeystrokeFile {
    version: u32,
    events: Vec<KeystrokeEvent>,
}

/// Three-way read: missing is a valid empty file, a recognized v1/v2 shape is
/// usable, and anything else (bad JSON, unknown version, unreadable) is
/// corrupt — never silently treated as "zero shortcuts captured".
enum KeyFileState {
    Missing,
    Valid(KeystrokeFile),
    Corrupt,
}

fn read_key_file(path: &Path) -> KeyFileState {
    match std::fs::read_to_string(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => KeyFileState::Missing,
        Err(_) => KeyFileState::Corrupt,
        Ok(text) => match serde_json::from_str::<KeystrokeFile>(&text) {
            Ok(file) if file.version == 1 || file.version == 2 => KeyFileState::Valid(file),
            _ => KeyFileState::Corrupt,
        },
    }
}

/// Running sampler for ONE capture segment. `stop()` joins the thread and
/// hands the caller the raw segment-time events — the session rebases them
/// onto the session timeline (head-trim + segment offset) and appends them
/// to `keystrokes.json`, mirroring cursor-telemetry alignment.
#[derive(Debug)]
pub struct KeystrokeSampler {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<Vec<KeystrokeEvent>>>,
}

impl KeystrokeSampler {
    /// Start polling. `origin` is the segment's timeline anchor (same
    /// Instant the cursor tracker uses) so `t_ms` is segment-local.
    pub fn start(origin: Instant) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let handle = std::thread::spawn(move || poll_keys(origin, flag));
        Self {
            stop,
            handle: Some(handle),
        }
    }

    /// Stop sampling and return this segment's raw events.
    pub fn stop(mut self) -> Vec<KeystrokeEvent> {
        self.stop.store(true, Ordering::SeqCst);
        self.handle
            .take()
            .map(|handle| handle.join().unwrap_or_default())
            .unwrap_or_default()
    }
}

impl Drop for KeystrokeSampler {
    /// A dropped sampler must not keep polling after the session is gone —
    /// e.g. a segment error path that returns before finalize.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub const KEYSTROKES_FILE_NAME: &str = "keystrokes.json";
const KEYSTROKES_TMP_FILE_NAME: &str = "keystrokes.json.tmp";
/// Name the app's older quarantine flow and user backups may share — the
/// append path never writes it, but tests verify it stays untouched.
#[cfg(test)]
const KEYSTROKES_CORRUPT_FILE_NAME: &str = "keystrokes.corrupt.json";

/// Read the session's keystroke events, if any were captured. Loaded labels
/// are re-parsed against the strict canonical table AND the privacy policy —
/// the file may be hand-edited or predate AltGr detection. A missing file is
/// a valid empty result; a malformed or unreadable one is an actionable
/// error, not a silent "zero shortcuts captured".
pub fn load_events(work_dir: &Path) -> crate::errors::Result<Vec<KeystrokeEvent>> {
    match read_key_file(&work_dir.join(KEYSTROKES_FILE_NAME)) {
        KeyFileState::Missing => Ok(Vec::new()),
        KeyFileState::Valid(file) => Ok(sanitize_events(file.events, file.version)),
        // Generic message on purpose: no file contents, labels, or paths.
        KeyFileState::Corrupt => Err(crate::errors::InternalError::Media(
            "captured shortcut data could not be read — it may have been modified outside RecordForge"
                .into(),
        )
        .into()),
    }
}

// ---- Platform implementations ------------------------------------------------

#[cfg(windows)]
fn poll_keys(origin: Instant, stop: Arc<AtomicBool>) -> Vec<KeystrokeEvent> {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    const POLL_MS: u64 = 25;
    // Non-modifier keys worth displaying, keyed `(vk, name, printable)`.
    // Names are canonical tokens (LeftBracket, Comma, …) so labels stay in
    // the [A-Za-z0-9+ ] safe set. `printable` drives the typing-vs-shortcut
    // allowlist: letters/digits/punctuation produce characters while
    // navigation, editing, function, and named whitespace keys do not.
    const KEYS: &[(i32, &str, bool)] = &[
        (0x41, "A", true),
        (0x42, "B", true),
        (0x43, "C", true),
        (0x44, "D", true),
        (0x45, "E", true),
        (0x46, "F", true),
        (0x47, "G", true),
        (0x48, "H", true),
        (0x49, "I", true),
        (0x4A, "J", true),
        (0x4B, "K", true),
        (0x4C, "L", true),
        (0x4D, "M", true),
        (0x4E, "N", true),
        (0x4F, "O", true),
        (0x50, "P", true),
        (0x51, "Q", true),
        (0x52, "R", true),
        (0x53, "S", true),
        (0x54, "T", true),
        (0x55, "U", true),
        (0x56, "V", true),
        (0x57, "W", true),
        (0x58, "X", true),
        (0x59, "Y", true),
        (0x5A, "Z", true),
        (0x30, "0", true),
        (0x31, "1", true),
        (0x32, "2", true),
        (0x33, "3", true),
        (0x34, "4", true),
        (0x35, "5", true),
        (0x36, "6", true),
        (0x37, "7", true),
        (0x38, "8", true),
        (0x39, "9", true),
        (0x70, "F1", false),
        (0x71, "F2", false),
        (0x72, "F3", false),
        (0x73, "F4", false),
        (0x74, "F5", false),
        (0x75, "F6", false),
        (0x76, "F7", false),
        (0x77, "F8", false),
        (0x78, "F9", false),
        (0x79, "F10", false),
        (0x7A, "F11", false),
        (0x7B, "F12", false),
        (0x0D, "Enter", false),
        (0x1B, "Esc", false),
        (0x09, "Tab", false),
        // Space produces a character — Shift+Space is typing, not a shortcut.
        (0x20, "Space", true),
        (0x08, "Backspace", false),
        (0x2E, "Del", false),
        (0x24, "Home", false),
        (0x23, "End", false),
        (0x21, "PgUp", false),
        (0x22, "PgDn", false),
        (0x25, "Left", false),
        (0x26, "Up", false),
        (0x27, "Right", false),
        (0x28, "Down", false),
        (0xBA, "Semicolon", true),
        (0xBB, "Equal", true),
        (0xBC, "Comma", true),
        (0xBD, "Minus", true),
        (0xBE, "Period", true),
        (0xBF, "Slash", true),
        (0xC0, "Backquote", true),
        (0xDB, "LeftBracket", true),
        (0xDC, "Backslash", true),
        (0xDD, "RightBracket", true),
        (0xDE, "Quote", true),
    ];
    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12; // Alt
    const VK_RMENU: i32 = 0xA5; // right Alt = AltGr on many layouts
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
        // AltGr is PHYSICAL right-Alt + Ctrl — distinguishable from a real
        // left-Ctrl+left-Alt shortcut, which must keep working.
        let mods = ModifierState {
            ctrl,
            alt,
            shift,
            win,
            alt_gr: is_down(VK_RMENU) && ctrl,
        };

        let t_ms = origin.elapsed().as_millis().min(u64::MAX as u128) as u64;
        for (index, (vk, name, printable)) in KEYS.iter().enumerate() {
            // Edge detection runs on the raw physical key state — toggling a
            // modifier while a key is held must not fabricate a new keydown.
            let phys = is_down(*vk);
            let edge = phys && !previous[index];
            previous[index] = phys;
            if edge && combo_is_allowed(mods, *printable) {
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
        .map(|(t_ms, label)| KeystrokeEvent { t_ms, label })
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

    fn mods(ctrl: bool, alt: bool, shift: bool, win: bool, alt_gr: bool) -> ModifierState {
        ModifierState {
            ctrl,
            alt,
            shift,
            win,
            alt_gr,
        }
    }

    #[test]
    fn load_events_returns_empty_when_missing() {
        assert!(load_events(Path::new("does-not-exist"))
            .expect("missing file is valid")
            .is_empty());
    }

    #[test]
    fn load_events_reads_written_file() {
        let dir = std::env::temp_dir().join(format!("rf-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = KeystrokeFile {
            version: 2,
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
        let events = load_events(&dir).expect("readable file");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].t_ms, 1500);
        assert_eq!(events[0].label, "Ctrl+C");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_events_errors_on_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("rf-keys-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(KEYSTROKES_FILE_NAME), "{not json").unwrap();
        assert!(load_events(&dir).is_err());
        // An unrecognized version is also corrupt, not "empty".
        std::fs::write(
            dir.join(KEYSTROKES_FILE_NAME),
            r#"{"version":9,"events":[]}"#,
        )
        .unwrap();
        assert!(load_events(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_preserves_corrupt_file_and_existing_backup() {
        let dir = std::env::temp_dir().join(format!("rf-keys-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(KEYSTROKES_FILE_NAME);
        let backup = dir.join(KEYSTROKES_CORRUPT_FILE_NAME);
        std::fs::write(&path, "hand-edited garbage").unwrap();
        std::fs::write(&backup, "earlier preserved bytes").unwrap();
        append_events(
            &dir,
            vec![KeystrokeEvent {
                t_ms: 1,
                label: "Ctrl+C".into(),
            }],
        );
        // Both files survive byte-for-byte — no quarantine rename, no
        // partial overwrite; the append is skipped entirely.
        assert_eq!(std::fs::read(&path).unwrap(), b"hand-edited garbage");
        assert_eq!(std::fs::read(&backup).unwrap(), b"earlier preserved bytes");
        assert!(load_events(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn allowlist_rejects_typing_and_accepts_shortcuts() {
        // Shifted/alt typing on printable keys must never be captured —
        // this is what made shifted text and passwords leak before.
        assert!(!combo_is_allowed(
            mods(false, false, true, false, false),
            true
        )); // Shift+A
        assert!(!combo_is_allowed(
            mods(false, true, false, false, false),
            true
        )); // Option/Alt+E
        assert!(!combo_is_allowed(
            mods(true, true, false, false, true),
            true
        )); // AltGr+Q
        assert!(!combo_is_allowed(
            mods(false, true, true, false, false),
            true
        )); // Shift+Alt+1
        assert!(!combo_is_allowed(
            mods(false, false, false, false, false),
            true
        )); // plain A
            // Real shortcuts.
        assert!(combo_is_allowed(
            mods(true, false, false, false, false),
            true
        )); // Ctrl+C
        assert!(combo_is_allowed(
            mods(false, false, false, true, false),
            true
        )); // Win+E
        assert!(combo_is_allowed(
            mods(true, false, true, false, false),
            true
        )); // Ctrl+Shift+S
        assert!(combo_is_allowed(
            mods(false, true, false, false, false),
            false
        )); // Alt+Tab
        assert!(combo_is_allowed(
            mods(false, false, true, false, false),
            false
        )); // Shift+Tab
        assert!(combo_is_allowed(
            mods(true, true, false, false, false),
            false
        )); // Ctrl+Alt+Del
            // Left-Ctrl+left-Alt on a printable key is a REAL shortcut — only
            // physical AltGr (right Alt + Ctrl) makes the same bits typing.
        assert!(combo_is_allowed(
            mods(true, true, false, false, false),
            true
        ));
        assert!(!combo_is_allowed(
            mods(true, true, false, false, true),
            true
        ));
    }

    #[test]
    fn canonical_parser_accepts_only_well_formed_shortcuts() {
        assert!(parse_combo_label("Ctrl+C").is_some());
        assert!(parse_combo_label("Ctrl+Alt+Shift+F5").is_some());
        assert!(parse_combo_label("Shift+Space").is_some()); // parses, rejected by privacy rule below
        assert!(parse_combo_label("Hello").is_none()); // arbitrary word
        assert!(parse_combo_label("Ctrl+Ctrl+A").is_none()); // duplicate modifier
        assert!(parse_combo_label("Ctrl+;").is_none()); // non-canonical key
        assert!(parse_combo_label("C").is_none()); // no modifier
        assert!(parse_combo_label("Ctrl+").is_none()); // empty key
        assert!(parse_combo_label("Password123").is_none());
    }

    #[test]
    fn loaded_labels_follow_privacy_policy_per_version() {
        let event = |label: &str| KeystrokeEvent {
            t_ms: 1,
            label: label.into(),
        };
        // Shift/Option-only printable labels are typing at EVERY version.
        for version in [1, 2] {
            assert!(sanitize_events(vec![event("Shift+A")], version).is_empty());
            assert!(sanitize_events(vec![event("Alt+E")], version).is_empty());
            assert!(sanitize_events(vec![event("Shift+Space")], version).is_empty());
            assert!(sanitize_events(vec![event("Shift+Tab")], version).len() == 1);
            assert!(sanitize_events(vec![event("Ctrl+Space")], version).len() == 1);
        }
        // v1 Ctrl+Alt+printable is dropped — AltGr provenance unknowable.
        assert!(sanitize_events(vec![event("Ctrl+Alt+Q")], 1).is_empty());
        // v2 files were written after physical AltGr detection, so a stored
        // Ctrl+Alt+printable label is a real left-modifier shortcut.
        assert_eq!(sanitize_events(vec![event("Ctrl+Alt+Q")], 2).len(), 1);
        assert_eq!(sanitize_events(vec![event("Ctrl+Alt+Del")], 1).len(), 1);
    }

    #[test]
    fn rebase_trims_head_drops_outside_and_offsets() {
        let events = vec![
            // Inside the head trim — a press during worker startup.
            KeystrokeEvent {
                t_ms: 100,
                label: "Ctrl+X".into(),
            },
            // Inside the rendered segment window.
            KeystrokeEvent {
                t_ms: 600,
                label: "Ctrl+C".into(),
            },
            KeystrokeEvent {
                t_ms: 900,
                label: "Ctrl+V".into(),
            },
            // Past the segment end — a press during finalization.
            KeystrokeEvent {
                t_ms: 1500,
                label: "Ctrl+S".into(),
            },
        ];
        // 400ms head trim, 800ms segment, session offset 5000ms.
        let rebased = rebase_segment_events(events, 5_000, 400, 800);
        assert_eq!(
            rebased
                .iter()
                .map(|e| (e.t_ms, e.label.as_str()))
                .collect::<Vec<_>>(),
            vec![(5_200, "Ctrl+C"), (5_500, "Ctrl+V")]
        );
    }

    #[test]
    fn sanitize_drops_unsafe_loaded_labels() {
        let events = sanitize_events(
            vec![
                KeystrokeEvent {
                    t_ms: 1,
                    label: "Ctrl+C".into(),
                },
                KeystrokeEvent {
                    t_ms: 2,
                    label: "Ctrl+;".into(),
                },
                KeystrokeEvent {
                    t_ms: 3,
                    label: String::new(),
                },
                KeystrokeEvent {
                    t_ms: 4,
                    label: "Shift+Tab".into(),
                },
            ],
            2,
        );
        assert_eq!(
            events.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(),
            vec!["Ctrl+C", "Shift+Tab"]
        );
    }

    #[test]
    fn append_events_merges_sorted() {
        let dir = std::env::temp_dir().join(format!("rf-keys-append-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        append_events(
            &dir,
            vec![KeystrokeEvent {
                t_ms: 3_000,
                label: "Ctrl+V".into(),
            }],
        );
        append_events(
            &dir,
            vec![KeystrokeEvent {
                t_ms: 1_000,
                label: "Ctrl+C".into(),
            }],
        );
        let events = load_events(&dir).expect("appended file readable");
        assert_eq!(
            events.iter().map(|e| e.t_ms).collect::<Vec<_>>(),
            vec![1_000, 3_000]
        );
        // New writes are version 2.
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(KEYSTROKES_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(raw["version"], 2);
        std::fs::remove_dir_all(&dir).ok();
    }
}
