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

/// Map a semantic font family name to a font family list for SVG/canvas text rendering.
pub fn resolve_font_family(family: &str) -> &'static str {
    match family {
        "serif" => "Source Serif 4, Georgia, serif",
        "mono" => "JetBrains Mono, Consolas, monospace",
        "heading" => "Outfit, Inter, Arial, sans-serif",
        _ => "Inter, Segoe UI, Arial, sans-serif",
    }
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

#[cfg(feature = "native-render")]
use std::sync::{Arc, OnceLock};

#[cfg(feature = "native-render")]
static SHARED_FONT_DB: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();

#[cfg(feature = "native-render")]
pub fn get_shared_font_database() -> Arc<resvg::usvg::fontdb::Database> {
    SHARED_FONT_DB
        .get_or_init(|| {
            let mut db = resvg::usvg::fontdb::Database::new();
            db.load_system_fonts();
            db.set_sans_serif_family("Arial");
            db.set_serif_family("Times New Roman");
            db.set_monospace_family("Courier New");
            Arc::new(db)
        })
        .clone()
}

