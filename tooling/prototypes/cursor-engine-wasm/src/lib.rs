//! Throwaway Rust prototype for a canonical cursor evaluator.
//!
//! This crate mirrors the evaluation model used by the TypeScript `cursor-core`
//! package and the Rust `exports/cursor.rs` renderer. The goal of the prototype
//! is to prove that the same Rust code can be compiled to both native (for export)
//! and `wasm32-unknown-unknown` (for preview) while producing identical output.

use serde::{Deserialize, Serialize};
/// Cursor telemetry event, V1-compatible with V2 optional extensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorEvent {
    pub t_ms: f64,
    pub x: f64,
    pub y: f64,
    pub clicked: bool,
    pub button: Option<String>,
    pub button_event: Option<String>,
    pub visible: bool,
    pub shape_id: Option<String>,
    pub hotspot_x: Option<f64>,
    pub hotspot_y: Option<f64>,
}

impl CursorEvent {
    pub fn is_click_edge(&self) -> bool {
        self.button_event.as_deref() == Some("down")
            || (self.button_event.is_none() && self.clicked)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTelemetry {
    pub schema_version: u32,
    pub asset_id: String,
    pub recording_id: String,
    pub source_width: f64,
    pub source_height: f64,
    pub capture_bounds: Bounds,
    pub dpi_scale: DpiScale,
    pub events: Vec<CursorEvent>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DpiScale {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    pub width: f64,
    pub height: f64,
    pub padding: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatedCursor {
    pub x: f64,
    pub y: f64,
    pub visible: bool,
    pub click_progress: Option<f64>,
}

pub struct Evaluator {
    telemetry: CursorTelemetry,
    canvas: Canvas,
    smoothing: f64,
    idle_timeout_ms: f64,
    click_window_ms: f64,
    fit_offset_x: f64,
    fit_offset_y: f64,
    fit_scale: f64,
}

impl Evaluator {
    pub fn new(telemetry: CursorTelemetry, canvas: Canvas) -> Result<Self, String> {
        if canvas.width <= 0.0 || canvas.height <= 0.0 {
            return Err("canvas dimensions must be positive".into());
        }
        if telemetry.source_width <= 0.0 || telemetry.source_height <= 0.0 {
            return Err("source dimensions must be positive".into());
        }

        let padding = canvas.padding;
        let content_width = (canvas.width - padding * 2.0).max(1.0);
        let content_height = (canvas.height - padding * 2.0).max(1.0);

        let fit_scale =
            (content_width / telemetry.source_width).min(content_height / telemetry.source_height);
        let fit_width = telemetry.source_width * fit_scale;
        let fit_height = telemetry.source_height * fit_scale;
        let fit_offset_x = padding + (content_width - fit_width) / 2.0;
        let fit_offset_y = padding + (content_height - fit_height) / 2.0;

        Ok(Self {
            telemetry,
            canvas,
            smoothing: 0.25,
            idle_timeout_ms: 2000.0,
            click_window_ms: 350.0,
            fit_offset_x,
            fit_offset_y,
            fit_scale,
        })
    }

    pub fn with_smoothing(mut self, value: f64) -> Self {
        self.smoothing = value.clamp(0.05, 1.0);
        self
    }

    pub fn with_idle_timeout(mut self, ms: f64) -> Self {
        self.idle_timeout_ms = ms.max(0.0);
        self
    }

    fn find_event_index(&self, time_ms: f64) -> Option<usize> {
        let events = &self.telemetry.events;
        if events.is_empty() || !time_ms.is_finite() {
            return None;
        }

        let mut low = 0usize;
        let mut high = events.len();
        while low < high {
            let mid = low + (high - low) / 2;
            if events[mid].t_ms < time_ms {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        let right = low.min(events.len() - 1);
        let left = right.saturating_sub(1);
        let left_dist = (events[left].t_ms - time_ms).abs();
        let right_dist = (events[right].t_ms - time_ms).abs();
        Some(if left_dist <= right_dist { left } else { right })
    }

    fn smooth_position(&self, index: usize) -> Point {
        let events = &self.telemetry.events;
        let event = &events[index];
        if self.smoothing >= 1.0 {
            return Point {
                x: event.x,
                y: event.y,
            };
        }

        let window_size = 5;
        let start = index.saturating_sub(window_size);
        let mut sum_x = 0.0;
        let mut sum_y = 0.0;
        let mut total_weight = 0.0;
        for i in start..=index {
            let weight = (1.0 - self.smoothing).powi((index - i) as i32);
            sum_x += events[i].x * weight;
            sum_y += events[i].y * weight;
            total_weight += weight;
        }

        if total_weight > 0.0 {
            Point {
                x: sum_x / total_weight,
                y: sum_y / total_weight,
            }
        } else {
            Point {
                x: event.x,
                y: event.y,
            }
        }
    }

    fn source_scale_x(&self) -> f64 {
        (self.telemetry.source_width / self.telemetry.capture_bounds.width.max(1.0))
            * self.telemetry.dpi_scale.x
    }

    fn source_scale_y(&self) -> f64 {
        (self.telemetry.source_height / self.telemetry.capture_bounds.height.max(1.0))
            * self.telemetry.dpi_scale.y
    }

    fn fit_to_canvas(&self, point: Point) -> Point {
        let raw_x = point.x * self.source_scale_x();
        let raw_y = point.y * self.source_scale_y();

        let clamped_x = raw_x.clamp(0.0, self.telemetry.source_width);
        let clamped_y = raw_y.clamp(0.0, self.telemetry.source_height);

        Point {
            x: self.fit_offset_x + clamped_x * self.fit_scale,
            y: self.fit_offset_y + clamped_y * self.fit_scale,
        }
    }

    fn is_idle(&self, index: usize, time_ms: f64) -> bool {
        if index == 0 || self.idle_timeout_ms <= 0.0 {
            return false;
        }
        let events = &self.telemetry.events;
        let current = &events[index];
        for i in (0..index).rev() {
            let prev = &events[i];
            if prev.x != current.x || prev.y != current.y || prev.is_click_edge() {
                return (time_ms - prev.t_ms).max(0.0) >= self.idle_timeout_ms;
            }
        }
        (time_ms - current.t_ms).max(0.0) >= self.idle_timeout_ms
    }

    fn click_progress(&self, index: usize, time_ms: f64) -> Option<f64> {
        let events = &self.telemetry.events;
        let current = &events[index];
        if !current.is_click_edge() {
            return None;
        }

        let click_time = current.t_ms;
        if time_ms < click_time || time_ms > click_time + self.click_window_ms {
            return None;
        }

        // Triangle falloff: 0 -> 1 at half window -> 0 at end.
        let half = self.click_window_ms / 2.0;
        let progress = ((time_ms - click_time) / half).clamp(0.0, 2.0);
        Some(1.0 - (progress - 1.0).abs())
    }

    pub fn evaluate(&self, time_ms: f64) -> EvaluatedCursor {
        let Some(index) = self.find_event_index(time_ms) else {
            return EvaluatedCursor {
                x: 0.0,
                y: 0.0,
                visible: false,
                click_progress: None,
            };
        };

        let event = &self.telemetry.events[index];
        if !event.visible || self.is_idle(index, time_ms) {
            return EvaluatedCursor {
                x: 0.0,
                y: 0.0,
                visible: false,
                click_progress: None,
            };
        }

        let smooth = self.smooth_position(index);
        let fitted = self.fit_to_canvas(smooth);

        EvaluatedCursor {
            x: fitted.x,
            y: fitted.y,
            visible: true,
            click_progress: self.click_progress(index, time_ms),
        }
    }
}

pub fn evaluate_at(
    telemetry: CursorTelemetry,
    canvas: Canvas,
    time_ms: f64,
) -> Result<EvaluatedCursor, String> {
    Evaluator::new(telemetry, canvas).map(|e| e.evaluate(time_ms))
}

pub fn load_telemetry(json: &str) -> Result<CursorTelemetry, String> {
    serde_json::from_str(json).map_err(|e| e.to_string())
}

// WASM bindings are intentionally minimal; they are activated only when building for wasm32.
#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct WasmEvaluator {
        inner: Evaluator,
    }

    #[wasm_bindgen]
    impl WasmEvaluator {
        #[wasm_bindgen(constructor)]
        pub fn new(json: &str, canvas_json: &str) -> Result<WasmEvaluator, String> {
            let telemetry = load_telemetry(json)?;
            let canvas: Canvas = serde_json::from_str(canvas_json).map_err(|e| e.to_string())?;
            let inner = Evaluator::new(telemetry, canvas)?;
            Ok(Self { inner })
        }

        #[wasm_bindgen]
        pub fn evaluate(&self, time_ms: f64) -> String {
            serde_json::to_string(&self.inner.evaluate(time_ms)).unwrap_or_default()
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
