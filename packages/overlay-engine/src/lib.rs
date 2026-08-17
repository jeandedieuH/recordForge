//! Canonical overlay evaluation engine shared by preview and export.
//!
//! The retained scene and evaluator are intentionally independent from the
//! preview and native raster adapters so both consumers share the same timing,
//! transform, and z-order decisions.

use thiserror::Error;

pub mod animation;
mod evaluator;
#[cfg(feature = "native-render")]
mod export_adapter;
pub mod fonts;
pub mod images;
#[cfg(target_arch = "wasm32")]
mod preview_adapter;
pub mod scene;

pub use animation::{
    animation_at, eased_progress, opacity_at, OverlayAnimation, OverlayAnimationFrame,
    OverlayAnimationOutType, OverlayAnimationType, OverlayEasing,
};
pub use fonts::{default_font_bundle, FontCache, FontSpec};
pub use images::{ImageAssetRef, ImageCachePolicy, ImageFit};
#[cfg(target_arch = "wasm32")]
pub use preview_adapter::WasmOverlayEngine;
pub use scene::{
    AnnotationDetails, DisplayAnnotation, DisplayImage, DisplayItem, DisplayList, DisplayText,
    ImageDetails, OverlayAsset, OverlayCanvas, OverlayItem, OverlayItemBase, OverlayRenderPlan,
    OverlayTransform, TextDetails,
};

#[derive(Debug, Error)]
pub enum OverlayError {
    #[error("invalid overlay render plan: {0}")]
    InvalidPlan(String),
    #[error("unsupported overlay render plan version {0}")]
    UnsupportedVersion(u32),
    #[error("duplicate overlay item id: {0}")]
    DuplicateItemId(String),
    #[error("duplicate overlay asset id: {0}")]
    DuplicateAssetId(String),
    #[cfg(feature = "native-render")]
    #[error("native overlay rasterization is not implemented yet")]
    NativeRenderingUnavailable,
}

#[derive(Debug, Clone)]
pub struct OverlayEngine {
    scene: scene::Scene,
}

impl OverlayEngine {
    /// Build a retained scene from a validated overlay render plan.
    pub fn from_render_plan(plan: OverlayRenderPlan) -> Result<Self, OverlayError> {
        let scene = scene::Scene::from_plan(plan)?;
        Ok(Self { scene })
    }

    /// Build a retained scene from the JSON transport used by the WASM adapter.
    pub fn from_render_plan_json(plan_json: &str) -> Result<Self, OverlayError> {
        let plan = serde_json::from_str(plan_json)
            .map_err(|error| OverlayError::InvalidPlan(error.to_string()))?;
        Self::from_render_plan(plan)
    }

    /// Canvas dimensions used by the retained scene.
    pub fn canvas(&self) -> OverlayCanvas {
        self.scene.canvas()
    }

    /// Evaluate active overlays at a project timeline timestamp.
    pub fn evaluate(&self, time_ms: u64) -> DisplayList {
        evaluator::evaluate(&self.scene, time_ms)
    }

