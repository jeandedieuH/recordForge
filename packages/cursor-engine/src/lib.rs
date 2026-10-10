//! Canonical cursor evaluation engine.
//!
//! The same core compiles to native code for the Tauri export and to
//! WebAssembly for the React preview so both sides evaluate identical frames.

use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
/// Fixed reference interval for the zero-phase smoothing rate. Measuring the
/// per-sample dt against a constant 60 Hz interval (instead of the telemetry's
/// declared sample rate) makes lambda = 1-(1-a)^(dt/ref) behave identically on
/// 60 Hz and 120 Hz captures.
const SMOOTHING_REFERENCE_INTERVAL_MS: f64 = 1000.0 / 60.0;

/// Raw cursor telemetry event. Supports both V2 (source/raw split, button
/// events, shape hashes) and legacy V1 (x/y, clicked, button) inputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CursorEvent {
    pub t_ms: u64,
    /// V2 physical pixel on the virtual desktop.
    #[serde(default)]
    pub raw_x: Option<f64>,
    #[serde(default)]
    pub raw_y: Option<f64>,
    /// V2 pre-transformed source coordinate (matches the output frame).
    #[serde(default)]
    pub source_x: Option<f64>,
    #[serde(default)]
    pub source_y: Option<f64>,
    /// V1 coordinates for backward-compatible fixtures.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// V2 independent button states.
    #[serde(default)]
    pub buttons: CursorButtonState,
    /// V2 button event such as `left-down` or `none`.
    #[serde(default)]
    pub button_event: Option<String>,
    /// V1 button label.
    #[serde(default)]
    pub button: Option<String>,
    /// V1 synthetic click flag.
    #[serde(default)]
    pub clicked: bool,
    pub visible: bool,
    /// Stable-ish hash derived from the current system cursor icon.
    #[serde(default)]
    pub shape_id: Option<String>,
    /// True when this sample is the first after the system cursor shape changed.
    #[serde(default)]
    pub shape_changed: bool,
}

impl Default for CursorEvent {
    fn default() -> Self {
        Self {
            t_ms: 0,
            raw_x: None,
            raw_y: None,
            source_x: None,
            source_y: None,
            x: 0.0,
            y: 0.0,
            buttons: CursorButtonState::default(),
            button_event: None,
            button: None,
            clicked: false,
            visible: true,
            shape_id: None,
            shape_changed: false,
        }
    }
}

impl CursorEvent {
    /// Resolve the source coordinates, migrating V1 `x`/`y` when V2 values are absent.
    pub fn source(&self) -> (f64, f64) {
        let x = self.source_x.unwrap_or(self.x);
        let y = self.source_y.unwrap_or(self.y);
        (x, y)
    }

    fn button_event_str(&self) -> String {
        if let Some(ref be) = self.button_event {
            if !be.is_empty() {
                return be.clone();
            }
        }
        // Legacy V1 fallback: reconstruct from button + clicked.
        let button = self.button.as_deref().unwrap_or("none");
        if self.clicked {
            return format!("{}-down", button);
        }
        if self.buttons.any_down() {
            return format!("{}-down", button);
        }
        "none".into()
    }

    fn is_click_down(&self) -> bool {
        let be = self.button_event_str();
        be == "down" || (be != "none" && be.ends_with("-down"))
    }

    fn click_button(&self) -> CursorButton {
        if let Some(ref b) = self.button {
            if let Some(btn) = CursorButton::from_known(b) {
                return btn;
            }
        }
        let be = self.button_event_str();
        if let Some(prefix) = be.split('-').next() {
            return CursorButton::from(prefix);
        }
        CursorButton::Left
    }

    fn press_phase(&self) -> PressPhase {
        let be = self.button_event_str();
        if be == "down" || be.ends_with("-down") {
            PressPhase::Down
        } else if be == "up" || be.ends_with("-up") {
            PressPhase::Up
        } else if be == "held" || be.ends_with("-held") {
            PressPhase::Held
        } else {
            PressPhase::None
        }
    }
}

/// Independent button states with per-button edge detection.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorButton {
    Left,
    Right,
    Middle,
}

impl CursorButton {
    fn from_known(value: &str) -> Option<Self> {
        match value {
            "left" => Some(CursorButton::Left),
            "right" => Some(CursorButton::Right),
            "middle" => Some(CursorButton::Middle),
            _ => None,
        }
    }
}

