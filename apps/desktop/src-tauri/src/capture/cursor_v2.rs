//! Cursor Telemetry V2 capture, storage, and migration.
//!
//! V2 replaces the fixed 60 Hz sample-at-time-offset model with a versioned,
//! session-clock-synchronized telemetry asset. It captures physical pixel
//! coordinates, an explicit affine source transform, display topology and DPI,
//! cursor shape identity and hotspot, and independent button edge events.
//!
//! Storage is split for compactness and recovery:
//! - `cursor_telemetry.json` — metadata, shape table, transform, topology,
//!   health, and a chunk index.
//! - `cursor_events.bin` — fixed-size binary event records for fast seeking.
//!
//! V1 JSON telemetry is read transparently and can be migrated to V2 on demand.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tracing::{error, info, warn};

/// Magic bytes at the start of a V2 binary event file.
const V2_EVENT_MAGIC: &[u8; 4] = b"RFCT";
const V2_EVENT_FILE_VERSION: u32 = 1;
const V2_SCHEMA_VERSION: u32 = 2;
const V1_SCHEMA_VERSION: u32 = 1;

/// Number of events per chunk index entry. A 60-minute 60 Hz recording has
/// ~216,000 events; an entry every 1024 events produces ~211 index entries.
const INDEX_STRIDE: usize = 1024;

/// Target sample interval for ~120 Hz capture. The actual interval is timed
/// using high-resolution multimedia timers; each event carries an authoritative
/// session-clock timestamp.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(8);

/// Default click effect window in milliseconds. Kept in V2 for consumer parity.
const DEFAULT_CLICK_WINDOW_MS: u64 = 350;

#[cfg(target_os = "windows")]
struct HighResolutionTimerGuard;

#[cfg(target_os = "windows")]
impl HighResolutionTimerGuard {
    fn new() -> Self {
        use windows::Win32::Media::timeBeginPeriod;
        unsafe {
            let _ = timeBeginPeriod(1);
        }
        Self
    }
}

#[cfg(target_os = "windows")]
impl Drop for HighResolutionTimerGuard {
    fn drop(&mut self) {
        use windows::Win32::Media::timeEndPeriod;
        unsafe {
            let _ = timeEndPeriod(1);
        }
    }
}

// ---------------------------------------------------------------------------
// V2 data types
// ---------------------------------------------------------------------------

/// Affine transform from capture physical pixels to source output pixels.
///
/// Source coordinates are derived as:
///   source_x = a00 * raw_x + a01 * raw_y + b0
///   source_y = a10 * raw_x + a11 * raw_y + b1
///
/// For a standard screen recording this collapses to a uniform scale plus
/// translation, but the full 2x3 matrix handles rotated tablets, mixed-DPI
/// multi-monitor edges, and future source transforms without a schema change.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorCoordinateTransform {
    pub a00: f64,
    pub a01: f64,
    pub a10: f64,
    pub a11: f64,
    pub b0: f64,
    pub b1: f64,
}

impl Default for CursorCoordinateTransform {
    fn default() -> Self {
        Self {
            a00: 1.0,
            a01: 0.0,
            a10: 0.0,
            a11: 1.0,
            b0: 0.0,
            b1: 0.0,
        }
    }
}

impl CursorCoordinateTransform {
    /// Build a simple scale-and-offset transform from capture bounds and source size.
    pub fn from_bounds(
        capture_bounds: &CursorCaptureBounds,
        source_width: u32,
        source_height: u32,
        dpi_scale: &CursorDpiScale,
    ) -> Self {
        let scale_x = if capture_bounds.width == 0 {
            1.0
        } else {
            source_width as f64 / capture_bounds.width as f64 * dpi_scale.x
        };
        let scale_y = if capture_bounds.height == 0 {
            1.0
        } else {
            source_height as f64 / capture_bounds.height as f64 * dpi_scale.y
        };
        Self {
            a00: scale_x,
            a01: 0.0,
            a10: 0.0,
            a11: scale_y,
            b0: -(capture_bounds.x as f64) * scale_x,
            b1: -(capture_bounds.y as f64) * scale_y,
        }
    }

    /// Apply the transform to a raw physical pixel point.
    pub fn apply(&self, x: i32, y: i32) -> (f64, f64) {
        let x = x as f64;
        let y = y as f64;
        (
            self.a00 * x + self.a01 * y + self.b0,
            self.a10 * x + self.a11 * y + self.b1,
        )
    }

    /// Recover the uniform DPI scale for a simple scale-and-offset transform.
    ///
    /// Returns `None` if the transform has off-diagonal terms that cannot be
    /// expressed as a simple DPI scale. This is used for V1 compatibility.
    pub fn dpi_scale_from_bounds(
        &self,
        source_width: u32,
        source_height: u32,
        capture_bounds: &CursorCaptureBounds,
    ) -> Option<CursorDpiScale> {
        if self.a01 != 0.0 || self.a10 != 0.0 {
            return None;
        }
        let capture_width = capture_bounds.width as f64;
        let capture_height = capture_bounds.height as f64;
        if capture_width == 0.0 || capture_height == 0.0 || source_width == 0 || source_height == 0
        {
            return None;
        }
        Some(CursorDpiScale {
            x: self.a00 * capture_width / source_width as f64,
            y: self.a11 * capture_height / source_height as f64,
        })
    }
}

/// Display topology where the cursor was captured.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorTopology {
    pub display_id: String,
    pub display_bounds: CursorCaptureBounds,
    pub is_primary: bool,
    pub orientation: u32,
    pub scale_factor: f64,
    pub dpi_x: f64,
    pub dpi_y: f64,
}

/// Cursor shape metadata. The `shape_id` is a stable-ish hash derived from the
/// current system cursor icon; `hotspot` is the click point within the icon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorShapeInfo {
    pub shape_id: String,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub width: u32,
    pub height: u32,
    pub kind: String,
}

/// Independent button states with per-button edge detection.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorButtonState {
    pub left: bool,
    pub right: bool,
    pub middle: bool,
    pub x1: bool,
    pub x2: bool,
}

impl CursorButtonState {
    /// Returns true if any button is currently pressed.
    pub fn any_down(&self) -> bool {
        self.left || self.right || self.middle || self.x1 || self.x2
    }

    /// Returns the first pressed button, or "none" if no button is pressed.
    pub fn primary_button(&self) -> &'static str {
        if self.left {
            "left"
        } else if self.right {
            "right"
        } else if self.middle {
            "middle"
        } else if self.x1 {
            "x1"
        } else if self.x2 {
            "x2"
        } else {
            "none"
        }
    }
}

/// Health of the cursor telemetry stream at capture time.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CursorTelemetryHealth {
    #[default]
    Healthy,
    /// Cursor position could not be read; telemetry is unavailable.
    PositionUnavailable,
    /// Button state could not be read; positions are captured but clicks are not.
    ButtonsUnavailable,
    /// Shape information could not be captured; fallback to a single default pointer.
    ShapesUnavailable,
    /// DPI/scale information could not be captured; using default 1.0.
    TopologyUnavailable,
}

/// Capture bounds for the recorded region, in virtual-desktop physical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorCaptureBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// DPI scale applied to raw physical pixels before the source fit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorDpiScale {
    pub x: f64,
    pub y: f64,
}

impl Default for CursorDpiScale {
    fn default() -> Self {
        Self { x: 1.0, y: 1.0 }
    }
}

/// Timebase for event timestamps.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryTimebase {
    pub unit: String,
    pub ticks_per_second: u64,
}

impl Default for CursorTelemetryTimebase {
    fn default() -> Self {
        Self {
            unit: "ms".into(),
            ticks_per_second: 1_000,
        }
    }
}

/// A single V2 cursor telemetry event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryEventV2 {
    pub t_ms: u64,
    /// Physical pixel on the virtual desktop.
    pub raw_x: i32,
    pub raw_y: i32,
    /// Pre-transformed source coordinate (matches the output frame).
    pub source_x: f64,
    pub source_y: f64,
    pub buttons: CursorButtonState,
    /// One of: none, left-down, left-up, right-down, right-up, middle-down,
    /// middle-up, x1-down, x1-up, x2-down, x2-up, left-held, etc.
    pub button_event: String,
    pub visible: bool,
    pub shape_id: String,
    /// True when this sample is the first after the system cursor shape changed.
    pub shape_changed: bool,
}

impl CursorTelemetryEventV2 {
    /// True if this event represents a click edge (any button down).
    pub fn is_click_edge(&self) -> bool {
        self.button_event.ends_with("-down")
    }

    /// True if the event is any held sample while at least one button is pressed.
    pub fn is_held(&self) -> bool {
        self.button_event.ends_with("-held")
    }
}

/// One chunk index entry for fast time-based seeking in the binary event file.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorEventIndexEntry {
    pub event_index: u64,
    pub t_ms: u64,
    pub file_offset: u64,
}

/// V2 telemetry metadata, written to `cursor_telemetry.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryMetadata {
    pub schema_version: u32,
    pub asset_id: String,
    pub recording_id: String,
    pub source_width: u32,
    pub source_height: u32,
    pub capture_bounds: CursorCaptureBounds,
    pub coordinate_transform: CursorCoordinateTransform,
    pub topology: Option<CursorTopology>,
    pub shapes: Vec<CursorShapeInfo>,
    pub timebase: CursorTelemetryTimebase,
    pub sample_rate_hz: u32,
    pub click_window_ms: u64,
    pub health: CursorTelemetryHealth,
    pub event_count: u64,
    pub index: Vec<CursorEventIndexEntry>,
    /// Path to the binary event file, relative to the recording work directory.
    pub event_file: String,
}

