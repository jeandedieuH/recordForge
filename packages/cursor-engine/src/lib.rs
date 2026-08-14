//! Canonical cursor evaluation engine.
//!
//! The same core compiles to native code for the Tauri export and to
//! WebAssembly for the React preview so both sides evaluate identical frames.

use serde::{Deserialize, Serialize};

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
    pub spotlight_mode: bool,
    pub spotlight_radius: f64,
    pub spotlight_dim_opacity: f64,
    pub hide_native_cursor: bool,
    pub smooth_movement: bool,
    pub smooth_factor: f64,
    pub auto_hide_idle: bool,
    pub idle_timeout_ms: f64,
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
            spotlight_mode: false,
            spotlight_radius: 120.0,
            spotlight_dim_opacity: 0.5,
            hide_native_cursor: true,
            smooth_movement: true,
            smooth_factor: 0.25,
            auto_hide_idle: false,
            idle_timeout_ms: 2_000.0,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorFrame {
    pub source_time_ms: u64,
    pub source_x: f64,
    pub source_y: f64,
    pub visible: bool,
    pub opacity: f64,
    pub shape_id: String,
    pub is_idle: bool,
    pub active_clicks: Vec<CursorClickEffect>,
    pub velocity_px_per_sec: f64,
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
    is_click_edge: bool,
}