    /// Render the evaluated display list into a native pixmap.
    #[cfg(all(not(target_arch = "wasm32"), feature = "native-render"))]
    pub fn render_to_pixmap(
        &self,
        time_ms: u64,
        pixmap: &mut tiny_skia::Pixmap,
    ) -> Result<(), OverlayError> {
        export_adapter::render_to_pixmap(self, time_ms, pixmap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(id: &str, start_ms: u64, end_ms: u64, z_index: i32) -> OverlayItemBase {
        OverlayItemBase {
            id: id.to_string(),
            start_ms,
            end_ms,
            transform: OverlayTransform {
                width: 200.0,
                height: 100.0,
                z_index,
                ..Default::default()
            },
            animation: OverlayAnimation::default(),
            enabled: true,
        }
    }

    fn plan() -> OverlayRenderPlan {
        OverlayRenderPlan {
            version: 1,
            canvas: OverlayCanvas {
                width: 1920,
                height: 1080,
            },
            items: vec![
                OverlayItem::Image {
                    base: base("image", 0, 1_000, 10),
                    details: ImageDetails {
                        asset_id: "asset-image".to_string(),
                        fit: "contain".to_string(),
                        border_radius: 0.0,
                        border_width: 0.0,
                        border_color: "#ffffff".to_string(),
                        shadow_enabled: false,
                        shadow_color: "#000000".to_string(),
                        shadow_blur: 0.0,
                    },
                },
                OverlayItem::Annotation {
                    base: base("annotation", 100, 900, -1),
                    details: AnnotationDetails {
                        annotation_type: "rectangle".to_string(),
                        end_x: None,
                        end_y: None,
                        stroke_color: "#38bdf8".to_string(),
                        stroke_width: 4.0,
                        stroke_style: "solid".to_string(),
                        fill_color: "#38bdf8".to_string(),
                        fill_opacity: 0.1,
                        corner_radius: 8.0,
                        arrow_end_head: "none".to_string(),
                        arrow_start_head: "none".to_string(),
                        shadow_enabled: false,
                        shadow_color: "#000000".to_string(),
                        shadow_blur: 0.0,
                        text: None,
                        text_color: "#ffffff".to_string(),
                        font_size: 16.0,
                    },
                },
            ],
            assets: Vec::new(),
            fonts: Vec::new(),
        }
    }

    #[test]
    fn evaluates_active_items_in_z_order() {
        let engine = OverlayEngine::from_render_plan(plan()).expect("fixture plan is valid");
        let display_list = engine.evaluate(200);

        assert_eq!(display_list.items.len(), 2);
        assert_eq!(display_list.items[0].id(), "annotation");
        assert_eq!(display_list.items[1].id(), "image");
    }

    #[test]
    fn filters_items_outside_their_time_range() {
        let engine = OverlayEngine::from_render_plan(plan()).expect("fixture plan is valid");

        assert_eq!(engine.evaluate(50).items.len(), 1);
        assert_eq!(engine.evaluate(950).items.len(), 1);
        assert!(engine.evaluate(1_000).items.is_empty());
    }

    #[test]
    fn preserves_input_order_for_equal_z_indices() {
        let mut json = serde_json::to_value(plan()).expect("fixture plan serializes");
        json["items"][0]["transform"]["zIndex"] = serde_json::json!(10);
        json["items"][1]["transform"]["zIndex"] = serde_json::json!(10);
        let tied_plan: OverlayRenderPlan =
            serde_json::from_value(json).expect("tied fixture plan parses");

        let display_list = OverlayEngine::from_render_plan(tied_plan)
            .expect("tied fixture plan is valid")
            .evaluate(200);

        assert_eq!(
            display_list
                .items
                .iter()
                .map(DisplayItem::id)
                .collect::<Vec<_>>(),
            vec!["image", "annotation"]
        );
    }

    #[test]
    fn rejects_duplicate_item_ids() {
        let mut invalid = plan();
        invalid.items.push(invalid.items[0].clone());

        assert!(matches!(
            OverlayEngine::from_render_plan(invalid),
            Err(OverlayError::DuplicateItemId(id)) if id == "image"
        ));
    }

    #[test]
    fn rejects_entrance_only_animation_types_on_exit() {
        let mut json = serde_json::to_string(&plan()).expect("fixture plan serializes");
        json = json.replace("\"outType\":\"fade\"", "\"outType\":\"draw\"");

        assert!(matches!(
            OverlayEngine::from_render_plan_json(&json),
            Err(OverlayError::InvalidPlan(_))
        ));
    }

    #[test]
    fn serializes_transport_names_in_camel_case() {
        let json = serde_json::to_value(plan()).expect("plan serializes");

        assert!(json["canvas"]["width"].is_number());
        assert!(json["items"][0]["startMs"].is_number());
        assert!(json["items"][0]["transform"]["zIndex"].is_number());
    }
}