impl From<&str> for CursorButton {
    fn from(value: &str) -> Self {
        CursorButton::from_known(value).unwrap_or(CursorButton::Left)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CursorCaptureBounds {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for CursorCaptureBounds {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CursorDpiScale {
    #[serde(default = "one")]
    pub x: f64,
    #[serde(default = "one")]
    pub y: f64,
}

impl Default for CursorDpiScale {
    fn default() -> Self {
        Self { x: 1.0, y: 1.0 }
    }
}

fn one() -> f64 {
    1.0
}

/// 2x2 linear transform plus translation for raw-to-source coordinate mapping.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorCoordinateTransform {
    #[serde(default)]
    pub a00: f64,
    #[serde(default)]
    pub a01: f64,
    #[serde(default)]
    pub a10: f64,
    #[serde(default)]
    pub a11: f64,
    #[serde(default)]
    pub b0: f64,
    #[serde(default)]
    pub b1: f64,
}

/// Display topology where the cursor was captured. Only the scale factor is
/// needed by the engine (the DPI cursor size model multiplies by it).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTopologyInfo {
    pub scale_factor: f64,
}

/// Cursor shape metadata captured with V2 telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorShapeInfo {
    pub shape_id: String,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub width: u32,
    pub height: u32,
    pub kind: String,
}

impl Default for CursorShapeInfo {
    fn default() -> Self {
        Self {
            shape_id: String::new(),
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            kind: "arrow".into(),
        }
    }
}

/// Telemetry file schema, camelCase to match the TypeScript V2 contracts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryFile {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub asset_id: String,
    #[serde(default)]
    pub recording_id: String,
    pub source_width: f64,
    pub source_height: f64,
    #[serde(default)]
    pub capture_bounds: Option<CursorCaptureBounds>,
    #[serde(default)]
    pub coordinate_transform: CursorCoordinateTransform,
    /// Display topology captured with the telemetry; carries the OS DPI scale
    /// factor used by the DPI cursor size model.
    #[serde(default)]
    pub topology: Option<CursorTopologyInfo>,
    #[serde(default)]
    pub shapes: Vec<CursorShapeInfo>,
    #[serde(default)]
    pub click_window_ms: u64,
    #[serde(default = "default_health")]
    pub health: CursorTelemetryHealth,
    #[serde(default)]
    pub event_count: u64,
    #[serde(default)]
    pub index: Vec<CursorEventIndexEntry>,
    #[serde(default)]
    pub event_file: String,
    #[serde(default)]
    pub timebase: CursorTelemetryTimebase,
    #[serde(default)]
    pub sample_rate_hz: f64,
    #[serde(default)]
    pub events: Vec<CursorEvent>,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CursorTelemetryHealth {
    #[default]
    Healthy,
    ShapesUnavailable,
    PositionUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorEventIndexEntry {
    pub event_index: u64,
    pub t_ms: u64,
    pub file_offset: u64,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetryTimebase {
    pub unit: CursorTimebaseUnit,
    pub ticks_per_second: u64,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorTimebaseUnit {
    #[default]
    Ms,
}

fn default_schema_version() -> u32 {
    2
}

fn default_health() -> CursorTelemetryHealth {
    CursorTelemetryHealth::Healthy
}

impl CursorTelemetryFile {
    pub fn normalize(mut self) -> Self {
        if self.capture_bounds.is_none() {
            self.capture_bounds = Some(CursorCaptureBounds {
                x: 0.0,
                y: 0.0,
                width: self.source_width,
                height: self.source_height,
            });
        }
        if self.sample_rate_hz <= 0.0 {
            self.sample_rate_hz = 60.0;
        }
        if self.events.is_empty() && self.event_count > 0 {
            // Preserve the reported count when no in-memory events are loaded.
        } else {
            self.event_count = self.events.len() as u64;
        }
        self.events.sort_by_key(|event| event.t_ms);
        // Remove events with missing source coordinates.
        self.events.retain(|event| {
            let (x, y) = event.source();
            x.is_finite() && y.is_finite()
        });
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorCanvas {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub padding: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CursorSettings {
    pub enabled: bool,
    pub shape_mode: String,
    pub preset: String,
    pub scale: f64,
    pub fill_color: String,
    pub fill_opacity: f64,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub stroke_opacity: f64,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
    pub shadow_offset_x: f64,
    pub shadow_offset_y: f64,
    pub shadow_opacity: f64,
    pub click_feedback: String,
    pub click_color: String,
    pub click_size: f64,
    pub click_duration_ms: f64,
    pub left_click_enabled: bool,
    pub right_click_enabled: bool,
    pub click_press_animation: bool,
    pub spotlight_mode: bool,
    pub spotlight_radius: f64,
    pub spotlight_dim_opacity: f64,
    pub hide_native_cursor: bool,
    pub smooth_movement: bool,
    pub smooth_factor: f64,
    pub auto_hide_idle: bool,
    pub idle_timeout_ms: f64,
    /// Cursor size model: `legacy` keeps the absolute `scale` factor; `dpi`
    /// multiplies by `cursor_size_factor` so artwork tracks display DPI.
    #[serde(default = "default_size_model")]
    pub size_model: String,
}

fn default_size_model() -> String {
    "legacy".into()
}

/// DPI-consistent cursor size factor shared with the TypeScript engine:
/// `(48 * dpiScale * transformScale) / 64`, clamped to `[0.25, 4]`. Assets are
/// authored at 64 units, so ~0.75 is the native 1080p @1x size. `legacy` is
/// always 1 regardless of topology.
pub fn cursor_size_factor(settings: &CursorSettings, telemetry: &CursorTelemetryFile) -> f64 {
    if settings.size_model != "dpi" {
        return 1.0;
    }
    let dpi_scale = telemetry
        .topology
        .map(|topology| topology.scale_factor)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);
    let transform_scale = {
        let a00 = telemetry.coordinate_transform.a00.abs();
        if a00.is_finite() && a00 > 0.0 {
            a00
        } else {
            1.0
        }
    };
    ((48.0 * dpi_scale * transform_scale) / 64.0).clamp(0.25, 4.0)
}

impl Default for CursorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            shape_mode: "optimized".into(),
            preset: "recorded-system".into(),
            scale: 1.0,
            fill_color: "#3b82f6".into(),
            fill_opacity: 1.0,
            stroke_color: "#ffffff".into(),
            stroke_width: 2.0,
            stroke_opacity: 1.0,
            shadow_enabled: true,
            shadow_color: "#000000".into(),
            shadow_blur: 8.0,
            shadow_offset_x: 2.0,
            shadow_offset_y: 4.0,
            shadow_opacity: 0.4,
            click_feedback: "ripple".into(),
            click_color: "#60a5fa".into(),
            click_size: 36.0,
            click_duration_ms: 350.0,
            left_click_enabled: true,
            right_click_enabled: true,
            click_press_animation: true,
            spotlight_mode: false,
            spotlight_radius: 120.0,
            spotlight_dim_opacity: 0.5,
            hide_native_cursor: true,
            smooth_movement: true,
            smooth_factor: 0.25,
            auto_hide_idle: false,
            idle_timeout_ms: 2_000.0,
            size_model: "legacy".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorEngineOptions {
    #[serde(default = "default_gap_multiplier")]
    pub gap_threshold_multiplier: f64,
    #[serde(default = "default_min_gap_threshold_ms")]
    pub min_gap_threshold_ms: f64,
    #[serde(default = "default_jitter_threshold_px")]
    pub jitter_threshold_px: f64,
    #[serde(default = "default_motion_threshold_px")]
    pub motion_threshold_px: f64,
    #[serde(default = "default_smoothing_window_size")]
    pub smoothing_window_size: usize,
    #[serde(default = "default_idle_fade_duration_ms")]
    pub idle_fade_duration_ms: f64,
    #[serde(default = "default_adaptive_speed_ref")]
    pub adaptive_speed_ref_px_per_sec: f64,
}

impl Default for CursorEngineOptions {
    fn default() -> Self {
        Self {
            gap_threshold_multiplier: default_gap_multiplier(),
            min_gap_threshold_ms: default_min_gap_threshold_ms(),
            jitter_threshold_px: default_jitter_threshold_px(),
            motion_threshold_px: default_motion_threshold_px(),
            smoothing_window_size: default_smoothing_window_size(),
            idle_fade_duration_ms: default_idle_fade_duration_ms(),
            adaptive_speed_ref_px_per_sec: default_adaptive_speed_ref(),
        }
    }
}

fn default_gap_multiplier() -> f64 {
    8.0
}
fn default_min_gap_threshold_ms() -> f64 {
    120.0
}
fn default_jitter_threshold_px() -> f64 {
    1.0
}
fn default_motion_threshold_px() -> f64 {
    1.5
}
fn default_smoothing_window_size() -> usize {
    12
}
fn default_idle_fade_duration_ms() -> f64 {
    400.0
}
fn default_adaptive_speed_ref() -> f64 {
    2000.0
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorClickEffect {
    pub button: CursorButton,
    pub start_ms: u64,
    pub source_x: f64,
    pub source_y: f64,
    pub progress: f64,
    pub intensity: f64,
    /// Ease-out-cubic expansion factor: `1 - (1 - p)^3`.
    #[serde(default)]
    pub expand: f64,
    /// Quadratic fade factor: `(1 - p)^2`.
    #[serde(default)]
    pub fade: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorFrame {
    pub source_time_ms: f64,
    pub source_x: f64,
    pub source_y: f64,
    pub visible: bool,
    pub opacity: f64,
    pub shape_id: String,
    pub is_idle: bool,
    pub active_clicks: Vec<CursorClickEffect>,
    pub velocity_px_per_sec: f64,
    #[serde(default = "default_click_scale")]
    pub click_scale: f64,
}

fn default_click_scale() -> f64 {
    1.0
}

/// Version tag for the compact cubic Bézier motion-plan format.
pub const CUBIC_BEZIER_MOTION_PLAN_VERSION: u32 = 1;
/// Kind tag for the compact cubic Bézier motion-plan format.
pub const CUBIC_BEZIER_MOTION_PLAN_KIND: &str = "cubic-bezier";

/// A two-dimensional point in a cubic Bézier motion plan.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CubicBezierMotionPoint {
    pub x: f64,
    pub y: f64,
}

/// A time-bounded cubic Bézier segment in a motion plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CubicBezierMotionSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub start: CubicBezierMotionPoint,
    pub control1: CubicBezierMotionPoint,
    pub control2: CubicBezierMotionPoint,
    pub end: CubicBezierMotionPoint,
}

/// A serialized cubic Bézier motion plan shared by preview and export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CubicBezierMotionPlan {
    pub version: u32,
    pub kind: String,
    pub segments: Vec<CubicBezierMotionSegment>,
}

fn is_finite_motion_point(point: &CubicBezierMotionPoint) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

fn is_evaluable_motion_segment(segment: &CubicBezierMotionSegment) -> bool {
    segment.end_ms > segment.start_ms
        && is_finite_motion_point(&segment.start)
        && is_finite_motion_point(&segment.control1)
        && is_finite_motion_point(&segment.control2)
        && is_finite_motion_point(&segment.end)
}

/// Evaluate a compact cubic Bézier motion plan at a fractional millisecond.
///
/// The evaluator clamps times outside the plan to its first or last point and
/// uses a binary search so long plans remain cheap to seek.
pub fn evaluate_cubic_motion_plan(
    motion_plan: &CubicBezierMotionPlan,
    time_ms: f64,
) -> Option<CubicBezierMotionPoint> {
    if motion_plan.version != CUBIC_BEZIER_MOTION_PLAN_VERSION
        || motion_plan.kind != CUBIC_BEZIER_MOTION_PLAN_KIND
        || motion_plan.segments.is_empty()
    {
        return None;
    }

    let first = motion_plan.segments.first()?;
    let last = motion_plan.segments.last()?;
    if !is_evaluable_motion_segment(first) || !is_evaluable_motion_segment(last) {
        return None;
    }
    let safe_time_ms = if time_ms.is_finite() {
        time_ms
    } else {
        first.start_ms as f64
    };
    if safe_time_ms <= first.start_ms as f64 {
        return Some(first.start);
    }
    if safe_time_ms >= last.end_ms as f64 {
        return Some(last.end);
    }

    let mut low = 0usize;
    let mut high = motion_plan.segments.len() - 1;
    while low < high {
        let middle = low + (high - low) / 2;
        if safe_time_ms <= motion_plan.segments[middle].end_ms as f64 {
            high = middle;
        } else {
            low = middle + 1;
        }
    }

    let segment = &motion_plan.segments[low];
    if !is_evaluable_motion_segment(segment) {
        return None;
    }
    let duration_ms = segment.end_ms.saturating_sub(segment.start_ms).max(1) as f64;
    let progress = ((safe_time_ms - segment.start_ms as f64) / duration_ms).clamp(0.0, 1.0);
    let inverse = 1.0 - progress;
    let inverse_squared = inverse * inverse;
    let progress_squared = progress * progress;

    Some(CubicBezierMotionPoint {
        x: inverse_squared * inverse * segment.start.x
            + 3.0 * inverse_squared * progress * segment.control1.x
            + 3.0 * inverse * progress_squared * segment.control2.x
            + progress_squared * progress * segment.end.x,
        y: inverse_squared * inverse * segment.start.y
            + 3.0 * inverse_squared * progress * segment.control1.y
            + 3.0 * inverse * progress_squared * segment.control2.y
            + progress_squared * progress * segment.end.y,
    })
}

#[derive(Debug, Clone)]
struct PreparedEvent {
    t_ms: u64,
    denoised_x: f64,
    denoised_y: f64,
    visible: bool,
    shape_id: String,
    speed_px_per_sec: f64,
    last_motion_ms: u64,
    /// Idle gap that preceded the most recent motion event; 0 while still moving.
    motion_gap_ms: u64,
    is_click_edge: bool,
}

#[derive(Debug, Clone, Copy)]
struct ClickEntry {
    t_ms: u64,
    x: f64,
    y: f64,
    button: CursorButton,
}

type SmoothingCacheKey = (usize, u64);
type SmoothingCacheValue = (Vec<f64>, Vec<f64>);
// Insertion-ordered list capped at 8 entries; HashMap iteration order made the
// eviction victim arbitrary and could churn a still-active segment.
type SmoothingCache = RefCell<Vec<(SmoothingCacheKey, SmoothingCacheValue)>>;

/// Cursor scale while an enabled button is held.
const PRESS_SCALE: f64 = 0.80;
/// Taps shorter than this are stretched so the press stays visible at video
/// frame rates.
const PRESS_MIN_HOLD_MS: f64 = 90.0;
/// Press-in spring (rad/s); near critical damping so there is no visible
/// undershoot on the way down.
const PRESS_IN_OMEGA: f64 = 70.0;
const PRESS_IN_ZETA: f64 = 0.92;
/// Release spring (rad/s); under-damped so it produces one soft overshoot
/// peaking near 1.041.
const PRESS_OUT_OMEGA: f64 = 24.0;
const PRESS_OUT_ZETA: f64 = 0.45;
/// Gap after which the spring is back at rest (residual < 1e-4); also the
/// fast-path cutoff for frames far from any press.
const PRESS_SETTLE_MS: f64 = 700.0;
/// Cap on presses replayed into a single evaluation so click storms stay cheap.
const PRESS_MAX_CHAIN: usize = 64;
const PRESS_SCALE_MIN: f64 = 0.5;
const PRESS_SCALE_MAX: f64 = 1.25;

/// Button state implied by one telemetry sample for the press model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PressPhase {
    Down,
    Up,
    Held,
    None,
}

/// `[start_ms, end_ms]` window during which the press spring's target is
/// [`PRESS_SCALE`]; outside it the spring relaxes back to 1.
#[derive(Debug, Clone, Copy)]
struct PressInterval {
    start_ms: f64,
    end_ms: f64,
}

/// One closed-form step of an underdamped spring (zeta < 1, unit mass). `tau`
/// is in seconds; `tau <= 0` returns the state unchanged so the value at a
/// press edge is exact.
fn spring_step(x: f64, v: f64, target: f64, tau: f64, omega: f64, zeta: f64) -> (f64, f64) {
    if tau <= 0.0 {
        return (x, v);
    }
    let e0 = x - target;
    let d = (-zeta * omega * tau).exp();
    let wd = omega * (1.0 - zeta * zeta).sqrt();
    let cos = (wd * tau).cos();
    let sin = (wd * tau).sin();
    (
        target + d * (e0 * cos + ((v + zeta * omega * e0) / wd) * sin),
        d * (v * cos - ((omega * omega * e0 + zeta * omega * v) / wd) * sin),
    )
}

#[derive(Debug, Clone)]
pub struct CursorEngine {
    telemetry: CursorTelemetryFile,
    options: CursorEngineOptions,
    prepared: Vec<PreparedEvent>,
    times: Vec<u64>,
    segment_start_index: Vec<usize>,
    segment_end_index: Vec<usize>,
    clicks: Vec<ClickEntry>,
    /// Distinct non-empty shape ids in first-appearance order. `evaluate_packed`
    /// emits indices into this table so per-frame results carry no strings.
    shape_ids: Vec<String>,
    shape_index_by_id: HashMap<String, usize>,
    /// Cached zero-phase smoothing passes keyed by segment start and alpha.
    /// Interior mutability keeps `evaluate` deterministic and seek-safe while
    /// avoiding an O(n) allocation for every exported frame.
    smoothing_cache: SmoothingCache,
    /// Merged press intervals per (left, right) enabled mask; index is
    /// `left | right << 1` and middle presses are always included, matching
    /// the click-effect gating. Precomputed so `click_scale` stays a pure,
    /// seek-safe function of time.
    press_intervals: [Vec<PressInterval>; 4],
}

impl CursorEngine {
    pub fn new(
        telemetry: CursorTelemetryFile,
        options: CursorEngineOptions,
    ) -> Result<Self, String> {
        if telemetry.source_width <= 0.0 || telemetry.source_height <= 0.0 {
            return Err("telemetry source dimensions must be positive".into());
        }

        let telemetry = telemetry.normalize();
        let count = telemetry.events.len();
        let mut prepared = Vec::with_capacity(count);
        let mut times = Vec::with_capacity(count);
        let mut segment_start_index = Vec::with_capacity(count);
        let mut clicks = Vec::new();

        let expected_interval_ms = 1000.0 / telemetry.sample_rate_hz.max(1.0);
        let gap_threshold_ms = (options.gap_threshold_multiplier * expected_interval_ms)
            .max(options.min_gap_threshold_ms);

        for (index, event) in telemetry.events.iter().enumerate() {
            let (source_x, source_y) = event.source();
            let shape_id = event.shape_id.clone().unwrap_or_default();
            let is_click_edge = event.is_click_down();
            let click_button = event.click_button();

            let (denoised_x, denoised_y) = if index > 0 {
                let previous: &PreparedEvent = &prepared[index - 1];
                let dt = (event.t_ms.saturating_sub(previous.t_ms)) as f64;
                let dx = source_x - previous.denoised_x;
                let dy = source_y - previous.denoised_y;
                let displacement = (dx * dx + dy * dy).sqrt();

                if is_click_edge || event.shape_changed {
                    // Click events and shape changes are exact physical anchors
                    (source_x, source_y)
                } else if dt < expected_interval_ms * 2.5
                    && displacement < options.jitter_threshold_px
                    && options.jitter_threshold_px > 0.0
                {
                    // Continuous quadratic attenuation below jitter threshold (no staircasing)
                    let factor = (displacement / options.jitter_threshold_px).powi(2);
                    (
                        previous.denoised_x + dx * factor,
                        previous.denoised_y + dy * factor,
                    )
                } else {
                    (source_x, source_y)
                }
            } else {
                (source_x, source_y)
            };

            let speed_px_per_sec = if index > 0 {
                let previous: &PreparedEvent = &prepared[index - 1];
                let dt = (event.t_ms.saturating_sub(previous.t_ms)) as f64;
                if dt > 0.0 {
                    let dx = denoised_x - previous.denoised_x;
                    let dy = denoised_y - previous.denoised_y;
                    (dx * dx + dy * dy).sqrt() / dt * 1000.0
                } else {
                    0.0
                }
            } else {
                0.0
            };

            let segment_start = if index == 0 {
                index
            } else {
                let previous: &PreparedEvent = &prepared[index - 1];
                let dt = (event.t_ms.saturating_sub(previous.t_ms)) as f64;
                if dt >= gap_threshold_ms {
                    index
                } else {
                    segment_start_index[index - 1]
                }
            };

            let is_motion = if index == 0 {
                true
            } else {
                let previous: &PreparedEvent = &prepared[index - 1];
                let dx = denoised_x - previous.denoised_x;
                let dy = denoised_y - previous.denoised_y;
                let displacement = (dx * dx + dy * dy).sqrt();
                displacement > options.motion_threshold_px || is_click_edge || event.shape_changed
            };

            let last_motion_ms = if is_motion {
                event.t_ms
            } else if index > 0 {
                prepared[index - 1].last_motion_ms
            } else {
                event.t_ms
            };

            // The idle gap this motion event ended; non-motion events inherit
            // their last motion's gap so the fade-in check stays stateless.
            let motion_gap_ms = if index == 0 {
                0
            } else if is_motion {
                event
                    .t_ms
                    .saturating_sub(prepared[index - 1].last_motion_ms)
            } else {
                prepared[index - 1].motion_gap_ms
            };

            if is_click_edge {
                clicks.push(ClickEntry {
                    t_ms: event.t_ms,
                    x: denoised_x,
                    y: denoised_y,
                    button: click_button,
                });
            }

            prepared.push(PreparedEvent {
                t_ms: event.t_ms,
                denoised_x,
                denoised_y,
                visible: event.visible,
                shape_id,
                speed_px_per_sec,
                last_motion_ms,
                motion_gap_ms,
                is_click_edge,
            });
            times.push(event.t_ms);
            segment_start_index.push(segment_start);
        }

        let mut segment_end_index = vec![0; count];
        let mut current_start = 0;
        for i in 0..count {
            if i == count - 1 || segment_start_index[i + 1] != segment_start_index[i] {
                for end_index in segment_end_index.iter_mut().take(i + 1).skip(current_start) {
                    *end_index = i;
                }
                current_start = i + 1;
            }
        }

        let mut shape_ids = Vec::new();
        let mut shape_index_by_id = HashMap::new();
        for event in &prepared {
            if event.shape_id.is_empty() || shape_index_by_id.contains_key(&event.shape_id) {
                continue;
            }
            shape_index_by_id.insert(event.shape_id.clone(), shape_ids.len());
            shape_ids.push(event.shape_id.clone());
        }

        // Derive [down, up] press windows per button class. A `-held` sample
        // implies an ongoing press, a `-up` or an ordinary sample closes it,
        // and a telemetry gap closes everything at the last event before the
        // gap because the button state across it is unknown.
        const PRESS_CLASSES: [CursorButton; 3] = [
            CursorButton::Left,
            CursorButton::Right,
            CursorButton::Middle,
        ];
        let mut raw_presses: Vec<(CursorButton, f64, f64)> = Vec::new();
        let mut open: [Option<f64>; 3] = [None; 3];
        for (index, event) in telemetry.events.iter().enumerate() {
            let t_ms = event.t_ms as f64;
            if index > 0 && segment_start_index[index] == index {
                let previous_ms = telemetry.events[index - 1].t_ms as f64;
                for (slot, start) in open.iter_mut().enumerate() {
                    if let Some(start_ms) = start.take() {
                        raw_presses.push((PRESS_CLASSES[slot], start_ms, previous_ms));
                    }
                }
            }
            let class_index = match event.click_button() {
                CursorButton::Left => 0,
                CursorButton::Right => 1,
                CursorButton::Middle => 2,
            };
            match event.press_phase() {
                PressPhase::Down | PressPhase::Held => {
                    if open[class_index].is_none() {
                        open[class_index] = Some(t_ms);
                    }
                }
                PressPhase::Up => {
                    if let Some(start_ms) = open[class_index].take() {
                        raw_presses.push((PRESS_CLASSES[class_index], start_ms, t_ms));
                    }
                }
                PressPhase::None => {
                    for (slot, start) in open.iter_mut().enumerate() {
                        if let Some(start_ms) = start.take() {
                            raw_presses.push((PRESS_CLASSES[slot], start_ms, t_ms));
                        }
                    }
                }
            }
        }
        if let Some(last) = telemetry.events.last() {
            let last_ms = last.t_ms as f64;
            for (slot, start) in open.iter_mut().enumerate() {
                if let Some(start_ms) = start.take() {
                    raw_presses.push((PRESS_CLASSES[slot], start_ms, last_ms));
                }
            }
        }

        // Merge each settings mask's presses into sorted, non-overlapping
        // intervals, stretching short taps to the minimum hold.
        let press_intervals: [Vec<PressInterval>; 4] = std::array::from_fn(|mask| {
            let left_enabled = mask & 1 != 0;
            let right_enabled = mask & 2 != 0;
            let mut merged: Vec<PressInterval> = raw_presses
                .iter()
                .filter(|(button, _, _)| match button {
                    CursorButton::Left => left_enabled,
                    CursorButton::Right => right_enabled,
                    CursorButton::Middle => true,
                })
                .map(|(_, start_ms, end_ms)| PressInterval {
                    start_ms: *start_ms,
                    end_ms: (*end_ms).max(*start_ms + PRESS_MIN_HOLD_MS),
                })
                .collect();
            merged.sort_by(|left, right| left.start_ms.total_cmp(&right.start_ms));
            let mut intervals: Vec<PressInterval> = Vec::with_capacity(merged.len());
            for interval in merged {
                if let Some(last) = intervals.last_mut() {
                    if interval.start_ms <= last.end_ms {
                        last.end_ms = last.end_ms.max(interval.end_ms);
                        continue;
                    }
                }
                intervals.push(interval);
            }
            intervals
        });

        Ok(Self {
            telemetry,
            options,
            prepared,
            times,
            segment_start_index,
            segment_end_index,
            clicks,
            shape_ids,
            shape_index_by_id,
            smoothing_cache: RefCell::new(Vec::new()),
            press_intervals,
        })
    }

    pub fn evaluate(&self, time_ms: f64, settings: &CursorSettings) -> CursorFrame {
        if self.prepared.is_empty() || !time_ms.is_finite() {
            return CursorFrame {
                source_time_ms: 0.0,
                source_x: 0.0,
                source_y: 0.0,
                visible: false,
                opacity: 0.0,
                shape_id: String::new(),
                is_idle: false,
                active_clicks: Vec::new(),
                velocity_px_per_sec: 0.0,
                click_scale: 1.0,
            };
        }

        let index = self.find_event_index(time_ms);
        let event = &self.prepared[index];

        let (mut source_x, mut source_y) = self.evaluate_spline_position(index, time_ms, settings);

        let idle_duration = (time_ms - event.last_motion_ms as f64).max(0.0);
        let is_idle = settings.auto_hide_idle
            && settings.idle_timeout_ms > 0.0
            && idle_duration > settings.idle_timeout_ms;

        let mut opacity = if is_idle {
            if self.options.idle_fade_duration_ms > 0.0 {
                let fade_progress = ((idle_duration - settings.idle_timeout_ms)
                    / self.options.idle_fade_duration_ms)
                    .clamp(0.0, 1.0);
                1.0 - fade_progress
            } else {
                0.0
            }
        } else {
            1.0
        };

        // Motion resumed after an idle gap: replay the faded opacity backwards
        // over a fixed 150ms fade-in instead of popping straight back to 1.
        if !is_idle
            && settings.auto_hide_idle
            && settings.idle_timeout_ms > 0.0
            && event.motion_gap_ms as f64 > settings.idle_timeout_ms
        {
            let opacity_before = if self.options.idle_fade_duration_ms > 0.0 {
                1.0 - ((event.motion_gap_ms as f64 - settings.idle_timeout_ms)
                    / self.options.idle_fade_duration_ms)
                    .clamp(0.0, 1.0)
            } else {
                0.0
            };
            let fade_in = ((time_ms - event.last_motion_ms as f64) / 150.0).clamp(0.0, 1.0);
            opacity = opacity_before + (1.0 - opacity_before) * fade_in;
        }

        let visible = settings.enabled && event.visible && opacity > 0.0;
        let click_scale = self.calculate_click_scale(time_ms, settings);

        if settings.click_press_animation {
            self.apply_click_movement(time_ms, settings, &mut source_x, &mut source_y);
        }

        CursorFrame {
            source_time_ms: time_ms,
            source_x,
            source_y,
            visible,
            opacity,
            shape_id: event.shape_id.clone(),
            is_idle,
            active_clicks: self.active_clicks(time_ms, settings),
            velocity_px_per_sec: event.speed_px_per_sec,
            click_scale,
        }
    }

    /// Distinct shape ids in first-appearance order; `evaluate_packed` encodes
    /// the frame shape as an index into this table (-1 = empty shape id).
    pub fn shape_ids(&self) -> &[String] {
        &self.shape_ids
    }

    /// Evaluate a frame and return it as a flat `f64` buffer for the WASM
    /// bridge, avoiding per-frame JSON. Layout: `PACKED_FRAME_HEADER_LEN`
    /// leading fields then `PACKED_CLICK_LEN` fields per active click:
    /// `[sourceTimeMs, sourceX, sourceY, visible(0/1), opacity, isIdle(0/1),
    /// velocityPxPerSec, clickScale, shapeIndex, clickCount, ...per click:
    /// button(0 left/1 right/2 middle), startMs, sourceX, sourceY, progress,
    /// intensity, expand, fade]`.
    pub fn evaluate_packed(&self, time_ms: f64, settings: &CursorSettings) -> Vec<f64> {
        const HEADER_LEN: usize = 10;
        const CLICK_LEN: usize = 8;

        let frame = self.evaluate(time_ms, settings);
        let mut packed = Vec::with_capacity(HEADER_LEN + frame.active_clicks.len() * CLICK_LEN);
        packed.push(frame.source_time_ms);
        packed.push(frame.source_x);
        packed.push(frame.source_y);
        packed.push(f64::from(frame.visible));
        packed.push(frame.opacity);
        packed.push(f64::from(frame.is_idle));
        packed.push(frame.velocity_px_per_sec);
        packed.push(frame.click_scale);
        let shape_index = self
            .shape_index_by_id
            .get(&frame.shape_id)
            .map(|index| *index as f64)
            .unwrap_or(-1.0);
        packed.push(shape_index);
        packed.push(frame.active_clicks.len() as f64);
        for click in &frame.active_clicks {
            packed.push(match click.button {
                CursorButton::Left => 0.0,
                CursorButton::Right => 1.0,
                CursorButton::Middle => 2.0,
            });
            packed.push(click.start_ms as f64);
            packed.push(click.source_x);
            packed.push(click.source_y);
            packed.push(click.progress);
            packed.push(click.intensity);
            packed.push(click.expand);
            packed.push(click.fade);
        }
        packed
    }

    fn ensure_smoothed_positions(&self, seg_start: usize, seg_end: usize, alpha: f64) {
        let key = (seg_start, alpha.to_bits());
        if self.smoothing_cache.borrow().iter().any(|(k, _)| *k == key) {
            return;
        }

        let seg_len = seg_end - seg_start + 1;
        let mut forward_x = Vec::with_capacity(seg_len);
        let mut forward_y = Vec::with_capacity(seg_len);

        // Forward pass of zero-phase bidirectional smoothing. The result is
        // computed once per segment/settings pair and reused for every frame.
        for i in seg_start..=seg_end {
            let ev = &self.prepared[i];
            let x = ev.denoised_x;
            let y = ev.denoised_y;

            if i == seg_start || ev.is_click_edge || alpha >= 1.0 {
                forward_x.push(x);
                forward_y.push(y);
            } else {
                let prev_fx = forward_x.last().copied().unwrap_or(x);
                let prev_fy = forward_y.last().copied().unwrap_or(y);
                let dt = (ev.t_ms.saturating_sub(self.prepared[i - 1].t_ms) as f64).max(1.0);
                let speed_factor = ev.speed_px_per_sec / self.options.adaptive_speed_ref_px_per_sec;
                let sample_alpha = (alpha * (1.0 + speed_factor)).clamp(0.05, 1.0);
                // Time-based rate against the fixed 60 Hz reference interval so
                // the same preset smooths identically at any capture rate.
                let rate = (dt / SMOOTHING_REFERENCE_INTERVAL_MS).clamp(0.1, 5.0);
                let lambda = (1.0 - (1.0 - sample_alpha).powf(rate)).clamp(0.01, 1.0);

                forward_x.push(prev_fx + (x - prev_fx) * lambda);
                forward_y.push(prev_fy + (y - prev_fy) * lambda);
            }
        }

        let mut smoothed_x = vec![0.0; seg_len];
        let mut smoothed_y = vec![0.0; seg_len];

        // Backward pass removes phase lag without making frame evaluation
        // stateful, so seeking and playback produce the same result.
        for rel_i in (0..seg_len).rev() {
            let abs_i = seg_start + rel_i;
            let ev = &self.prepared[abs_i];
            let fx = forward_x[rel_i];
            let fy = forward_y[rel_i];

            if rel_i == seg_len - 1 || ev.is_click_edge || alpha >= 1.0 {
                smoothed_x[rel_i] = fx;
                smoothed_y[rel_i] = fy;
            } else {
                let next_bx = smoothed_x[rel_i + 1];
                let next_by = smoothed_y[rel_i + 1];
                let dt = (self.prepared[abs_i + 1].t_ms.saturating_sub(ev.t_ms) as f64).max(1.0);
                let speed_factor = ev.speed_px_per_sec / self.options.adaptive_speed_ref_px_per_sec;
                let sample_alpha = (alpha * (1.0 + speed_factor)).clamp(0.05, 1.0);
                // Same fixed reference interval as the forward pass.
                let rate = (dt / SMOOTHING_REFERENCE_INTERVAL_MS).clamp(0.1, 5.0);
                let lambda = (1.0 - (1.0 - sample_alpha).powf(rate)).clamp(0.01, 1.0);

                smoothed_x[rel_i] = next_bx + (fx - next_bx) * lambda;
                smoothed_y[rel_i] = next_by + (fy - next_by) * lambda;
            }
        }

        let mut cache = self.smoothing_cache.borrow_mut();
        // Evict the oldest entry first; arbitrary order here could throw away a
        // segment the next frame still needs.
        if cache.len() >= 8 {
            cache.remove(0);
        }
        cache.push((key, (smoothed_x, smoothed_y)));
    }

    fn evaluate_spline_position(
        &self,
        index: usize,
        time_ms: f64,
        settings: &CursorSettings,
    ) -> (f64, f64) {
        let seg_start = self.segment_start_index[index];
        let seg_end = self.segment_end_index[index];

        if seg_start == seg_end {
            return (
                self.prepared[seg_start].denoised_x,
                self.prepared[seg_start].denoised_y,
            );
        }

        let alpha_base = if settings.smooth_movement {
            settings.smooth_factor.clamp(0.05, 1.0)
        } else {
            1.0
        };

        let seg_len = seg_end - seg_start + 1;
        self.ensure_smoothed_positions(seg_start, seg_end, alpha_base);
        let cache_key = (seg_start, alpha_base.to_bits());
        let cache = self.smoothing_cache.borrow();
        let (smoothed_x, smoothed_y) = cache
            .iter()
            .find(|(k, _)| *k == cache_key)
            .map(|(_, value)| value)
            .expect("smoothing cache entry is populated before evaluation");

        // Time-aware Catmull-Rom interpolation between index and index + 1.
        let k = index;
        let k_rel = k - seg_start;
        let t0 = self.prepared[k].t_ms as f64;

        if k == seg_end || time_ms <= t0 {
            return (smoothed_x[k_rel], smoothed_y[k_rel]);
        }

        let k1 = k + 1;
        let k1_rel = k1 - seg_start;
        let t1 = self.prepared[k1].t_ms as f64;

        let u = if t1 <= t0 {
            0.0
        } else {
            ((time_ms - t0) / (t1 - t0)).clamp(0.0, 1.0)
        };

        let p1_x = smoothed_x[k_rel];
        let p1_y = smoothed_y[k_rel];
        let p2_x = smoothed_x[k1_rel];
        let p2_y = smoothed_y[k1_rel];

        let p0_x = if k_rel > 0 {
            smoothed_x[k_rel - 1]
        } else {
            p1_x - (p2_x - p1_x)
        };
        let p0_y = if k_rel > 0 {
            smoothed_y[k_rel - 1]
        } else {
            p1_y - (p2_y - p1_y)
        };
        let p3_x = if k1_rel + 1 < seg_len {
            smoothed_x[k1_rel + 1]
        } else {
            p2_x + (p2_x - p1_x)
        };
        let p3_y = if k1_rel + 1 < seg_len {
            smoothed_y[k1_rel + 1]
        } else {
            p2_y + (p2_y - p1_y)
        };

        // Cardinal Catmull-Rom expressed as a time-aware cubic Hermite curve.
        // Irregular polling intervals affect tangents by duration rather than
        // by array index, so sparse samples cannot pull the cursor backward.
        let previous_time = if k_rel > 0 {
            self.prepared[k - 1].t_ms as f64
        } else {
            t0 - (t1 - t0)
        };
        let next_time = if k1_rel + 1 < seg_len {
            self.prepared[k1 + 1].t_ms as f64
        } else {
            t1 + (t1 - t0)
        };
        let interval = (t1 - t0).max(1.0);
        let tangent1_scale = interval / (t1 - previous_time).max(1.0);
        let tangent2_scale = interval / (next_time - t0).max(1.0);
        let tangent1_x = (p2_x - p0_x) * tangent1_scale;
        let tangent1_y = (p2_y - p0_y) * tangent1_scale;
        let tangent2_x = (p3_x - p1_x) * tangent2_scale;
        let tangent2_y = (p3_y - p1_y) * tangent2_scale;

        let u2 = u * u;
        let u3 = u2 * u;
        let h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
        let h10 = u3 - 2.0 * u2 + u;
        let h01 = -2.0 * u3 + 3.0 * u2;
        let h11 = u3 - u2;

        (
            h00 * p1_x + h10 * tangent1_x + h01 * p2_x + h11 * tangent2_x,
            h00 * p1_y + h10 * tangent1_y + h01 * p2_y + h11 * tangent2_y,
        )
    }

    pub fn fit(
        &self,
        source_x: f64,
        source_y: f64,
        target_width: f64,
        target_height: f64,
        padding: f64,
    ) -> CursorPoint {
        let clamped_x = source_x.clamp(0.0, self.telemetry.source_width);
        let clamped_y = source_y.clamp(0.0, self.telemetry.source_height);

        let content_width = (target_width - padding * 2.0).max(1.0);
        let content_height = (target_height - padding * 2.0).max(1.0);
        let fit_scale = (content_width / self.telemetry.source_width)
            .min(content_height / self.telemetry.source_height);
        let fit_width = self.telemetry.source_width * fit_scale;
        let fit_height = self.telemetry.source_height * fit_scale;

        let offset_x = padding + (content_width - fit_width) / 2.0;
        let offset_y = padding + (content_height - fit_height) / 2.0;

        CursorPoint {
            x: offset_x + clamped_x * fit_scale,
            y: offset_y + clamped_y * fit_scale,
        }
    }

    pub fn telemetry(&self) -> &CursorTelemetryFile {
        &self.telemetry
    }

    fn find_event_index(&self, time_ms: f64) -> usize {
        if time_ms <= self.times[0] as f64 {
            return 0;
        }
        let last = self.times.len() - 1;
        if time_ms >= self.times[last] as f64 {
            return last;
        }

        let mut low = 0usize;
        let mut high = self.times.len() - 1;
        while low < high {
            let mid = low + (high - low).div_ceil(2);
            if self.times[mid] as f64 <= time_ms {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        low
    }

    fn active_clicks(&self, time_ms: f64, settings: &CursorSettings) -> Vec<CursorClickEffect> {
        if settings.click_feedback == "none" || settings.click_duration_ms <= 0.0 {
            return Vec::new();
        }

        let mut result = Vec::new();
        let mut low = 0usize;
        let mut high = self.clicks.len();
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            if self.clicks[middle - 1].t_ms as f64 <= time_ms {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        // Clicks are sparse; only scan the active window ending at the last
        // click before this timestamp instead of walking future events.
        for click in self.clicks[..low].iter().rev() {
            let elapsed = time_ms - click.t_ms as f64;
            if elapsed > settings.click_duration_ms {
                break;
            }

            let button_allowed = match click.button {
                CursorButton::Left => settings.left_click_enabled,
                CursorButton::Right => settings.right_click_enabled,
                CursorButton::Middle => true,
            };
            if !button_allowed {
                continue;
            }

            let progress = elapsed / settings.click_duration_ms;
            let intensity = 1.0 - progress;
            // Expansion/fade easing shared by preview and export so both draw
            // the same ring/disc envelope per frame.
            let expand = 1.0 - (1.0 - progress).powi(3);
            let fade = (1.0 - progress).powi(2);
            result.push(CursorClickEffect {
                button: click.button,
                start_ms: click.t_ms,
                source_x: click.x,
                source_y: click.y,
                progress,
                intensity,
                expand,
                fade,
            });
        }
        result.reverse();
        result
    }

    /// Button-aware press model: a damped spring whose target is
    /// [`PRESS_SCALE`] while any enabled button is held and 1.0 otherwise.
    /// Evaluated in closed form per press interval, so position and velocity
    /// carry across presses (C1 continuity) and double clicks interrupt each
    /// other naturally — all without evaluation state.
    fn calculate_click_scale(&self, time_ms: f64, settings: &CursorSettings) -> f64 {
        if !settings.click_press_animation {
            return 1.0;
        }
        let mask = usize::from(settings.left_click_enabled)
            | (usize::from(settings.right_click_enabled) << 1);
        let intervals = &self.press_intervals[mask];
        if intervals.is_empty() {
            return 1.0;
        }

        // Last press that started at or before this time.
        let k = match intervals
            .partition_point(|interval| interval.start_ms <= time_ms)
            .checked_sub(1)
        {
            Some(k) => k,
            None => return 1.0,
        };
        // Well past the last press the spring is at rest; no replay needed.
        if time_ms - intervals[k].end_ms >= PRESS_SETTLE_MS {
            return 1.0;
        }

        // Walk back to the first press in the chain of nearby presses; the
        // spring is assumed at rest before it.
        let mut j = k;
        while j > 0
            && k - j < PRESS_MAX_CHAIN
            && intervals[j].start_ms - intervals[j - 1].end_ms < PRESS_SETTLE_MS
        {
            j -= 1;
        }

        let (mut x, mut v) = (1.0, 0.0);
        for i in j..=k {
            let interval = intervals[i];
            (x, v) = spring_step(
                x,
                v,
                PRESS_SCALE,
                (time_ms.min(interval.end_ms) - interval.start_ms) / 1000.0,
                PRESS_IN_OMEGA,
                PRESS_IN_ZETA,
            );
            if time_ms <= interval.end_ms {
                return x.clamp(PRESS_SCALE_MIN, PRESS_SCALE_MAX);
            }
            let release_end = if i < k {
                intervals[i + 1].start_ms
            } else {
                time_ms
            };
            (x, v) = spring_step(
                x,
                v,
                1.0,
                (release_end - interval.end_ms) / 1000.0,
                PRESS_OUT_OMEGA,
                PRESS_OUT_ZETA,
            );
        }
        x.clamp(PRESS_SCALE_MIN, PRESS_SCALE_MAX)
    }

    fn apply_click_movement(
        &self,
        time_ms: f64,
        settings: &CursorSettings,
        source_x: &mut f64,
        source_y: &mut f64,
    ) {
        const DWELL_HOLD_MS: f64 = 50.0;
        const DWELL_TOTAL_MS: f64 = 160.0;
        const DWELL_RELEASE_MS: f64 = DWELL_TOTAL_MS - DWELL_HOLD_MS;

        let mut low = 0usize;
        let mut high = self.clicks.len();
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            if self.clicks[middle - 1].t_ms as f64 <= time_ms {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        // Search for the most recent click within the dwell window
        for click in self.clicks[..low].iter().rev() {
            let elapsed = time_ms - click.t_ms as f64;
            if elapsed > DWELL_TOTAL_MS {
                break;
            }
            if elapsed < 0.0 {
                continue;
            }

            let button_allowed = match click.button {
                CursorButton::Left => settings.left_click_enabled,
                CursorButton::Right => settings.right_click_enabled,
                CursorButton::Middle => true,
            };
            if !button_allowed {
                continue;
            }

            // Click dwell stabilization in smoothed movement modes
            if settings.smooth_movement {
                if elapsed <= DWELL_HOLD_MS {
                    *source_x = click.x;
                    *source_y = click.y;
                } else {
                    let u = ((elapsed - DWELL_HOLD_MS) / DWELL_RELEASE_MS).clamp(0.0, 1.0);
                    let blend = u * u * (3.0 - 2.0 * u);
                    *source_x = click.x + (*source_x - click.x) * blend;
                    *source_y = click.y + (*source_y - click.y) * blend;
                }
            }

            break; // Anchored to most recent active click
        }
    }
}

fn parse_json_or_err<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|e| e.to_string())
}

pub fn evaluate_at(
    telemetry_json: &str,
    settings_json: &str,
    options_json: &str,
    time_ms: f64,
) -> Result<String, String> {
    let telemetry: CursorTelemetryFile = parse_json_or_err(telemetry_json)?;
    let settings: CursorSettings = parse_json_or_err(settings_json)?;
    let options: CursorEngineOptions = parse_json_or_err(options_json)?;
    let engine = CursorEngine::new(telemetry, options)?;
    let frame = engine.evaluate(time_ms, &settings);
    serde_json::to_string(&frame).map_err(|e| e.to_string())
}

pub mod assets;

// WebAssembly bindings
#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct WasmCursorEngine {
        inner: CursorEngine,
        /// Last settings pushed by `set_settings`; `evaluate_packed` reads this
        /// so hot per-frame calls never cross the bridge with JSON.
        settings: CursorSettings,
    }

    #[wasm_bindgen]
    impl WasmCursorEngine {
        #[wasm_bindgen(constructor)]
        pub fn new(telemetry_json: &str, options_json: &str) -> Result<WasmCursorEngine, String> {
            let telemetry: CursorTelemetryFile = parse_json_or_err(telemetry_json)?;
            let options: CursorEngineOptions = parse_json_or_err(options_json)?;
            let inner = CursorEngine::new(telemetry, options)?;
            Ok(Self {
                inner,
                settings: CursorSettings::default(),
            })
        }

        /// Ordered shape-id table evaluated once at construction; packed frames
        /// reference entries by index. Serialized once, not per frame.
        #[wasm_bindgen]
        pub fn shape_ids(&self) -> String {
            serde_json::to_string(self.inner.shape_ids()).unwrap_or_else(|_| "[]".into())
        }

        /// Store the settings used by `evaluate_packed`. The JS wrapper only
        /// calls this when the serialized settings actually change.
        #[wasm_bindgen]
        pub fn set_settings(&mut self, settings_json: &str) -> Result<(), String> {
            self.settings = parse_json_or_err(settings_json)?;
            Ok(())
        }

        /// Per-frame evaluation without JSON. Returns the flat f64 layout
        /// documented on `CursorEngine::evaluate_packed`.
        #[wasm_bindgen]
        pub fn evaluate_packed(&self, time_ms: f64) -> Vec<f64> {
            self.inner.evaluate_packed(time_ms, &self.settings)
        }

        #[wasm_bindgen]
        pub fn evaluate_motion_plan(
            &self,
            motion_plan_json: &str,
            time_ms: f64,
        ) -> Result<String, String> {
            let motion_plan: CubicBezierMotionPlan = parse_json_or_err(motion_plan_json)?;
            let point = evaluate_cubic_motion_plan(&motion_plan, time_ms);
            serde_json::to_string(&point).map_err(|error| error.to_string())
        }

        #[wasm_bindgen]
        pub fn fit(
            &self,
            source_x: f64,
            source_y: f64,
            target_width: f64,
            target_height: f64,
            padding: f64,
        ) -> String {
            let point = self
                .inner
                .fit(source_x, source_y, target_width, target_height, padding);
            serde_json::to_string(&point).unwrap_or_default()
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn make_telemetry(events: Vec<CursorEvent>) -> CursorTelemetryFile {
        CursorTelemetryFile {
            schema_version: 2,
            asset_id: "test".into(),
            recording_id: "test".into(),
            source_width: 1920.0,
            source_height: 1080.0,
            sample_rate_hz: 60.0,
            capture_bounds: None,
            coordinate_transform: CursorCoordinateTransform::default(),
            topology: None,
            shapes: Vec::new(),
            click_window_ms: 350,
            health: CursorTelemetryHealth::Healthy,
            event_count: events.len() as u64,
            index: Vec::new(),
            event_file: "cursor_events.bin".into(),
            timebase: CursorTelemetryTimebase::default(),
            events,
        }
        .normalize()
    }

    /// Dense stationary telemetry at (500, 400) on a 1920x1080 source sampled
    /// every 8 ms (120 Hz), plus an event at every press edge. Each press is a
    /// `(button, down_ms, up_ms)` tuple; samples between them carry
    /// `{button}-held` and the matching `buttons` flag.
    fn press_telemetry(presses: &[(&str, u64, u64)], duration_ms: u64) -> CursorTelemetryFile {
        let mut times: Vec<u64> = (0..=duration_ms).step_by(8).collect();
        for (_, down_ms, up_ms) in presses {
            times.push(*down_ms);
            times.push(*up_ms);
        }
        times.sort_unstable();
        times.dedup();
        let events = times
            .into_iter()
            .map(|t_ms| {
                let mut button_event = "none".to_string();
                let mut buttons = CursorButtonState::default();
                for (button, down_ms, up_ms) in presses {
                    if t_ms == *down_ms {
                        button_event = format!("{button}-down");
                    } else if t_ms == *up_ms {
                        button_event = format!("{button}-up");
                    } else if t_ms > *down_ms && t_ms < *up_ms {
                        button_event = format!("{button}-held");
                    }
                    if t_ms >= *down_ms && t_ms < *up_ms {
                        match *button {
                            "left" => buttons.left = true,
                            "right" => buttons.right = true,
                            "middle" => buttons.middle = true,
                            _ => {}
                        }
                    }
                }
                CursorEvent {
                    t_ms,
                    x: 500.0,
                    y: 400.0,
                    visible: true,
                    buttons,
                    button_event: Some(button_event),
                    ..Default::default()
                }
            })
            .collect();
        let mut telemetry = make_telemetry(events);
        telemetry.sample_rate_hz = 120.0;
        telemetry
    }

    fn click_scale_at(engine: &CursorEngine, settings: &CursorSettings, time_ms: f64) -> f64 {
        engine.evaluate(time_ms, settings).click_scale
    }

    fn assert_scale(engine: &CursorEngine, settings: &CursorSettings, time_ms: f64, expected: f64) {
        let actual = click_scale_at(engine, settings, time_ms);
        assert!(
            (actual - expected).abs() <= 0.002,
            "clickScale at {time_ms}ms: expected {expected}, got {actual}"
        );
    }

    /// Oracle for the canonical tap (down 1000, up 1090), computed from the
    /// closed-form spring reference implementation.
    const TAP_ORACLE: &[(f64, f64)] = &[
        (20.0, 0.9146),
        (50.0, 0.8200),
        (90.0, 0.8004),
        (110.0, 0.8190),
        (150.0, 0.9186),
        (200.0, 1.0208),
        (250.0, 1.0392),
        (300.0, 1.0148),
        (400.0, 0.9921),
        (500.0, 1.0012),
    ];

    #[test]
    fn cursor_size_factor_matches_typescript_model() {
        let events = vec![CursorEvent {
            t_ms: 0,
            x: 0.0,
            y: 0.0,
            visible: true,
            ..Default::default()
        }];

        // legacy is always 1 regardless of topology.
        let mut telemetry = make_telemetry(events.clone());
        telemetry.topology = Some(CursorTopologyInfo { scale_factor: 2.0 });
        telemetry.coordinate_transform.a00 = 0.5;
        let mut settings = CursorSettings::default();
        assert_eq!(cursor_size_factor(&settings, &telemetry), 1.0);

        // 1080p @ 1x -> 48/64 = 0.75.
        settings.size_model = "dpi".into();
        let mut telemetry = make_telemetry(events.clone());
        telemetry.topology = Some(CursorTopologyInfo { scale_factor: 1.0 });
        telemetry.coordinate_transform.a00 = 1.0;
        assert!((cursor_size_factor(&settings, &telemetry) - 0.75).abs() < 1e-9);

        // 4K @ 2x -> 0.75 * 2 * 1 = 1.5.
        let mut telemetry = make_telemetry(events.clone());
        telemetry.topology = Some(CursorTopologyInfo { scale_factor: 2.0 });
        telemetry.coordinate_transform.a00 = 1.0;
        assert!((cursor_size_factor(&settings, &telemetry) - 1.5).abs() < 1e-9);

        // Downscaled capture: a00 = 0.5 at scale 2 -> 0.75 * 2 * 0.5 = 0.75.
        let mut telemetry = make_telemetry(events.clone());
        telemetry.topology = Some(CursorTopologyInfo { scale_factor: 2.0 });
        telemetry.coordinate_transform.a00 = 0.5;
        assert!((cursor_size_factor(&settings, &telemetry) - 0.75).abs() < 1e-9);

        // Missing/invalid topology and transform fall back to scale 1.
        let telemetry = make_telemetry(events);
        assert!((cursor_size_factor(&settings, &telemetry) - 0.75).abs() < 1e-9);
    }

    #[test]
    fn evaluates_basic_line() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 100.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 200,
                x: 100.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let frame = engine.evaluate(50.0, &CursorSettings::default());
        assert!(frame.source_x > 0.0 && frame.source_x < 100.0);
        assert!(frame.visible);
    }

    #[test]
    fn uses_event_timestamps_for_irregular_interpolation() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 10,
                x: 10.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 20,
                x: 20.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 120,
                x: 120.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings {
            smooth_movement: false,
            ..Default::default()
        };
        let frame = engine.evaluate(15.0, &settings);

        assert!((frame.source_x - 15.0).abs() < 0.000_001);
    }

    #[test]
    fn detects_idle_fade() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 100.0,
                y: 100.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 16,
                x: 100.0,
                y: 100.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 32,
                x: 100.0,
                y: 100.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let settings = CursorSettings {
            auto_hide_idle: true,
            idle_timeout_ms: 50.0,
            ..Default::default()
        };
        let options = CursorEngineOptions {
            idle_fade_duration_ms: 0.0,
            ..Default::default()
        };
        let engine = CursorEngine::new(telemetry, options).unwrap();
        let frame = engine.evaluate(100.0, &settings);
        assert!(!frame.visible);
        assert_eq!(frame.opacity, 0.0);
    }

    #[test]
    fn reset_smoothing_after_gap() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 16,
                x: 10.0,
                y: 10.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 2000,
                x: 500.0,
                y: 500.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let options = CursorEngineOptions {
            gap_threshold_multiplier: 1.0,
            min_gap_threshold_ms: 100.0,
            smoothing_window_size: 5,
            ..Default::default()
        };
        let engine = CursorEngine::new(telemetry, options).unwrap();
        let frame = engine.evaluate(2000.0, &CursorSettings::default());
        assert!((frame.source_x - 500.0).abs() < 1.0);
        assert!((frame.source_y - 500.0).abs() < 1.0);
    }

    #[test]
    fn click_effect_progress() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 100.0,
                y: 0.0,
                visible: true,
                clicked: true,
                button: Some("left".into()),
                button_event: Some("down".into()),
                ..Default::default()
            },
            CursorEvent {
                t_ms: 500,
                x: 100.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let at_click = engine.evaluate(100.0, &CursorSettings::default());
        assert_eq!(at_click.active_clicks.len(), 1);
        assert!((at_click.active_clicks[0].progress).abs() < 0.001);
        assert!((at_click.active_clicks[0].expand).abs() < 0.001);
        assert!((at_click.active_clicks[0].fade - 1.0).abs() < 0.001);

        // expand = 1-(1-p)^3 (ease-out cubic), fade = (1-p)^2.
        let mid = engine.evaluate(275.0, &CursorSettings::default());
        assert!((mid.active_clicks[0].progress - 0.5).abs() < 0.001);
        assert!((mid.active_clicks[0].expand - 0.875).abs() < 0.001);
        assert!((mid.active_clicks[0].fade - 0.25).abs() < 0.001);

        let later = engine.evaluate(500.0, &CursorSettings::default());
        assert!(later.active_clicks.is_empty());
    }

    #[test]
    fn fits_to_canvas() {
        let telemetry = make_telemetry(vec![CursorEvent {
            t_ms: 0,
            x: 0.5,
            y: 0.5,
            visible: true,
            ..Default::default()
        }]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let point = engine.fit(0.5, 0.5, 1920.0, 1080.0, 0.0);
        assert!(point.x >= 0.0 && point.y >= 0.0);
    }

    #[test]
    fn anchors_click_position_exactly() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 350.0,
                y: 200.0,
                visible: true,
                clicked: true,
                button: Some("left".into()),
                button_event: Some("left-down".into()),
                ..Default::default()
            },
            CursorEvent {
                t_ms: 200,
                x: 600.0,
                y: 400.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings {
            smooth_movement: true,
            smooth_factor: 0.15,
            ..Default::default()
        };

        // At exactly t = 100ms (the click event), the evaluated position MUST equal the click coordinate
        let at_click = engine.evaluate(100.0, &settings);
        assert!((at_click.source_x - 350.0).abs() < 0.001);
        assert!((at_click.source_y - 200.0).abs() < 0.001);
        assert_eq!(at_click.active_clicks.len(), 1);
        assert!((at_click.active_clicks[0].source_x - 350.0).abs() < 0.001);
        assert!((at_click.active_clicks[0].source_y - 200.0).abs() < 0.001);
    }

    #[test]
    fn zero_phase_symmetric_motion() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 50,
                x: 50.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 100.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 150,
                x: 100.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 200,
                x: 100.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings {
            smooth_movement: true,
            smooth_factor: 0.25,
            ..Default::default()
        };

        // At t = 100ms when mouse reaches 100.0 and stops, the zero-phase position should be close to 100.0
        let at_stop = engine.evaluate(100.0, &settings);
        assert!(at_stop.source_x > 85.0);

        // At t = 50ms midpoint, position should be centered ~50.0
        let at_mid = engine.evaluate(50.0, &settings);
        assert!((at_mid.source_x - 50.0).abs() < 10.0);
    }

