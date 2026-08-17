#[cfg(feature = "native-render")]
use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFit {
    Contain,
    Cover,
    Fill,
}

impl ImageFit {
    pub fn from_str_lossy(fit: &str) -> Self {
        match fit {
            "cover" => Self::Cover,
            "fill" => Self::Fill,
            _ => Self::Contain,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetRef {
    pub asset_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Cache policy shared by the preview and native image adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageCachePolicy {
    pub max_bytes: usize,
}

impl Default for ImageCachePolicy {
    fn default() -> Self {
        Self {
            max_bytes: 100 * 1024 * 1024,
        }
    }
}

/// In-memory cache of decoded image pixmaps used during export and native rendering.
#[derive(Debug, Clone, Default)]
pub struct ImageCache {
    #[cfg(feature = "native-render")]
    pixmaps: HashMap<String, tiny_skia::Pixmap>,
    policy: ImageCachePolicy,
}

impl ImageCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_policy(policy: ImageCachePolicy) -> Self {
        Self {
            #[cfg(feature = "native-render")]
            pixmaps: HashMap::new(),
            policy,
        }
    }

    pub fn policy(&self) -> ImageCachePolicy {
        self.policy
    }

    #[cfg(feature = "native-render")]
    pub fn get(&self, asset_id: &str) -> Option<&tiny_skia::Pixmap> {
        self.pixmaps.get(asset_id)
    }

    #[cfg(feature = "native-render")]
    pub fn insert_pixmap(&mut self, asset_id: String, pixmap: tiny_skia::Pixmap) {
        self.pixmaps.insert(asset_id, pixmap);
    }

    #[cfg(feature = "native-render")]
    pub fn insert_png_bytes(
        &mut self,
        asset_id: &str,
        bytes: &[u8],
    ) -> Result<(), crate::OverlayError> {
        let pixmap = decode_png(bytes)?;
        self.pixmaps.insert(asset_id.to_string(), pixmap);
        Ok(())
    }

    #[cfg(feature = "native-render")]
    pub fn insert_svg_bytes(
        &mut self,
        asset_id: &str,
        bytes: &[u8],
    ) -> Result<(), crate::OverlayError> {
        let pixmap = decode_svg(bytes)?;
        self.pixmaps.insert(asset_id.to_string(), pixmap);
        Ok(())
    }

    #[cfg(feature = "native-render")]
    pub fn insert_rgba(
        &mut self,
        asset_id: &str,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), crate::OverlayError> {
        let pixmap = from_rgba(width, height, rgba)?;
        self.pixmaps.insert(asset_id.to_string(), pixmap);
        Ok(())
    }

    #[cfg(feature = "native-render")]
    pub fn clear(&mut self) {
        self.pixmaps.clear();
    }

    #[cfg(feature = "native-render")]
    pub fn len(&self) -> usize {
        self.pixmaps.len()
    }

    #[cfg(feature = "native-render")]
    pub fn is_empty(&self) -> bool {
        self.pixmaps.is_empty()
    }
}

#[cfg(feature = "native-render")]
pub fn decode_png(bytes: &[u8]) -> Result<tiny_skia::Pixmap, crate::OverlayError> {
    tiny_skia::Pixmap::decode_png(bytes)
        .map_err(|e| crate::OverlayError::InvalidPlan(format!("failed to decode PNG: {e}")))
}

#[cfg(feature = "native-render")]
pub fn decode_svg(bytes: &[u8]) -> Result<tiny_skia::Pixmap, crate::OverlayError> {
    let svg_str = std::str::from_utf8(bytes)
        .map_err(|e| crate::OverlayError::InvalidPlan(format!("invalid UTF-8 in SVG: {e}")))?;
    let options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_str(svg_str, &options)
        .map_err(|e| crate::OverlayError::InvalidPlan(format!("failed to parse SVG: {e}")))?;
    let size = tree.size();
    let width = (size.width().ceil() as u32).max(1);
    let height = (size.height().ceil() as u32).max(1);
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| crate::OverlayError::InvalidPlan("SVG dimensions are invalid".into()))?;
    resvg::render(&tree, tiny_skia::Transform::identity(), &mut pixmap.as_mut());
    Ok(pixmap)
}

#[cfg(feature = "native-render")]
pub fn from_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<tiny_skia::Pixmap, crate::OverlayError> {
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| crate::OverlayError::InvalidPlan("dimensions too large".into()))?;

    if rgba.len() != expected_len {
        return Err(crate::OverlayError::InvalidPlan(format!(
            "RGBA byte length mismatch: expected {expected_len}, got {}",
            rgba.len()
        )));
    }

    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| crate::OverlayError::InvalidPlan("invalid image dimensions".into()))?;
    pixmap.data_mut().copy_from_slice(rgba);
    Ok(pixmap)
}
