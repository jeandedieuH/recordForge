#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

use crate::{OverlayEngine, OverlayRenderPlan};

#[wasm_bindgen]
pub struct WasmOverlayEngine {
    inner: OverlayEngine,
}

#[wasm_bindgen]
impl WasmOverlayEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(plan_json: &str) -> Result<WasmOverlayEngine, String> {
        let plan: OverlayRenderPlan =
            serde_json::from_str(plan_json).map_err(|error| error.to_string())?;
        let inner = OverlayEngine::from_render_plan(plan).map_err(|error| error.to_string())?;
        Ok(Self { inner })
    }

    #[wasm_bindgen]
    pub fn evaluate(&self, time_ms: f64) -> String {
        let time_ms = normalize_time_ms(time_ms);
        match serde_json::to_string(&self.inner.evaluate(time_ms)) {
            Ok(display_list) => display_list,
            Err(_) => String::from("{\"timeMs\":0,\"items\":[]}"),
        }
    }
}

fn normalize_time_ms(time_ms: f64) -> u64 {
    if !time_ms.is_finite() || time_ms <= 0.0 {
        return 0;
    }
    time_ms.min(u64::MAX as f64).floor() as u64
}