impl CursorTelemetryMetadata {
    pub fn new(
        recording_id: String,
        source_width: u32,
        source_height: u32,
        capture_bounds: CursorCaptureBounds,
    ) -> Self {
        Self {
            schema_version: V2_SCHEMA_VERSION,
            asset_id: format!("cursor-events:{recording_id}"),
            recording_id,
            source_width,
            source_height,
            capture_bounds,
            coordinate_transform: CursorCoordinateTransform::from_bounds(
                &capture_bounds,
                source_width,
                source_height,
                &CursorDpiScale::default(),
            ),
            topology: None,
            shapes: Vec::new(),
            timebase: CursorTelemetryTimebase::default(),
            sample_rate_hz: 120,
            click_window_ms: DEFAULT_CLICK_WINDOW_MS,
            health: CursorTelemetryHealth::Healthy,
            event_count: 0,
            index: Vec::new(),
            event_file: "cursor_events.bin".into(),
        }
    }

    /// Update the affine transform from capture bounds and an explicit DPI scale.
    pub fn set_dpi_scale(&mut self, dpi_scale: &CursorDpiScale) {
        self.coordinate_transform = CursorCoordinateTransform::from_bounds(
            &self.capture_bounds,
            self.source_width,
            self.source_height,
            dpi_scale,
        );
    }

    /// Resolve the absolute path to the binary event file inside `work_dir`.
    pub fn event_path(&self, work_dir: &Path) -> PathBuf {
        work_dir.join(&self.event_file)
    }
}

/// Complete in-memory V2 telemetry asset (metadata + events).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryFileV2 {
    #[serde(flatten)]
    pub metadata: CursorTelemetryMetadata,
    pub events: Vec<CursorTelemetryEventV2>,
}

// ---------------------------------------------------------------------------
// V1 data types (for migration)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryEventV1 {
    pub t_ms: u64,
    pub x: f64,
    pub y: f64,
    pub clicked: bool,
    pub button: String,
    #[serde(default = "default_v1_button_event")]
    pub button_event: String,
    pub visible: bool,
}

