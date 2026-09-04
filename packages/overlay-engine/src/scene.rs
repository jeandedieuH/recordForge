use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::animation::OverlayAnimation;
use crate::fonts::FontCache;
use crate::fonts::FontSpec;
use crate::images::ImageCache;
use crate::OverlayError;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCanvas {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlayTransform {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
    pub z_index: i32,
    pub opacity: f64,
}

impl Default for OverlayTransform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: 0.0,
            anchor_x: 0.5,
            anchor_y: 0.5,
            z_index: 0,
            opacity: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayAsset {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRenderPlan {
    #[serde(default = "default_version")]
    pub version: u32,
    pub canvas: OverlayCanvas,
    #[serde(default)]
    pub items: Vec<OverlayItem>,
    #[serde(default)]
    pub assets: Vec<OverlayAsset>,
    #[serde(default)]
    pub fonts: Vec<FontSpec>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayItemBase {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub transform: OverlayTransform,
    #[serde(default)]
    pub animation: OverlayAnimation,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDetails {
    pub annotation_type: String,
    #[serde(default)]
    pub end_x: Option<f64>,
    #[serde(default)]
    pub end_y: Option<f64>,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub stroke_style: String,
    pub fill_color: String,
    pub fill_opacity: f64,
    pub corner_radius: f64,
    pub arrow_end_head: String,
    pub arrow_start_head: String,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
    #[serde(default)]
    pub text: Option<String>,
    pub text_color: String,
    pub font_size: f64,
}

fn deserialize_flexible_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct FlexibleStringVisitor;

    impl<'de> serde::de::Visitor<'de> for FlexibleStringVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or integer")
        }

        fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(v.to_string())
        }

        fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(v.to_string())
        }

        fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(v.to_string())
        }

        fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(v.round().to_string())
        }
    }

    deserializer.deserialize_any(FlexibleStringVisitor)
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDetails {
    pub preset_id: String,
    pub category: String,
    pub primary_text: String,
    #[serde(default)]
    pub secondary_text: Option<String>,
    #[serde(default)]
    pub tag_text: Option<String>,
    pub alignment: String,
    pub font_family: String,
    pub font_size: f64,
    #[serde(deserialize_with = "deserialize_flexible_string")]
    pub font_weight: String,
    pub text_color: String,
    pub secondary_text_color: String,
    pub accent_color: String,
    pub backdrop_style: String,
    pub backdrop_color: String,
    pub backdrop_opacity: f64,
    pub backdrop_blur: f64,
    pub backdrop_border_radius: f64,
    pub backdrop_padding_x: f64,
    pub backdrop_padding_y: f64,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
    #[serde(default = "default_true")]
    pub auto_scale_text: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDetails {
    pub asset_id: String,
    pub fit: String,
    pub border_radius: f64,
    pub border_width: f64,
    pub border_color: String,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OverlayItem {
    Annotation {
        #[serde(flatten)]
        base: OverlayItemBase,
        #[serde(flatten)]
        details: AnnotationDetails,
    },
    Text {
        #[serde(flatten)]
        base: OverlayItemBase,
        #[serde(flatten)]
        details: TextDetails,
    },
    Image {
        #[serde(flatten)]
        base: OverlayItemBase,
        #[serde(flatten)]
        details: ImageDetails,
    },
}

fn default_enabled() -> bool {
    true
}

impl OverlayItem {
    pub fn id(&self) -> &str {
        self.base().id.as_str()
    }

    pub fn timing(&self) -> (u64, u64) {
        let base = self.base();
        (base.start_ms, base.end_ms)
    }

    pub fn transform(&self) -> &OverlayTransform {
        &self.base().transform
    }

    pub fn animation(&self) -> &OverlayAnimation {
        &self.base().animation
    }

    pub fn enabled(&self) -> bool {
        self.base().enabled
    }

    fn base(&self) -> &OverlayItemBase {
        match self {
            Self::Annotation { base, .. } | Self::Text { base, .. } | Self::Image { base, .. } => {
                base
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayAnnotation {
    pub id: String,
    pub z_index: i32,
    pub transform: OverlayTransform,
    pub animation_progress: f64,
    pub draw_progress: f64,
    pub annotation_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_y: Option<f64>,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub stroke_style: String,
    pub fill_color: String,
    pub fill_opacity: f64,
    pub corner_radius: f64,
    pub arrow_end_head: String,
    pub arrow_start_head: String,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub text_color: String,
    pub font_size: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayText {
    pub id: String,
    pub z_index: i32,
    pub transform: OverlayTransform,
    pub animation_progress: f64,
    pub text_progress: f64,
    pub preset_id: String,
    pub category: String,
    pub primary_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_text: Option<String>,
    pub alignment: String,
    pub font_family: String,
    pub font_size: f64,
    #[serde(deserialize_with = "deserialize_flexible_string")]
    pub font_weight: String,
    pub text_color: String,
    pub secondary_text_color: String,
    pub accent_color: String,
    pub backdrop_style: String,
    pub backdrop_color: String,
    pub backdrop_opacity: f64,
    pub backdrop_blur: f64,
    pub backdrop_border_radius: f64,
    pub backdrop_padding_x: f64,
    pub backdrop_padding_y: f64,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
    #[serde(default = "default_true")]
    pub auto_scale_text: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayImage {
    pub id: String,
    pub z_index: i32,
    pub transform: OverlayTransform,
    pub animation_progress: f64,
    pub asset_id: String,
    pub fit: String,
    pub border_radius: f64,
    pub border_width: f64,
    pub border_color: String,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DisplayItem {
    Annotation {
        #[serde(flatten)]
        item: DisplayAnnotation,
    },
    Text {
        #[serde(flatten)]
        item: DisplayText,
    },
    Image {
        #[serde(flatten)]
        item: DisplayImage,
    },
}

impl DisplayItem {
    pub fn id(&self) -> &str {
        match self {
            Self::Annotation { item } => item.id.as_str(),
            Self::Text { item } => item.id.as_str(),
            Self::Image { item } => item.id.as_str(),
        }
    }

    pub fn z_index(&self) -> i32 {
        match self {
            Self::Annotation { item } => item.z_index,
            Self::Text { item } => item.z_index,
            Self::Image { item } => item.z_index,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayList {
    pub time_ms: u64,
    pub items: Vec<DisplayItem>,
}

#[derive(Debug, Clone)]
pub(crate) struct Scene {
    canvas: OverlayCanvas,
    items: Vec<OverlayItem>,
    assets: Vec<OverlayAsset>,
    fonts: FontCache,
    images: ImageCache,
}

impl Scene {
    pub(crate) fn from_plan(mut plan: OverlayRenderPlan) -> Result<Self, OverlayError> {
        if plan.version != default_version() {
            return Err(OverlayError::UnsupportedVersion(plan.version));
        }
        if plan.canvas.width == 0 || plan.canvas.height == 0 {
            return Err(OverlayError::InvalidPlan(
                "canvas dimensions must be positive".to_string(),
            ));
        }

        validate_assets(&plan.assets)?;
        validate_fonts(&plan.fonts)?;

        let mut ids = HashSet::with_capacity(plan.items.len());
        for item in &plan.items {
            if item.id().trim().is_empty() {
                return Err(OverlayError::InvalidPlan(
                    "overlay item id must not be empty".to_string(),
                ));
            }
            if !ids.insert(item.id()) {
                return Err(OverlayError::DuplicateItemId(item.id().to_string()));
            }
            let (start_ms, end_ms) = item.timing();
            if end_ms <= start_ms {
                return Err(OverlayError::InvalidPlan(format!(
                    "overlay item {} must have a positive duration",
                    item.id()
                )));
            }
            validate_item(item)?;
        }

        // Sort once at scene construction so every frame preserves the same
        // deterministic z-order without re-sorting the retained scene.
        plan.items.sort_by_key(|item| item.transform().z_index);

        Ok(Self {
            canvas: plan.canvas,
            items: plan.items,
            assets: plan.assets,
            fonts: FontCache::new(plan.fonts),
            images: ImageCache::new(),
        })
    }

    pub(crate) fn canvas(&self) -> OverlayCanvas {
        self.canvas
    }

    pub(crate) fn items(&self) -> &[OverlayItem] {
        &self.items
    }

    #[allow(dead_code)]
    pub(crate) fn assets(&self) -> &[OverlayAsset] {
        &self.assets
    }

    #[allow(dead_code)]
    pub(crate) fn fonts(&self) -> &FontCache {
        &self.fonts
    }

    pub(crate) fn images(&self) -> &ImageCache {
        &self.images
    }

    pub(crate) fn images_mut(&mut self) -> &mut ImageCache {
        &mut self.images
    }
}

fn validate_assets(assets: &[OverlayAsset]) -> Result<(), OverlayError> {
    let mut ids = HashSet::with_capacity(assets.len());
    for asset in assets {
        if asset.id.trim().is_empty() {
            return Err(OverlayError::InvalidPlan(
                "overlay asset id must not be empty".to_string(),
            ));
        }
        if !ids.insert(asset.id.as_str()) {
            return Err(OverlayError::DuplicateAssetId(asset.id.clone()));
        }
        if asset.kind.trim().is_empty() {
            return Err(OverlayError::InvalidPlan(format!(
                "overlay asset {} must have a kind",
                asset.id
            )));
        }
        if asset.width == Some(0) || asset.height == Some(0) {
            return Err(OverlayError::InvalidPlan(format!(
                "overlay asset {} dimensions must be positive",
                asset.id
            )));
        }
    }
    Ok(())
}

fn validate_fonts(fonts: &[FontSpec]) -> Result<(), OverlayError> {
    let mut families = HashSet::with_capacity(fonts.len());
    for font in fonts {
        if font.family.trim().is_empty() || font.file.trim().is_empty() {
            return Err(OverlayError::InvalidPlan(
                "overlay fonts require a family and file".to_string(),
            ));
        }
        if !families.insert(font.family.as_str()) {
            return Err(OverlayError::InvalidPlan(format!(
                "duplicate overlay font family {}",
                font.family
            )));
        }
    }
    Ok(())
}

fn validate_item(item: &OverlayItem) -> Result<(), OverlayError> {
    validate_transform(item.transform(), item.id())?;

    match item {
        OverlayItem::Annotation { details, .. } => {
            validate_optional_finite(details.end_x, "endX", item.id())?;
            validate_optional_finite(details.end_y, "endY", item.id())?;
            validate_non_negative(details.stroke_width, "strokeWidth", item.id())?;
            validate_unit(details.fill_opacity, "fillOpacity", item.id())?;
            validate_non_negative(details.corner_radius, "cornerRadius", item.id())?;
            validate_non_negative(details.shadow_blur, "shadowBlur", item.id())?;
            validate_minimum(details.font_size, 8.0, "fontSize", item.id())?;
        }
        OverlayItem::Text { details, .. } => {
            if details.primary_text.is_empty() {
                return Err(OverlayError::InvalidPlan(format!(
                    "overlay text {} must not be empty",
                    item.id()
                )));
            }
            validate_minimum(details.font_size, 8.0, "fontSize", item.id())?;
            validate_unit(details.backdrop_opacity, "backdropOpacity", item.id())?;
            for (name, value) in [
                ("backdropBlur", details.backdrop_blur),
                ("backdropBorderRadius", details.backdrop_border_radius),
                ("backdropPaddingX", details.backdrop_padding_x),
                ("backdropPaddingY", details.backdrop_padding_y),
                ("shadowBlur", details.shadow_blur),
            ] {
                validate_non_negative(value, name, item.id())?;
            }
        }
        OverlayItem::Image { details, .. } => {
            if details.asset_id.trim().is_empty() {
                return Err(OverlayError::InvalidPlan(format!(
                    "overlay image {} must reference an asset",
                    item.id()
                )));
            }
            if !matches!(details.fit.as_str(), "contain" | "cover" | "fill") {
                return Err(OverlayError::InvalidPlan(format!(
                    "overlay image {} has an unsupported fit mode",
                    item.id()
                )));
            }
            validate_non_negative(details.border_radius, "borderRadius", item.id())?;
            validate_non_negative(details.border_width, "borderWidth", item.id())?;
            validate_non_negative(details.shadow_blur, "shadowBlur", item.id())?;
        }
    }

    Ok(())
}

fn validate_transform(transform: &OverlayTransform, item_id: &str) -> Result<(), OverlayError> {
    let values = [
        transform.x,
        transform.y,
        transform.width,
        transform.height,
        transform.rotation,
        transform.anchor_x,
        transform.anchor_y,
        transform.opacity,
    ];
    if values.iter().any(|value| !value.is_finite()) {
        return Err(OverlayError::InvalidPlan(format!(
            "overlay item {item_id} has a non-finite transform"
        )));
    }
    if transform.width < 0.0 || transform.height < 0.0 {
        return Err(OverlayError::InvalidPlan(format!(
            "overlay item {item_id} has a negative size"
        )));
    }
    if !(0.0..=1.0).contains(&transform.anchor_x)
        || !(0.0..=1.0).contains(&transform.anchor_y)
        || !(0.0..=1.0).contains(&transform.opacity)
    {
        return Err(OverlayError::InvalidPlan(format!(
            "overlay item {item_id} has an invalid transform range"
        )));
    }
    Ok(())
}

fn validate_finite(value: f64, field: &str, item_id: &str) -> Result<(), OverlayError> {
    if value.is_finite() {
        return Ok(());
    }
    Err(OverlayError::InvalidPlan(format!(
        "overlay item {item_id} has a non-finite {field}"
    )))
}

fn validate_non_negative(value: f64, field: &str, item_id: &str) -> Result<(), OverlayError> {
    validate_finite(value, field, item_id)?;
    if value < 0.0 {
        return Err(OverlayError::InvalidPlan(format!(
            "overlay item {item_id} has a negative {field}"
        )));
    }
    Ok(())
}

fn validate_minimum(
    value: f64,
    minimum: f64,
    field: &str,
    item_id: &str,
) -> Result<(), OverlayError> {
    validate_finite(value, field, item_id)?;
    if value < minimum {
        return Err(OverlayError::InvalidPlan(format!(
            "overlay item {item_id} has an invalid {field}"
        )));
    }
    Ok(())
}

fn validate_unit(value: f64, field: &str, item_id: &str) -> Result<(), OverlayError> {
    validate_finite(value, field, item_id)?;
    if !(0.0..=1.0).contains(&value) {
        return Err(OverlayError::InvalidPlan(format!(
            "overlay item {item_id} has an invalid {field}"
        )));
    }
    Ok(())
}

fn validate_optional_finite(
    value: Option<f64>,
    field: &str,
    item_id: &str,
) -> Result<(), OverlayError> {
    if let Some(value) = value {
        validate_finite(value, field, item_id)?;
    }
    Ok(())
}