    #[test]
    fn evaluates_cubic_motion_plan_at_boundaries_and_midpoints() {
        let plan = CubicBezierMotionPlan {
            version: 1,
            kind: "cubic-bezier".into(),
            segments: vec![
                CubicBezierMotionSegment {
                    start_ms: 100,
                    end_ms: 1_100,
                    start: CubicBezierMotionPoint { x: 0.0, y: 0.0 },
                    control1: CubicBezierMotionPoint { x: 0.0, y: 0.0 },
                    control2: CubicBezierMotionPoint { x: 100.0, y: 100.0 },
                    end: CubicBezierMotionPoint { x: 100.0, y: 100.0 },
                },
                CubicBezierMotionSegment {
                    start_ms: 1_100,
                    end_ms: 2_100,
                    start: CubicBezierMotionPoint { x: 100.0, y: 100.0 },
                    control1: CubicBezierMotionPoint { x: 100.0, y: 100.0 },
                    control2: CubicBezierMotionPoint { x: 200.0, y: 0.0 },
                    end: CubicBezierMotionPoint { x: 200.0, y: 0.0 },
                },
            ],
        };

        let before = evaluate_cubic_motion_plan(&plan, 0.0).expect("valid motion plan");
        assert_eq!(before, CubicBezierMotionPoint { x: 0.0, y: 0.0 });

        let midpoint = evaluate_cubic_motion_plan(&plan, 600.0).expect("valid motion plan");
        assert!((midpoint.x - 50.0).abs() < 0.000_001);
        assert!((midpoint.y - 50.0).abs() < 0.000_001);

        let after = evaluate_cubic_motion_plan(&plan, 3_000.0).expect("valid motion plan");
        assert_eq!(after, CubicBezierMotionPoint { x: 200.0, y: 0.0 });

        let invalid_kind = CubicBezierMotionPlan {
            kind: "linear".into(),
            ..plan
        };
        assert!(evaluate_cubic_motion_plan(&invalid_kind, 600.0).is_none());
    }