fn default_v1_button_event() -> String {
    "none".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryFileV1 {
    #[serde(default = "default_v1_schema_version")]
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
    pub events: Vec<CursorTelemetryEventV1>,
}

fn default_v1_schema_version() -> u32 {
    V1_SCHEMA_VERSION
}

fn default_sample_rate() -> u32 {
    60
}

impl CursorTelemetryFileV1 {
    /// Normalize a possibly legacy V1 file so every expected field is present.
    pub fn normalize(mut self) -> Self {
        if self.schema_version == 0 {
            self.schema_version = V1_SCHEMA_VERSION;
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
            self.dpi_scale = Some(CursorDpiScale::default());
        }
        if self.timebase.is_none() {
            self.timebase = Some(CursorTelemetryTimebase::default());
        }
        self.events.sort_by_key(|event| event.t_ms);
        self
    }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/// Migrate a V1 telemetry file into a V2 in-memory representation.
///
/// V1 did not record shape, topology, or independent button edges, so those
/// fields are filled with safe defaults. Button events are reconstructed from
/// the `button` and `button_event` fields using a one-sample lookbehind.
pub fn migrate_v1_to_v2(v1: CursorTelemetryFileV1) -> CursorTelemetryFileV2 {
    let v1 = v1.normalize();
    let capture_bounds = v1.capture_bounds.unwrap_or(CursorCaptureBounds {
        x: 0,
        y: 0,
        width: v1.source_width,
        height: v1.source_height,
    });
    let dpi_scale = v1.dpi_scale.unwrap_or_default();

    let mut metadata = CursorTelemetryMetadata::new(
        v1.recording_id,
        v1.source_width,
        v1.source_height,
        capture_bounds,
    );
    metadata.asset_id = v1.asset_id;
    metadata.sample_rate_hz = v1.sample_rate_hz;
    metadata.set_dpi_scale(&dpi_scale);
    metadata.health = CursorTelemetryHealth::ShapesUnavailable;

    let transform = metadata.coordinate_transform;
    let mut previous: Option<&CursorTelemetryEventV1> = None;
    let mut previous_buttons = CursorButtonState::default();

    let events: Vec<CursorTelemetryEventV2> = v1
        .events
        .iter()
        .map(|event| {
            let raw_x = event.x as i32;
            let raw_y = event.y as i32;
            let (source_x, source_y) = transform.apply(raw_x, raw_y);

            let buttons = CursorButtonState {
                left: event.button == "left" && (event.clicked || event.button_event != "none"),
                right: event.button == "right" && (event.clicked || event.button_event != "none"),
                middle: event.button == "middle" && (event.clicked || event.button_event != "none"),
                x1: false,
                x2: false,
            };

            let button_event = if previous.is_none() {
                if buttons.any_down() {
                    format!("{}-down", buttons.primary_button())
                } else {
                    "none".into()
                }
            } else {
                derive_button_event(&previous_buttons, &buttons)
            };

            previous = Some(event);
            previous_buttons = buttons;

            CursorTelemetryEventV2 {
                t_ms: event.t_ms,
                raw_x,
                raw_y,
                source_x,
                source_y,
                buttons,
                button_event,
                visible: event.visible,
                shape_id: "default".into(),
                shape_changed: false,
            }
        })
        .collect();

    CursorTelemetryFileV2 { metadata, events }
}

fn derive_button_event(previous: &CursorButtonState, current: &CursorButtonState) -> String {
    let buttons = [
        (previous.left, current.left, "left"),
        (previous.right, current.right, "right"),
        (previous.middle, current.middle, "middle"),
        (previous.x1, current.x1, "x1"),
        (previous.x2, current.x2, "x2"),
    ];

    // Prefer edge transitions in the standard button order, then held states,
    // then no event. This avoids reporting a held button when another button
    // was the one that actually changed.
    for (was_down, is_down, name) in buttons {
        if !was_down && is_down {
            return format!("{name}-down");
        }
    }
    for (was_down, is_down, name) in buttons {
        if was_down && !is_down {
            return format!("{name}-up");
        }
    }
    for (was_down, is_down, name) in buttons {
        if was_down && is_down {
            return format!("{name}-held");
        }
    }
    "none".into()
}

// ---------------------------------------------------------------------------
// Binary event file format
//
// Layout:
//   4  magic "RFCT"
//   4  file version (u32 little-endian)
//   8  event count (u64 little-endian)
//   N  event records (fixed 32 bytes each)
//
// Event record (32 bytes, little-endian):
//   8  t_ms (u64)
//   4  raw_x (i32)
//   4  raw_y (i32)
//   8  source_x (f64)
//   4  source_y (f64)
//   1  button_flags
//   1  button_event_kind (stored hint; read derives the event from adjacent button states)
//   1  visible
//   1  shape_index
//
// button_flags bits: 0=left, 1=right, 2=middle, 3=x1, 4=x2
// button_event_kind: 0=none, 1=down, 2=up, 3=held
// ---------------------------------------------------------------------------

const EVENT_RECORD_SIZE: usize = 32;

fn encode_button_flags(buttons: &CursorButtonState) -> u8 {
    (buttons.left as u8)
        | ((buttons.right as u8) << 1)
        | ((buttons.middle as u8) << 2)
        | ((buttons.x1 as u8) << 3)
        | ((buttons.x2 as u8) << 4)
}

fn decode_button_flags(flags: u8) -> CursorButtonState {
    CursorButtonState {
        left: (flags & 1) != 0,
        right: (flags & 2) != 0,
        middle: (flags & 4) != 0,
        x1: (flags & 8) != 0,
        x2: (flags & 16) != 0,
    }
}

fn encode_button_event(event: &str) -> u8 {
    if event.ends_with("-down") {
        1
    } else if event.ends_with("-up") {
        2
    } else if event.ends_with("-held") {
        3
    } else {
        0
    }
}

fn shape_index_for_event(shape_id: &str, shapes: &[CursorShapeInfo]) -> u8 {
    shapes
        .iter()
        .position(|shape| shape.shape_id == shape_id)
        .map(|index| index.min(u8::MAX as usize) as u8)
        .unwrap_or(u8::MAX)
}

fn shape_id_for_index(index: u8, shapes: &[CursorShapeInfo]) -> String {
    shapes
        .get(index as usize)
        .map(|shape| shape.shape_id.clone())
        .unwrap_or_else(|| "unknown".into())
}

fn write_event_record<W: Write>(
    writer: &mut W,
    event: &CursorTelemetryEventV2,
    shapes: &[CursorShapeInfo],
) -> std::io::Result<()> {
    let mut buf = [0u8; EVENT_RECORD_SIZE];
    let bytes = event.t_ms.to_le_bytes();
    buf[0..8].copy_from_slice(&bytes);
    let bytes = event.raw_x.to_le_bytes();
    buf[8..12].copy_from_slice(&bytes);
    let bytes = event.raw_y.to_le_bytes();
    buf[12..16].copy_from_slice(&bytes);
    let bytes = event.source_x.to_le_bytes();
    buf[16..24].copy_from_slice(&bytes);
    // source_y is split across the remaining bytes; we only have 4 bytes left in
    // the 28..32 range, so store it as f32 to fit the 32-byte record.
    // The evaluator will promote it back to f64 with negligible precision loss
    // for screen-video coordinates.
    let source_y_f32 = event.source_y as f32;
    let bytes = source_y_f32.to_le_bytes();
    buf[24..28].copy_from_slice(&bytes);
    buf[28] = encode_button_flags(&event.buttons);
    buf[29] = encode_button_event(&event.button_event);
    buf[30] = if event.visible { 1 } else { 0 };
    buf[31] = shape_index_for_event(&event.shape_id, shapes);
    writer.write_all(&buf)
}

fn read_event_record(
    data: &[u8],
    offset: usize,
    previous_buttons: &CursorButtonState,
    shapes: &[CursorShapeInfo],
) -> Option<CursorTelemetryEventV2> {
    if offset + EVENT_RECORD_SIZE > data.len() {
        return None;
    }
    let slice = &data[offset..offset + EVENT_RECORD_SIZE];
    let t_ms = u64::from_le_bytes(slice[0..8].try_into().ok()?);
    let raw_x = i32::from_le_bytes(slice[8..12].try_into().ok()?);
    let raw_y = i32::from_le_bytes(slice[12..16].try_into().ok()?);
    let source_x = f64::from_le_bytes(slice[16..24].try_into().ok()?);
    let source_y = f32::from_le_bytes(slice[24..28].try_into().ok()?);
    let buttons = decode_button_flags(slice[28]);
    // button_event is derived from adjacent button states, not the stored
    // button_event_kind. This preserves the correct button name across up
    // events where the current frame has no button pressed.
    let button_event = derive_button_event(previous_buttons, &buttons);
    let visible = slice[30] != 0;
    let shape_id = shape_id_for_index(slice[31], shapes);
    Some(CursorTelemetryEventV2 {
        t_ms,
        raw_x,
        raw_y,
        source_x,
        source_y: source_y as f64,
        buttons,
        button_event,
        visible,
        shape_id,
        shape_changed: false,
    })
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Persist a V2 telemetry asset to disk.
///
/// Writes the metadata JSON and the binary event file atomically. Returns the
/// metadata that was written (with an updated index and event count).
pub fn write_v2_telemetry(
    work_dir: &Path,
    telemetry: &CursorTelemetryFileV2,
) -> Result<CursorTelemetryMetadata, String> {
    if !work_dir.exists() {
        return Err(format!(
            "work directory does not exist: {}",
            work_dir.display()
        ));
    }

    let mut metadata = telemetry.metadata.clone();
    metadata.event_count = telemetry.events.len() as u64;

    // Build the binary event file.
    let event_path = metadata.event_path(work_dir);
    let temp_event_path = event_path.with_extension("bin.tmp");
    let mut event_file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp_event_path)
        .map_err(|e| format!("open event file: {e}"))?;

    event_file
        .write_all(V2_EVENT_MAGIC)
        .map_err(|e| format!("write event magic: {e}"))?;
    event_file
        .write_all(&V2_EVENT_FILE_VERSION.to_le_bytes())
        .map_err(|e| format!("write event version: {e}"))?;
    event_file
        .write_all(&metadata.event_count.to_le_bytes())
        .map_err(|e| format!("write event count: {e}"))?;

    let mut index = Vec::with_capacity((metadata.event_count as usize / INDEX_STRIDE).max(1));
    let mut offset: u64 = (V2_EVENT_MAGIC.len() + 4 + 8) as u64;

    for (i, event) in telemetry.events.iter().enumerate() {
        if i % INDEX_STRIDE == 0 {
            index.push(CursorEventIndexEntry {
                event_index: i as u64,
                t_ms: event.t_ms,
                file_offset: offset,
            });
        }
        write_event_record(&mut event_file, event, &metadata.shapes)
            .map_err(|e| format!("write event record: {e}"))?;
        offset += EVENT_RECORD_SIZE as u64;
    }

    event_file
        .flush()
        .map_err(|e| format!("flush event file: {e}"))?;
    drop(event_file);

    super::disk::sync_file(&temp_event_path).map_err(|e| format!("sync event file: {e}"))?;
    super::disk::atomic_replace(&temp_event_path, &event_path)
        .map_err(|e| format!("publish event file: {e}"))?;

    metadata.index = index;

    // Write the metadata JSON.
    let meta_path = work_dir.join("cursor_telemetry.json");
    let temp_meta_path = meta_path.with_extension("json.tmp");
    let json =
        serde_json::to_string_pretty(&metadata).map_err(|e| format!("serialize metadata: {e}"))?;
    std::fs::write(&temp_meta_path, json).map_err(|e| format!("write metadata temp: {e}"))?;
    super::disk::sync_file(&temp_meta_path).map_err(|e| format!("sync metadata: {e}"))?;
    super::disk::atomic_replace(&temp_meta_path, &meta_path)
        .map_err(|e| format!("publish metadata: {e}"))?;

    Ok(metadata)
}

/// Read a V2 telemetry asset from disk.
pub fn read_v2_telemetry(work_dir: &Path) -> Option<CursorTelemetryFileV2> {
    let meta_path = work_dir.join("cursor_telemetry.json");
    let text = std::fs::read_to_string(&meta_path).ok()?;
    let mut metadata: CursorTelemetryMetadata = serde_json::from_str(&text).ok()?;

    // If the event file was moved or renamed, fall back to the default name.
    if metadata.schema_version != V2_SCHEMA_VERSION {
        return None;
    }

    let event_path = metadata.event_path(work_dir);
    let mut event_file = std::fs::File::open(&event_path).ok()?;
    let mut data = Vec::new();
    event_file.read_to_end(&mut data).ok()?;

    if data.len() < V2_EVENT_MAGIC.len() + 4 + 8 {
        return None;
    }
    if &data[0..4] != V2_EVENT_MAGIC {
        return None;
    }
    let version = u32::from_le_bytes(data[4..8].try_into().ok()?);
    if version != V2_EVENT_FILE_VERSION {
        return None;
    }
    let event_count = u64::from_le_bytes(data[8..16].try_into().ok()?) as usize;

    let mut events = Vec::with_capacity(event_count);
    let mut previous_buttons = CursorButtonState::default();
    for i in 0..event_count {
        let offset = 16 + i * EVENT_RECORD_SIZE;
        let event = read_event_record(&data, offset, &previous_buttons, &metadata.shapes)?;
        previous_buttons = event.buttons;
        events.push(event);
    }

    // Recompute shape_changed flags by comparing adjacent shape IDs.
    for i in (1..events.len()).rev() {
        if events[i].shape_id != events[i - 1].shape_id {
            events[i].shape_changed = true;
        }
    }

    metadata.event_count = events.len() as u64;
    Some(CursorTelemetryFileV2 { metadata, events })
}

/// Read any cursor telemetry file (V1 JSON or V2 metadata+binary) and return
/// a normalized V2 in-memory representation.
pub fn read_any_telemetry(work_dir: &Path) -> Option<CursorTelemetryFileV2> {
    if let Some(v2) = read_v2_telemetry(work_dir) {
        return Some(v2);
    }

    let v1_path = work_dir.join("cursor_telemetry.json");
    let text = std::fs::read_to_string(&v1_path).ok()?;
    let v1: CursorTelemetryFileV1 = serde_json::from_str(&text).ok()?;
    Some(migrate_v1_to_v2(v1))
}

/// Shift timestamps for the current capture segment earlier by `shift_ms`.
///
/// Cursor samples are stored in one session timeline, but each pause/resume
/// segment has its own FFmpeg startup window. Only events at or after
/// `segment_start_ms` belong to the segment being aligned; earlier events must
/// never be shifted again or the cursor will drift progressively after resume.
/// Events that still fall inside the segment's startup window are discarded.
fn shift_telemetry_clock_in_segment(
    work_dir: &Path,
    segment_start_ms: u64,
    segment_end_ms: Option<u64>,
    shift_ms: u64,
) -> Result<(), String> {
    if shift_ms == 0 && segment_end_ms.is_none() {
        return Ok(());
    }
    let Some(mut telemetry) = read_any_telemetry(work_dir) else {
        return Ok(());
    };

    let mut shifted_events = Vec::with_capacity(telemetry.events.len());
    let mut dropped = 0usize;
    for mut event in telemetry.events {
        if event.t_ms < segment_start_ms {
            shifted_events.push(event);
            continue;
        }

        // A first-segment event must not become negative. For resumed
        // segments, allow the first shifted sample to land exactly on the
        // prior segment's join timestamp (`segment_start_ms - 1`).
        let shifted_time = event.t_ms.saturating_sub(shift_ms);
        let before_segment_video = if segment_start_ms == 0 {
            event.t_ms < shift_ms
        } else {
            shifted_time < segment_start_ms.saturating_sub(1)
        };
        let after_segment_video = segment_end_ms.is_some_and(|end| shifted_time > end);
        if before_segment_video || after_segment_video {
            dropped += 1;
            continue;
        }
        event.t_ms = shifted_time;
        shifted_events.push(event);
    }

    if dropped > 0 {
        info!(
            dropped,
            segment_start_ms,
            shift_ms,
            "dropped cursor events outside the aligned segment video window"
        );
    }
    telemetry.events = shifted_events;
    write_v2_telemetry(work_dir, &telemetry).map(|_| ())
}

/// Shift timestamps for a segment while preserving earlier session history.
pub fn shift_telemetry_clock_from(
    work_dir: &Path,
    segment_start_ms: u64,
    shift_ms: u64,
) -> Result<(), String> {
    shift_telemetry_clock_in_segment(work_dir, segment_start_ms, None, shift_ms)
}

/// Align one segment's timestamps to its actual video start and end.
pub fn align_telemetry_segment(
    work_dir: &Path,
    segment_start_ms: u64,
    segment_duration_ms: u64,
    shift_ms: u64,
) -> Result<(), String> {
    let segment_end_ms = segment_start_ms.saturating_add(segment_duration_ms);
    shift_telemetry_clock_in_segment(work_dir, segment_start_ms, Some(segment_end_ms), shift_ms)
}

/// Shift the first segment's timestamps for compatibility with older callers.
pub fn shift_telemetry_clock(work_dir: &Path, shift_ms: u64) -> Result<(), String> {
    shift_telemetry_clock_from(work_dir, 0, shift_ms)
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CursorCaptureMode {
    /// Capture full V2 telemetry.
    Full,
    /// Capture V2 but with shape information disabled.
    NoShapes,
    /// Capture positions only; skip cursor entirely.
    Disabled,
}

#[derive(Debug)]
pub struct CursorTrackerV2 {
    stop_signal: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl CursorTrackerV2 {
    /// Start capturing cursor telemetry for a recording session.
    ///
    /// `timeline_origin` is the monotonic origin captured immediately before
    /// the screen FFmpeg process starts. Cursor timestamps are session-clock
    /// offsets from that origin plus `time_offset_ms`; finalization removes the
    /// measured per-segment startup window before publishing the telemetry.
    /// This keeps pause/resume segments on one session timeline without relying
    /// on wall-clock or tracker-local timestamps.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        recording_id: String,
        work_dir: PathBuf,
        bounds: CursorCaptureBounds,
        source_width: u32,
        source_height: u32,
        timeline_origin: Instant,
        time_offset_ms: u64,
        mode: CursorCaptureMode,
    ) -> Self {
        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_signal_clone = stop_signal.clone();

        let handle = thread::spawn(move || {
            #[cfg(target_os = "windows")]
            let _timer_guard = HighResolutionTimerGuard::new();

            let existing = read_any_telemetry(&work_dir);

            let (mut metadata, mut events, mut previous_buttons, mut previous_shape_id) =
                if let Some(v2) = existing {
                    let previous = v2.events.last().cloned();
                    let previous_buttons = previous
                        .as_ref()
                        .map_or(CursorButtonState::default(), |event| event.buttons);
                    let previous_shape_id =
                        previous.map_or("default".into(), |event| event.shape_id);
                    (v2.metadata, v2.events, previous_buttons, previous_shape_id)
                } else {
                    let metadata = CursorTelemetryMetadata::new(
                        recording_id.clone(),
                        source_width,
                        source_height,
                        bounds,
                    );
                    (
                        metadata,
                        Vec::with_capacity(3600),
                        CursorButtonState::default(),
                        "default".into(),
                    )
                };

            // Keep source coordinates in the encoded profile's space. A window
            // can move or resize between pause/resume segments, so each new
            // tracker must publish the transform for its current bounds while
            // preserving the stable source dimensions used by prior events.
            let topology = probe_cursor_topology(bounds.x, bounds.y);
            let dpi_scale = topology
                .as_ref()
                .map_or_else(CursorDpiScale::default, |topology| CursorDpiScale {
                    x: topology.dpi_x / 96.0,
                    y: topology.dpi_y / 96.0,
                });
            metadata.source_width = source_width;
            metadata.source_height = source_height;
            metadata.capture_bounds = bounds;
            metadata.coordinate_transform = CursorCoordinateTransform::from_bounds(
                &bounds,
                source_width,
                source_height,
                &dpi_scale,
            );
            if topology.is_some() {
                metadata.topology = topology;
            } else if metadata.topology.is_none() {
                metadata.health = CursorTelemetryHealth::TopologyUnavailable;
            }

            // Health handshake: verify we can read the cursor state.
            let health = check_cursor_capture_health();
            if health == CursorTelemetryHealth::PositionUnavailable {
                metadata.health = health;
                if let Err(error) = write_v2_telemetry(
                    &work_dir,
                    &CursorTelemetryFileV2 {
                        metadata,
                        events: vec![],
                    },
                ) {
                    error!(error = %error, "failed to write degraded cursor metadata");
                }
                warn!("cursor position unavailable; telemetry disabled");
                return;
            }
            if metadata.health == CursorTelemetryHealth::Healthy
                && health != CursorTelemetryHealth::Healthy
            {
                metadata.health = health;
            }

            if mode == CursorCaptureMode::Disabled {
                metadata.health = CursorTelemetryHealth::PositionUnavailable;
                let _ = write_v2_telemetry(
                    &work_dir,
                    &CursorTelemetryFileV2 {
                        metadata,
                        events: vec![],
                    },
                );
                return;
            }

            let mut last_checkpoint = Instant::now();
            // Schedule against a monotonic deadline instead of sleeping for a
            // fixed interval after each sample. This prevents capture work and
            // disk checkpoints from slowly lowering the effective polling rate.
            let mut next_sample_at = Instant::now();
            let mut shape_registry: std::collections::HashMap<String, CursorShapeInfo> = metadata
                .shapes
                .iter()
                .map(|shape| (shape.shape_id.clone(), shape.clone()))
                .collect();

            info!(mode = ?mode, "cursor telemetry v2 tracking started");

            while !stop_signal_clone.load(Ordering::Relaxed) {
                let now = Instant::now();
                if now < next_sample_at {
                    thread::sleep(next_sample_at.duration_since(now));
                    continue;
                }

                let t_ms = elapsed_ms(timeline_origin, time_offset_ms);
                let (raw_x, raw_y, visible) = capture_cursor_position();

                let (shape_id, shape_changed) = if mode == CursorCaptureMode::NoShapes {
                    ("default".into(), false)
                } else {
                    match capture_cursor_shape(&mut shape_registry, &metadata.shapes) {
                        Some(shape) => {
                            let changed = shape.shape_id != previous_shape_id;
                            if changed {
                                if !shape_registry.contains_key(&shape.shape_id) {
                                    shape_registry.insert(shape.shape_id.clone(), shape.clone());
                                    metadata.shapes.push(shape.clone());
                                }
                                previous_shape_id = shape.shape_id.clone();
                            }
                            (shape.shape_id, changed)
                        }
                        None => {
                            if metadata.health == CursorTelemetryHealth::Healthy {
                                metadata.health = CursorTelemetryHealth::ShapesUnavailable;
                            }
                            ("default".into(), false)
                        }
                    }
                };

                let buttons = capture_button_state();
                let button_event = derive_button_event(&previous_buttons, &buttons);
                previous_buttons = buttons;

                let (source_x, source_y) = metadata.coordinate_transform.apply(raw_x, raw_y);

                events.push(CursorTelemetryEventV2 {
                    t_ms,
                    raw_x,
                    raw_y,
                    source_x,
                    source_y,
                    buttons,
                    button_event,
                    visible,
                    shape_id,
                    shape_changed,
                });

                if last_checkpoint.elapsed() >= Duration::from_secs(1) {
                    let telemetry = CursorTelemetryFileV2 {
                        metadata: metadata.clone(),
                        events: events.clone(),
                    };
                    if let Err(error) = write_v2_telemetry(&work_dir, &telemetry) {
                        error!(error = %error, "failed to checkpoint cursor telemetry");
                    }
                    last_checkpoint = Instant::now();
                }

                next_sample_at = next_sample_at
                    .checked_add(SAMPLE_INTERVAL)
                    .unwrap_or_else(Instant::now);
                let after_sample = Instant::now();
                if next_sample_at <= after_sample {
                    next_sample_at = after_sample + SAMPLE_INTERVAL;
                }
            }

            let telemetry = CursorTelemetryFileV2 {
                metadata: metadata.clone(),
                events,
            };
            if let Err(error) = write_v2_telemetry(&work_dir, &telemetry) {
                error!(error = %error, "failed to publish cursor telemetry");
            } else {
                info!(
                    event_count = telemetry.events.len(),
                    "saved cursor telemetry v2"
                );
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

impl Drop for CursorTrackerV2 {
    fn drop(&mut self) {
        self.stop();
    }
}

fn elapsed_ms(origin: Instant, time_offset_ms: u64) -> u64 {
    let now = Instant::now();
    let elapsed = if now >= origin {
        now.duration_since(origin).as_millis() as u64
    } else {
        // origin is in the future (should not happen for a started capture)
        0
    };
    time_offset_ms.saturating_add(elapsed)
}

/// Health check performed before recording starts.
pub fn check_cursor_capture_health() -> CursorTelemetryHealth {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = windows::Win32::Foundation::POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) }.is_err() {
            return CursorTelemetryHealth::PositionUnavailable;
        }
        CursorTelemetryHealth::Healthy
    }
    #[cfg(not(target_os = "windows"))]
    {
        CursorTelemetryHealth::Healthy
    }
}

// ---------------------------------------------------------------------------
// OS-specific capture helpers
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn capture_cursor_position() -> (i32, i32, bool) {
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, CURSORINFO};

    let mut info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };

    let visible = unsafe { GetCursorInfo(&mut info) }.is_ok() && info.flags.0 != 0;

    // Cursor position from CURSORINFO is in screen (physical) pixels.
    let x = info.ptScreenPos.x;
    let y = info.ptScreenPos.y;

    (x, y, visible)
}

#[cfg(target_os = "macos")]
fn capture_cursor_position() -> (i32, i32, bool) {
    // In native macOS, CGEventSource / NSEvent mouseLocation returns screen points.
    // CoreGraphics displays are measured from top-left.
    (0, 0, true)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture_cursor_position() -> (i32, i32, bool) {
    if let Some(snapshot) = get_pipewire_cursor_metadata() {
        if snapshot.active {
            return (snapshot.x, snapshot.y, true);
        }
    }
    (0, 0, true)
}

// ---------------------------------------------------------------------------
// PipeWire stream buffer metadata support (Wayland desktop sharing)
// ---------------------------------------------------------------------------

/// Layout of `struct spa_meta_cursor` from PipeWire's `spa/buffer/meta.h`.
#[repr(C)]
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct SpaMetaCursor {
    pub id: i32,
    pub flags: u32,
    pub x: i32,
    pub y: i32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub width: u32,
    pub height: u32,
    pub offset: u32,
}

/// Shared snapshot of cursor state delivered by a PipeWire screen capture stream.
#[derive(Clone, Debug, PartialEq)]
pub struct PipeWireCursorSnapshot {
    pub active: bool,
    pub x: i32,
    pub y: i32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub width: u32,
    pub height: u32,
    pub shape_name: Option<String>,
    pub bitmap_hash: u64,
    pub cursor_mode: Option<crate::capture::linux_portal::PortalCursorMode>,
    pub updated_at_ms: u64,
}

static PIPEWIRE_CURSOR: RwLock<Option<PipeWireCursorSnapshot>> = RwLock::new(None);

/// Update cursor metadata from an active PipeWire stream frame buffer.
pub fn update_pipewire_cursor_metadata(snapshot: PipeWireCursorSnapshot) {
    if let Ok(mut lock) = PIPEWIRE_CURSOR.write() {
        *lock = Some(snapshot);
    }
}

/// Retrieve the latest cursor snapshot emitted by the PipeWire stream, if any.
pub fn get_pipewire_cursor_metadata() -> Option<PipeWireCursorSnapshot> {
    if let Ok(lock) = PIPEWIRE_CURSOR.read() {
        lock.clone()
    } else {
        None
    }
}

/// Reset PipeWire cursor state (e.g. when recording stops or restarts).
pub fn clear_pipewire_cursor_metadata() {
    if let Ok(mut lock) = PIPEWIRE_CURSOR.write() {
        *lock = None;
    }
}

/// Parse a raw buffer containing PipeWire `SPA_META_Cursor` metadata.
pub fn parse_pipewire_spa_meta_cursor(raw: &[u8]) -> Option<PipeWireCursorSnapshot> {
    if raw.len() < std::mem::size_of::<SpaMetaCursor>() {
        return None;
    }

    let mut meta = SpaMetaCursor::default();
    // SAFETY: raw buffer has at least size_of::<SpaMetaCursor>() bytes
    unsafe {
        std::ptr::copy_nonoverlapping(
            raw.as_ptr(),
            &mut meta as *mut SpaMetaCursor as *mut u8,
            std::mem::size_of::<SpaMetaCursor>(),
        );
    }

    let mut bitmap_hash = 0u64;
    let offset = meta.offset as usize;
    let pixel_bytes = (meta.width as usize)
        .saturating_mul(meta.height as usize)
        .saturating_mul(4);

    if offset > 0 && offset.saturating_add(pixel_bytes) <= raw.len() && pixel_bytes > 0 {
        let pixels = &raw[offset..offset + pixel_bytes];
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        pixels.hash(&mut hasher);
        bitmap_hash = hasher.finish();
    }

    Some(PipeWireCursorSnapshot {
        active: true,
        x: meta.x,
        y: meta.y,
        hotspot_x: meta.hotspot_x,
        hotspot_y: meta.hotspot_y,
        width: meta.width,
        height: meta.height,
        shape_name: None,
        bitmap_hash,
        cursor_mode: Some(crate::capture::linux_portal::PortalCursorMode::Metadata),
        updated_at_ms: 0,
    })
}

#[cfg(target_os = "windows")]
fn capture_button_state() -> CursorButtonState {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_XBUTTON1, VK_XBUTTON2,
    };

    let is_down = |vk: i32| -> bool { unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 } };

    CursorButtonState {
        left: is_down(VK_LBUTTON.0 as i32),
        right: is_down(VK_RBUTTON.0 as i32),
        middle: is_down(VK_MBUTTON.0 as i32),
        x1: is_down(VK_XBUTTON1.0 as i32),
        x2: is_down(VK_XBUTTON2.0 as i32),
    }
}

#[cfg(target_os = "macos")]
fn capture_button_state() -> CursorButtonState {
    // On macOS, CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonLeft/Right/Center)
    CursorButtonState::default()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture_button_state() -> CursorButtonState {
    CursorButtonState::default()
}

/// Capture the current cursor shape and hotspot.
///
/// On Windows this uses `GetCursorInfo` plus `GetIconInfo`. The shape ID is a
/// deterministic string built from the icon dimensions and hotspot. A full
/// bitmap hash is deferred to later phases; this is enough to detect shape
/// transitions and provide the correct hotspot in the evaluator.
#[cfg(target_os = "windows")]
fn capture_cursor_shape(
    _registry: &mut std::collections::HashMap<String, CursorShapeInfo>,
    _known: &[CursorShapeInfo],
) -> Option<CursorShapeInfo> {
    use windows::Win32::Graphics::Gdi::{GetObjectW, BITMAP};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, GetIconInfo, CURSORINFO, ICONINFO,
    };

    let mut info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetCursorInfo(&mut info) }.ok()?;

    let hcursor = info.hCursor;
    let mut icon_info = ICONINFO::default();
    // SAFETY: `GetIconInfo` fills the provided struct and returns a bool.
    unsafe { GetIconInfo(hcursor.into(), &mut icon_info) }.ok()?;

    // Query the mask bitmap to get the real cursor dimensions. For monochrome
    // cursors the mask height is doubled (AND mask on top, XOR mask below).
    let mut bitmap = BITMAP::default();
    let (width, height) = if !icon_info.hbmMask.is_invalid() {
        // SAFETY: hbmMask is a valid bitmap handle returned by GetIconInfo.
        let written = unsafe {
            GetObjectW(
                icon_info.hbmMask.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bitmap as *mut _ as *mut _),
            )
        };
        if written > 0 {
            let actual_height = if icon_info.hbmColor.is_invalid() {
                // Monochrome cursor: mask contains two stacked bitmaps.
                bitmap.bmHeight / 2
            } else {
                bitmap.bmHeight
            };
            (bitmap.bmWidth as u32, actual_height as u32)
        } else {
            (32, 32)
        }
    } else {
        (32, 32)
    };

    // Clean up the bitmap handles returned by GetIconInfo to avoid GDI leaks.
    // SAFETY: the handles were returned by GetIconInfo and must be deleted.
    unsafe {
        if !icon_info.hbmMask.is_invalid() {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(icon_info.hbmMask.into());
        }
        if !icon_info.hbmColor.is_invalid() {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(icon_info.hbmColor.into());
        }
    }

    let hotspot_x = icon_info.xHotspot as i32;
    let hotspot_y = icon_info.yHotspot as i32;

    // Try to identify the system cursor by its cached handle first; fall back
    // to geometry-based heuristics for custom cursors.
    let kind = classify_cursor_kind(hcursor, width, height, hotspot_x, hotspot_y);

    // Use the real dimensions and hotspot for the shape ID so distinct cursor
    // silhouettes are tracked separately. Cast the handle to a usize for a
    // stable in-process identifier.
    let shape_id = format!(
        "{}x{}-{}-{}-{}",
        width, height, hotspot_x, hotspot_y, hcursor.0 as usize
    );

    Some(CursorShapeInfo {
        shape_id,
        hotspot_x,
        hotspot_y,
        width,
        height,
        kind,
    })
}

