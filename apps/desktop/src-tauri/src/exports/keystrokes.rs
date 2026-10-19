//! Keystroke overlay — renders modifier-combo badges ("Ctrl+C") near a frame
//! edge for a configurable hold window per event (Pro).
//!
//! The badge chain is a row of `drawtext` filters gated by `enable=` windows.
//! Labels come from our own VK→name table at capture time — punctuation keys
//! carry canonical names (`LeftBracket`, `Comma`, …) so every label is a safe
//! `[A-Za-z0-9+ ]` token; drawtext escaping is still applied for defense in
//! depth.
//!
//! Window construction mirrors `buildKeystrokeWindows` in
//! `packages/editor-core/src/keystroke-windows.ts`: events are source-time
//! stamps on the original recording, mapped to output time through the plan's
//! primary screen segments — trims, moves, speed changes, and duplicated
//! clips all land correctly. A newer badge truncates the previous badge's
//! visible end at its own start (the earlier badge keeps the visible portion
//! it already earned — it is never replaced wholesale).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::capture::keystrokes::KeystrokeEvent;
use crate::errors::{InternalError, Result};

use super::{KeystrokeOverlay, RenderSegment};

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

/// One output-timeline badge placement — already resolved from source event
/// stamps through the plan's segments (see `build_badge_windows`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BadgeWindow {
    pub start_ms: u64,
    pub end_ms: u64,
    pub label: String,
}

/// Labels are built from a fixed token table at capture; anything carrying
/// other bytes (hand-edited file, hostile fixture, legacy label format)
/// is dropped rather than escaped into a drawtext context.
pub(crate) use crate::capture::keystrokes::label_is_safe;

/// Map captured source-time events onto output-time badge windows through
/// the plan's primary screen segments. Mirrors the TypeScript
/// `buildKeystrokeWindows` — keep the two implementations in parity.
///
/// - An event belongs to a segment's half-open `[source_in, source_out)` and
///   lands at `output_start + (t - source_in) / speed`.
/// - The badge ends at `min(start + hold_ms, segment.output_end)` — a badge
///   never outlives its own clip.
/// - Sorted by start; each badge's end is then truncated at the next badge's
///   start (equal starts drop the earlier badge — latest event wins).
/// - Segments referencing non-primary assets (b-roll, inserted media) never
///   produce windows; a duplicated source clip produces one window per use.
pub(crate) fn build_badge_windows(
    events: &[KeystrokeEvent],
    segments: &[RenderSegment],
    primary_asset_ids: &HashSet<String>,
    hold_ms: u64,
) -> Vec<BadgeWindow> {
    // Stable sort by timestamp; dedupe only exact (t, label) repeats so the
    // "equal timestamps: latest wins" rule keeps later entries.
    let mut sorted: Vec<&KeystrokeEvent> = events
        .iter()
        .filter(|event| label_is_safe(&event.label))
        .collect();
    sorted.sort_by_key(|event| event.t_ms);
    sorted.dedup_by(|a, b| a.t_ms == b.t_ms && a.label == b.label);

    let mut windows: Vec<BadgeWindow> = Vec::new();
    for segment in segments {
        if !primary_asset_ids.contains(&segment.asset_id) {
            continue;
        }
        // Invalid speed can't produce a trustworthy mapping — skip the
        // segment entirely (same rule as the TypeScript mapper).
        if !segment.speed.is_finite() || segment.speed <= 0.0 {
            continue;
        }
        let speed = segment.speed;
        for event in &sorted {
            if event.t_ms < segment.source_in_ms || event.t_ms >= segment.source_out_ms {
                continue;
            }
            // Round fractional mapped offsets to the nearest ms — matches the
            // TypeScript canvas mapper exactly (speed=3 can land on x.33).
            let offset_ms = ((event.t_ms - segment.source_in_ms) as f64 / speed).round() as u64;
            let start_ms = segment.output_start_ms.saturating_add(offset_ms);
            let end_ms = start_ms.saturating_add(hold_ms).min(segment.output_end_ms);
            if end_ms > start_ms {
                windows.push(BadgeWindow {
                    start_ms,
                    end_ms,
                    label: event.label.clone(),
                });
            }
        }
    }

    // Stable sort by start, then let each newer badge truncate the previous
    // one's tail. After sorting, the next window's start is the earliest
    // later start, so a single forward pass suffices.
    windows.sort_by_key(|a| a.start_ms);
    for index in 0..windows.len().saturating_sub(1) {
        let next_start = windows[index + 1].start_ms;
        if windows[index].end_ms > next_start {
            windows[index].end_ms = next_start;
        }
    }
    windows.retain(|window| window.end_ms > window.start_ms);
    windows
}

/// Escape a label for drawtext `text=` (defense in depth — labels already
/// pass `label_is_safe`, but filter args are a hostile context).
fn escape_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == ' ')
        .collect::<String>()
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