    #[test]
    fn click_scale_spring_matches_tap_oracle() {
        let telemetry = press_telemetry(&[("left", 1000, 1090)], 4000);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        // Exactly 1.0 before and at the press edge.
        assert_eq!(click_scale_at(&engine, &settings, 999.0), 1.0);
        assert_eq!(click_scale_at(&engine, &settings, 1000.0), 1.0);
        for (offset, expected) in TAP_ORACLE {
            assert_scale(&engine, &settings, 1000.0 + offset, *expected);
        }

        // One soft overshoot peaking near 1.041 (~+237ms); the press bottoms
        // out at the held scale of 0.80.
        let mut peak = 0.0f64;
        let mut trough = f64::MAX;
        for t in 0..=900 {
            let scale = click_scale_at(&engine, &settings, 1000.0 + t as f64);
            peak = peak.max(scale);
            trough = trough.min(scale);
        }
        assert!((peak - 1.041).abs() <= 0.002, "peak {peak}");
        assert!((0.7995..=0.8010).contains(&trough), "trough {trough}");

        // Exactly settled one settle window after the release edge.
        assert_eq!(click_scale_at(&engine, &settings, 1790.0), 1.0);
        assert_eq!(click_scale_at(&engine, &settings, 2500.0), 1.0);

        // Explicitly disabled stays 1.0 at every sampled time.
        let disabled = CursorSettings {
            click_press_animation: false,
            ..Default::default()
        };
        for t in [999.0, 1000.0, 1050.0, 1150.0, 1250.0, 2000.0] {
            assert_eq!(click_scale_at(&engine, &disabled, t), 1.0);
        }
    }