#[cfg(target_os = "macos")]
fn capture_cursor_shape(
    _registry: &mut std::collections::HashMap<String, CursorShapeInfo>,
    _known: &[CursorShapeInfo],
) -> Option<CursorShapeInfo> {
    macos_capture_cursor_shape()
}

#[cfg(target_os = "macos")]
fn macos_capture_cursor_shape() -> Option<CursorShapeInfo> {
    use std::ffi::{c_char, c_void, CStr};
    use std::sync::OnceLock;

    #[repr(C)]
    #[derive(Copy, Clone, Debug)]
    struct NSPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Copy, Clone, Debug)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    type FnMsgSendPoint = unsafe extern "C" fn(*mut c_void, *mut c_void) -> NSPoint;
    type FnMsgSendSize = unsafe extern "C" fn(*mut c_void, *mut c_void) -> NSSize;

    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend(receiver: *mut c_void, op: *mut c_void, ...) -> *mut c_void;
    }

    unsafe {
        let nscursor_cls = objc_getClass(c"NSCursor".as_ptr());
        if nscursor_cls.is_null() {
            return None;
        }

        let sel_current_system = sel_registerName(c"currentSystemCursor".as_ptr());
        let sel_current = sel_registerName(c"currentCursor".as_ptr());
        let mut cursor = objc_msgSend(nscursor_cls, sel_current_system);
        if cursor.is_null() {
            cursor = objc_msgSend(nscursor_cls, sel_current);
        }
        if cursor.is_null() {
            return None;
        }

        // Cache selectors and singleton cursor pointers
        struct MacosCursorPointers {
            arrow: usize,
            ibeam: usize,
            pointing_hand: usize,
            closed_hand: usize,
            open_hand: usize,
            crosshair: usize,
            resize_left_right: usize,
            resize_up_down: usize,
            operation_not_allowed: usize,
            disappearing_item: usize,
        }

        static POINTERS: OnceLock<MacosCursorPointers> = OnceLock::new();
        let pointers = POINTERS.get_or_init(|| {
            let get_ptr = |sel_name: &CStr| -> usize {
                let sel = sel_registerName(sel_name.as_ptr());
                objc_msgSend(nscursor_cls, sel) as usize
            };
            MacosCursorPointers {
                arrow: get_ptr(c"arrowCursor"),
                ibeam: get_ptr(c"IBeamCursor"),
                pointing_hand: get_ptr(c"pointingHandCursor"),
                closed_hand: get_ptr(c"closedHandCursor"),
                open_hand: get_ptr(c"openHandCursor"),
                crosshair: get_ptr(c"crosshairCursor"),
                resize_left_right: get_ptr(c"resizeLeftRightCursor"),
                resize_up_down: get_ptr(c"resizeUpDownCursor"),
                operation_not_allowed: get_ptr(c"operationNotAllowedCursor"),
                disappearing_item: get_ptr(c"disappearingItemCursor"),
            }
        });

        let cursor_addr = cursor as usize;
        let kind = if cursor_addr == pointers.arrow {
            "arrow"
        } else if cursor_addr == pointers.ibeam {
            "ibeam"
        } else if cursor_addr == pointers.pointing_hand {
            "hand"
        } else if cursor_addr == pointers.closed_hand {
            "grabbing"
        } else if cursor_addr == pointers.open_hand {
            "grab"
        } else if cursor_addr == pointers.crosshair {
            "crosshair"
        } else if cursor_addr == pointers.resize_left_right {
            "resize-horizontal"
        } else if cursor_addr == pointers.resize_up_down {
            "resize-vertical"
        } else if cursor_addr == pointers.operation_not_allowed
            || cursor_addr == pointers.disappearing_item
        {
            "unavailable"
        } else {
            // Check hotSpot and image size for custom cursors
            let sel_hotspot = sel_registerName(c"hotSpot".as_ptr());
            let sel_image = sel_registerName(c"image".as_ptr());
            let sel_size = sel_registerName(c"size".as_ptr());

            let msg_send_point: FnMsgSendPoint =
                std::mem::transmute::<*const (), FnMsgSendPoint>(objc_msgSend as *const ());
            let hotspot = msg_send_point(cursor, sel_hotspot);

            let image = objc_msgSend(cursor, sel_image);
            let size = if !image.is_null() {
                let msg_send_size: FnMsgSendSize =
                    std::mem::transmute::<*const (), FnMsgSendSize>(objc_msgSend as *const ());
                msg_send_size(image, sel_size)
            } else {
                NSSize {
                    width: 32.0,
                    height: 32.0,
                }
            };

            let w = size.width.max(1.0) as u32;
            let h = size.height.max(1.0) as u32;
            let hx = hotspot.x as i32;
            let hy = hotspot.y as i32;
            let classified = classify_cursor_kind_by_geometry(w, h, hx, hy);
            return Some(CursorShapeInfo {
                shape_id: format!("macos-{w}x{h}-{hx}-{hy}-{cursor_addr}"),
                hotspot_x: hx,
                hotspot_y: hy,
                width: w,
                height: h,
                kind: classified,
            });
        };

        let sel_hotspot = sel_registerName(c"hotSpot".as_ptr());
        let msg_send_point: FnMsgSendPoint =
            std::mem::transmute::<*const (), FnMsgSendPoint>(objc_msgSend as *const ());
        let hotspot = msg_send_point(cursor, sel_hotspot);

        Some(CursorShapeInfo {
            shape_id: format!("macos-{kind}-{cursor_addr}"),
            hotspot_x: hotspot.x as i32,
            hotspot_y: hotspot.y as i32,
            width: 32,
            height: 32,
            kind: kind.into(),
        })
    }
}

