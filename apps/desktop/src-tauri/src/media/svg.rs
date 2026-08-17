use std::path::Path;

use regex::Regex;

use crate::errors::{InternalError, Result};

const MAX_SVG_BYTES: u64 = 5 * 1024 * 1024;

/// Read and validate an SVG before it is copied into a project or rendered as
/// a derivative. SVG is treated as untrusted markup rather than as a normal
/// image file because it can contain scripts, event handlers, and remote URLs.
pub fn read_safe_svg(path: &Path) -> Result<Vec<u8>> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| InternalError::Storage(format!("read SVG metadata: {error}")))?;
    if metadata.len() > MAX_SVG_BYTES {
        return Err(InternalError::Media("SVG exceeds the 5 MiB safety limit".into()).into());
    }

    let bytes = std::fs::read(path)
        .map_err(|error| InternalError::Storage(format!("read SVG: {error}")))?;
    validate_svg_bytes(&bytes)?;
    Ok(bytes)
}

/// Validate SVG markup without parsing or executing it.
pub fn validate_svg_bytes(bytes: &[u8]) -> Result<()> {
    let markup = std::str::from_utf8(bytes)
        .map_err(|_| InternalError::Media("SVG must be valid UTF-8".into()))?;
    let lower = markup.to_ascii_lowercase();

    let forbidden_tokens = [
        "<script",
        "</script",
        "javascript:",
        "vbscript:",
        "data:text/html",
        "<!doctype",
        "<!entity",
        "<foreignobject",
    ];
    if forbidden_tokens.iter().any(|token| lower.contains(token)) {
        return Err(InternalError::Media(
            "SVG contains an executable or external content construct".into(),
        )
        .into());
    }

    let event_handler = Regex::new(r"(?i)\bon[a-z0-9_-]+\s*=")
        .map_err(|error| InternalError::Media(format!("compile SVG safety rule: {error}")))?;
    if event_handler.is_match(markup) {
        return Err(InternalError::Media("SVG event handlers are not allowed".into()).into());
    }

    let external_reference = Regex::new(
        r#"(?i)(?:href|xlink:href|src)\s*=\s*[\"']\s*(?:https?:|file:|//)|url\(\s*(?:https?:|file:)"#,
    )
    .map_err(|error| InternalError::Media(format!("compile SVG reference rule: {error}")))?;
    if external_reference.is_match(markup) {
        return Err(InternalError::Media("SVG external references are not allowed".into()).into());
    }

    if !lower.contains("<svg") {
        return Err(InternalError::Media("file is not an SVG document".into()).into());
    }

    Ok(())
}

pub fn is_svg_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_static_svg_markup() {
        assert!(validate_svg_bytes(
            br#"<svg viewBox='0 0 10 10'><rect width='10' height='10'/></svg>"#
        )
        .is_ok());
    }

    #[test]
    fn rejects_scripts_event_handlers_and_external_references() {
        for svg in [
            br#"<svg><script>alert(1)</script></svg>"#.as_slice(),
            br#"<svg><rect onload='alert(1)'/></svg>"#.as_slice(),
            br#"<svg><image href='https://example.com/a.png'/></svg>"#.as_slice(),
        ] {
            assert!(validate_svg_bytes(svg).is_err());
        }
    }
}