    #[test]
    fn click_scale_min_hold_stretches_short_taps() {
        let settings = CursorSettings::default();
        let canonical = CursorEngine::new(
            press_telemetry(&[("left", 1000, 1090)], 4000),
            CursorEngineOptions::default(),
        )
        .unwrap();
        // A one-sample tap (8 ms hold) stretches to the minimum hold and
        // produces the identical curve.
        let stretched = CursorEngine::new(
            press_telemetry(&[("left", 1000, 1008)], 4000),
            CursorEngineOptions::default(),
        )
        .unwrap();
        for offset in [0.0, 20.0, 50.0, 90.0, 150.0, 237.0, 400.0] {
            assert_eq!(
                click_scale_at(&canonical, &settings, 1000.0 + offset).to_bits(),
                click_scale_at(&stretched, &settings, 1000.0 + offset).to_bits(),
                "offset {offset}"
            );
        }

        // A legacy single-sample press (`-down` then a plain sample 17 ms
        // later) produces the same curve shifted to its own start.
        let legacy = CursorEngine::new(
            make_telemetry(vec![
                CursorEvent {
                    t_ms: 0,
                    x: 500.0,
                    y: 400.0,
                    visible: true,
                    ..Default::default()
                },
                CursorEvent {
                    t_ms: 100,
                    x: 500.0,
                    y: 400.0,
                    visible: true,
                    clicked: true,
                    button: Some("left".into()),
                    button_event: Some("left-down".into()),
                    ..Default::default()
                },
                CursorEvent {
                    t_ms: 117,
                    x: 500.0,
                    y: 400.0,
                    visible: true,
                    ..Default::default()
                },
                CursorEvent {
                    t_ms: 600,
                    x: 500.0,
                    y: 400.0,
                    visible: true,
                    ..Default::default()
                },
            ]),
            CursorEngineOptions::default(),
        )
        .unwrap();
        for (offset, expected) in TAP_ORACLE {
            assert_scale(&legacy, &settings, 100.0 + offset, *expected);
        }
    }