#[cfg(target_os = "linux")]
fn capture_cursor_shape(
    _registry: &mut std::collections::HashMap<String, CursorShapeInfo>,
    _known: &[CursorShapeInfo],
) -> Option<CursorShapeInfo> {
    linux_capture_cursor_shape()
}

#[cfg(target_os = "linux")]
fn linux_capture_cursor_shape() -> Option<CursorShapeInfo> {
    // 1. Check active PipeWire stream metadata first (Wayland portal desktop sharing)
    if let Some(snapshot) = get_pipewire_cursor_metadata() {
        if snapshot.active
            && (snapshot.width > 0 || snapshot.hotspot_x > 0 || snapshot.hotspot_y > 0)
        {
            let width = snapshot.width.max(1);
            let height = snapshot.height.max(1);
            let hx = snapshot.hotspot_x;
            let hy = snapshot.hotspot_y;

            let kind = if let Some(ref name) = snapshot.shape_name {
                match name.to_ascii_lowercase().as_str() {
                    "arrow" | "default" | "left_ptr" | "top_left_arrow" => "arrow".into(),
                    "pointer" | "hand" | "hand2" | "pointing_hand" => "hand".into(),
                    "text" | "ibeam" | "xterm" => "ibeam".into(),
                    "crosshair" | "cross" => "crosshair".into(),
                    "wait" | "watch" => "wait".into(),
                    "progress" | "left_ptr_watch" => "progress".into(),
                    "help" | "question_arrow" => "help".into(),
                    "move" | "all-scroll" | "fleur" => "move".into(),
                    "col-resize" | "ew-resize" | "size_hor" | "h_double_arrow" => {
                        "resize-horizontal".into()
                    }
                    "row-resize" | "ns-resize" | "size_ver" | "v_double_arrow" => {
                        "resize-vertical".into()
                    }
                    "nwse-resize" | "size_fdiag" => "resize-diagonal-1".into(),
                    "nesw-resize" | "size_bdiag" => "resize-diagonal-2".into(),
                    "not-allowed" | "circle" | "crossed_circle" => "unavailable".into(),
                    "grab" | "openhand" => "grab".into(),
                    "grabbing" | "closedhand" => "grabbing".into(),
                    "zoom-in" => "zoom-in".into(),
                    "zoom-out" => "zoom-out".into(),
                    "copy" => "copy".into(),
                    "cell" => "cell".into(),
                    _ => classify_cursor_kind_by_geometry(width, height, hx, hy),
                }
            } else {
                classify_cursor_kind_by_geometry(width, height, hx, hy)
            };

            let shape_id = if snapshot.bitmap_hash != 0 {
                format!(
                    "pipewire-{width}x{height}-{hx}-{hy}-{:x}",
                    snapshot.bitmap_hash
                )
            } else {
                format!("pipewire-{kind}-{width}x{height}-{hx}-{hy}")
            };

            return Some(CursorShapeInfo {
                shape_id,
                hotspot_x: hx,
                hotspot_y: hy,
                width,
                height,
                kind,
            });
        }
    }

    // 2. Fall back to X11 XFixes query
    linux_capture_x11_cursor_shape()
}

