use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub use crate::CursorShapeInfo;

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

/// Resolve a shape id (usually from telemetry) to a canonical asset id.
///
/// The map contains two kinds of lookups:
///   * direct asset ids (`modern-neon`, `shape-arrow`, etc.) pass through;
///   * recorded system `kind` strings (`arrow`, `hand`, etc.) are mapped to the
///     generic shape asset for that kind;
///   * V2 `shapeId` hashes are looked up in the provided `shapes` metadata to
///     find their `kind`, then mapped to the generic shape asset.
pub fn resolve_cursor_shape_id(shape_id: &str, shapes: &[CursorShapeInfo]) -> String {
    if shape_id.is_empty() {
        return shape_id.to_string();
    }

    // Direct asset ids are stored in the manifest.
    if resolve_cursor_asset(shape_id).is_some() {
        return shape_id.to_string();
    }

    static SHAPE_MAP: OnceLock<HashMap<String, String>> = OnceLock::new();
    let map = SHAPE_MAP.get_or_init(|| {
        serde_json::from_str(include_str!("../shape-map.json"))
            .expect("embedded cursor shape map should be valid JSON")
    });

    // Legacy V1 kind strings and the recorded-system `recorded-system` entry.
    if let Some(asset_id) = map.get(shape_id) {
        return asset_id.clone();
    }

    // V2 shape hashes: find the metadata for this hash and map from its kind.
    if let Some(shape) = shapes.iter().find(|s| s.shape_id == shape_id) {
        if let Some(asset_id) = map.get(&shape.kind) {
            return asset_id.clone();
        }
    }

    shape_id.to_string()
}

/// Resolve an asset id, falling back to a default arrow cursor.
pub fn resolve_cursor_asset_or_default(id: &str) -> &'static CursorAsset {
    resolve_cursor_asset(id)
        .or_else(|| resolve_cursor_asset("default"))
        .expect("default cursor asset must exist in the manifest")
}