    #[test]
    fn click_scale_double_click_composes() {
        // Effective ends are stretched to 1090 and 1240 by the minimum hold.
        let telemetry = press_telemetry(&[("left", 1000, 1070), ("left", 1150, 1220)], 4000);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        const DOUBLE_ORACLE: &[(f64, f64)] = &[
            (100.0, 0.8051),
            (120.0, 0.8395),
            (140.0, 0.8913),
            (149.0, 0.9159),
            (155.0, 0.9225),
            (170.0, 0.8821),
            (200.0, 0.8157),
            (230.0, 0.8014),
            (300.0, 0.9188),
            (400.0, 1.0392),
        ];
        for (offset, expected) in DOUBLE_ORACLE {
            assert_scale(&engine, &settings, 1000.0 + offset, *expected);
        }

        // Position and velocity carry across the second press edge (C1).
        let before = click_scale_at(&engine, &settings, 1149.99);
        let after = click_scale_at(&engine, &settings, 1150.01);
        assert!(
            (before - after).abs() < 1e-3,
            "discontinuity at the second press: {before} vs {after}"
        );
    }

    #[test]
    fn click_scale_holds_for_drag_and_releases() {
        let telemetry = press_telemetry(&[("left", 1000, 2500)], 5000);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        // The spring stays pinned at the held scale for the whole drag.
        for offset in [100.0, 500.0, 1000.0, 1499.0, 1500.0] {
            let scale = click_scale_at(&engine, &settings, 1000.0 + offset);
            assert!(
                (scale - 0.8).abs() <= 0.001,
                "held scale at +{offset}: {scale}"
            );
        }

        const RELEASE_ORACLE: &[(f64, f64)] = &[
            (1550.0, 0.8926),
            (1600.0, 1.0080),
            (1650.0, 1.0409),
            (1700.0, 1.0201),
            (1800.0, 0.9917),
            (2000.0, 1.0007),
        ];
        for (offset, expected) in RELEASE_ORACLE {
            assert_scale(&engine, &settings, 1000.0 + offset, *expected);
        }
        assert_eq!(click_scale_at(&engine, &settings, 4200.0), 1.0);
    }

