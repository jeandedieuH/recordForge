//! Canonical overlay evaluation engine shared by preview and export.
//!
//! The retained scene and evaluator are intentionally independent from the
//! preview and native raster adapters so both consumers share the same timing,
//! transform, and z-order decisions.

use thiserror::Error;

pub mod animation;
#[cfg(any(feature = "native-render", test))]
mod connectors;
mod evaluator;
#[cfg(feature = "native-render")]
mod export_adapter;
pub mod fonts;
pub mod images;
#[cfg(target_arch = "wasm32")]
mod preview_adapter;
pub mod scene;
pub mod titles;

pub use animation::{
    animation_at, eased_progress, opacity_at, OverlayAnimation, OverlayAnimationFrame,
    OverlayAnimationOutType, OverlayAnimationType, OverlayEasing,
};
#[cfg(feature = "native-render")]
pub use fonts::get_shared_font_database;
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

    /// Access the retained image cache.
    pub fn images(&self) -> &images::ImageCache {
        self.scene.images()
    }

    /// Access the retained image cache mutably.
    pub fn images_mut(&mut self) -> &mut images::ImageCache {
        self.scene.images_mut()
    }

    /// Register a decoded pixmap for an image asset.
    #[cfg(feature = "native-render")]
    pub fn register_image(&mut self, asset_id: String, pixmap: tiny_skia::Pixmap) {
        self.scene.images_mut().insert_pixmap(asset_id, pixmap);
    }

    /// Register and decode a PNG image asset from raw file bytes.
    #[cfg(feature = "native-render")]
    pub fn register_image_png(&mut self, asset_id: &str, bytes: &[u8]) -> Result<(), OverlayError> {
        self.scene.images_mut().insert_png_bytes(asset_id, bytes)
    }

    /// Register and decode an SVG image asset from raw file bytes.
    #[cfg(feature = "native-render")]
    pub fn register_image_svg(&mut self, asset_id: &str, bytes: &[u8]) -> Result<(), OverlayError> {
        self.scene.images_mut().insert_svg_bytes(asset_id, bytes)
    }

    /// Register an image asset from pre-decoded raw RGBA bytes.
    #[cfg(feature = "native-render")]
    pub fn register_image_rgba(
        &mut self,
        asset_id: &str,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), OverlayError> {
        self.scene
            .images_mut()
            .insert_rgba(asset_id, width, height, rgba)
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

    /// Render into a pixmap covering only the canvas crop whose top-left
    /// corner sits at `origin` — the export plate feed ships per-plane
    /// bounding rects instead of full canvases.
    #[cfg(all(not(target_arch = "wasm32"), feature = "native-render"))]
    pub fn render_to_pixmap_cropped(
        &self,
        time_ms: u64,
        pixmap: &mut tiny_skia::Pixmap,
        origin: (f64, f64),
    ) -> Result<(), OverlayError> {
        export_adapter::render_to_pixmap_at(
            self,
            time_ms,
            pixmap,
            (origin.0 as f32, origin.1 as f32),
        )
    }

    /// Union of every active item's canvas-space rect at `time_ms`, widened
    /// by a margin covering strokes, borders, shadows, backdrop blur and
    /// connector endpoints — the plate feed uses it to size the items plane.
    /// A spotlight annotation darkens the whole canvas, so it always reports
    /// the full canvas. `None` when nothing is active.
    pub fn items_bounds(&self, time_ms: u64) -> Option<(f64, f64, f64, f64)> {
        let canvas = self.canvas();
        let mut acc: Option<(f64, f64, f64, f64)> = None;
        for item in &self.evaluate(time_ms).items {
            let bounds = display_item_bounds(item, canvas.width, canvas.height);
            if let Some((x0, y0, x1, y1)) = bounds {
                acc = Some(match acc {
                    Some((ax0, ay0, ax1, ay1)) => {
                        (ax0.min(x0), ay0.min(y0), ax1.max(x1), ay1.max(y1))
                    }
                    None => (x0, y0, x1, y1),
                });
            }
        }
        acc
    }
}