#[cfg(target_os = "linux")]
fn linux_capture_x11_cursor_shape() -> Option<CursorShapeInfo> {
    use std::ffi::{c_char, c_int, c_ulong, c_void, CStr};
    use std::sync::OnceLock;

    #[repr(C)]
    struct XFixesCursorImage {
        x: i16,
        y: i16,
        width: u16,
        height: u16,
        xhot: u16,
        yhot: u16,
        cursor_serial: c_ulong,
        pixels: *mut c_ulong,
        atom: c_ulong,
        name: *const c_char,
    }

    type FnXOpenDisplay = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    type FnXCloseDisplay = unsafe extern "C" fn(*mut c_void) -> c_int;
    type FnXFree = unsafe extern "C" fn(*mut c_void) -> c_int;
    type FnXFixesGetCursorImage = unsafe extern "C" fn(*mut c_void) -> *mut XFixesCursorImage;

    struct X11Functions {
        open_display: FnXOpenDisplay,
        close_display: FnXCloseDisplay,
        free: FnXFree,
        get_cursor_image: FnXFixesGetCursorImage,
    }

    static X11: OnceLock<Option<X11Functions>> = OnceLock::new();
    let fns = X11.get_or_init(|| unsafe {
        extern "C" {
            fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
            fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        }
        const RTLD_LAZY: c_int = 1;

        let lib_x11 = dlopen(c"libX11.so.6".as_ptr(), RTLD_LAZY);
        let lib_x11 = if lib_x11.is_null() {
            dlopen(c"libX11.so".as_ptr(), RTLD_LAZY)
        } else {
            lib_x11
        };
        if lib_x11.is_null() {
            return None;
        }

        let lib_xfixes = dlopen(c"libXfixes.so.3".as_ptr(), RTLD_LAZY);
        let lib_xfixes = if lib_xfixes.is_null() {
            dlopen(c"libXfixes.so".as_ptr(), RTLD_LAZY)
        } else {
            lib_xfixes
        };
        if lib_xfixes.is_null() {
            return None;
        }

        let sym_open = dlsym(lib_x11, c"XOpenDisplay".as_ptr());
        let sym_close = dlsym(lib_x11, c"XCloseDisplay".as_ptr());
        let sym_free = dlsym(lib_x11, c"XFree".as_ptr());
        let sym_get_cursor = dlsym(lib_xfixes, c"XFixesGetCursorImage".as_ptr());

        if sym_open.is_null()
            || sym_close.is_null()
            || sym_free.is_null()
            || sym_get_cursor.is_null()
        {
            return None;
        }

        Some(X11Functions {
            open_display: std::mem::transmute::<*mut c_void, FnXOpenDisplay>(sym_open),
            close_display: std::mem::transmute::<*mut c_void, FnXCloseDisplay>(sym_close),
            free: std::mem::transmute::<*mut c_void, FnXFree>(sym_free),
            get_cursor_image: std::mem::transmute::<*mut c_void, FnXFixesGetCursorImage>(
                sym_get_cursor,
            ),
        })
    });

    let fns = fns.as_ref()?;

    unsafe {
        let display = (fns.open_display)(std::ptr::null());
        if display.is_null() {
            return None;
        }

        let img_ptr = (fns.get_cursor_image)(display);
        if img_ptr.is_null() {
            (fns.close_display)(display);
            return None;
        }

        let img = &*img_ptr;
        let width = img.width as u32;
        let height = img.height as u32;
        let hotspot_x = img.xhot as i32;
        let hotspot_y = img.yhot as i32;
        let serial = img.cursor_serial;

        let kind = if !img.name.is_null() {
            let name_str = CStr::from_ptr(img.name)
                .to_string_lossy()
                .to_ascii_lowercase();
            match name_str.as_str() {
                "arrow" | "default" | "left_ptr" | "top_left_arrow" => "arrow".into(),
                "pointer" | "hand" | "hand2" | "pointing_hand" => "hand".into(),
                "text" | "ibeam" | "xterm" => "ibeam".into(),
                "crosshair" | "cross" => "crosshair".into(),
                "wait" | "watch" => "wait".into(),
                "progress" | "left_ptr_watch" => "progress".into(),
                "help" | "question_arrow" => "help".into(),
                "move" | "all-scroll" | "fleur" => "move".into(),
                "col-resize" | "ew-resize" | "size_hor" | "h_double_arrow" => {
                    "resize-horizontal".into()
                }
                "row-resize" | "ns-resize" | "size_ver" | "v_double_arrow" => {
                    "resize-vertical".into()
                }
                "nwse-resize" | "size_fdiag" => "resize-diagonal-1".into(),
                "nesw-resize" | "size_bdiag" => "resize-diagonal-2".into(),
                "not-allowed" | "circle" | "crossed_circle" => "unavailable".into(),
                "grab" | "openhand" => "grab".into(),
                "grabbing" | "closedhand" => "grabbing".into(),
                "zoom-in" => "zoom-in".into(),
                "zoom-out" => "zoom-out".into(),
                "copy" => "copy".into(),
                "cell" => "cell".into(),
                _ => classify_cursor_kind_by_geometry(width, height, hotspot_x, hotspot_y),
            }
        } else {
            classify_cursor_kind_by_geometry(width, height, hotspot_x, hotspot_y)
        };

        (fns.free)(img_ptr as *mut c_void);
        (fns.close_display)(display);

        Some(CursorShapeInfo {
            shape_id: format!("linux-{width}x{height}-{hotspot_x}-{hotspot_y}-{serial}"),
            hotspot_x,
            hotspot_y,
            width: width.max(1),
            height: height.max(1),
            kind,
        })
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn capture_cursor_shape(
    _registry: &mut std::collections::HashMap<String, CursorShapeInfo>,
    _known: &[CursorShapeInfo],
) -> Option<CursorShapeInfo> {
    None
}

/// On Windows, compare the current cursor handle against the cached system
/// cursor handles loaded with `LoadCursorW`. This is the most reliable way to
/// identify standard system cursors without parsing bitmaps.
#[cfg(target_os = "windows")]
fn classify_cursor_kind(
    hcursor: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    width: u32,
    height: u32,
    hotspot_x: i32,
    hotspot_y: i32,
) -> String {
    let current = hcursor.0 as usize;
    for (system, kind) in system_cursor_kinds() {
        if current == *system {
            return (*kind).into();
        }
    }
    classify_cursor_kind_by_geometry(width, height, hotspot_x, hotspot_y)
}

#[cfg(target_os = "windows")]
fn system_cursor_kinds() -> &'static [(usize, &'static str)] {
    use std::sync::OnceLock;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadCursorW, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO,
        IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_UPARROW, IDC_WAIT,
    };

    static CURSORS: OnceLock<Vec<(usize, &'static str)>> = OnceLock::new();
    CURSORS.get_or_init(|| {
        let ids: &[(windows::core::PCWSTR, &str)] = &[
            (IDC_ARROW, "arrow"),
            (IDC_HAND, "hand"),
            (IDC_IBEAM, "ibeam"),
            (IDC_CROSS, "crosshair"),
            (IDC_WAIT, "wait"),
            (IDC_APPSTARTING, "progress"),
            (IDC_HELP, "help"),
            (IDC_SIZEALL, "move"),
            (IDC_SIZENWSE, "resize-diagonal-1"),
            (IDC_SIZENESW, "resize-diagonal-2"),
            (IDC_SIZEWE, "resize-horizontal"),
            (IDC_SIZENS, "resize-vertical"),
            (IDC_UPARROW, "arrow"),
            (IDC_NO, "unavailable"),
        ];
        ids.iter()
            .filter_map(|(id, kind)| {
                // SAFETY: loading a system cursor by ID is a safe Win32 call.
                unsafe { LoadCursorW(None, *id) }
                    .ok()
                    .map(|handle| (handle.0 as usize, *kind))
            })
            .collect()
    })
}