#[derive(Debug, Clone, Copy)]
struct ClickEntry {
    t_ms: u64,
    x: f64,
    y: f64,
    button: CursorButton,
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
                is_click_edge,
            });
            times.push(event.t_ms);
            segment_start_index.push(segment_start);
        }

        let mut segment_end_index = vec![0; count];
        let mut current_start = 0;
        for i in 0..count {
            if i == count - 1 || segment_start_index[i + 1] != segment_start_index[i] {
                for j in current_start..=i {
                    segment_end_index[j] = i;
                }
                current_start = i + 1;
            }
        }

        Ok(Self {
            telemetry,
            options,
            prepared,
            times,
            segment_start_index,
            segment_end_index,
            clicks,
        })
    }

    pub fn evaluate(&self, time_ms: f64, settings: &CursorSettings) -> CursorFrame {
        if self.prepared.is_empty() || !time_ms.is_finite() {
            return CursorFrame {
                source_time_ms: 0,
                source_x: 0.0,
                source_y: 0.0,
                visible: false,
                opacity: 0.0,
                shape_id: String::new(),
                is_idle: false,
                active_clicks: Vec::new(),
                velocity_px_per_sec: 0.0,
            };
        }

        let index = self.find_event_index(time_ms);
        let event = &self.prepared[index];

        let (source_x, source_y) = self.evaluate_spline_position(index, time_ms, settings);

        let idle_duration = (time_ms - event.last_motion_ms as f64).max(0.0);
        let is_idle = settings.auto_hide_idle
            && settings.idle_timeout_ms > 0.0
            && idle_duration > settings.idle_timeout_ms;

        let opacity = if is_idle {
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

        let visible = settings.enabled && event.visible && opacity > 0.0;

        CursorFrame {
            source_time_ms: time_ms as u64,
            source_x,
            source_y,
            visible,
            opacity,
            shape_id: event.shape_id.clone(),
            is_idle,
            active_clicks: self.active_clicks(time_ms, settings),
            velocity_px_per_sec: event.speed_px_per_sec,
        }
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
        let expected_interval_ms = 1000.0 / self.telemetry.sample_rate_hz.max(1.0);

        // Forward pass of zero-phase bidirectional smoothing
        let mut forward_x = Vec::with_capacity(seg_len);
        let mut forward_y = Vec::with_capacity(seg_len);

        for i in seg_start..=seg_end {
            let ev = &self.prepared[i];
            let x = ev.denoised_x;
            let y = ev.denoised_y;

            if i == seg_start || ev.is_click_edge || alpha_base >= 1.0 {
                forward_x.push(x);
                forward_y.push(y);
            } else {
                let prev_fx = forward_x.last().copied().unwrap_or(x);
                let prev_fy = forward_y.last().copied().unwrap_or(y);
                let dt = (ev.t_ms.saturating_sub(self.prepared[i - 1].t_ms) as f64).max(1.0);
                let speed_factor = ev.speed_px_per_sec / self.options.adaptive_speed_ref_px_per_sec;
                let sample_alpha = (alpha_base * (1.0 + speed_factor)).clamp(0.05, 1.0);
                let rate = (dt / expected_interval_ms).clamp(0.1, 5.0);
                let lambda = (1.0 - (1.0 - sample_alpha).powf(rate)).clamp(0.05, 1.0);

                forward_x.push(prev_fx + (x - prev_fx) * lambda);
                forward_y.push(prev_fy + (y - prev_fy) * lambda);
            }
        }

        // Backward pass of zero-phase bidirectional smoothing
        let mut smoothed_x = vec![0.0; seg_len];
        let mut smoothed_y = vec![0.0; seg_len];

        for rel_i in (0..seg_len).rev() {
            let abs_i = seg_start + rel_i;
            let ev = &self.prepared[abs_i];
            let fx = forward_x[rel_i];
            let fy = forward_y[rel_i];

            if rel_i == seg_len - 1 || ev.is_click_edge || alpha_base >= 1.0 {
                smoothed_x[rel_i] = fx;
                smoothed_y[rel_i] = fy;
            } else {
                let next_bx = smoothed_x[rel_i + 1];
                let next_by = smoothed_y[rel_i + 1];
                let dt = (self.prepared[abs_i + 1].t_ms.saturating_sub(ev.t_ms) as f64).max(1.0);
                let speed_factor = ev.speed_px_per_sec / self.options.adaptive_speed_ref_px_per_sec;
                let sample_alpha = (alpha_base * (1.0 + speed_factor)).clamp(0.05, 1.0);
                let rate = (dt / expected_interval_ms).clamp(0.1, 5.0);
                let lambda = (1.0 - (1.0 - sample_alpha).powf(rate)).clamp(0.05, 1.0);

                smoothed_x[rel_i] = next_bx + (fx - next_bx) * lambda;
                smoothed_y[rel_i] = next_by + (fy - next_by) * lambda;
            }
        }

        // Centripetal Catmull-Rom Spline Interpolation between index and index+1:
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

        let u2 = u * u;
        let u3 = u2 * u;

        let interp_x = 0.5
            * ((2.0 * p1_x)
                + (-p0_x + p2_x) * u
                + (2.0 * p0_x - 5.0 * p1_x + 4.0 * p2_x - p3_x) * u2
                + (-p0_x + 3.0 * p1_x - 3.0 * p2_x + p3_x) * u3);

        let interp_y = 0.5
            * ((2.0 * p1_y)
                + (-p0_y + p2_y) * u
                + (2.0 * p0_y - 5.0 * p1_y + 4.0 * p2_y - p3_y) * u2
                + (-p0_y + 3.0 * p1_y - 3.0 * p2_y + p3_y) * u3);

        (interp_x, interp_y)
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
        for click in self.clicks.iter().rev() {
            if click.t_ms as f64 > time_ms {
                continue;
            }
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
            result.push(CursorClickEffect {
                button: click.button,
                start_ms: click.t_ms,
                source_x: click.x,
                source_y: click.y,
                progress,
                intensity,
            });
        }
        result.reverse();
        result
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
    }

    #[wasm_bindgen]
    impl WasmCursorEngine {
        #[wasm_bindgen(constructor)]
        pub fn new(telemetry_json: &str, options_json: &str) -> Result<WasmCursorEngine, String> {
            let telemetry: CursorTelemetryFile = parse_json_or_err(telemetry_json)?;
            let options: CursorEngineOptions = parse_json_or_err(options_json)?;
            let inner = CursorEngine::new(telemetry, options)?;
            Ok(Self { inner })
        }

        #[wasm_bindgen]
        pub fn evaluate(&self, time_ms: f64, settings_json: &str) -> String {
            let settings: CursorSettings = parse_json_or_err(settings_json).unwrap_or_default();
            serde_json::to_string(&self.inner.evaluate(time_ms, &settings)).unwrap_or_default()
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
        let mut settings = CursorSettings::default();
        settings.auto_hide_idle = true;
        settings.idle_timeout_ms = 50.0;
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
        let mut options = CursorEngineOptions::default();
        options.gap_threshold_multiplier = 1.0;
        options.min_gap_threshold_ms = 100.0;
        options.smoothing_window_size = 5;
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
}

