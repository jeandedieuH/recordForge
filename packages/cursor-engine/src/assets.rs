use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Static cursor asset data shared with the React overlay.
///
/// The manifest is generated from `packages/cursor-core/src/assets.ts` and
/// embedded at compile time so the Rust rasterizer and TypeScript preview agree
/// on geometry, hotspots, and view boxes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAsset {
    pub id: String,
    pub label: String,
    pub view_box: String,
    pub width: f64,
    pub height: f64,
    pub hotspot_x: f64,
    pub hotspot_y: f64,
    pub is_center_hotspot: bool,
    pub svg: String,
}

/// Resolve an asset id (usually from telemetry `shapeId`) to a static asset.
pub fn resolve_cursor_asset(id: &str) -> Option<&'static CursorAsset> {
    static MANIFEST: OnceLock<HashMap<String, CursorAsset>> = OnceLock::new();
    MANIFEST
        .get_or_init(|| {
            serde_json::from_str(include_str!("../assets.json"))
                .expect("embedded cursor asset manifest should be valid JSON")
        })
        .get(id)
}

/// Resolve an asset id, falling back to a default arrow cursor.
pub fn resolve_cursor_asset_or_default(id: &str) -> &'static CursorAsset {
    resolve_cursor_asset(id)
        .or_else(|| resolve_cursor_asset("default"))
        .expect("default cursor asset must exist in the manifest")
}