/// Geometry-based fallback for cursors that are not standard system cursors.
fn classify_cursor_kind_by_geometry(
    width: u32,
    height: u32,
    hotspot_x: i32,
    hotspot_y: i32,
) -> String {
    if width == 0 || height == 0 {
        return "arrow".into();
    }
    let center_x = width as f64 / 2.0;
    let center_y = height as f64 / 2.0;
    let distance_from_center =
        ((hotspot_x as f64 - center_x).abs()).max((hotspot_y as f64 - center_y).abs());
    let aspect = width as f64 / height as f64;
    let size = width.max(height) as i32;

    // Narrow tall cursor: I-beam text selector (typically 6-12px wide, aspect <= 0.45)
    if aspect <= 0.45 {
        return "ibeam".into();
    }
    // Very wide cursor: horizontal resize
    if aspect > 2.2 {
        return "resize-horizontal".into();
    }
    // Moderately tall cursor with centered hotspot: vertical resize with arrowheads (aspect 0.45..0.85)
    if aspect <= 0.85 && distance_from_center < 4.0 {
        return "resize-vertical".into();
    }

    // Centered hotspot
    if distance_from_center < 4.0 {
        if size >= 26 {
            return "crosshair".into();
        }
        return "wait".into();
    }

    // Hotspot in the upper-left quadrant usually indicates an arrow or hand.
    let in_upper_left = hotspot_x < (width as i32 / 2) && hotspot_y < (height as i32 / 2);
    if in_upper_left {
        let is_squareish = (width as i32 - height as i32).abs() <= 6;
        // Pointing hands have the index fingertip offset inward (typically x: 20%-45% of width)
        let is_hand_hotspot = hotspot_x >= (width as i32 / 6).max(3);
        if is_squareish && size >= 20 && is_hand_hotspot {
            return "hand".into();
        }
        return "arrow".into();
    }

    // Diagonal resize checks
    if hotspot_x < 5 && hotspot_y < 5 && (width as i32 - height as i32).abs() <= 4 {
        return "resize-diagonal-1".into();
    }
    if hotspot_x >= (width as i32 - 5) && hotspot_y < 5 && (width as i32 - height as i32).abs() <= 4
    {
        return "resize-diagonal-2".into();
    }

    "arrow".into()
}

/// Probe the display topology at the given virtual-desktop point.
#[cfg(target_os = "windows")]
pub fn probe_cursor_topology(x: i32, y: i32) -> Option<CursorTopology> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MONITOR_DPI_TYPE};

    let pt = POINT { x, y };
    // SAFETY: MonitorFromPoint returns an HMONITOR for the given point.
    let hmonitor = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };

    if hmonitor.is_invalid() {
        return None;
    }

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(hmonitor, &mut info) }.as_bool() {
        return None;
    }

    let mut dpi_x = 96u32;
    let mut dpi_y = 96u32;
    // GetDpiForMonitor returns 0/false on failure; we keep the default 96.
    // SAFETY: `hmonitor` is valid and the out pointers are valid u32s.
    let _ = unsafe { GetDpiForMonitor(hmonitor, MONITOR_DPI_TYPE(0), &mut dpi_x, &mut dpi_y) };

    let scale_factor = (dpi_x as f64 / 96.0).clamp(0.5, 4.0);

    Some(CursorTopology {
        display_id: format!("monitor-{:?}", hmonitor.0),
        display_bounds: CursorCaptureBounds {
            x: info.rcMonitor.left,
            y: info.rcMonitor.top,
            width: (info.rcMonitor.right - info.rcMonitor.left).max(1) as u32,
            height: (info.rcMonitor.bottom - info.rcMonitor.top).max(1) as u32,
        },
        is_primary: (info.dwFlags & 1) != 0,
        orientation: 0, // Windows does not expose rotation through this API without DXGI
        scale_factor,
        dpi_x: dpi_x as f64,
        dpi_y: dpi_y as f64,
    })
}

#[cfg(not(target_os = "windows"))]
pub fn probe_cursor_topology(_x: i32, _y: i32) -> Option<CursorTopology> {
    Some(CursorTopology {
        display_id: "default-display".into(),
        display_bounds: CursorCaptureBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        },
        is_primary: true,
        orientation: 0,
        scale_factor: 1.0,
        dpi_x: 96.0,
        dpi_y: 96.0,
    })
}

/// Enumerate all connected display topologies. Useful for multi-monitor context
/// and for validating that the capture bounds fit inside a known display.
pub fn enumerate_topologies() -> Vec<CursorTopology> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{LPARAM, RECT};
        use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};

        let mut topologies: Vec<CursorTopology> = Vec::new();

        unsafe extern "system" fn callback(
            hmonitor: HMONITOR,
            _hdc: HDC,
            _rect: *mut RECT,
            lparam: LPARAM,
        ) -> windows::core::BOOL {
            let topologies = &mut *(lparam.0 as *mut Vec<CursorTopology>);
            if let Some(topology) = probe_cursor_topology_from_hmonitor(hmonitor) {
                topologies.push(topology);
            }
            windows::core::BOOL(1)
        }

        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(callback),
                LPARAM(&mut topologies as *mut _ as isize),
            );
        }

        topologies
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![CursorTopology {
            display_id: "default-display".into(),
            display_bounds: CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            is_primary: true,
            orientation: 0,
            scale_factor: 1.0,
            dpi_x: 96.0,
            dpi_y: 96.0,
        }]
    }
}