    #[test]
    fn click_scale_rest_between_distant_presses() {
        let telemetry = press_telemetry(&[("left", 1000, 1090), ("left", 3000, 3090)], 4000);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        // Presses farther apart than the settle window start from rest, so
        // the second click replays the canonical curve exactly.
        let first = click_scale_at(&engine, &settings, 1050.0);
        let second = click_scale_at(&engine, &settings, 3050.0);
        assert!((first - 0.82).abs() <= 0.002, "canonical +50ms: {first}");
        assert_eq!(first.to_bits(), second.to_bits());
    }

    #[test]
    fn click_scale_respects_button_toggles() {
        let settings = CursorSettings::default();

        // Right presses follow rightClickEnabled.
        let right = CursorEngine::new(
            press_telemetry(&[("right", 1000, 1090)], 4000),
            CursorEngineOptions::default(),
        )
        .unwrap();
        let right_off = CursorSettings {
            right_click_enabled: false,
            ..Default::default()
        };
        for t in [1050.0, 1100.0, 1250.0, 1500.0] {
            assert_eq!(click_scale_at(&right, &right_off, t), 1.0);
        }
        for (offset, expected) in TAP_ORACLE {
            assert_scale(&right, &settings, 1000.0 + offset, *expected);
        }

        // Left presses follow leftClickEnabled.
        let left = CursorEngine::new(
            press_telemetry(&[("left", 1000, 1090)], 4000),
            CursorEngineOptions::default(),
        )
        .unwrap();
        let left_off = CursorSettings {
            left_click_enabled: false,
            ..Default::default()
        };
        for t in [1050.0, 1100.0, 1250.0, 1500.0] {
            assert_eq!(click_scale_at(&left, &left_off, t), 1.0);
        }

        // Middle presses animate even when both toggles are off.
        let middle = CursorEngine::new(
            press_telemetry(&[("middle", 1000, 1090)], 4000),
            CursorEngineOptions::default(),
        )
        .unwrap();
        let both_off = CursorSettings {
            left_click_enabled: false,
            right_click_enabled: false,
            ..Default::default()
        };
        for (offset, expected) in TAP_ORACLE {
            assert_scale(&middle, &both_off, 1000.0 + offset, *expected);
        }
    }

    #[test]
    fn click_scale_merges_overlapping_buttons() {
        // Overlapping left/right presses merge into one held interval.
        let telemetry = press_telemetry(&[("left", 1000, 1300), ("right", 1100, 1200)], 4000);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        let held = click_scale_at(&engine, &settings, 1250.0);
        assert!((held - 0.8).abs() <= 0.002, "merged hold at 1250: {held}");
        // Release begins at the merged end (1300): +50 ms matches the drag
        // release oracle.
        assert_scale(&engine, &settings, 1350.0, 0.8926);
    }

    #[test]
    fn click_scale_closes_presses_across_telemetry_gaps() {
        // Dense samples through 1008 with a press at 1000, then a silent gap
        // until 3000 where held samples resume until release at 3500.
        let mut events = Vec::new();
        for t in (0..=1008).step_by(8) {
            let (button_event, left) = if t == 1000 {
                ("left-down", true)
            } else if t > 1000 {
                ("left-held", true)
            } else {
                ("none", false)
            };
            events.push(CursorEvent {
                t_ms: t,
                x: 500.0,
                y: 400.0,
                visible: true,
                buttons: CursorButtonState {
                    left,
                    ..Default::default()
                },
                button_event: Some(button_event.into()),
                ..Default::default()
            });
        }
        for t in (3000..3500).step_by(8) {
            events.push(CursorEvent {
                t_ms: t,
                x: 500.0,
                y: 400.0,
                visible: true,
                buttons: CursorButtonState {
                    left: true,
                    ..Default::default()
                },
                button_event: Some("left-held".into()),
                ..Default::default()
            });
        }
        events.push(CursorEvent {
            t_ms: 3500,
            x: 500.0,
            y: 400.0,
            visible: true,
            button_event: Some("left-up".into()),
            ..Default::default()
        });
        events.push(CursorEvent {
            t_ms: 4000,
            x: 500.0,
            y: 400.0,
            visible: true,
            ..Default::default()
        });
        let mut telemetry = make_telemetry(events);
        telemetry.sample_rate_hz = 120.0;
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        // The pre-gap press was closed at the last pre-gap sample (1008) and
        // stretched to 1090, so by 2000 the spring is long settled.
        assert_eq!(click_scale_at(&engine, &settings, 2000.0), 1.0);
        // The held samples after the gap re-open the press.
        let held = click_scale_at(&engine, &settings, 3200.0);
        assert!((held - 0.8).abs() <= 0.002, "post-gap hold: {held}");
        // A normal release follows the -up at 3500.
        assert_scale(&engine, &settings, 3550.0, 0.8926);
    }

    #[test]
    fn click_scale_is_seek_safe_and_stateless() {
        let telemetry = press_telemetry(
            &[
                ("left", 1000, 1090),
                ("right", 1400, 1600),
                ("left", 2000, 3500),
            ],
            4000,
        );
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        let times: Vec<f64> = (0..40).map(|i| 500.0 + i as f64 * 87.31).collect();
        let expected: Vec<u64> = times
            .iter()
            .map(|t| click_scale_at(&engine, &settings, *t).to_bits())
            .collect();

        // Re-evaluating in reverse and in a shuffled order must return
        // bit-identical values: evaluation carries no hidden state.
        for i in (0..times.len()).rev() {
            assert_eq!(
                click_scale_at(&engine, &settings, times[i]).to_bits(),
                expected[i],
                "reversed t={}",
                times[i]
            );
        }
        let mut order: Vec<usize> = (0..times.len()).collect();
        for i in (1..order.len()).rev() {
            let swap = (i * 31 + 7) % (i + 1);
            order.swap(i, swap);
        }
        for i in order {
            assert_eq!(
                click_scale_at(&engine, &settings, times[i]).to_bits(),
                expected[i],
                "shuffled t={}",
                times[i]
            );
        }
    }