/// Axis-aligned canvas bounds of one evaluated display item, including the
/// effects margin. All values are `(x0, y0, x1, y1)`.
fn display_item_bounds(
    item: &scene::DisplayItem,
    canvas_w: u32,
    canvas_h: u32,
) -> Option<(f64, f64, f64, f64)> {
    let (transform, pad, extra_point) = match item {
        scene::DisplayItem::Annotation { item } => {
            // Spotlight fills the canvas with a mask punched by its rect.
            if item.annotation_type == "spotlight" {
                return Some((0.0, 0.0, canvas_w as f64, canvas_h as f64));
            }
            (
                &item.transform,
                item.stroke_width / 2.0 + item.shadow_blur * 2.0,
                item.end_x.zip(item.end_y),
            )
        }
        scene::DisplayItem::Text { item } => (
            &item.transform,
            // Designed-title scenes can overhang the item box with descenders
            // and ornament paths; a font-proportional term covers the usual
            // case while shadows and backdrop blur add their own margins.
            item.shadow_blur * 2.0 + item.backdrop_blur + item.font_size * 0.4,
            None,
        ),
        scene::DisplayItem::Image { item } => (
            &item.transform,
            item.border_width + item.shadow_blur * 2.0,
            None,
        ),
    };
    let t = *transform;
    if !t.opacity.is_finite() || t.opacity <= 0.0 || t.width <= 0.0 || t.height <= 0.0 {
        return None;
    }
    // Rotate the rect's corners around its anchor pivot, then take the
    // axis-aligned hull. Callout tails and AA fringe ride on the fixed pad.
    let pivot_x = t.x + t.width * t.anchor_x;
    let pivot_y = t.y + t.height * t.anchor_y;
    let radians = t.rotation.to_radians();
    let (sin, cos) = radians.sin_cos();
    let mut x0 = f64::MAX;
    let mut y0 = f64::MAX;
    let mut x1 = f64::MIN;
    let mut y1 = f64::MIN;
    for corner in [
        (t.x, t.y),
        (t.x + t.width, t.y),
        (t.x + t.width, t.y + t.height),
        (t.x, t.y + t.height),
    ]
    .into_iter()
    .chain(extra_point)
    {
        let dx = corner.0 - pivot_x;
        let dy = corner.1 - pivot_y;
        let px = pivot_x + dx * cos - dy * sin;
        let py = pivot_y + dx * sin + dy * cos;
        x0 = x0.min(px);
        y0 = y0.min(py);
        x1 = x1.max(px);
        y1 = y1.max(py);
    }
    let pad = pad + 8.0;
    Some((
        (x0 - pad).max(0.0),
        (y0 - pad).max(0.0),
        (x1 + pad).min(canvas_w as f64),
        (y1 + pad).min(canvas_h as f64),
    ))
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
                        arrow_style: "straight".to_string(),
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

    #[cfg(feature = "native-render")]
    #[test]
    fn renders_annotations_and_images_to_pixmap() {
        let mut engine = OverlayEngine::from_render_plan(plan()).expect("fixture plan is valid");
        let raw_image_rgba = vec![255u8; 100 * 100 * 4];
        engine
            .register_image_rgba("asset-image", 100, 100, &raw_image_rgba)
            .expect("register raw image");

        let mut pixmap = tiny_skia::Pixmap::new(1920, 1080).expect("create pixmap");
        engine
            .render_to_pixmap(200, &mut pixmap)
            .expect("render to pixmap succeeds");

        // The rendered frame should not be completely empty/transparent
        let non_transparent = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
        assert!(non_transparent, "rendered pixmap should contain pixels");
    }

    #[cfg(feature = "native-render")]
    #[test]
    fn renders_all_annotation_shapes_to_pixmap() {
        let shapes = [
            "rectangle",
            "rounded-rect",
            "circle",
            "arrow",
            "line",
            "callout",
            "spotlight",
            "badge",
        ];

        let items: Vec<OverlayItem> = shapes
            .iter()
            .enumerate()
            .map(|(i, shape)| OverlayItem::Annotation {
                base: OverlayItemBase {
                    id: format!("ann-{shape}"),
                    start_ms: 0,
                    end_ms: 10_000,
                    transform: OverlayTransform {
                        x: (i * 100) as f64,
                        y: 100.0,
                        width: 150.0,
                        height: 100.0,
                        rotation: 5.0,
                        z_index: i as i32,
                        ..Default::default()
                    },
                    animation: OverlayAnimation::default(),
                    enabled: true,
                },
                details: AnnotationDetails {
                    annotation_type: shape.to_string(),
                    end_x: Some((i * 100 + 150) as f64),
                    end_y: Some(200.0),
                    stroke_color: "#ef4444".to_string(),
                    stroke_width: 3.0,
                    stroke_style: "dashed".to_string(),
                    fill_color: "#ef4444".to_string(),
                    fill_opacity: 0.25,
                    corner_radius: 12.0,
                    arrow_end_head: "arrow".to_string(),
                    arrow_start_head: "circle".to_string(),
                    arrow_style: "straight".to_string(),
                    shadow_enabled: true,
                    shadow_color: "rgba(0,0,0,0.5)".to_string(),
                    shadow_blur: 8.0,
                    text: Some("Label".to_string()),
                    text_color: "#ffffff".to_string(),
                    font_size: 14.0,
                },
            })
            .collect();

        let plan = OverlayRenderPlan {
            version: 1,
            canvas: OverlayCanvas {
                width: 1920,
                height: 1080,
            },
            items,
            assets: Vec::new(),
            fonts: Vec::new(),
        };

        let engine = OverlayEngine::from_render_plan(plan).expect("plan with all shapes is valid");
        let mut pixmap = tiny_skia::Pixmap::new(1920, 1080).expect("create pixmap");
        engine
            .render_to_pixmap(1000, &mut pixmap)
            .expect("render all shapes succeeds");

        let non_transparent = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
        assert!(non_transparent, "all shapes render to pixmap");
    }

    #[cfg(feature = "native-render")]
    #[test]
    fn renders_styled_text_presets_to_pixmap() {
        let text_item = OverlayItem::Text {
            base: OverlayItemBase {
                id: "title-1".to_string(),
                start_ms: 500,
                end_ms: 5000,
                transform: OverlayTransform {
                    x: 100.0,
                    y: 100.0,
                    width: 500.0,
                    height: 160.0,
                    z_index: 10,
                    ..Default::default()
                },
                animation: OverlayAnimation::default(),
                enabled: true,
            },
            details: TextDetails {
                preset_id: "glass-title".to_string(),
                category: "title".to_string(),
                primary_text: "High Fidelity Screen Recording".to_string(),
                secondary_text: Some("Built for desktop export".to_string()),
                tag_text: Some("PRO V2".to_string()),
                alignment: "left".to_string(),
                font_family: "sans".to_string(),
                font_size: 32.0,
                font_weight: "700".to_string(),
                text_color: "#ffffff".to_string(),
                secondary_text_color: "#94a3b8".to_string(),
                accent_color: "#38bdf8".to_string(),
                backdrop_style: "glass".to_string(),
                backdrop_color: "#0f172a".to_string(),
                backdrop_opacity: 0.85,
                backdrop_blur: 16.0,
                backdrop_border_radius: 16.0,
                backdrop_padding_x: 24.0,
                backdrop_padding_y: 18.0,
                shadow_enabled: true,
                shadow_color: "rgba(0,0,0,0.5)".to_string(),
                shadow_blur: 12.0,
                auto_scale_text: true,
                title_design: None,
            },
        };

        let plan = OverlayRenderPlan {
            version: 1,
            canvas: OverlayCanvas {
                width: 1920,
                height: 1080,
            },
            items: vec![text_item],
            assets: Vec::new(),
            fonts: Vec::new(),
        };

        let engine = OverlayEngine::from_render_plan(plan).expect("text plan is valid");
        let mut pixmap = tiny_skia::Pixmap::new(1920, 1080).expect("create pixmap");
        engine
            .render_to_pixmap(1500, &mut pixmap)
            .expect("render text succeeds");

        let non_transparent = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
        assert!(non_transparent, "text preset renders to pixmap");
    }

    #[test]
    #[cfg(feature = "native-render")]
    fn renders_multiline_text_and_annotations_to_pixmap() {
        let text_item = OverlayItem::Text {
            base: OverlayItemBase {
                id: "text-multiline-1".to_string(),
                start_ms: 0,
                end_ms: 5000,
                transform: OverlayTransform {
                    x: 100.0,
                    y: 100.0,
                    width: 500.0,
                    height: 220.0,
                    z_index: 10,
                    ..Default::default()
                },
                animation: OverlayAnimation::default(),
                enabled: true,
            },
            details: TextDetails {
                preset_id: "solid-title".to_string(),
                category: "title".to_string(),
                primary_text: "Line 1 Main Title\nLine 2 Main Title\nLine 3 Main Title".to_string(),
                secondary_text: Some("Subtitle Line 1\nSubtitle Line 2".to_string()),
                tag_text: Some("FEATURE".to_string()),
                alignment: "left".to_string(),
                font_family: "sans".to_string(),
                font_size: 28.0,
                font_weight: "700".to_string(),
                text_color: "#ffffff".to_string(),
                secondary_text_color: "#94a3b8".to_string(),
                accent_color: "#38bdf8".to_string(),
                backdrop_style: "solid".to_string(),
                backdrop_color: "#0f172a".to_string(),
                backdrop_opacity: 0.9,
                backdrop_blur: 0.0,
                backdrop_border_radius: 12.0,
                backdrop_padding_x: 20.0,
                backdrop_padding_y: 16.0,
                shadow_enabled: false,
                shadow_color: "#000000".to_string(),
                shadow_blur: 0.0,
                auto_scale_text: true,
                title_design: None,
            },
        };

        let callout_item = OverlayItem::Annotation {
            base: OverlayItemBase {
                id: "callout-multiline-1".to_string(),
                start_ms: 0,
                end_ms: 5000,
                transform: OverlayTransform {
                    x: 650.0,
                    y: 100.0,
                    width: 320.0,
                    height: 180.0,
                    z_index: 11,
                    ..Default::default()
                },
                animation: OverlayAnimation::default(),
                enabled: true,
            },
            details: AnnotationDetails {
                annotation_type: "callout".to_string(),
                end_x: None,
                end_y: None,
                stroke_color: "#38bdf8".to_string(),
                stroke_width: 3.0,
                stroke_style: "solid".to_string(),
                fill_color: "#0f172a".to_string(),
                fill_opacity: 0.9,
                corner_radius: 12.0,
                arrow_end_head: "none".to_string(),
                arrow_start_head: "none".to_string(),
                arrow_style: "straight".to_string(),
                shadow_enabled: false,
                shadow_color: "#000000".to_string(),
                shadow_blur: 0.0,
                text: Some("Callout Line 1\nCallout Line 2\nCallout Line 3".to_string()),
                text_color: "#ffffff".to_string(),
                font_size: 16.0,
            },
        };

        let plan = OverlayRenderPlan {
            version: 1,
            canvas: OverlayCanvas {
                width: 1920,
                height: 1080,
            },
            items: vec![text_item, callout_item],
            assets: Vec::new(),
            fonts: Vec::new(),
        };

        let engine = OverlayEngine::from_render_plan(plan).expect("plan is valid");
        let mut pixmap = tiny_skia::Pixmap::new(1920, 1080).expect("create pixmap");
        engine
            .render_to_pixmap(1000, &mut pixmap)
            .expect("render multiline items succeeds");

        let non_transparent = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
        assert!(non_transparent, "multiline items render to pixmap");
    }
}