#[cfg(target_os = "windows")]
unsafe fn probe_cursor_topology_from_hmonitor(
    hmonitor: windows::Win32::Graphics::Gdi::HMONITOR,
) -> Option<CursorTopology> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MONITOR_DPI_TYPE};

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(hmonitor, &mut info).as_bool() {
        return None;
    }

    let mut dpi_x = 96u32;
    let mut dpi_y = 96u32;
    let _ = GetDpiForMonitor(hmonitor, MONITOR_DPI_TYPE(0), &mut dpi_x, &mut dpi_y);
    let scale_factor = (dpi_x as f64 / 96.0).clamp(0.5, 4.0);

    Some(CursorTopology {
        display_id: format!("monitor-{:?}", hmonitor.0),
        display_bounds: CursorCaptureBounds {
            x: info.rcMonitor.left,
            y: info.rcMonitor.top,
            width: (info.rcMonitor.right - info.rcMonitor.left).max(1) as u32,
            height: (info.rcMonitor.bottom - info.rcMonitor.top).max(1) as u32,
        },
        is_primary: (info.dwFlags & 1) != 0,
        orientation: 0,
        scale_factor,
        dpi_x: dpi_x as f64,
        dpi_y: dpi_y as f64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinate_transform_from_bounds() {
        let bounds = CursorCaptureBounds {
            x: 100,
            y: 50,
            width: 1920,
            height: 1080,
        };
        let dpi = CursorDpiScale { x: 1.5, y: 1.5 };
        let transform = CursorCoordinateTransform::from_bounds(&bounds, 1920, 1080, &dpi);
        assert!((transform.a00 - 1.5).abs() < f64::EPSILON);
        assert!((transform.b0 - (-150.0)).abs() < 0.001);
        assert_eq!(transform.apply(100, 50), (0.0, 0.0));
    }

    #[test]
    fn coordinate_transform_maps_capture_bounds_to_encoded_dimensions() {
        let bounds = CursorCaptureBounds {
            x: -100,
            y: 50,
            width: 3840,
            height: 2160,
        };
        let transform =
            CursorCoordinateTransform::from_bounds(&bounds, 1920, 1080, &CursorDpiScale::default());

        assert_eq!(transform.apply(-100, 50), (0.0, 0.0));
        assert!((transform.apply(3_740, 2_210).0 - 1_920.0).abs() < 0.001);
        assert!((transform.apply(3_740, 2_210).1 - 1_080.0).abs() < 0.001);
    }

    #[test]
    fn button_event_derivation() {
        let mut previous = CursorButtonState::default();
        let current = CursorButtonState {
            left: true,
            ..Default::default()
        };
        assert_eq!(derive_button_event(&previous, &current), "left-down");

        previous = current;
        let current = CursorButtonState {
            left: true,
            ..Default::default()
        };
        assert_eq!(derive_button_event(&previous, &current), "left-held");

        previous = current;
        let current = CursorButtonState::default();
        assert_eq!(derive_button_event(&previous, &current), "left-up");
    }

    #[test]
    fn v1_to_v2_migration_preserves_coordinates() {
        let v1 = CursorTelemetryFileV1 {
            schema_version: 1,
            asset_id: "cursor-events:rec".into(),
            recording_id: "rec".into(),
            source_width: 1920,
            source_height: 1080,
            capture_bounds: Some(CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }),
            dpi_scale: Some(CursorDpiScale { x: 1.0, y: 1.0 }),
            timebase: None,
            sample_rate_hz: 60,
            events: vec![
                CursorTelemetryEventV1 {
                    t_ms: 0,
                    x: 100.0,
                    y: 200.0,
                    clicked: false,
                    button: "none".into(),
                    button_event: "none".into(),
                    visible: true,
                },
                CursorTelemetryEventV1 {
                    t_ms: 16,
                    x: 120.0,
                    y: 220.0,
                    clicked: true,
                    button: "left".into(),
                    button_event: "down".into(),
                    visible: true,
                },
            ],
        };

        let v2 = migrate_v1_to_v2(v1);
        assert_eq!(v2.metadata.schema_version, V2_SCHEMA_VERSION);
        assert_eq!(v2.events.len(), 2);
        assert_eq!(v2.events[0].raw_x, 100);
        assert_eq!(v2.events[0].source_x, 100.0);
        assert_eq!(v2.events[1].button_event, "left-down");
        assert!(v2.events[1].buttons.left);
    }

    #[test]
    fn binary_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut metadata = CursorTelemetryMetadata::new(
            "rec".into(),
            1920,
            1080,
            CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        );
        metadata.shapes.push(CursorShapeInfo {
            shape_id: "arrow".into(),
            hotspot_x: 0,
            hotspot_y: 0,
            width: 32,
            height: 32,
            kind: "arrow".into(),
        });

        let events = vec![
            CursorTelemetryEventV2 {
                t_ms: 0,
                raw_x: 100,
                raw_y: 200,
                source_x: 100.0,
                source_y: 200.0,
                buttons: CursorButtonState::default(),
                button_event: "none".into(),
                visible: true,
                shape_id: "arrow".into(),
                shape_changed: false,
            },
            CursorTelemetryEventV2 {
                t_ms: 16,
                raw_x: 120,
                raw_y: 220,
                source_x: 120.0,
                source_y: 220.0,
                buttons: CursorButtonState {
                    left: true,
                    ..Default::default()
                },
                button_event: "left-down".into(),
                visible: true,
                shape_id: "arrow".into(),
                shape_changed: false,
            },
        ];

        let telemetry = CursorTelemetryFileV2 { metadata, events };
        let written = write_v2_telemetry(dir.path(), &telemetry).expect("write");
        assert_eq!(written.event_count, 2);
        assert!(!written.index.is_empty());

        let read = read_v2_telemetry(dir.path()).expect("read");
        assert_eq!(read.events.len(), 2);
        assert_eq!(read.events[1].button_event, "left-down");
        assert!((read.events[1].source_y - 220.0).abs() < 0.01);
    }

    #[test]
    fn shift_clock_moves_events_and_drops_pre_video_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let metadata = CursorTelemetryMetadata::new(
            "rec".into(),
            1920,
            1080,
            CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        );
        let event = |t_ms: u64| CursorTelemetryEventV2 {
            t_ms,
            raw_x: 100,
            raw_y: 200,
            source_x: 100.0,
            source_y: 200.0,
            buttons: CursorButtonState::default(),
            button_event: "none".into(),
            visible: true,
            shape_id: "arrow".into(),
            shape_changed: false,
        };
        let telemetry = CursorTelemetryFileV2 {
            metadata,
            events: vec![event(100), event(400), event(900)],
        };
        write_v2_telemetry(dir.path(), &telemetry).expect("write");

        shift_telemetry_clock(dir.path(), 400).expect("shift");

        let shifted = read_v2_telemetry(dir.path()).expect("read");
        assert_eq!(
            shifted
                .events
                .iter()
                .map(|event| event.t_ms)
                .collect::<Vec<_>>(),
            vec![0, 500]
        );
        assert_eq!(shifted.metadata.event_count, 2);
        assert!(shifted.metadata.index.iter().all(|entry| entry.t_ms <= 500));

        // A zero shift is a no-op and must not touch the files.
        shift_telemetry_clock(dir.path(), 0).expect("zero shift");
        let reread = read_v2_telemetry(dir.path()).expect("reread");
        assert_eq!(reread.events.len(), 2);
    }

    #[test]
    fn shift_clock_preserves_prior_segments_when_aligning_a_later_segment() {
        let dir = tempfile::tempdir().expect("tempdir");
        let metadata = CursorTelemetryMetadata::new(
            "rec".into(),
            1920,
            1080,
            CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        );
        let event = |t_ms: u64| CursorTelemetryEventV2 {
            t_ms,
            raw_x: 100,
            raw_y: 200,
            source_x: 100.0,
            source_y: 200.0,
            buttons: CursorButtonState::default(),
            button_event: "none".into(),
            visible: true,
            shape_id: "arrow".into(),
            shape_changed: false,
        };
        write_v2_telemetry(
            dir.path(),
            &CursorTelemetryFileV2 {
                metadata,
                events: vec![
                    event(100),
                    event(900),
                    event(1_400),
                    event(1_900),
                    event(2_300),
                ],
            },
        )
        .expect("write");

        align_telemetry_segment(dir.path(), 1_000, 500, 400).expect("align later segment");

        let shifted = read_v2_telemetry(dir.path()).expect("read");
        assert_eq!(
            shifted
                .events
                .iter()
                .map(|event| event.t_ms)
                .collect::<Vec<_>>(),
            vec![100, 900, 1_000, 1_500]
        );
    }

    #[test]
    fn v1_json_read_and_migration() {
        let dir = tempfile::tempdir().expect("tempdir");
        let v1 = CursorTelemetryFileV1 {
            schema_version: 1,
            asset_id: "".into(),
            recording_id: "rec".into(),
            source_width: 100,
            source_height: 80,
            capture_bounds: None,
            dpi_scale: None,
            timebase: None,
            sample_rate_hz: 60,
            events: vec![CursorTelemetryEventV1 {
                t_ms: 0,
                x: 10.0,
                y: 20.0,
                clicked: false,
                button: "none".into(),
                button_event: "none".into(),
                visible: true,
            }],
        };
        std::fs::write(
            dir.path().join("cursor_telemetry.json"),
            serde_json::to_string(&v1).unwrap(),
        )
        .unwrap();

        let v2 = read_any_telemetry(dir.path()).expect("read");
        assert_eq!(v2.metadata.schema_version, V2_SCHEMA_VERSION);
        assert_eq!(v2.events.len(), 1);
        assert_eq!(v2.events[0].raw_x, 10);
    }

    #[test]
    fn geometry_classification() {
        assert_eq!(classify_cursor_kind_by_geometry(10, 32, 5, 16), "ibeam");
        assert_eq!(
            classify_cursor_kind_by_geometry(32, 12, 16, 6),
            "resize-horizontal"
        );
        assert_eq!(
            classify_cursor_kind_by_geometry(20, 32, 10, 16),
            "resize-vertical"
        );
        assert_eq!(
            classify_cursor_kind_by_geometry(32, 32, 16, 16),
            "crosshair"
        );
        assert_eq!(classify_cursor_kind_by_geometry(18, 18, 9, 9), "wait");
        assert_eq!(classify_cursor_kind_by_geometry(32, 32, 10, 2), "hand");
        assert_eq!(classify_cursor_kind_by_geometry(32, 32, 1, 1), "arrow");
        assert_eq!(
            classify_cursor_kind_by_geometry(32, 32, 30, 2),
            "resize-diagonal-2"
        );
    }

    #[test]
    fn pipewire_cursor_metadata() {
        // 1. Buffer too small returns None
        assert_eq!(parse_pipewire_spa_meta_cursor(&[0u8; 10]), None);

        // 2. Build synthetic SPA_META_Cursor buffer
        let mut buffer = vec![0u8; std::mem::size_of::<SpaMetaCursor>() + 64];
        let meta = SpaMetaCursor {
            id: 1,
            flags: 0,
            x: 250,
            y: 400,
            hotspot_x: 3,
            hotspot_y: 3,
            width: 24,
            height: 24,
            offset: 0,
        };
        unsafe {
            std::ptr::copy_nonoverlapping(
                &meta as *const SpaMetaCursor as *const u8,
                buffer.as_mut_ptr(),
                std::mem::size_of::<SpaMetaCursor>(),
            );
        }

        let parsed = parse_pipewire_spa_meta_cursor(&buffer).expect("valid parse");
        assert!(parsed.active);
        assert_eq!(parsed.x, 250);
        assert_eq!(parsed.y, 400);
        assert_eq!(parsed.hotspot_x, 3);
        assert_eq!(parsed.hotspot_y, 3);
        assert_eq!(parsed.width, 24);
        assert_eq!(parsed.height, 24);

        // 3. Test state registry update and retrieval
        clear_pipewire_cursor_metadata();
        assert_eq!(get_pipewire_cursor_metadata(), None);

        update_pipewire_cursor_metadata(parsed);
        let retrieved = get_pipewire_cursor_metadata().expect("retrieved");
        assert_eq!(retrieved.x, 250);
        assert_eq!(retrieved.y, 400);
        assert_eq!(
            retrieved.cursor_mode,
            Some(crate::capture::linux_portal::PortalCursorMode::Metadata)
        );

        // Verify geometry classification works directly with PipeWire stream dimensions
        assert_eq!(
            classify_cursor_kind_by_geometry(
                retrieved.width,
                retrieved.height,
                retrieved.hotspot_x,
                retrieved.hotspot_y
            ),
            "arrow"
        );

        clear_pipewire_cursor_metadata();
        assert_eq!(get_pipewire_cursor_metadata(), None);
    }
}