/// (x, y) drawtext expressions for the configured badge position. The inset
/// is 7% of the output height on every edge, matching the preview overlay.
fn position_exprs(position: &str, inset: u32) -> (String, String) {
    // Bottom positions anchor the TEXT BOTTOM at the inset — `h-inset` would
    // anchor the top and put a 7% inset's worth of badge off-screen.
    match position {
        "bottom-left" => (inset.to_string(), format!("h-text_h-{inset}")),
        "bottom-right" => (format!("w-text_w-{inset}"), format!("h-text_h-{inset}")),
        "top-center" => ("(w-text_w)/2".to_string(), inset.to_string()),
        _ => ("(w-text_w)/2".to_string(), format!("h-text_h-{inset}")),
    }
}

/// Emit the drawtext chain: `[{input}]drawtext=…[ks0];[ks0]drawtext=…[out]`.
/// `windows` are absolute output-time badge placements; `window_s` is this
/// chunk's `[start_s, end_s)` — each badge is clipped to the chunk and
/// rebased to 0 because the raster is re-anchored (`PTS-STARTPTS`) before
/// this stage. Gates use half-open `gte`/`lt` so adjacent badges hand off
/// cleanly at their shared boundary. Returns the final label.
#[allow(clippy::too_many_arguments)]
pub(crate) fn append_badge_chain(
    filters: &mut Vec<String>,
    input_label: &str,
    windows: &[BadgeWindow],
    window_start_s: f64,
    window_end_s: f64,
    overlay: &KeystrokeOverlay,
    canvas_height: u32,
    font_path: &Path,
) -> String {
    let clipped: Vec<(f64, f64, &str)> = windows
        .iter()
        .filter_map(|window| {
            let start = (window.start_ms as f64 / 1000.0).max(window_start_s);
            let end = (window.end_ms as f64 / 1000.0).min(window_end_s);
            (end > start).then_some({
                (
                    start - window_start_s,
                    end - window_start_s,
                    window.label.as_str(),
                )
            })
        })
        .collect();
    if clipped.is_empty() {
        return input_label.to_string();
    }
    // FFmpeg args need forward slashes even on Windows; '\' escapes confuse
    // the filter parser.
    let font_arg = font_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");
    let scale = overlay.scale_factor();
    let font_size = ((canvas_height as f64 * 0.030) * scale).round().max(10.0) as u32;
    let inset = (canvas_height as f64 * 0.07).round().max(16.0) as u32;
    let (x_expr, y_expr) = position_exprs(overlay.position(), inset);

    let mut current = input_label.to_string();
    for (index, (start_s, end_s, label)) in clipped.iter().enumerate() {
        let out = format!("keystroke{index}");
        let enable = format!("gte(t,{start_s:.3})*lt(t,{end_s:.3})");
        filters.push(format!(
            "[{current}]drawtext=fontfile='{font_arg}':text='{}':fontsize={font_size}:fontcolor=white:borderw=1:bordercolor=black@0.6:box=1:boxcolor=black@0.55:boxborderw={}:x={x_expr}:y={y_expr}:enable='{enable}'[{out}]",
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

    fn segment(
        asset_id: &str,
        source_in: u64,
        source_out: u64,
        output_start: u64,
        output_end: u64,
        speed: f64,
    ) -> RenderSegment {
        RenderSegment {
            asset_id: asset_id.into(),
            stream_index: None,
            volume: None,
            fade_in_ms: None,
            fade_out_ms: None,
            volume_keyframes: None,
            audio_filter: None,
            speed,
            source_in_ms: source_in,
            source_out_ms: source_out,
            output_start_ms: output_start,
            output_end_ms: output_end,
            source_width: None,
            source_height: None,
        }
    }

    fn ids(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn newer_badge_truncates_earlier_tail_not_replaces() {
        // Pinned fixture: Ctrl+C at 1000, Ctrl+V at 1500, source [0,4000) —
        // the earlier badge keeps [1000,1500] instead of disappearing.
        let events = [ev(1000, "Ctrl+C"), ev(1500, "Ctrl+V")];
        let segments = [segment("screen", 0, 4000, 0, 4000, 1.0)];
        let windows = build_badge_windows(&events, &segments, &ids(&["screen"]), 1400);
        assert_eq!(
            windows,
            vec![
                BadgeWindow {
                    start_ms: 1000,
                    end_ms: 1500,
                    label: "Ctrl+C".into()
                },
                BadgeWindow {
                    start_ms: 1500,
                    end_ms: 2900,
                    label: "Ctrl+V".into()
                },
            ]
        );
    }

    #[test]
    fn speed_and_offset_map_events_to_output_time() {
        // source [2000,6000) at speed 2 → output [500,2500).
        // Event 3000 → 500 + (3000-2000)/2 = 1000, hold to 2400.
        // Event 5500 → 500 + 1750 = 2250, clipped by segment end 2500.
        // Events outside the segment's source range are excluded.
        let events = [
            ev(1999, "Ctrl+X"),
            ev(3000, "Ctrl+A"),
            ev(5500, "Ctrl+B"),
            ev(6000, "Ctrl+C"),
        ];
        let segments = [segment("screen", 2000, 6000, 500, 2500, 2.0)];
        let windows = build_badge_windows(&events, &segments, &ids(&["screen"]), 1400);
        assert_eq!(
            windows,
            vec![
                BadgeWindow {
                    start_ms: 1000,
                    end_ms: 2250,
                    label: "Ctrl+A".into()
                },
                BadgeWindow {
                    start_ms: 2250,
                    end_ms: 2500,
                    label: "Ctrl+B".into()
                },
            ]
        );
    }

    #[test]
    fn duplicated_source_clip_produces_a_window_per_use() {
        let events = [ev(1000, "Ctrl+C")];
        let segments = [
            segment("screen", 0, 4000, 0, 4000, 1.0),
            segment("screen", 0, 4000, 5000, 9000, 1.0),
        ];
        let windows = build_badge_windows(&events, &segments, &ids(&["screen"]), 1400);
        assert_eq!(
            windows,
            vec![
                BadgeWindow {
                    start_ms: 1000,
                    end_ms: 2400,
                    label: "Ctrl+C".into()
                },
                BadgeWindow {
                    start_ms: 6000,
                    end_ms: 7400,
                    label: "Ctrl+C".into()
                },
            ]
        );
    }

    #[test]
    fn non_primary_assets_never_produce_windows() {
        let events = [ev(1000, "Ctrl+C")];
        let segments = [segment("broll", 0, 4000, 0, 4000, 1.0)];
        let windows = build_badge_windows(&events, &segments, &ids(&["screen"]), 1400);
        assert!(windows.is_empty());
    }

    #[test]
    fn equal_timestamps_latest_event_wins() {
        // The later entry in the events array survives; the earlier badge is
        // truncated to zero length and dropped.
        let events = [ev(1000, "Ctrl+C"), ev(1000, "Ctrl+V")];
        let segments = [segment("screen", 0, 4000, 0, 4000, 1.0)];
        let windows = build_badge_windows(&events, &segments, &ids(&["screen"]), 1400);
        assert_eq!(
            windows,
            vec![BadgeWindow {
                start_ms: 1000,
                end_ms: 2400,
                label: "Ctrl+V".into()
            }]
        );
    }

    #[test]
    fn equal_time_repeat_label_last_entry_wins() {
        // C,V,C at the same timestamp — adjacent dedupe must not remove the
        // second C; it is the LAST captured entry and truncates both
        // earlier windows to zero. Matches the TypeScript fixture.
        let events = [ev(1000, "Ctrl+C"), ev(1000, "Ctrl+V"), ev(1000, "Ctrl+C")];
        let segments = [segment("screen", 0, 4000, 0, 4000, 1.0)];
        let windows = build_badge_windows(&events, &segments, &ids(&["screen"]), 1400);
        assert_eq!(
            windows,
            vec![BadgeWindow {
                start_ms: 1000,
                end_ms: 2400,
                label: "Ctrl+C".into()
            }]
        );
    }

    #[test]
    fn non_finite_speed_segments_are_skipped() {
        let events = [ev(1000, "Ctrl+C")];
        let segments = [
            segment("nan", 0, 4000, 0, 4000, f64::NAN),
            segment("inf", 0, 4000, 0, 4000, f64::INFINITY),
            segment("screen", 0, 4000, 0, 4000, 1.0),
        ];
        let windows =
            build_badge_windows(&events, &segments, &ids(&["nan", "inf", "screen"]), 1400);
        assert_eq!(
            windows,
            vec![BadgeWindow {
                start_ms: 1000,
                end_ms: 2400,
                label: "Ctrl+C".into()
            }]
        );
    }

    #[test]
    fn malformed_labels_are_rejected() {
        let events = [ev(1000, "Ctrl+C');overlay=0:0["), ev(1100, "Ctrl+C")];
        let segments = [segment("screen", 0, 4000, 0, 4000, 1.0)];
        let windows = build_badge_windows(&events, &segments, &ids(&["screen"]), 1400);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label, "Ctrl+C");
        assert!(!label_is_safe("Ctrl+;"));
        assert!(!label_is_safe("';drawbox'"));
        assert!(label_is_safe("Ctrl+LeftBracket"));
    }

    #[test]
    fn filter_chain_clips_and_rebases_to_chunk() {
        let mut filters = Vec::new();
        let overlay = KeystrokeOverlay {
            enabled: true,
            duration_ms: None,
            position: None,
            scale_percent: None,
        };
        let windows = vec![BadgeWindow {
            start_ms: 1500,
            end_ms: 2900,
            label: "Ctrl+V".into(),
        }];
        // Chunk [2000,4000) keeps only the badge's [2000,2900] tail, rebased
        // to the chunk-local raster as [0, 0.9).
        let out = append_badge_chain(
            &mut filters,
            "in",
            &windows,
            2.0,
            4.0,
            &overlay,
            1080,
            Path::new("C:\\tmp\\font.ttf"),
        );
        assert_eq!(out, "keystroke0");
        let filter = &filters[0];
        assert!(filter.contains("text='Ctrl+V'"));
        assert!(filter.contains("enable='gte(t,0.000)*lt(t,0.900)'"));
        assert!(filter.contains("fontfile='C\\:/tmp/font.ttf'"));
    }
}