    #[test]
    fn click_scale_handles_press_chains() {
        // 300 rapid presses exercise the replay chain cap; evaluation stays
        // finite and inside the output clamp.
        let presses: Vec<(&str, u64, u64)> = (0..300u64)
            .map(|i| ("left", i * 100, i * 100 + 40))
            .collect();
        let telemetry = press_telemetry(&presses, 31_000);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        for t in [5_000.0, 14_950.0, 29_950.0, 30_500.0] {
            let scale = click_scale_at(&engine, &settings, t);
            assert!(
                scale.is_finite() && (PRESS_SCALE_MIN..=PRESS_SCALE_MAX).contains(&scale),
                "chain evaluation at {t}: {scale}"
            );
        }
    }

    #[test]
    fn cinematic_click_dwell_and_tap_movement() {
        let mut events = Vec::new();
        // Moving cursor from (0,0) to (1000, 500) over 2000ms, clicking at t=1000ms at (500, 250)
        for t in (0..=2000).step_by(16) {
            let round_t = t as u64;
            let x = (t as f64 / 2000.0) * 1000.0;
            let y = (t as f64 / 2000.0) * 500.0;
            let (button_event, clicked) = if round_t == 1008 {
                (Some("left-down".into()), true)
            } else {
                (None, false)
            };
            events.push(CursorEvent {
                t_ms: round_t,
                x,
                y,
                visible: true,
                clicked,
                button: if clicked { Some("left".into()) } else { None },
                button_event,
                ..Default::default()
            });
        }

        let telemetry = make_telemetry(events);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let cinematic = CursorSettings {
            smooth_movement: true,
            smooth_factor: 0.15,
            click_press_animation: true,
            ..Default::default()
        };

        // At t = 1008 (exact click), position is right at the click target (504, 252)
        let frame_click = engine.evaluate(1008.0, &cinematic);
        assert!((frame_click.source_x - 504.0).abs() < 1.0);
        assert!((frame_click.source_y - 252.0).abs() < 1.0);
        assert!((frame_click.click_scale - 1.0).abs() < 0.001);

        // During down-press at dt = 40ms (t = 1048), dwell anchors the cursor
        // exactly on the click position; the press is visual-only (clickScale)
        // and must not dip the tip.
        let frame_press = engine.evaluate(1048.0, &cinematic);
        assert!(frame_press.click_scale < 0.88);
        assert_eq!(frame_press.source_x, 504.0);
        assert_eq!(frame_press.source_y, 252.0);

        // When click_press_animation is disabled, no press state is produced
        let cinematic_no_press = CursorSettings {
            smooth_movement: true,
            smooth_factor: 0.15,
            click_press_animation: false,
            ..Default::default()
        };
        let frame_no_press = engine.evaluate(1048.0, &cinematic_no_press);
        assert!((frame_no_press.click_scale - 1.0).abs() < 0.0001);
    }

    #[test]
    fn stationary_cursor_does_not_move_during_click_press() {
        let events = vec![
            CursorEvent {
                t_ms: 0,
                x: 350.0,
                y: 200.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 350.0,
                y: 200.0,
                visible: true,
                clicked: true,
                button: Some("left".into()),
                button_event: Some("left-down".into()),
                ..Default::default()
            },
            CursorEvent {
                t_ms: 300,
                x: 350.0,
                y: 200.0,
                visible: true,
                ..Default::default()
            },
        ];
        let telemetry = make_telemetry(events);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings {
            smooth_movement: false,
            click_press_animation: true,
            ..Default::default()
        };

        // 40ms into the press: clickScale is engaged but the tip must stay put.
        let frame = engine.evaluate(140.0, &settings);
        assert!(frame.click_scale < 1.0);
        assert_eq!(frame.source_x, 350.0);
        assert_eq!(frame.source_y, 200.0);
    }

    #[test]
    fn smooths_same_path_consistently_at_60hz_and_120hz() {
        // Zero-phase smoothing is driven by a fixed 60 Hz reference interval,
        // so the same preset must produce equivalent results at either rate.
        let curve = |t: f64| {
            let u = t / 2000.0;
            let s = u * u * (3.0 - 2.0 * u);
            (200.0 + 600.0 * s, 100.0 + 400.0 * s)
        };
        let build = |step: u64, rate: f64| {
            let mut t = 0u64;
            let mut events = Vec::new();
            while t <= 2000 {
                let (x, y) = curve(t as f64);
                events.push(CursorEvent {
                    t_ms: t,
                    x,
                    y,
                    visible: true,
                    ..Default::default()
                });
                t += step;
            }
            let mut telemetry = make_telemetry(events);
            telemetry.sample_rate_hz = rate;
            // Denoise disabled so only the smoothing rate can differ.
            let options = CursorEngineOptions {
                jitter_threshold_px: 0.0,
                ..Default::default()
            };
            CursorEngine::new(telemetry, options).unwrap()
        };
        let engine60 = build(16, 60.0);
        let engine120 = build(8, 120.0);
        let settings = CursorSettings {
            smooth_movement: true,
            smooth_factor: 0.15,
            ..Default::default()
        };

        for t in [400.0, 800.0, 1_000.0, 1_400.0, 1_800.0] {
            let frame60 = engine60.evaluate(t, &settings);
            let frame120 = engine120.evaluate(t, &settings);
            assert!(
                (frame60.source_x - frame120.source_x).abs() <= 0.5,
                "x differs at {t}ms: {} vs {}",
                frame60.source_x,
                frame120.source_x
            );
            assert!(
                (frame60.source_y - frame120.source_y).abs() <= 0.5,
                "y differs at {t}ms: {} vs {}",
                frame60.source_y,
                frame120.source_y
            );
        }
    }

    #[test]
    fn fades_cursor_back_in_when_motion_resumes_after_idle() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 100.0,
                y: 100.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 200.0,
                y: 100.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 5_000,
                x: 300.0,
                y: 100.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 5_500,
                x: 400.0,
                y: 100.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings {
            auto_hide_idle: true,
            idle_timeout_ms: 1_000.0,
            smooth_movement: false,
            ..Default::default()
        };

        // Long idle fades the cursor fully out.
        assert_eq!(engine.evaluate(4_900.0, &settings).opacity, 0.0);
        // Motion resumes at 5000: a stateless 150ms fade-in restores opacity.
        assert!(engine.evaluate(5_000.0, &settings).opacity < 0.01);
        assert!((engine.evaluate(5_075.0, &settings).opacity - 0.5).abs() < 0.01);
        assert_eq!(engine.evaluate(5_150.0, &settings).opacity, 1.0);
    }

    #[test]
    fn smoothing_cache_evicts_the_oldest_entry_in_insertion_order() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 100.0,
                y: 0.0,
                visible: true,
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();

        // Fill past capacity with distinct alpha keys; the first inserted must
        // be the one evicted rather than an arbitrary HashMap victim.
        let alphas = [0.05f64, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13];
        for alpha in alphas {
            engine.ensure_smoothed_positions(0, 1, alpha);
        }
        let cache = engine.smoothing_cache.borrow();
        assert_eq!(cache.len(), 8);
        assert!(cache.iter().all(|(k, _)| k.1 != alphas[0].to_bits()));
        for alpha in &alphas[1..] {
            assert!(cache.iter().any(|(k, _)| k.1 == alpha.to_bits()));
        }
    }

    #[test]
    fn evaluate_packed_layout_matches_bridge_contract() {
        let telemetry = make_telemetry(vec![
            CursorEvent {
                t_ms: 0,
                x: 0.0,
                y: 0.0,
                visible: true,
                shape_id: Some("arrow".into()),
                ..Default::default()
            },
            CursorEvent {
                t_ms: 100,
                x: 100.0,
                y: 0.0,
                visible: true,
                clicked: true,
                button: Some("left".into()),
                button_event: Some("left-down".into()),
                shape_id: Some("arrow".into()),
                ..Default::default()
            },
            CursorEvent {
                t_ms: 600,
                x: 100.0,
                y: 0.0,
                visible: true,
                shape_id: Some("ibeam".into()),
                ..Default::default()
            },
        ]);
        let engine = CursorEngine::new(telemetry, CursorEngineOptions::default()).unwrap();
        let settings = CursorSettings::default();

        // Shape table is ordered by first appearance across the events.
        assert_eq!(engine.shape_ids(), ["arrow", "ibeam"]);

        // Header: [sourceTimeMs, sourceX, sourceY, visible, opacity, isIdle,
        // velocityPxPerSec, clickScale, shapeIndex, clickCount].
        let at_click = engine.evaluate_packed(100.0, &settings);
        assert_eq!(at_click.len(), 10 + 8);
        assert_eq!(at_click[0], 100.0);
        assert!((at_click[1] - 100.0).abs() < 0.001); // click anchors sourceX exactly
        assert!(at_click[2].abs() < 0.001); // sourceY
        assert_eq!(at_click[3], 1.0); // visible
        assert_eq!(at_click[4], 1.0); // opacity
        assert_eq!(at_click[5], 0.0); // isIdle
        assert_eq!(at_click[7], 1.0); // clickScale untouched at the click instant
        assert_eq!(at_click[8], 0.0); // shapeIndex 0 -> "arrow"
        assert_eq!(at_click[9], 1.0); // clickCount

        // Per click: [button(0 left/1 right/2 middle), startMs, sourceX,
        // sourceY, progress, intensity, expand, fade].
        assert_eq!(at_click[10], 0.0);
        assert_eq!(at_click[11], 100.0);
        assert!((at_click[12] - 100.0).abs() < 0.001);
        assert!(at_click[13].abs() < 0.001);
        assert!(at_click[14].abs() < 0.001); // progress 0
        assert!((at_click[15] - 1.0).abs() < 0.001); // intensity 1
        assert!(at_click[16].abs() < 0.001); // expand 0
        assert!((at_click[17] - 1.0).abs() < 0.001); // fade 1

        // Later frames carry the second shape id and no clicks.
        let later = engine.evaluate_packed(600.0, &settings);
        assert_eq!(later.len(), 10);
        assert_eq!(later[8], 1.0); // shapeIndex 1 -> "ibeam"
        assert_eq!(later[9], 0.0);

        // Events without a shape id encode -1.
        let shapeless = CursorEngine::new(
            make_telemetry(vec![CursorEvent {
                t_ms: 0,
                x: 1.0,
                y: 1.0,
                visible: true,
                ..Default::default()
            }]),
            CursorEngineOptions::default(),
        )
        .unwrap();
        let packed = shapeless.evaluate_packed(0.0, &settings);
        assert_eq!(packed[8], -1.0);
        assert!(shapeless.shape_ids().is_empty());
    }
}
