use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFit {
    Contain,
    Cover,
    Fill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetRef {
    pub asset_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Cache policy shared by the future preview and native image adapters.
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
