use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontSpec {
    pub family: String,
    pub file: String,
    pub license: String,
}

/// The bundled font manifest is shared by preview and native export adapters.
pub fn default_font_bundle() -> Vec<FontSpec> {
    vec![
        FontSpec {
            family: "sans".to_string(),
            file: "Inter-VariableFont_slnt,wght.ttf".to_string(),
            license: "OFL-1.1".to_string(),
        },
        FontSpec {
            family: "serif".to_string(),
            file: "SourceSerif4-Regular.ttf".to_string(),
            license: "OFL-1.1".to_string(),
        },
        FontSpec {
            family: "mono".to_string(),
            file: "JetBrainsMono-Regular.ttf".to_string(),
            license: "OFL-1.1".to_string(),
        },
        FontSpec {
            family: "heading".to_string(),
            file: "Outfit-VariableFont_wght.ttf".to_string(),
            license: "OFL-1.1".to_string(),
        },
    ]
}

#[derive(Debug, Clone, Default)]
pub struct FontCache {
    specs: Vec<FontSpec>,
}

impl FontCache {
    pub fn new(specs: Vec<FontSpec>) -> Self {
        Self { specs }
    }

    pub fn specs(&self) -> &[FontSpec] {
        &self.specs
    }
}
