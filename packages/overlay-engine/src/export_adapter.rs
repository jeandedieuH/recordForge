#![cfg(feature = "native-render")]

use tiny_skia::Pixmap;

use crate::{OverlayEngine, OverlayError};

/// Native rasterization is intentionally reserved for the export phase.
pub(crate) fn render_to_pixmap(
    _engine: &OverlayEngine,
    _time_ms: u64,
    _pixmap: &mut Pixmap,
) -> Result<(), OverlayError> {
    Err(OverlayError::NativeRenderingUnavailable)
}
