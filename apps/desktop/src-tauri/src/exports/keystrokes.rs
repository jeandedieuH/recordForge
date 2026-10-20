//! Keystroke overlay — renders modifier-combo badges ("Ctrl+C") near the
//! bottom-center of the frame for ~1.4 s per event (Pro).
//!
//! The badge chain is a row of `drawtext` filters gated by `enable=` windows.
//! Labels come from our own VK→name table at capture time, so text is always
//! a safe `[A-Za-z0-9+ ]` token — drawtext escaping is still applied for
//! defense in depth. Events closer than the display window are superseded by
//! the newer keypress (newest wins, matching Screen Studio's behavior).

use std::path::{Path, PathBuf};

use crate::capture::keystrokes::KeystrokeEvent;
use crate::errors::{InternalError, Result};

/// How long each badge stays on screen.
const BADGE_MS: u64 = 1_400;

const KEYSTROKE_FONT_BYTES: &[u8] =
    include_bytes!("../../../../../packages/overlay-engine/fonts/inter.ttf");

/// Write the embedded Inter font next to the badge filters (drawtext needs a
/// real file; the same trick as caption burn-in's font staging).
pub fn write_font(dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|e| InternalError::Storage(format!("keystroke font dir: {e}")))?;
    let path = dir.join("keystrokes-font.ttf");
    std::fs::write(&path, KEYSTROKE_FONT_BYTES)
        .map_err(|e| InternalError::Storage(format!("write keystroke font: {e}")))?;
    Ok(path)
}

/// Collapse raw events into non-overlapping display windows — a newer press
/// replaces a badge still on screen.
fn display_windows(events: &[KeystrokeEvent]) -> Vec<(u64, u64, &str)> {
    let mut windows: Vec<(u64, u64, &str)> = Vec::new();
    for event in events {
        if let Some(last) = windows.last_mut() {
            if event.t_ms < last.1 {
                // New press while the previous badge is visible — replace it.
                *last = (event.t_ms, event.t_ms + BADGE_MS, event.label.as_str());
                continue;
            }
        }
        windows.push((event.t_ms, event.t_ms + BADGE_MS, event.label.as_str()));
    }
    windows
}

/// Escape a label for drawtext `text=` (defense in depth — captured labels are
/// already whitelisted glyphs, but filter args are a hostile context).
fn escape_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == ' ')
        .collect::<String>()
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

/// Emit the drawtext chain: `[{input}]drawtext=…[ks0];[ks0]drawtext=…[out]`.
/// Returns the final label.
pub fn append_badge_chain(
    filters: &mut Vec<String>,
    input_label: &str,
    events: &[KeystrokeEvent],
    canvas_width: u32,
    canvas_height: u32,
    font_path: &Path,
) -> String {
    let windows = display_windows(events);
    if windows.is_empty() {
        return input_label.to_string();
    }
    // FFmpeg args need forward slashes even on Windows; '\' escapes confuse
    // the filter parser.
    let font_arg = font_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");
    let font_size = (canvas_height as f64 * 0.030).round().max(14.0) as u32;
    let bottom_offset = (canvas_height as f64 * 0.07).round().max(24.0) as u32;
    let _ = canvas_width;

    let mut current = input_label.to_string();
    for (index, (start_ms, end_ms, label)) in windows.iter().enumerate() {
        let out = format!("keystroke{index}");
        let enable = format!(
            "between(t,{:.3},{:.3})",
            *start_ms as f64 / 1000.0,
            *end_ms as f64 / 1000.0
        );
        filters.push(format!(
            "[{current}]drawtext=fontfile='{font_arg}':text='{}':fontsize={font_size}:fontcolor=white:borderw=1:bordercolor=black@0.6:box=1:boxcolor=black@0.55:boxborderw={}:x=(w-text_w)/2:y=h-{bottom_offset}:enable='{enable}'[{out}]",
            escape_label(label),
            (font_size / 3).max(6),
        ));
        current = out;
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(t_ms: u64, label: &str) -> KeystrokeEvent {
        KeystrokeEvent {
            t_ms,
            label: label.into(),
        }
    }

    #[test]
    fn windows_supersede_overlapping_badges() {
        let events = [
            ev(1000, "Ctrl+C"),
            ev(1500, "Ctrl+V"), // replaces the first badge mid-window
            ev(4000, "Ctrl+S"), // starts fresh after 1500+1400=2900
        ];
        let windows = display_windows(&events);
        assert_eq!(
            windows,
            vec![(1500, 2900, "Ctrl+V"), (4000, 5400, "Ctrl+S")]
        );
    }

    #[test]
    fn filter_chain_escapes_and_gates() {
        let mut filters = Vec::new();
        let out = append_badge_chain(
            &mut filters,
            "in",
            &[ev(1000, "Ctrl+C")],
            1920,
            1080,
            Path::new("C:\\tmp\\font.ttf"),
        );
        assert_eq!(out, "keystroke0");
        assert_eq!(filters.len(), 1);
        let filter = &filters[0];
        assert!(filter.contains("text='Ctrl+C'"));
        assert!(filter.contains("enable='between(t,1.000,2.400)'"));
        assert!(filter.contains("fontfile='C\\:/tmp/font.ttf'"));
    }
}
