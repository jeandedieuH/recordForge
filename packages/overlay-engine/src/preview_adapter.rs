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

    /// Patch item transforms/endpoints in place for interactive drags. The
    /// caller must keep every non-geometry field identical (item set, timing,
    /// animation, z-order); the export path still validates the full plan.
    #[wasm_bindgen]
    pub fn update_geometry(&mut self, patches_json: &str) -> Result<(), String> {
        self.inner
            .update_item_geometry_json(patches_json)
            .map_err(|error| error.to_string())
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

/// Size of the composed camera LUT texture (33).
#[wasm_bindgen]
pub fn camera_lut_size() -> u32 {
    crate::color::LUT_SIZE
}

/// Composed camera LUT as an RGBA8 3D texture (size³ × 4 bytes, red fastest).
/// Same table the export writes as a `.cube`, so preview and render agree.
#[wasm_bindgen]
pub fn camera_lut_texture(request_json: &str) -> Result<Vec<u8>, String> {
    let request: crate::color::CameraColorRequest =
        serde_json::from_str(request_json).map_err(|error| error.to_string())?;
    Ok(crate::color::compose_camera_lut(&request)
        .map_err(|error| error.to_string())?
        .to_rgba8())
}
