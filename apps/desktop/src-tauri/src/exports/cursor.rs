use std::collections::HashMap;
use std::sync::Arc;

use cursor_engine::CursorTelemetryFile;

use resvg::tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Transform};
use resvg::usvg;

use super::camera::{self, ZoomTransformState};
use super::{RenderPlanZoomSegment, RenderSegment};

// Re-export the canonical cursor settings so the renderer and engine share the
// same type and defaults.
pub use cursor_engine::CursorSettings;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RenderCanvas {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[serde(default = "default_canvas_background")]
    pub background: String,
    #[serde(default)]
    pub padding: u32,
    #[serde(default)]
    pub border_radius: u32,
    #[serde(default)]
    pub shadow: bool,
    #[serde(default)]
    pub shadow_color: Option<String>,
    #[serde(default)]
    pub shadow_blur: Option<f64>,
    #[serde(default)]
    pub shadow_offset_x: Option<f64>,
    #[serde(default)]
    pub shadow_offset_y: Option<f64>,
    #[serde(default)]
    pub background_blur: Option<f64>,
    #[serde(default)]
    pub background_dim: Option<f64>,
    #[serde(default)]
    pub background_fit: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub video_position_y: Option<f64>,
    pub cursor_settings: CursorSettings,
}

fn default_canvas_background() -> String {
    "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)".into()
}

#[derive(Debug, Clone, Copy)]
struct Rgba {
    red: u8,
    green: u8,
    blue: u8,
    alpha: f32,
}

impl Rgba {
    fn with_alpha(self, alpha: f64) -> Self {
        Self {
            alpha: (self.alpha * alpha as f32).clamp(0.0, 1.0),
            ..self
        }
    }
}

/// A pixel-aligned rectangle used to clip all cursor drawing to the fitted
/// recorded video screen. Respects canvas border_radius for rounded video corners.
#[derive(Debug, Clone, Copy)]
struct ClipRect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    border_radius: u32,
}

impl ClipRect {
    fn contains(&self, px: i32, py: i32) -> bool {
        if px < self.x as i32
            || px >= (self.x + self.w) as i32
            || py < self.y as i32
            || py >= (self.y + self.h) as i32
        {
            return false;
        }
        if self.border_radius == 0 {
            return true;
        }
        let r = self.border_radius.min(self.w / 2).min(self.h / 2) as i32;
        if r <= 0 {
            return true;
        }
        let left = self.x as i32;
        let right = (self.x + self.w) as i32 - 1;
        let top = self.y as i32;
        let bottom = (self.y + self.h) as i32 - 1;

        if px < left + r && py < top + r {
            let dx = (left + r) - px;
            let dy = (top + r) - py;
            return dx * dx + dy * dy <= r * r;
        }
        if px > right - r && py < top + r {
            let dx = px - (right - r);
            let dy = (top + r) - py;
            return dx * dx + dy * dy <= r * r;
        }
        if px < left + r && py > bottom - r {
            let dx = (left + r) - px;
            let dy = py - (bottom - r);
            return dx * dx + dy * dy <= r * r;
        }
        if px > right - r && py > bottom - r {
            let dx = px - (right - r);
            let dy = py - (bottom - r);
            return dx * dx + dy * dy <= r * r;
        }
        true
    }
}

/// A software-rasterized cursor ready to be composited onto the export frame.
/// The quarter-pixel phase is baked into `data`; the float hotspot lives in
/// `draw_cursor`, so blitting only needs an integer origin.
#[derive(Debug, Clone)]
struct RasterizedCursor {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

/// One entry of the bounded raster LRU — a cursor bitmap pre-shifted by a
/// quarter-pixel phase so subpixel positions do not re-rasterize.
#[derive(Debug, Clone)]
struct RasterCacheEntry {
    asset_id: String,
    scale_bin: u32,
    phase_x: u8,
    phase_y: u8,
    cursor: RasterizedCursor,
}

const RASTER_CACHE_CAPACITY: usize = 256;

/// Hash of every cursor setting that changes the generated SVG document — the
/// usvg tree is shared per (asset id, style hash), not per scale.
fn cursor_style_hash(settings: &CursorSettings) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    settings.fill_color.hash(&mut hasher);
    settings.stroke_color.hash(&mut hasher);
    settings.stroke_width.to_bits().hash(&mut hasher);
    settings.fill_opacity.to_bits().hash(&mut hasher);
    settings.stroke_opacity.to_bits().hash(&mut hasher);
    settings.shadow_enabled.hash(&mut hasher);
    settings.shadow_color.hash(&mut hasher);
    settings.shadow_blur.to_bits().hash(&mut hasher);
    settings.shadow_offset_x.to_bits().hash(&mut hasher);
    settings.shadow_offset_y.to_bits().hash(&mut hasher);
    settings.shadow_opacity.to_bits().hash(&mut hasher);
    hasher.finish()
}

/// One fitted screen rect and the absolute output window it applies to —
/// exported layouts switch between the full area and the side-by-side slot as
/// camera overlays come and go, and the cursor mapping must follow.
#[derive(Debug, Clone, Copy)]
pub struct ScreenRectWindow {
    pub start_ms: u64,
    pub end_ms: u64,
    pub rect: (f64, f64, f64, f64),
}

/// Resolved clip rect + telemetry fit scale for one layout window.
/// `rect` is the unrounded display rect the zoompan output surface is drawn
/// into — equal to the surface rect except inside layout windows (e.g.
/// side-by-side) where the graph rescales it.
#[derive(Debug, Clone, Copy)]
struct ScreenRectEntry {
    start_ms: f64,
    end_ms: f64,
    clip: ClipRect,
    fit_scale: f64,
    rect: (f64, f64, f64, f64),
}

#[derive(Debug, Clone)]
pub struct CursorRenderer {
    settings: CursorSettings,
    /// Shared per-telemetry engine — several export ranges of one capture
    /// reuse the same normalized event pipeline. `Mutex` because the engine's
    /// interior smoothing cache (`RefCell`) is not `Sync`.
    pub(crate) engine: Arc<std::sync::Mutex<cursor_engine::CursorEngine>>,
    /// Telemetry source dimensions, cached at construction so per-frame
    /// mapping does not take the engine lock.
    telemetry_source_w: f64,
    telemetry_source_h: f64,
    /// Captured cursor shapes for recorded/optimized shape resolution.
    telemetry_shapes: Vec<cursor_engine::CursorShapeInfo>,
    segments: Vec<RenderSegment>,
    zoom_segments: Vec<RenderPlanZoomSegment>,
    canvas_width: u32,
    canvas_height: u32,
    canvas_padding: u32,
    /// The recorded video screen in full-canvas coordinates. Cursor drawing is
    /// clipped to this rectangle unless a zoom effect expands the view to the
    /// full canvas.
    video_screen: ClipRect,
    /// Unrounded canvas rect for `video_screen`; used for the zoompan surface
    /// registration where pixel-exact float math matters.
    video_screen_rect: (f64, f64, f64, f64),
    /// Pixel dimensions of the zoompan output surface (`s=` argument): the
    /// rounded primary screen rect, or the full canvas for fullscreen exports.
    zoompan_out_w: f64,
    zoompan_out_h: f64,
    /// `settings.scale` clamped once; the per-frame scale multiplies it by the
    /// active window's fit scale so the cursor resizes with the video slot.
    cursor_scale_factor: f64,
    /// Telemetry→pixel fit scale for `video_screen`, kept for the
    /// single-rect fast path and the no-window fallback.
    base_fit_scale: f64,
    /// Sorted, non-overlapping absolute output windows for renders whose
    /// layout changes over time; empty keeps the single `video_screen` rect.
    video_screen_windows: Vec<ScreenRectEntry>,
    /// Style hash of the cursor settings baked into the SVG document (fill,
    /// stroke, opacities, shadow). Constant per renderer.
    style_hash: u64,
    /// Shadow padding in viewBox units, sized for the blur extent and offset
    /// so the shadow never clips at any render scale.
    shadow_pad_vb: f64,
    /// Parsed usvg trees keyed by (asset id, style hash) — parsing is the
    /// expensive step; scales and phases reuse the same tree.
    tree_cache: HashMap<(String, u64), usvg::Tree>,
    /// Bounded LRU of rendered rasters keyed by (asset, scale bin, quarter-px
    /// phase). Insertion order doubles as recency order (back = newest).
    raster_cache: Vec<RasterCacheEntry>,
}

impl CursorRenderer {
    /// Map a telemetry source point through the exact integer crop zoompan
    /// applies (truncate + chroma snap), so the cursor stays pixel-registered
    /// with the zoomed video. Returns the canvas position and the
    /// output-pixels-per-input-pixel ratio for cursor artwork scaling.
    ///
    /// sws_scale is center-aligned: an input pixel center at `p` lands at
    /// `((p - crop_origin) + 0.5) * out / crop_size - 0.5` on the zoompan
    /// output surface.
    fn map_source_point(
        &self,
        transform: &ZoomTransformState,
        source_x: f64,
        source_y: f64,
        clip: ClipRect,
        rect: (f64, f64, f64, f64),
        fit_scale: f64,
    ) -> (f64, f64, f64) {
        let in_w = self.telemetry_source_w.max(1.0);
        let in_h = self.telemetry_source_h.max(1.0);

        // No zoom activity: keep the aspect-fitted placement unchanged.
        if transform.scale <= 1.0001 && transform.progress < 1e-4 {
            let (x, y) = self.fit_source_point_in(source_x, source_y, clip);
            return (x, y, fit_scale);
        }

        let (ix, iy, iw, ih) = camera::zoompan_integer_crop(
            (
                transform.crop_x,
                transform.crop_y,
                transform.crop_w,
                transform.crop_h,
            ),
            in_w,
            in_h,
            self.canvas_width as f64,
            self.canvas_height as f64,
            // format=yuv420p is inserted before every zoompan in the graph, so
            // the chroma snap is always one pixel in each axis.
            1,
            1,
        );
        let px = source_x.clamp(0.0, in_w);
        let py = source_y.clamp(0.0, in_h);
        let surface_x = ((px - ix as f64) + 0.5) * self.zoompan_out_w / iw.max(1) as f64 - 0.5;
        let surface_y = ((py - iy as f64) + 0.5) * self.zoompan_out_h / ih.max(1) as f64 - 0.5;
        // The base window draws the surface 1:1 at its float origin; layout
        // windows (side-by-side) rescale it into a smaller rect.
        let display_scale_x = if (rect.2 - self.zoompan_out_w).abs() > 0.5 {
            rect.2 / self.zoompan_out_w
        } else {
            1.0
        };
        let display_scale_y = if (rect.3 - self.zoompan_out_h).abs() > 0.5 {
            rect.3 / self.zoompan_out_h
        } else {
            1.0
        };
        (
            rect.0 + surface_x * display_scale_x,
            rect.1 + surface_y * display_scale_y,
            display_scale_x * self.zoompan_out_w / iw.max(1) as f64,
        )
    }
}

impl CursorRenderer {
    #[cfg(test)]
    pub fn new(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        canvas: &RenderCanvas,
    ) -> Result<Self, String> {
        Self::new_with_zoom(settings, telemetry, segments, &[], canvas, None, None)
    }

    #[cfg(test)]
    pub fn new_with_zoom(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        zoom_segments: &[RenderPlanZoomSegment],
        canvas: &RenderCanvas,
        screen_rect: Option<(f64, f64, f64, f64)>,
        screen_windows: Option<Vec<ScreenRectWindow>>,
    ) -> Result<Self, String> {
        let options = cursor_engine::CursorEngineOptions::default();
        let engine = cursor_engine::CursorEngine::new(telemetry, options)
            .map_err(|e| format!("failed to build cursor engine: {e}"))?;
        Self::new_with_engine(
            settings,
            Arc::new(std::sync::Mutex::new(engine)),
            segments,
            zoom_segments,
            canvas,
            screen_rect,
            screen_windows,
        )
    }

    /// Build a renderer over an existing engine so several cursor ranges of
    /// one capture share a single smoothed event pipeline.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_engine(
        settings: CursorSettings,
        engine: Arc<std::sync::Mutex<cursor_engine::CursorEngine>>,
        segments: &[RenderSegment],
        zoom_segments: &[RenderPlanZoomSegment],
        canvas: &RenderCanvas,
        screen_rect: Option<(f64, f64, f64, f64)>,
        screen_windows: Option<Vec<ScreenRectWindow>>,
    ) -> Result<Self, String> {
        if canvas.width == 0 || canvas.height == 0 {
            return Err("cursor canvas dimensions must be positive".into());
        }
        let telemetry = engine.lock().expect("cursor engine").telemetry().clone();
        if telemetry.source_width == 0.0 || telemetry.source_height == 0.0 {
            return Err("cursor telemetry dimensions must be positive".into());
        }
        if segments.is_empty() {
            return Err("cursor renderer requires at least one video segment".into());
        }

        let (video_screen, video_screen_rect) = if let Some((sx, sy, sw, sh)) = screen_rect {
            (
                ClipRect {
                    x: sx.round().max(0.0) as u32,
                    y: sy.round().max(0.0) as u32,
                    w: sw.round().max(1.0) as u32,
                    h: sh.round().max(1.0) as u32,
                    border_radius: canvas.border_radius,
                },
                (sx, sy, sw, sh),
            )
        } else {
            let padding = canvas.padding as f64;
            let content_width = (canvas.width as f64 - padding * 2.0).max(1.0);
            let content_height = (canvas.height as f64 - padding * 2.0).max(1.0);
            let fit_scale = (content_width / telemetry.source_width)
                .min(content_height / telemetry.source_height);
            let fit_width = telemetry.source_width * fit_scale;
            let fit_height = telemetry.source_height * fit_scale;
            let position_y = if canvas.aspect_ratio.as_deref() == Some("16:9") {
                0.5
            } else {
                canvas.video_position_y.unwrap_or(0.5).clamp(0.0, 1.0)
            };
            let clip = ClipRect {
                x: (padding + (content_width - fit_width) / 2.0).floor() as u32,
                y: (padding + (content_height - fit_height) * position_y).floor() as u32,
                w: fit_width.floor().max(1.0) as u32,
                h: fit_height.floor().max(1.0) as u32,
                border_radius: canvas.border_radius,
            };
            (
                clip,
                (clip.x as f64, clip.y as f64, clip.w as f64, clip.h as f64),
            )
        };

        let source_w = telemetry.source_width.max(1.0);
        let source_h = telemetry.source_height.max(1.0);
        let base_fit_scale =
            (video_screen.w as f64 / source_w).min(video_screen.h as f64 / source_h);
        // The DPI size model scales `settings.scale` by the captured display
        // DPI/geometry; legacy keeps it a pure absolute multiplier.
        let cursor_scale_factor = settings.scale.clamp(0.2, 5.0)
            * cursor_engine::cursor_size_factor(&settings, &telemetry);
        let mut video_screen_windows: Vec<ScreenRectEntry> = screen_windows
            .unwrap_or_default()
            .into_iter()
            .filter(|window| window.end_ms > window.start_ms)
            .map(|window| {
                let (rx, ry, rw, rh) = window.rect;
                let clip = ClipRect {
                    x: rx.round().max(0.0) as u32,
                    y: ry.round().max(0.0) as u32,
                    w: rw.round().max(1.0) as u32,
                    h: rh.round().max(1.0) as u32,
                    border_radius: canvas.border_radius,
                };
                ScreenRectEntry {
                    start_ms: window.start_ms as f64,
                    end_ms: window.end_ms as f64,
                    clip,
                    fit_scale: (clip.w as f64 / source_w).min(clip.h as f64 / source_h),
                    rect: (rx, ry, rw, rh),
                }
            })
            .collect();
        video_screen_windows.sort_by(|left, right| left.start_ms.total_cmp(&right.start_ms));

        // The zoompan output surface equals the rounded primary screen rect
        // (`s=` is an integer size); fullscreen exports pass the canvas rect,
        // which then equals the canvas size exactly.
        let zoompan_out_w = video_screen_rect.2.round().max(1.0);
        let zoompan_out_h = video_screen_rect.3.round().max(1.0);

        let style_hash = cursor_style_hash(&settings);
        // feDropShadow offsets/stdDeviation are userSpaceOnUse (viewBox units);
        // pad enough to cover the shadow at any render scale.
        let shadow_pad_vb = if settings.shadow_enabled
            && settings.shadow_opacity > 0.0
            && (settings.shadow_blur.abs() > f64::EPSILON
                || settings.shadow_offset_x.abs() > f64::EPSILON
                || settings.shadow_offset_y.abs() > f64::EPSILON)
        {
            settings
                .shadow_offset_x
                .abs()
                .max(settings.shadow_offset_y.abs())
                + settings.shadow_blur.max(0.0) * 2.0
                + 1.0
        } else {
            0.0
        };

        Ok(Self {
            settings,
            engine,
            telemetry_source_w: source_w,
            telemetry_source_h: source_h,
            telemetry_shapes: telemetry.shapes.clone(),
            segments: segments.to_vec(),
            zoom_segments: zoom_segments.to_vec(),
            canvas_width: canvas.width,
            canvas_height: canvas.height,
            canvas_padding: canvas.padding,
            video_screen,
            video_screen_rect,
            zoompan_out_w,
            zoompan_out_h,
            cursor_scale_factor,
            base_fit_scale,
            video_screen_windows,
            style_hash,
            shadow_pad_vb,
            tree_cache: HashMap::new(),
            raster_cache: Vec::new(),
        })
    }

    /// Clip rect, fit scale, and float display rect active at an absolute
    /// output timestamp — falls back to the primary rect outside every
    /// declared window.
    fn screen_entry_at(&self, output_ms: f64) -> (ClipRect, f64, (f64, f64, f64, f64)) {
        self.video_screen_windows
            .iter()
            .find(|entry| output_ms >= entry.start_ms && output_ms < entry.end_ms)
            .map(|entry| (entry.clip, entry.fit_scale, entry.rect))
            .unwrap_or((
                self.video_screen,
                self.base_fit_scale,
                self.video_screen_rect,
            ))
    }

    /// Resolve the effective asset id for a cursor frame, honoring the user's
    /// shape mode preference (preset, recorded, or optimized mapping).
    fn resolve_cursor_shape_id(&self, frame_shape_id: &str) -> String {
        if frame_shape_id.is_empty() || self.settings.shape_mode == "preset" {
            return self.settings.preset.clone();
        }

        if self.settings.shape_mode == "recorded" {
            if cursor_engine::assets::resolve_cursor_asset(frame_shape_id).is_some() {
                return frame_shape_id.to_string();
            }
            return self.settings.preset.clone();
        }

        // Optimized mode: map recorded system shape ids to our canonical assets,
        // then fall back to the preset when no mapping exists.
        let mapped =
            cursor_engine::assets::resolve_cursor_shape_id(frame_shape_id, &self.telemetry_shapes);
        if cursor_engine::assets::resolve_cursor_asset(&mapped).is_some() {
            return mapped;
        }

        self.settings.preset.clone()
    }

    /// Map source coordinates from telemetry into the pixel boundaries of the
    /// fitted video screen on the canvas.
    #[cfg(test)]
    fn fit_source_point(&self, source_x: f64, source_y: f64) -> (f64, f64) {
        self.fit_source_point_in(source_x, source_y, self.video_screen)
    }

    /// Same mapping against an explicit screen rect — layout-varying renders
    /// resolve the rect per frame instead of keying off `video_screen`.
    fn fit_source_point_in(&self, source_x: f64, source_y: f64, screen: ClipRect) -> (f64, f64) {
        let source_w = self.telemetry_source_w.max(1.0);
        let source_h = self.telemetry_source_h.max(1.0);
        let clamped_x = source_x.clamp(0.0, source_w);
        let clamped_y = source_y.clamp(0.0, source_h);
        let scale = (screen.w as f64 / source_w).min(screen.h as f64 / source_h);
        let offset_x = (screen.w as f64 - source_w * scale) / 2.0;
        let offset_y = (screen.h as f64 - source_h * scale) / 2.0;
        (
            screen.x as f64 + offset_x + clamped_x * scale,
            screen.y as f64 + offset_y + clamped_y * scale,
        )
    }

    /// Render at the exact fractional presentation timestamp assigned to a
    /// CFR frame so cursor evaluation shares the video frame PTS.
    pub fn render_frame_at(&mut self, output_ms: f64, frame: &mut [u8]) {
        let expected_len = self.canvas_width as usize * self.canvas_height as usize * 4;
        if frame.len() != expected_len || !output_ms.is_finite() || output_ms < 0.0 {
            return;
        }

        let source_time_ms = match source_time_for_output(&self.segments, output_ms) {
            Some(time) => time,
            None => return,
        };
        if !self.settings.enabled {
            return;
        }

        let cursor_frame = self
            .engine
            .lock()
            .expect("cursor engine")
            .evaluate(source_time_ms, &self.settings);
        if !cursor_frame.visible {
            return;
        }

        let transform = self.resolve_zoom_transform_at(output_ms);
        let (clip, fit_scale, rect) = self.screen_entry_at(output_ms);
        let (x, y, zoom_px_scale) = self.map_source_point(
            &transform,
            cursor_frame.source_x,
            cursor_frame.source_y,
            clip,
            rect,
            fit_scale,
        );
        // Cursor artwork scales with the quantized zoom (output px per input
        // px), matching what zoompan does to the video.
        let effective_cursor_scale = self.cursor_scale_factor * zoom_px_scale;

        if self.settings.spotlight_mode {
            self.render_spotlight(frame, x, y, effective_cursor_scale, &clip);
        }

        if self.settings.click_feedback != "none" {
            for click in &cursor_frame.active_clicks {
                let (cx, cy, _) = self.map_source_point(
                    &transform,
                    click.source_x,
                    click.source_y,
                    clip,
                    rect,
                    fit_scale,
                );
                self.render_click_feedback(frame, cx, cy, click, effective_cursor_scale, &clip);
            }
        }

        let shape_id = self.resolve_cursor_shape_id(&cursor_frame.shape_id);
        // Apply the idle fade opacity computed by the canonical engine. The
        // cached asset is rendered at full opacity and modulated per-frame.
        self.draw_cursor(
            frame,
            x,
            y,
            cursor_frame.opacity,
            &shape_id,
            effective_cursor_scale * cursor_frame.click_scale,
            &clip,
        );
    }

    /// Resolve zoom at a fractional output PTS so the cursor and video use the
    /// same transition progress between integer millisecond boundaries.
    /// The camera math lives in `camera` so the filter-graph expressions and
    /// this evaluator cannot drift apart.
    pub fn resolve_zoom_transform_at(&self, output_ms: f64) -> ZoomTransformState {
        camera::evaluate_zoom_transform(
            &self.zoom_segments,
            self.canvas_width,
            self.canvas_height,
            self.canvas_padding,
            output_ms,
        )
    }

    /// Map a telemetry source point to canvas coordinates at `output_ms`
    /// through the primary screen rect (test helper).
    #[cfg(test)]
    fn map_source_at(&self, output_ms: f64, source_x: f64, source_y: f64) -> (f64, f64) {
        let transform = self.resolve_zoom_transform_at(output_ms);
        let (x, y, _) = self.map_source_point(
            &transform,
            source_x,
            source_y,
            self.video_screen,
            self.video_screen_rect,
            self.base_fit_scale,
        );
        (x, y)
    }

    /// Focus-spotlight dim: the screen area outside a feathered hole around the
    /// cursor. The dim color is always black — `shadow_color` must not tint it.
    /// Coverage is sampled at pixel centers so the hole edge is antialiased.
    fn render_spotlight(
        &self,
        frame: &mut [u8],
        x: f64,
        y: f64,
        cursor_scale: f64,
        clip: &ClipRect,
    ) {
        let dim_alpha = self.settings.spotlight_dim_opacity.clamp(0.0, 1.0);
        if dim_alpha <= 0.0 {
            return;
        }
        // The spotlight radius scales with the cursor so it stays proportional
        // to the fitted video, matching the preview overlay.
        let radius = self.settings.spotlight_radius.max(0.0) * cursor_scale;
        let feather = (0.12 * radius).max(1.5);
        let dim = Rgba::opaque(0, 0, 0);

        let end_x = clip.x.saturating_add(clip.w).min(self.canvas_width);
        let end_y = clip.y.saturating_add(clip.h).min(self.canvas_height);
        for py in clip.y..end_y {
            for px in clip.x..end_x {
                if !clip.contains(px as i32, py as i32) {
                    continue;
                }
                let dx = px as f64 + 0.5 - x;
                let dy = py as f64 + 0.5 - y;
                let distance = (dx * dx + dy * dy).sqrt();
                // Linear falloff over the feathered edge; fully dim outside.
                let coverage = ((distance - radius) / feather).clamp(0.0, 1.0);
                if coverage <= 0.0 {
                    continue;
                }
                blend_pixel(
                    frame,
                    self.canvas_width,
                    px as i32,
                    py as i32,
                    dim.with_alpha(dim_alpha * coverage),
                    clip,
                );
            }
        }
    }

    /// Click feedback geometry shared with the preview overlay:
    /// `r = D/2 * (0.25 + 0.75 * expand)` at `alpha = 0.75 * fade`, where D is
    /// the click size scaled by the same factor as the cursor artwork.
    fn render_click_feedback(
        &self,
        frame: &mut [u8],
        x: f64,
        y: f64,
        click: &cursor_engine::CursorClickEffect,
        cursor_scale: f64,
        clip: &ClipRect,
    ) {
        let click_size = self.settings.click_size.max(10.0) * cursor_scale;
        let radius = (click_size / 2.0 * (0.25 + 0.75 * click.expand)).max(1.0);
        let alpha = 0.75 * click.fade;
        if alpha <= 0.0 {
            return;
        }
        let color = parse_color(&self.settings.click_color, Rgba::opaque(96, 165, 250));

        match self.settings.click_feedback.as_str() {
            // Core disc at 0.55r plus a quadratic halo out to r at half alpha.
            "spotlight" => fill_spotlight_glow(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius,
                color,
                alpha,
                clip,
            ),
            "pulse" => fill_disc(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius,
                color,
                alpha,
                clip,
            ),
            "ripple" => draw_ring_aa(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius,
                (0.08 * click_size).max(1.0),
                color,
                alpha,
                clip,
            ),
            _ => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_cursor(
        &mut self,
        frame: &mut [u8],
        x: f64,
        y: f64,
        opacity: f64,
        shape_id: &str,
        cursor_scale: f64,
        clip: &ClipRect,
    ) {
        let asset = cursor_engine::assets::resolve_cursor_asset_or_default(shape_id);
        let scale_bin = (cursor_scale.max(0.005) * 200.0).round().max(1.0) as u32;
        let scale = scale_bin as f64 / 200.0;
        let (vb_x, vb_y, vb_w, vb_h) = cursor_view_box(asset);
        let pad = self.shadow_pad_vb;
        let scale_x = asset.width * scale / vb_w;
        let scale_y = asset.height * scale / vb_h;
        let hotspot_x = (asset.hotspot_x - vb_x + pad) * scale_x;
        let hotspot_y = (asset.hotspot_y - vb_y + pad) * scale_y;

        // Quarter-pixel phases keep subpixel placement without re-rasterizing.
        let origin_x = x - hotspot_x;
        let origin_y = y - hotspot_y;
        let (x0, phase_x) = quantize_phase(origin_x);
        let (y0, phase_y) = quantize_phase(origin_y);

        let cursor_index = match self.raster_index(asset, scale_bin, phase_x, phase_y) {
            Ok(index) => index,
            Err(error) => {
                tracing::warn!(%error, asset_id = %asset.id, "failed to rasterize cursor asset; skipping cursor");
                return;
            }
        };
        self.blit_cursor(
            frame,
            &self.raster_cache[cursor_index].cursor,
            x0,
            y0,
            opacity,
            clip,
        );
    }

    /// Fetch (or render and cache) the quarter-phase raster for an asset at a
    /// scale bin, returning its index in the LRU. Hits move to the back;
    /// misses evict the front once past `RASTER_CACHE_CAPACITY`.
    fn raster_index(
        &mut self,
        asset: &cursor_engine::assets::CursorAsset,
        scale_bin: u32,
        phase_x: u8,
        phase_y: u8,
    ) -> Result<usize, String> {
        if let Some(index) = self.raster_cache.iter().position(|entry| {
            entry.asset_id == asset.id
                && entry.scale_bin == scale_bin
                && entry.phase_x == phase_x
                && entry.phase_y == phase_y
        }) {
            let entry = self.raster_cache.remove(index);
            self.raster_cache.push(entry);
            return Ok(self.raster_cache.len() - 1);
        }

        let cursor = self.render_cursor_raster(asset, scale_bin, phase_x, phase_y)?;
        self.raster_cache.push(RasterCacheEntry {
            asset_id: asset.id.clone(),
            scale_bin,
            phase_x,
            phase_y,
            cursor,
        });
        if self.raster_cache.len() > RASTER_CACHE_CAPACITY {
            self.raster_cache.remove(0);
        }
        Ok(self.raster_cache.len() - 1)
    }

    fn blit_cursor(
        &self,
        frame: &mut [u8],
        cursor: &RasterizedCursor,
        x0: i32,
        y0: i32,
        opacity: f64,
        clip: &ClipRect,
    ) {
        let opacity = opacity.clamp(0.0, 1.0) as f32;
        if opacity <= 0.0 {
            return;
        }
        for row in 0..cursor.height as i32 {
            let fy = y0 + row;
            if fy < 0 || fy >= self.canvas_height as i32 {
                continue;
            }
            for col in 0..cursor.width as i32 {
                let fx = x0 + col;
                if fx < 0 || fx >= self.canvas_width as i32 || !clip.contains(fx, fy) {
                    continue;
                }
                let src = (row as usize * cursor.width as usize + col as usize) * 4;
                let alpha = cursor.data[src + 3] as f32 / 255.0 * opacity;
                if alpha <= 0.0 {
                    continue;
                }
                let color = Rgba {
                    red: cursor.data[src],
                    green: cursor.data[src + 1],
                    blue: cursor.data[src + 2],
                    alpha,
                };
                blend_pixel(frame, self.canvas_width, fx, fy, color, clip);
            }
        }
    }

    /// Parse the shared SVG cursor asset once per (asset, style hash). The
    /// document is built in viewBox units so a single tree can be rendered at
    /// any scale/phase transform.
    fn cursor_tree(
        &mut self,
        asset: &cursor_engine::assets::CursorAsset,
    ) -> Result<&usvg::Tree, String> {
        let key = (asset.id.clone(), self.style_hash);
        if !self.tree_cache.contains_key(&key) {
            let (vb_x, vb_y, vb_w, vb_h) = cursor_view_box(asset);
            let pad_vb = self.shadow_pad_vb;
            let svg = build_cursor_svg(
                asset,
                &self.settings,
                pad_vb > 0.0,
                pad_vb,
                vb_w + pad_vb * 2.0,
                vb_h + pad_vb * 2.0,
                vb_x,
                vb_y,
                vb_w,
                vb_h,
            );
            let options = usvg::Options::default();
            let tree = usvg::Tree::from_str(&svg, &options)
                .map_err(|error| format!("failed to parse cursor SVG: {error}"))?;
            self.tree_cache.insert(key.clone(), tree);
        }
        Ok(self.tree_cache.get(&key).expect("just inserted"))
    }

    /// Render the cached tree at a scale bin plus a quarter-pixel phase shift.
    /// The phase offset is baked into the pixmap so blitting stays integer.
    fn render_cursor_raster(
        &mut self,
        asset: &cursor_engine::assets::CursorAsset,
        scale_bin: u32,
        phase_x: u8,
        phase_y: u8,
    ) -> Result<RasterizedCursor, String> {
        let scale = scale_bin as f64 / 200.0;
        let (_vb_x, _vb_y, vb_w, vb_h) = cursor_view_box(asset);
        let pad_vb = self.shadow_pad_vb;
        let scale_x = asset.width * scale / vb_w;
        let scale_y = asset.height * scale / vb_h;

        let width = (((vb_w + pad_vb * 2.0) * scale_x).ceil() as u32 + 1).max(1);
        let height = (((vb_h + pad_vb * 2.0) * scale_y).ceil() as u32 + 1).max(1);
        let Some(mut pixmap) = Pixmap::new(width, height) else {
            return Err("failed to allocate cursor pixmap".into());
        };

        // Scale then translate by the phase fraction in output pixels: the
        // matrix is sx*x + tx directly, avoiding concat-order ambiguity.
        let transform = Transform::from_row(
            scale_x as f32,
            0.0,
            0.0,
            scale_y as f32,
            phase_x as f32 / 4.0,
            phase_y as f32 / 4.0,
        );
        let tree = self.cursor_tree(asset)?;
        resvg::render(tree, transform, &mut pixmap.as_mut());

        let mut data = pixmap.data().to_vec();
        unpremultiply_rgba(&mut data);

        Ok(RasterizedCursor {
            width,
            height,
            data,
        })
    }
}

/// Convert a captured V2 telemetry struct straight into the engine's input
/// type — no JSON roundtrip. The layouts are intentionally parallel; fields
/// the engine does not model (e.g. `buttonsUnavailable`) degrade to the
/// closest supported value.
impl From<&crate::capture::cursor_v2::CursorTelemetryFileV2> for CursorTelemetryFile {
    fn from(v2: &crate::capture::cursor_v2::CursorTelemetryFileV2) -> Self {
        use crate::capture::cursor_v2::CursorTelemetryHealth as V2Health;
        let metadata = &v2.metadata;
        let health = match metadata.health {
            V2Health::Healthy => cursor_engine::CursorTelemetryHealth::Healthy,
            V2Health::ShapesUnavailable => cursor_engine::CursorTelemetryHealth::ShapesUnavailable,
            V2Health::PositionUnavailable => {
                cursor_engine::CursorTelemetryHealth::PositionUnavailable
            }
            // Buttons/topology loss does not block rendering; positions are
            // still valid, so degrade to healthy.
            V2Health::ButtonsUnavailable | V2Health::TopologyUnavailable => {
                cursor_engine::CursorTelemetryHealth::Healthy
            }
        };
        Self {
            schema_version: metadata.schema_version,
            asset_id: metadata.asset_id.clone(),
            recording_id: metadata.recording_id.clone(),
            source_width: metadata.source_width as f64,
            source_height: metadata.source_height as f64,
            capture_bounds: Some(cursor_engine::CursorCaptureBounds {
                x: metadata.capture_bounds.x as f64,
                y: metadata.capture_bounds.y as f64,
                width: metadata.capture_bounds.width as f64,
                height: metadata.capture_bounds.height as f64,
            }),
            coordinate_transform: cursor_engine::CursorCoordinateTransform {
                a00: metadata.coordinate_transform.a00,
                a01: metadata.coordinate_transform.a01,
                a10: metadata.coordinate_transform.a10,
                a11: metadata.coordinate_transform.a11,
                b0: metadata.coordinate_transform.b0,
                b1: metadata.coordinate_transform.b1,
            },
            topology: metadata.topology.as_ref().map(|topology| {
                cursor_engine::CursorTopologyInfo {
                    scale_factor: topology.scale_factor,
                }
            }),
            shapes: metadata
                .shapes
                .iter()
                .map(|shape| cursor_engine::CursorShapeInfo {
                    shape_id: shape.shape_id.clone(),
                    hotspot_x: shape.hotspot_x,
                    hotspot_y: shape.hotspot_y,
                    width: shape.width,
                    height: shape.height,
                    kind: shape.kind.clone(),
                })
                .collect(),
            click_window_ms: metadata.click_window_ms,
            health,
            event_count: metadata.event_count,
            index: metadata
                .index
                .iter()
                .map(|entry| cursor_engine::CursorEventIndexEntry {
                    event_index: entry.event_index,
                    t_ms: entry.t_ms,
                    file_offset: entry.file_offset,
                })
                .collect(),
            event_file: metadata.event_file.clone(),
            timebase: cursor_engine::CursorTelemetryTimebase {
                unit: cursor_engine::CursorTimebaseUnit::Ms,
                ticks_per_second: metadata.timebase.ticks_per_second,
            },
            sample_rate_hz: metadata.sample_rate_hz as f64,
            events: v2
                .events
                .iter()
                .map(|event| cursor_engine::CursorEvent {
                    t_ms: event.t_ms,
                    raw_x: Some(event.raw_x as f64),
                    raw_y: Some(event.raw_y as f64),
                    source_x: Some(event.source_x),
                    source_y: Some(event.source_y),
                    x: event.source_x,
                    y: event.source_y,
                    buttons: cursor_engine::CursorButtonState {
                        left: event.buttons.left,
                        right: event.buttons.right,
                        middle: event.buttons.middle,
                        x1: event.buttons.x1,
                        x2: event.buttons.x2,
                    },
                    button_event: Some(event.button_event.clone()),
                    button: None,
                    clicked: false,
                    visible: event.visible,
                    shape_id: Some(event.shape_id.clone()),
                    shape_changed: event.shape_changed,
                })
                .collect(),
        }
    }
}

/// Parse the asset's viewBox into (x, y, w, h), falling back to the declared
/// asset extents.
fn cursor_view_box(asset: &cursor_engine::assets::CursorAsset) -> (f64, f64, f64, f64) {
    let view_box: Vec<f64> = asset
        .view_box
        .split_whitespace()
        .filter_map(|part| part.parse().ok())
        .collect();
    match view_box.as_slice() {
        &[x, y, w, h] if w > 0.0 && h > 0.0 => (x, y, w, h),
        _ => (0.0, 0.0, asset.width, asset.height),
    }
}

/// Split a float origin into an integer blit origin plus a quarter-pixel
/// phase index (0..=3), so the rendered raster covers the subpixel offset.
fn quantize_phase(origin: f64) -> (i32, u8) {
    let mut integer = origin.floor() as i32;
    let mut phase = ((origin - integer as f64) * 4.0).round() as i32;
    if phase == 4 {
        integer += 1;
        phase = 0;
    }
    (integer, phase as u8)
}

/// Substitutes the shared asset template tokens and builds a full SVG document.
/// When shadow is enabled a `<feDropShadow>` filter is injected so the cached
/// pixmap already contains the shadow, matching the preview overlay.
#[allow(clippy::too_many_arguments)]
fn build_cursor_svg(
    asset: &cursor_engine::assets::CursorAsset,
    settings: &CursorSettings,
    shadow: bool,
    pad_vb: f64,
    width: f64,
    height: f64,
    vb_x: f64,
    vb_y: f64,
    vb_w: f64,
    vb_h: f64,
) -> String {
    let fill = parse_hex_color(&settings.fill_color, "#3b82f6");
    let stroke = parse_hex_color(&settings.stroke_color, "#ffffff");
    let stroke_width = settings.stroke_width;

    let mut markup = asset.svg.clone();
    markup = markup.replace(
        "{Math.max(2, strokeWidth)}",
        &stroke_width.max(2.0).to_string(),
    );
    markup = markup.replace(
        "{strokeWidth || 1.5}",
        &if stroke_width > 0.0 {
            stroke_width
        } else {
            1.5
        }
        .to_string(),
    );
    markup = markup.replace("{strokeWidth}", &stroke_width.to_string());
    markup = markup.replace("{fill}", &fill);
    markup = markup.replace("{stroke}", &stroke);
    markup = markup.replace("{fillOpacity}", &settings.fill_opacity.to_string());
    markup = markup.replace("{strokeOpacity}", &settings.stroke_opacity.to_string());

    let view_box = format!(
        "{} {} {} {}",
        vb_x - pad_vb,
        vb_y - pad_vb,
        vb_w + pad_vb * 2.0,
        vb_h + pad_vb * 2.0
    );

    if shadow {
        let shadow_color = parse_hex_color(&settings.shadow_color, "#000000");
        let std_deviation = (settings.shadow_blur / 2.0).max(0.0);
        // The filter region is expanded in view-box units to avoid clipping the
        // blurred shadow. pad_vb is already sized for the shadow extent.
        let filter_x = vb_x - pad_vb * 2.0;
        let filter_y = vb_y - pad_vb * 2.0;
        let filter_w = vb_w + pad_vb * 4.0;
        let filter_h = vb_h + pad_vb * 4.0;
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" width="{width}" height="{height}">
<defs>
<filter id="cursor-shadow" x="{filter_x}" y="{filter_y}" width="{filter_w}" height="{filter_h}" filterUnits="userSpaceOnUse">
<feDropShadow dx="{dx}" dy="{dy}" stdDeviation="{std_deviation}" flood-color="{shadow_color}" flood-opacity="{shadow_opacity}"/>
</filter>
</defs>
<g filter="url(#cursor-shadow)">{markup}</g>
</svg>"#,
            dx = settings.shadow_offset_x,
            dy = settings.shadow_offset_y,
            shadow_opacity = settings.shadow_opacity,
        )
    } else {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" width="{width}" height="{height}">{markup}</svg>"#
        )
    }
}

fn parse_hex_color(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('#') && (trimmed.len() == 7 || trimmed.len() == 9) {
        return trimmed.into();
    }
    // Named colors used by the fixtures/tests.
    match trimmed.to_ascii_lowercase().as_str() {
        "black" => "#000000".into(),
        "white" => "#ffffff".into(),
        _ => fallback.into(),
    }
}

fn inv_alpha_lut() -> &'static [f32; 256] {
    static INV_ALPHA: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    INV_ALPHA.get_or_init(|| {
        let mut lut = [0.0f32; 256];
        for (a, val) in lut.iter_mut().enumerate().take(255).skip(1) {
            *val = 255.0 / a as f32;
        }
        lut[255] = 1.0;
        lut
    })
}

/// tiny-skia / resvg store pixels as premultiplied RGBA. The export frame uses
/// straight-alpha RGBA, so convert once when the cursor asset is cached or in-place per frame.
pub(crate) fn unpremultiply_rgba(data: &mut [u8]) {
    let inv_lut = inv_alpha_lut();
    for pixel in data.as_chunks_mut::<4>().0 {
        let alpha = pixel[3] as usize;
        if alpha > 0 && alpha < 255 {
            let inv = inv_lut[alpha];
            pixel[0] = (pixel[0] as f32 * inv).min(255.0) as u8;
            pixel[1] = (pixel[1] as f32 * inv).min(255.0) as u8;
            pixel[2] = (pixel[2] as f32 * inv).min(255.0) as u8;
        }
    }
}

/// Same conversion as `unpremultiply_rgba`, restricted to the bounding box of
/// pixels with non-zero alpha. Alpha-0 pixels are left untouched either way,
/// and drawn content dominates only a small screen rect on most frames, so
/// bounding the pass avoids unpremultiplying millions of already-transparent
/// pixels per frame. `stride_w` is the row stride in pixels.
pub(crate) fn unpremultiply_rgba_bounded(data: &mut [u8], stride_w: usize) {
    let stride = stride_w.saturating_mul(4);
    if stride == 0 || data.len() < stride {
        return;
    }
    let mut rows = data.chunks_exact(stride);
    let mut top = usize::MAX;
    let mut bottom = 0usize;
    let mut left = usize::MAX;
    let mut right = 0usize;
    for (row, row_bytes) in rows.by_ref().enumerate() {
        let mut row_left = usize::MAX;
        let mut row_right = 0usize;
        for (col, pixel) in row_bytes.as_chunks::<4>().0.iter().enumerate() {
            if pixel[3] != 0 {
                row_left = row_left.min(col);
                row_right = col + 1;
            }
        }
        if row_left != usize::MAX {
            top = top.min(row);
            bottom = row + 1;
            left = left.min(row_left);
            right = right.max(row_right);
        }
    }
    if top == usize::MAX {
        return;
    }
    let inv_lut = inv_alpha_lut();
    for row_bytes in data[top * stride..bottom * stride].chunks_exact_mut(stride) {
        for pixel in row_bytes[left * 4..right * 4].as_chunks_mut::<4>().0 {
            let alpha = pixel[3] as usize;
            if alpha > 0 && alpha < 255 {
                let inv = inv_lut[alpha];
                pixel[0] = (pixel[0] as f32 * inv).min(255.0) as u8;
                pixel[1] = (pixel[1] as f32 * inv).min(255.0) as u8;
                pixel[2] = (pixel[2] as f32 * inv).min(255.0) as u8;
            }
        }
    }
}

/// Generates a grayscale anti-aliased rounded rectangle mask PNG for fast hardware/SIMD compositing with alphamerge.
pub fn generate_rounded_rect_mask_png(
    width: u32,
    height: u32,
    radius: f32,
) -> Result<Vec<u8>, String> {
    let mut pixmap = Pixmap::new(width.max(1), height.max(1))
        .ok_or_else(|| "failed to allocate mask pixmap".to_string())?;
    pixmap.fill(Color::BLACK);

    let w = width.max(1) as f32;
    let h = height.max(1) as f32;
    let r = radius.min(w / 2.0).min(h / 2.0).max(0.0);

    let mut pb = PathBuilder::new();
    if r <= 0.0 {
        pb.move_to(0.0, 0.0);
        pb.line_to(w, 0.0);
        pb.line_to(w, h);
        pb.line_to(0.0, h);
        pb.close();
    } else {
        pb.move_to(r, 0.0);
        pb.line_to(w - r, 0.0);
        pb.quad_to(w, 0.0, w, r);
        pb.line_to(w, h - r);
        pb.quad_to(w, h, w - r, h);
        pb.line_to(r, h);
        pb.quad_to(0.0, h, 0.0, h - r);
        pb.line_to(0.0, r);
        pb.quad_to(0.0, 0.0, r, 0.0);
        pb.close();
    }

    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(Color::WHITE);
        paint.anti_alias = true;
        pixmap.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
    pixmap
        .encode_png()
        .map_err(|e| format!("encode mask png: {e}"))
}

/// Generates a grayscale anti-aliased circle mask PNG for fast hardware/SIMD compositing with alphamerge.
pub fn generate_circle_mask_png(width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut pixmap = Pixmap::new(width.max(1), height.max(1))
        .ok_or_else(|| "failed to allocate circle mask pixmap".to_string())?;
    pixmap.fill(Color::BLACK);

    let w = width.max(1) as f32;
    let h = height.max(1) as f32;
    let rx = (w / 2.0).min(h / 2.0);
    let ry = rx;
    let cx = w / 2.0;
    let cy = h / 2.0;

    let k = 0.552_284_8;
    let kx = rx * k;
    let ky = ry * k;
    let mut pb = PathBuilder::new();
    pb.move_to(cx, cy - ry);
    pb.cubic_to(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
    pb.cubic_to(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
    pb.cubic_to(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
    pb.cubic_to(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
    pb.close();

    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(Color::WHITE);
        paint.anti_alias = true;
        pixmap.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
    pixmap
        .encode_png()
        .map_err(|e| format!("encode circle mask png: {e}"))
}

/// Return the exact presentation timestamp for a CFR output frame.
///
/// Keeping this as a rational calculation until the last possible boundary
/// prevents the per-frame floor in the old feeder from accumulating a visible
/// cursor lag over long exports.
pub(crate) fn frame_time_ms(frame_index: u64, fps: u32) -> f64 {
    if fps == 0 {
        return 0.0;
    }
    frame_index as f64 * 1_000.0 / fps as f64
}

/// Map an output presentation timestamp to the source timestamp for the active
/// segment. The result remains fractional so the cursor engine can interpolate
/// at the same PTS that FFmpeg assigns to the overlay frame.
fn source_time_for_output(segments: &[RenderSegment], output_ms: f64) -> Option<f64> {
    if !output_ms.is_finite() || output_ms < 0.0 {
        return None;
    }
    let segment = segments.iter().find(|segment| {
        output_ms >= segment.output_start_ms as f64 && output_ms < segment.output_end_ms as f64
    })?;
    let output_duration = segment
        .output_end_ms
        .saturating_sub(segment.output_start_ms) as f64;
    let source_duration = segment.source_out_ms.saturating_sub(segment.source_in_ms) as f64;
    if output_duration <= 0.0 || source_duration <= 0.0 {
        return None;
    }
    let elapsed = (output_ms - segment.output_start_ms as f64).clamp(0.0, output_duration);
    let ratio = source_duration / output_duration;
    Some((segment.source_in_ms as f64 + elapsed * ratio).min(segment.source_out_ms as f64))
}

fn parse_color(value: &str, fallback: Rgba) -> Rgba {
    let value = value.trim().trim_start_matches('#');
    let (value, alpha) = if value.len() == 8 {
        (
            &value[..6],
            u8::from_str_radix(&value[6..], 16).unwrap_or(255) as f32 / 255.0,
        )
    } else {
        (value, 1.0)
    };
    if value.len() != 6 {
        return fallback;
    }
    let red = u8::from_str_radix(&value[0..2], 16).ok();
    let green = u8::from_str_radix(&value[2..4], 16).ok();
    let blue = u8::from_str_radix(&value[4..6], 16).ok();
    match (red, green, blue) {
        (Some(red), Some(green), Some(blue)) => Rgba {
            red,
            green,
            blue,
            alpha,
        },
        _ => fallback,
    }
}

impl Rgba {
    const fn opaque(red: u8, green: u8, blue: u8) -> Self {
        Self {
            red,
            green,
            blue,
            alpha: 1.0,
        }
    }
}

fn blend_pixel(frame: &mut [u8], width: u32, x: i32, y: i32, color: Rgba, clip: &ClipRect) {
    if x < 0 || y < 0 || x >= width as i32 || !clip.contains(x, y) {
        return;
    }
    let index = (y as usize * width as usize + x as usize) * 4;
    if index + 3 >= frame.len() {
        return;
    }
    let source_alpha = color.alpha.clamp(0.0, 1.0);
    let destination_alpha = frame[index + 3] as f32 / 255.0;
    let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
    if output_alpha <= f32::EPSILON {
        return;
    }
    frame[index] = ((color.red as f32 * source_alpha
        + frame[index] as f32 * destination_alpha * (1.0 - source_alpha))
        / output_alpha) as u8;
    frame[index + 1] = ((color.green as f32 * source_alpha
        + frame[index + 1] as f32 * destination_alpha * (1.0 - source_alpha))
        / output_alpha) as u8;
    frame[index + 2] = ((color.blue as f32 * source_alpha
        + frame[index + 2] as f32 * destination_alpha * (1.0 - source_alpha))
        / output_alpha) as u8;
    frame[index + 3] = (output_alpha * 255.0).round() as u8;
}

/// Antialiased disc coverage for a pixel center at `distance` from a disc of
/// `radius`: fully covered below `radius - 0.5`, a 1px linear edge band, and
/// zero beyond `radius + 0.5`.
fn disc_coverage(distance: f64, radius: f64) -> f64 {
    (radius + 0.5 - distance).clamp(0.0, 1.0)
}

#[allow(clippy::too_many_arguments)]
fn fill_disc(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    color: Rgba,
    alpha: f64,
    clip: &ClipRect,
) {
    let outer = radius + 0.5;
    let min_x = (cx - outer).floor().max(0.0) as u32;
    let max_x = (cx + outer).ceil().min(width as f64) as u32;
    let min_y = (cy - outer).floor().max(0.0) as u32;
    let max_y = (cy + outer).ceil().min(height as f64) as u32;
    for py in min_y..max_y {
        for px in min_x..max_x {
            if !clip.contains(px as i32, py as i32) {
                continue;
            }
            let dx = px as f64 + 0.5 - cx;
            let dy = py as f64 + 0.5 - cy;
            let coverage = disc_coverage((dx * dx + dy * dy).sqrt(), radius);
            if coverage <= 0.0 {
                continue;
            }
            blend_pixel(
                frame,
                width,
                px as i32,
                py as i32,
                color.with_alpha(alpha * coverage),
                clip,
            );
        }
    }
}

/// Spotlight click style: a solid core disc at `0.55r` and a halo out to `r`
/// whose alpha falls off quadratically to zero at half strength.
#[allow(clippy::too_many_arguments)]
fn fill_spotlight_glow(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    color: Rgba,
    alpha: f64,
    clip: &ClipRect,
) {
    let core = radius * 0.55;
    let outer = radius + 0.5;
    let min_x = (cx - outer).floor().max(0.0) as u32;
    let max_x = (cx + outer).ceil().min(width as f64) as u32;
    let min_y = (cy - outer).floor().max(0.0) as u32;
    let max_y = (cy + outer).ceil().min(height as f64) as u32;
    for py in min_y..max_y {
        for px in min_x..max_x {
            if !clip.contains(px as i32, py as i32) {
                continue;
            }
            let dx = px as f64 + 0.5 - cx;
            let dy = py as f64 + 0.5 - cy;
            let distance = (dx * dx + dy * dy).sqrt();
            let edge = disc_coverage(distance, radius);
            if edge <= 0.0 {
                continue;
            }
            let pixel_alpha = if distance <= core {
                // AA on the core/halo boundary keeps a continuous edge.
                alpha * edge
            } else {
                let t = ((distance - core) / (radius - core).max(f64::EPSILON)).clamp(0.0, 1.0);
                alpha * 0.5 * (1.0 - t) * (1.0 - t) * edge
            };
            if pixel_alpha <= 0.0 {
                continue;
            }
            blend_pixel(
                frame,
                width,
                px as i32,
                py as i32,
                color.with_alpha(pixel_alpha),
                clip,
            );
        }
    }
}

/// Ring (ripple) with a `thickness`-wide stroke centered on `radius`, sampled
/// analytically at pixel centers for 1px antialiased edges.
#[allow(clippy::too_many_arguments)]
fn draw_ring_aa(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    thickness: f64,
    color: Rgba,
    alpha: f64,
    clip: &ClipRect,
) {
    let half_stroke = thickness / 2.0;
    let outer = radius + half_stroke + 0.5;
    let min_x = (cx - outer).floor().max(0.0) as u32;
    let max_x = (cx + outer).ceil().min(width as f64) as u32;
    let min_y = (cy - outer).floor().max(0.0) as u32;
    let max_y = (cy + outer).ceil().min(height as f64) as u32;
    for py in min_y..max_y {
        for px in min_x..max_x {
            if !clip.contains(px as i32, py as i32) {
                continue;
            }
            let dx = px as f64 + 0.5 - cx;
            let dy = py as f64 + 0.5 - cy;
            let distance = (dx * dx + dy * dy).sqrt();
            // A stroke centered on `radius` covers |d - radius| < half + AA.
            let coverage = (half_stroke + 0.5 - (distance - radius).abs()).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                continue;
            }
            blend_pixel(
                frame,
                width,
                px as i32,
                py as i32,
                color.with_alpha(alpha * coverage),
                clip,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::RenderCropFloat;

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FractionalParityFixture {
        canvas: RenderCanvas,
        screen_rect: GoldenScreenRect,
        telemetry: CursorTelemetryFile,
        segments: Vec<RenderSegment>,
        zoom_segments: Vec<RenderPlanZoomSegment>,
        frames: Vec<GoldenFrame>,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenScreenRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenFrame {
        time_ms: f64,
        expected: GoldenFrameExpectation,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenFrameExpectation {
        source_time_ms: f64,
        source_point: GoldenPoint,
        zoom: GoldenZoom,
        cursor_point: GoldenPoint,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenPoint {
        x: f64,
        y: f64,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenZoom {
        progress: f64,
        scale: f64,
        crop: GoldenCrop,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenCrop {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    fn fractional_parity_fixture() -> FractionalParityFixture {
        serde_json::from_str(include_str!(
            "../../../../../tooling/golden-fixtures/preview-rust-fractional-frame.json"
        ))
        .expect("fractional preview/Rust golden fixture is valid")
    }

    fn assert_within_half_pixel(label: &str, actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 0.5,
            "{label}: expected {expected}, got {actual}"
        );
    }

    fn make_v2_telemetry() -> CursorTelemetryFile {
        CursorTelemetryFile {
            schema_version: 2,
            asset_id: "cursor-events:recording".into(),
            recording_id: "recording".into(),
            source_width: 100.0,
            source_height: 100.0,
            sample_rate_hz: 60.0,
            capture_bounds: Some(cursor_engine::CursorCaptureBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            }),
            coordinate_transform: cursor_engine::CursorCoordinateTransform::default(),
            topology: None,
            shapes: Vec::new(),
            click_window_ms: 350,
            health: cursor_engine::CursorTelemetryHealth::Healthy,
            event_count: 2,
            index: Vec::new(),
            event_file: "cursor_events.bin".into(),
            timebase: cursor_engine::CursorTelemetryTimebase::default(),
            events: vec![
                cursor_engine::CursorEvent {
                    t_ms: 0,
                    x: 10.0,
                    y: 20.0,
                    visible: true,
                    ..Default::default()
                },
                cursor_engine::CursorEvent {
                    t_ms: 100,
                    x: 40.0,
                    y: 50.0,
                    button: Some("left".into()),
                    button_event: Some("down".into()),
                    clicked: true,
                    visible: true,
                    ..Default::default()
                },
            ],
        }
        .normalize()
    }

    fn segments() -> Vec<RenderSegment> {
        vec![RenderSegment {
            asset_id: "recording".into(),
            stream_index: None,
            volume: None,
            fade_in_ms: None,
            fade_out_ms: None,
            volume_keyframes: None,
            audio_filter: None,
            speed: 1.0,
            source_in_ms: 0,
            source_out_ms: 1_000,
            output_start_ms: 0,
            output_end_ms: 1_000,
            source_width: None,
            source_height: None,
        }]
    }

    #[test]
    fn maps_output_time_to_source_time_for_a_segment() {
        assert_eq!(source_time_for_output(&segments(), 500.0), Some(500.0));
    }

    #[test]
    fn maps_exact_fractional_frame_pts_without_flooring_time() {
        let mut scaled = segments();
        scaled[0].source_out_ms = 2_000;

        let frame_time_ms = frame_time_ms(1, 30);
        let source_time = source_time_for_output(&scaled, frame_time_ms).expect("active segment");

        assert!((frame_time_ms - (1_000.0 / 30.0)).abs() < 0.000_001);
        assert!((source_time - (2_000.0 / 30.0)).abs() < 0.000_001);
    }

    fn test_canvas(width: u32, height: u32, padding: u32) -> RenderCanvas {
        RenderCanvas {
            width,
            height,
            padding,
            ..Default::default()
        }
    }

    #[test]
    fn renders_a_non_empty_cursor_frame() {
        let mut renderer = CursorRenderer::new(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &test_canvas(100, 100, 0),
        )
        .expect("valid cursor renderer");
        let mut frame = vec![0; 100 * 100 * 4];
        renderer.render_frame_at(100.0, &mut frame);
        assert!(frame.chunks_exact(4).any(|pixel| pixel[3] > 0));
    }

    #[test]
    fn rasterized_cursor_uses_asset_hotspot_and_fill_color() {
        let mut settings = CursorSettings::default();
        settings.preset = "recorded-system".into();
        settings.fill_color = "#ff0000".into();
        settings.stroke_color = "#ffffff".into();
        settings.shadow_enabled = false;
        settings.scale = 2.0;

        let mut renderer = CursorRenderer::new(
            settings,
            make_v2_telemetry(),
            &segments(),
            &test_canvas(100, 100, 0),
        )
        .expect("valid cursor renderer");
        let mut frame = vec![0; 100 * 100 * 4];
        // Time 0 places the cursor at the first telemetry sample (10, 20).
        renderer.render_frame_at(0.0, &mut frame);

        let mut found = false;
        for index in (0..frame.len()).step_by(4) {
            let pixel = &frame[index..index + 4];
            // The recorded cursor arrow is filled with the configured red.
            if pixel[3] > 200 && pixel[0] > 200 && pixel[1] < 50 && pixel[2] < 50 {
                found = true;
                break;
            }
        }
        assert!(
            found,
            "expected a solid red cursor pixel in the rendered frame"
        );
    }

    #[test]
    fn spotlight_click_effect_draws_a_radial_glow_beyond_the_core() {
        let mut settings = CursorSettings::default();
        settings.click_feedback = "spotlight".into();
        settings.click_color = "#00ff00".into();
        settings.click_size = 40.0;

        let mut renderer = CursorRenderer::new(
            settings,
            make_v2_telemetry(),
            &segments(),
            &test_canvas(100, 100, 0),
        )
        .expect("valid cursor renderer");
        let mut frame = vec![0; 100 * 100 * 4];
        // The second telemetry sample is a left-click at (40, 50) and time 100,
        // which is the start of the click effect (progress 0, full intensity).
        renderer.render_frame_at(100.0, &mut frame);

        let mut core_pixel_count = 0;
        let mut glow_pixel_count = 0;
        for py in 0..100u32 {
            for px in 0..100u32 {
                let dx = px as f64 - 40.0;
                let dy = py as f64 - 50.0;
                let distance = (dx * dx + dy * dy).sqrt();
                let index = (py as usize * 100 + px as usize) * 4;
                let pixel = &frame[index..index + 4];
                if pixel[3] > 10 && pixel[1] > 100 {
                    if distance <= 5.0 {
                        core_pixel_count += 1;
                    } else if distance <= 12.0 {
                        glow_pixel_count += 1;
                    }
                }
            }
        }
        assert!(core_pixel_count > 0, "expected a solid spotlight core");
        assert!(
            glow_pixel_count > 0,
            "expected a spotlight glow outside the core"
        );
    }

    #[test]
    fn matches_shared_cursor_fixture_metadata_and_aspect_fit() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tooling/fixtures/editor-fixtures/cursor-telemetry.json"
        ));
        let telemetry = serde_json::from_str::<CursorTelemetryFile>(fixture)
            .expect("shared cursor fixture should parse")
            .normalize();
        assert_eq!(telemetry.schema_version, 2);
        assert_eq!(telemetry.asset_id, "asset-cursor-events");
        let renderer = CursorRenderer::new(
            CursorSettings::default(),
            telemetry,
            &segments(),
            &test_canvas(1_920, 1_080, 0),
        )
        .expect("valid cursor renderer");
        let engine = renderer.engine.lock().expect("cursor engine");
        let frame = engine.evaluate(0.0, &renderer.settings);
        assert!(frame.visible);
        let point = engine.fit(frame.source_x, frame.source_y, 1_920.0, 1_080.0, 0.0);
        assert!((point.x - 352.5).abs() < 0.01);
        assert!((point.y - 135.0).abs() < 0.01);
    }

    #[test]
    fn does_not_render_hidden_cursor_events() {
        let mut data = make_v2_telemetry();
        data.events[1].visible = false;
        let mut renderer = CursorRenderer::new(
            CursorSettings::default(),
            data,
            &segments(),
            &test_canvas(100, 100, 0),
        )
        .expect("valid cursor renderer");
        let mut frame = vec![0; 100 * 100 * 4];
        renderer.render_frame_at(100.0, &mut frame);
        assert!(frame.chunks_exact(4).all(|pixel| pixel[3] == 0));
    }

    #[test]
    fn apply_zoom_clamps_target_to_padded_content_area() {
        let zoom = RenderPlanZoomSegment {
            id: "zoom".into(),
            start_ms: 0,
            end_ms: 1_000,
            target: RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 200.0,
            },
            scale: 2.0,
            easing: "linear".into(),
            transition_in_ms: 300,
            transition_out_ms: 300,
            enabled: true,
            mode: "manual".into(),
            source: "manual".into(),
            preset: "manual-only".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: None,
            from_scale: None,
            keyframes: None,
            motion_plan: None,
        };
        let renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &[zoom],
            &test_canvas(200, 200, 20),
            None,
            None,
        )
        .expect("valid cursor renderer");

        // In the 3-phase lifecycle, 500ms is in the sustained hold phase.
        // Canvas 200x200 (padding 20) -> screen rect (20,20,160,160); source
        // 100x100. Target (0,0,200,200) at scale 2 -> crop (50,50,100,100),
        // zoom = 2 -> integer crop: w = 100/2 = 50, dx = 50-25 = 25 -> snap
        // to 24. Source (60,60) -> ((60-24)+0.5)*160/50 - 0.5 = 116.3 ->
        // canvas 20 + 116.3 = 136.3.
        let (x, y) = renderer.map_source_at(500.0, 60.0, 60.0);
        assert!((x - 136.3).abs() < 0.1, "expected 136.3, got {x}");
        assert!((y - 136.3).abs() < 0.1, "expected 136.3, got {y}");

        // After the segment ends the cursor uses the aspect-fit path:
        // 20 + 60 * 1.6 = 116.0.
        let (no_zoom_x, no_zoom_y) = renderer.map_source_at(1_001.0, 60.0, 60.0);
        assert!((no_zoom_x - 116.0).abs() < 0.01);
        assert!((no_zoom_y - 116.0).abs() < 0.01);
    }

    #[test]
    fn apply_zoom_interpolates_keyframes_accurately() {
        let zoom = RenderPlanZoomSegment {
            id: "zoom-follow".into(),
            start_ms: 0,
            end_ms: 1_000,
            target: RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            scale: 2.0,
            easing: "linear".into(),
            transition_in_ms: 0,
            transition_out_ms: 0,
            enabled: true,
            mode: "follow-cursor".into(),
            source: "manual".into(),
            preset: "manual-only".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: None,
            from_scale: None,
            keyframes: Some(vec![
                crate::exports::RenderPlanZoomKeyframe {
                    time_ms: 0,
                    target: RenderCropFloat {
                        x: 0.0,
                        y: 0.0,
                        width: 100.0,
                        height: 100.0,
                    },
                },
                crate::exports::RenderPlanZoomKeyframe {
                    time_ms: 1_000,
                    target: RenderCropFloat {
                        x: 100.0,
                        y: 100.0,
                        width: 100.0,
                        height: 100.0,
                    },
                },
            ]),
            motion_plan: None,
        };
        let renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &[zoom],
            &test_canvas(200, 200, 0),
            None,
            None,
        )
        .expect("valid cursor renderer");

        let transform_mid = renderer.resolve_zoom_transform_at(500.0);
        assert!((transform_mid.crop_x - 50.0).abs() < 0.1);
        assert!((transform_mid.crop_y - 50.0).abs() < 0.1);
        assert!((transform_mid.scale - 2.0).abs() < 0.1);
    }

    #[test]
    fn apply_zoom_interpolates_compact_motion_plan_accurately() {
        let zoom = RenderPlanZoomSegment {
            id: "zoom-motion".into(),
            start_ms: 0,
            end_ms: 1_000,
            target: RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            scale: 2.0,
            easing: "linear".into(),
            transition_in_ms: 0,
            transition_out_ms: 0,
            enabled: true,
            mode: "follow-cursor".into(),
            source: "manual".into(),
            preset: "manual-only".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: None,
            from_scale: None,
            keyframes: None,
            motion_plan: Some(crate::exports::RenderPlanZoomMotionPlan {
                version: 1,
                kind: "cubic-bezier".into(),
                segments: vec![crate::exports::RenderPlanZoomMotionSegment {
                    start_ms: 0,
                    end_ms: 1_000,
                    start: crate::exports::RenderPlanZoomMotionPoint { x: 50.0, y: 50.0 },
                    control1: crate::exports::RenderPlanZoomMotionPoint { x: 50.0, y: 50.0 },
                    control2: crate::exports::RenderPlanZoomMotionPoint { x: 150.0, y: 150.0 },
                    end: crate::exports::RenderPlanZoomMotionPoint { x: 150.0, y: 150.0 },
                }],
            }),
        };
        let renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &[zoom],
            &test_canvas(200, 200, 0),
            None,
            None,
        )
        .expect("valid cursor renderer");

        let transform_mid = renderer.resolve_zoom_transform_at(500.0);
        assert!((transform_mid.crop_x - 50.0).abs() < 0.1);
        assert!((transform_mid.crop_y - 50.0).abs() < 0.1);
        assert!((transform_mid.scale - 2.0).abs() < 0.1);
    }

    #[test]
    fn apply_zoom_pans_seamlessly_from_previous_segment() {
        let zoom1 = RenderPlanZoomSegment {
            id: "zoom-1".into(),
            start_ms: 0,
            end_ms: 1_000,
            target: RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            scale: 2.0,
            easing: "linear".into(),
            transition_in_ms: 200,
            transition_out_ms: 200,
            enabled: true,
            mode: "manual".into(),
            source: "manual".into(),
            preset: "manual-only".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: None,
            from_scale: None,
            keyframes: None,
            motion_plan: None,
        };
        let zoom2 = RenderPlanZoomSegment {
            id: "zoom-2".into(),
            start_ms: 1_000,
            end_ms: 2_000,
            target: RenderCropFloat {
                x: 100.0,
                y: 100.0,
                width: 100.0,
                height: 100.0,
            },
            scale: 2.0,
            easing: "linear".into(),
            transition_in_ms: 400,
            transition_out_ms: 200,
            enabled: true,
            mode: "manual".into(),
            source: "manual".into(),
            preset: "manual-only".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: Some(RenderCropFloat {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            }),
            from_scale: Some(2.0),
            keyframes: None,
            motion_plan: None,
        };
        let renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &[zoom1, zoom2],
            &test_canvas(200, 200, 0),
            None,
            None,
        )
        .expect("valid cursor renderer");

        // At 1200ms (halfway through 400ms transition), crop should be at (50, 50) with scale 2.0 (never dropping to 1.0)
        let transform = renderer.resolve_zoom_transform_at(1200.0);
        assert!((transform.crop_x - 50.0).abs() < 0.1);
        assert!((transform.crop_y - 50.0).abs() < 0.1);
        assert!((transform.scale - 2.0).abs() < 0.1);
    }

    #[test]
    fn matches_typescript_preview_golden_frames_at_fractional_timestamps() {
        let fixture = fractional_parity_fixture();
        let settings = fixture.canvas.cursor_settings.clone();
        let screen_rect = (
            fixture.screen_rect.x,
            fixture.screen_rect.y,
            fixture.screen_rect.width,
            fixture.screen_rect.height,
        );
        let source_w = fixture.telemetry.source_width;
        let source_h = fixture.telemetry.source_height;
        let mut renderer = CursorRenderer::new_with_zoom(
            settings.clone(),
            fixture.telemetry,
            &fixture.segments,
            &fixture.zoom_segments,
            &fixture.canvas,
            Some(screen_rect),
            None,
        )
        .expect("valid fractional preview/Rust parity renderer");

        for golden in fixture.frames {
            assert!(
                golden.time_ms.fract().abs() > f64::EPSILON,
                "golden frame timestamp must remain fractional: {}",
                golden.time_ms
            );
            let source_time = source_time_for_output(&fixture.segments, golden.time_ms)
                .expect("golden frame must map to a source timestamp");
            let cursor_frame = renderer
                .engine
                .lock()
                .expect("cursor engine")
                .evaluate(source_time, &settings);
            let expected = &golden.expected;

            assert!((cursor_frame.source_time_ms - expected.source_time_ms).abs() < 0.000_001);
            assert_within_half_pixel(
                "cursor source x",
                cursor_frame.source_x,
                expected.source_point.x,
            );
            assert_within_half_pixel(
                "cursor source y",
                cursor_frame.source_y,
                expected.source_point.y,
            );

            let transform = renderer.resolve_zoom_transform_at(golden.time_ms);
            assert!((transform.progress - expected.zoom.progress).abs() < 0.000_001);
            assert!((transform.scale - expected.zoom.scale).abs() < 0.000_001);
            assert_within_half_pixel("zoom crop x", transform.crop_x, expected.zoom.crop.x);
            assert_within_half_pixel("zoom crop y", transform.crop_y, expected.zoom.crop.y);
            assert_within_half_pixel(
                "zoom crop width",
                transform.crop_w,
                expected.zoom.crop.width,
            );
            assert_within_half_pixel(
                "zoom crop height",
                transform.crop_h,
                expected.zoom.crop.height,
            );

            // The export cursor is registered to zoompan's integer crop, so
            // it can differ from the float-crop preview mapping by the crop
            // quantization: the origin shifts down by <2 input px (truncate +
            // chroma snap) and the size truncates by <1 input px. Bound the
            // error at ~3 input px expressed in output px.
            let (_, _, int_w, int_h) = camera::zoompan_integer_crop(
                (
                    transform.crop_x,
                    transform.crop_y,
                    transform.crop_w,
                    transform.crop_h,
                ),
                source_w,
                source_h,
                fixture.canvas.width as f64,
                fixture.canvas.height as f64,
                1,
                1,
            );
            let quantize_bound_x = 3.0 * fixture.screen_rect.width / int_w.max(1) as f64 + 0.5;
            let quantize_bound_y = 3.0 * fixture.screen_rect.height / int_h.max(1) as f64 + 0.5;
            let cursor_point = renderer.map_source_at(
                golden.time_ms,
                cursor_frame.source_x,
                cursor_frame.source_y,
            );
            assert!(
                (cursor_point.0 - expected.cursor_point.x).abs() <= quantize_bound_x,
                "cursor x {} vs golden {} exceeds zoompan quantization bound {quantize_bound_x}",
                cursor_point.0,
                expected.cursor_point.x,
            );
            assert!(
                (cursor_point.1 - expected.cursor_point.y).abs() <= quantize_bound_y,
                "cursor y {} vs golden {} exceeds zoompan quantization bound {quantize_bound_y}",
                cursor_point.1,
                expected.cursor_point.y,
            );

            let mut frame =
                vec![0; fixture.canvas.width as usize * fixture.canvas.height as usize * 4];
            renderer.render_frame_at(golden.time_ms, &mut frame);
            assert!(
                frame.chunks_exact(4).any(|pixel| pixel[3] > 0),
                "fractional golden frame at {}ms should contain cursor pixels",
                golden.time_ms
            );
        }
    }

    #[test]
    fn side_by_side_places_cursor_strictly_inside_left_screen_bounds() {
        // Canvas: 1920x1080 with 40px padding.
        // Side-by-side screen is placed on the left: target_w = (1920 - 80)*0.76 = 1398, x = 40.
        // Screen bounds: x: 40, y: 40 + (1000 - 786)/2 = 147, w: 1398, h: 786.
        let screen_rect = (40.0, 147.0, 1398.0, 786.0);
        let mut telemetry = make_v2_telemetry();
        // Telemetry point at bottom-right corner of recorded source:
        telemetry.events = vec![cursor_engine::CursorEvent {
            t_ms: 0,
            x: 100.0,
            y: 100.0,
            visible: true,
            shape_id: Some("arrow".into()),
            ..Default::default()
        }];

        let mut renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            telemetry,
            &segments(),
            &[],
            &test_canvas(1920, 1080, 40),
            Some(screen_rect),
            None,
        )
        .expect("valid side-by-side renderer");

        let (px, py) = renderer.fit_source_point(100.0, 100.0);
        // Source is 100x100 (1:1). Target screen is 1398x786 (16:9).
        // Fit scale = 786 / 100 = 7.86, fit_width = 786. Offset_x = (1398 - 786) / 2 = 306.0.
        // Mapped x = 40 + 306 + 100 * 7.86 = 1132.0.
        // Mapped y = 147 + 0 + 100 * 7.86 = 933.0.
        assert!(
            (px - 1132.0).abs() < 1.0,
            "expected px near 1132.0, got {px}"
        );
        assert!((py - 933.0).abs() < 1.0, "expected py near 933.0, got {py}");

        // Now test 16:9 source (1920x1080)
        let mut telemetry_16_9 = make_v2_telemetry();
        telemetry_16_9.source_width = 1920.0;
        telemetry_16_9.source_height = 1080.0;
        let renderer_16_9 = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            telemetry_16_9,
            &segments(),
            &[],
            &test_canvas(1920, 1080, 40),
            Some(screen_rect),
            None,
        )
        .expect("valid 16:9 side-by-side renderer");
        let (px_16_9, py_16_9) = renderer_16_9.fit_source_point(1920.0, 1080.0);
        // For 16:9 source matching 16:9 screen rect, (1920, 1080) maps exactly to (40 + 1398 = 1438, 147 + 786 = 933)
        assert!(
            (px_16_9 - 1438.0).abs() < 1.0,
            "expected px_16_9 near 1438.0, got {px_16_9}"
        );
        assert!(
            (py_16_9 - 933.0).abs() < 1.0,
            "expected py_16_9 near 933.0, got {py_16_9}"
        );

        // Render frame: no pixels should bleed beyond the screen rect,
        // and absolutely no pixels should be in the right camera half (x > 1470).
        let mut frame = vec![0; 1920 * 1080 * 4];
        renderer.render_frame_at(0.0, &mut frame);

        let mut right_side_pixels = 0;
        for py in 0..1080u32 {
            for px in 1470..1920u32 {
                let idx = (py as usize * 1920 + px as usize) * 4;
                if frame[idx + 3] > 0 {
                    right_side_pixels += 1;
                }
            }
        }
        assert_eq!(
            right_side_pixels, 0,
            "cursor rendered pixels on the camera/right side of the canvas in side-by-side mode"
        );
    }

    #[test]
    fn renders_different_cursor_types_per_frame() {
        let mut telemetry = make_v2_telemetry();
        telemetry.events = vec![
            cursor_engine::CursorEvent {
                t_ms: 0,
                x: 50.0,
                y: 50.0,
                visible: true,
                shape_id: Some("arrow".into()),
                ..Default::default()
            },
            cursor_engine::CursorEvent {
                t_ms: 200,
                x: 50.0,
                y: 50.0,
                visible: true,
                shape_id: Some("ibeam".into()),
                ..Default::default()
            },
            cursor_engine::CursorEvent {
                t_ms: 400,
                x: 50.0,
                y: 50.0,
                visible: true,
                shape_id: Some("hand".into()),
                ..Default::default()
            },
        ];
        let mut settings = CursorSettings::default();
        settings.shape_mode = "optimized".into();

        let mut renderer =
            CursorRenderer::new(settings, telemetry, &segments(), &test_canvas(100, 100, 0))
                .expect("valid cursor renderer");

        let mut frame_arrow = vec![0; 100 * 100 * 4];
        renderer.render_frame_at(0.0, &mut frame_arrow);

        let mut frame_ibeam = vec![0; 100 * 100 * 4];
        renderer.render_frame_at(200.0, &mut frame_ibeam);

        let mut frame_hand = vec![0; 100 * 100 * 4];
        renderer.render_frame_at(400.0, &mut frame_hand);

        // All 3 frames should have non-empty cursor content
        assert!(frame_arrow.iter().any(|&b| b > 0));
        assert!(frame_ibeam.iter().any(|&b| b > 0));
        assert!(frame_hand.iter().any(|&b| b > 0));

        // And the rendered pixel buffers must differ between cursor shapes
        assert_ne!(
            frame_arrow, frame_ibeam,
            "arrow and ibeam should render different pixels"
        );
        assert_ne!(
            frame_ibeam, frame_hand,
            "ibeam and hand should render different pixels"
        );

        // The tree cache should hold all 3 resolved assets
        for asset_id in ["shape-arrow", "shape-ibeam", "shape-hand"] {
            assert!(
                renderer.tree_cache.keys().any(|(id, _)| id == asset_id),
                "expected a parsed tree for {asset_id}"
            );
        }
    }

    #[test]
    fn spring_easing_is_normalized_with_bounded_overshoot() {
        assert!((camera::ease_progress(0.0, "spring")).abs() < 1e-9);
        assert!((camera::ease_progress(1.0, "spring") - 1.0).abs() < 1e-9);

        let mut max = 0.0f64;
        for i in 0..=500 {
            max = max.max(camera::ease_progress(i as f64 / 500.0, "spring"));
        }
        assert!(max > 1.0, "a real spring must overshoot the endpoint");
        assert!(max <= 1.03, "spring overshoot {max} exceeds 3%");
    }

    #[test]
    fn snappy_zoom_out_decelerates_into_the_end() {
        let zoom_segments = vec![RenderPlanZoomSegment {
            id: "snappy-out".into(),
            start_ms: 0,
            end_ms: 1_000,
            target: RenderCropFloat {
                x: 480.0,
                y: 270.0,
                width: 960.0,
                height: 540.0,
            },
            scale: 2.0,
            easing: "snappy".into(),
            transition_in_ms: 200,
            transition_out_ms: 300,
            enabled: true,
            mode: "auto".into(),
            source: "click".into(),
            preset: "product-demo".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: None,
            from_scale: None,
            keyframes: None,
            motion_plan: None,
        }];
        let renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &zoom_segments,
            &test_canvas(1_920, 1_080, 0),
            None,
            None,
        )
        .expect("valid snappy-out renderer");

        // Out-phase spans elapsed 700..1000ms: snappy must start steep and end
        // nearly flat, like a real ease-out camera move.
        let progress_at = |t: f64| renderer.resolve_zoom_transform_at(t).progress;
        let drop_near_start = progress_at(700.0) - progress_at(710.0);
        let drop_near_end = progress_at(990.0) - progress_at(1_000.0);
        assert!(
            drop_near_start > 0.05,
            "out phase must start steep: {drop_near_start}"
        );
        assert!(
            drop_near_end < drop_near_start * 0.01,
            "out phase must end nearly flat: {drop_near_end} vs start {drop_near_start}"
        );
        assert_eq!(progress_at(1_000.0), 0.0);
    }

    #[test]
    fn ripple_ring_has_antialiased_edge_pixels() {
        let settings = CursorSettings {
            click_feedback: "ripple".into(),
            click_color: "#ff0000".into(),
            ..Default::default()
        };
        let renderer = CursorRenderer::new(
            settings,
            make_v2_telemetry(),
            &segments(),
            &test_canvas(200, 200, 0),
        )
        .expect("valid cursor renderer");
        let click = cursor_engine::CursorClickEffect {
            button: cursor_engine::CursorButton::Left,
            start_ms: 0,
            source_x: 50.0,
            source_y: 50.0,
            progress: 0.5,
            intensity: 0.5,
            expand: 1.0 - 0.5_f64.powi(3),
            fade: 0.25,
        };
        let clip = renderer.video_screen;
        let mut frame = vec![0u8; 200 * 200 * 4];
        renderer.render_click_feedback(&mut frame, 100.0, 100.0, &click, 1.0, &clip);

        // Coverage at pixel centers yields fractional alpha at the ring edges.
        let fractional = frame
            .chunks_exact(4)
            .filter(|p| p[3] > 10 && p[3] < 240)
            .count();
        assert!(
            fractional > 0,
            "ripple ring should have antialiased (fractional alpha) edge pixels"
        );
    }

    #[test]
    fn spotlight_dim_is_black_even_with_colored_shadow() {
        let settings = CursorSettings {
            spotlight_mode: true,
            spotlight_dim_opacity: 0.6,
            // A non-black shadow color must not leak into the dim layer.
            shadow_color: "#ff00ff".into(),
            ..Default::default()
        };
        let renderer = CursorRenderer::new(
            settings,
            make_v2_telemetry(),
            &segments(),
            &test_canvas(200, 200, 0),
        )
        .expect("valid cursor renderer");
        let clip = renderer.video_screen;
        let mut frame = vec![0u8; 200 * 200 * 4];
        renderer.render_spotlight(&mut frame, 150.0, 100.0, 1.0, &clip);

        // A pixel far from the hole is fully dimmed with pure black.
        let index = (10 * 200 + 10) * 4;
        assert_eq!(
            &frame[index..index + 3],
            &[0, 0, 0],
            "spotlight dim must be black, not shadow_color"
        );
        assert!(frame[index + 3] > 100, "dim pixel should be mostly opaque");
        // Feather band pixels carry partial alpha.
        let feathered = frame
            .chunks_exact(4)
            .filter(|p| p[3] > 10 && p[3] < 100)
            .count();
        assert!(
            feathered > 0,
            "spotlight hole edge should have a feathered gradient"
        );
    }

    #[test]
    fn renderers_share_one_engine_per_telemetry() {
        let engine = Arc::new(std::sync::Mutex::new(
            cursor_engine::CursorEngine::new(
                make_v2_telemetry(),
                cursor_engine::CursorEngineOptions::default(),
            )
            .expect("engine"),
        ));
        let canvas = test_canvas(200, 200, 0);
        let first = CursorRenderer::new_with_engine(
            CursorSettings::default(),
            engine.clone(),
            &segments(),
            &[],
            &canvas,
            None,
            None,
        )
        .expect("first renderer");
        let second = CursorRenderer::new_with_engine(
            CursorSettings::default(),
            engine.clone(),
            &segments(),
            &[],
            &canvas,
            None,
            None,
        )
        .expect("second renderer");
        assert_eq!(Arc::strong_count(&engine), 3);
        assert!(Arc::ptr_eq(&first.engine, &second.engine));
    }

    #[test]
    fn quarter_pixel_phases_keep_subpixel_cursor_positions() {
        let mut renderer = CursorRenderer::new(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &test_canvas(200, 200, 0),
        )
        .expect("valid cursor renderer");
        let clip = renderer.video_screen;
        let scale = renderer.cursor_scale_factor * renderer.base_fit_scale;

        let mut frame_a = vec![0; 200 * 200 * 4];
        renderer.draw_cursor(&mut frame_a, 50.0, 50.0, 1.0, "", scale, &clip);
        let mut frame_b = vec![0; 200 * 200 * 4];
        renderer.draw_cursor(&mut frame_b, 50.25, 50.0, 1.0, "", scale, &clip);
        assert_ne!(
            frame_a, frame_b,
            "0.25px offset must change the rendered cursor"
        );

        // Repeating a position hits the raster cache without growth.
        let cached = renderer.raster_cache.len();
        let mut frame_c = vec![0; 200 * 200 * 4];
        renderer.draw_cursor(&mut frame_c, 50.0, 50.0, 1.0, "", scale, &clip);
        assert_eq!(renderer.raster_cache.len(), cached);
        assert_eq!(frame_a, frame_c, "same phase must reuse the same raster");

        // The LRU is bounded at RASTER_CACHE_CAPACITY: fill it with cheap
        // synthetic entries, then a real rasterization must evict the oldest.
        let asset = cursor_engine::assets::resolve_cursor_asset_or_default("arrow");
        renderer.raster_cache.clear();
        for index in 0..RASTER_CACHE_CAPACITY {
            renderer.raster_cache.push(RasterCacheEntry {
                asset_id: format!("filler-{index}"),
                scale_bin: 1,
                phase_x: 0,
                phase_y: 0,
                cursor: RasterizedCursor {
                    width: 1,
                    height: 1,
                    data: vec![0; 4],
                },
            });
        }
        renderer
            .raster_index(asset, 999, 0, 0)
            .expect("rasterize over-capacity entry");
        assert_eq!(renderer.raster_cache.len(), RASTER_CACHE_CAPACITY);
        assert_eq!(renderer.raster_cache[0].asset_id, "filler-1");
    }

    /// FFmpeg-backed registration test: render a known bright square through
    /// the real zoompan filter string built by `camera::build_zoompan_expressions`
    /// and measure where it lands; the cursor mapping must place a source
    /// point at the same output position (within 0.75 px).
    #[test]
    fn zoompan_integer_crop_registration_matches_ffmpeg() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(path) => path,
            Err(_) => return, // sidecar unavailable; skip
        };

        // Source: 256x144 black video with an 8x8 white square whose pixel
        // center is at (124, 64) in input space.
        let src_w = 256.0f64;
        let src_h = 144.0f64;
        let out_w = 128u32;
        let out_h = 72u32;
        let square_center = (124.0f64, 64.0f64);

        // Slow pan: zoom from the full 128x72 canvas to a 2x crop centered on
        // the square's unzoomed display position (124*0.5, 64*0.5) = (62,32)
        // over the first 1.2s, then hold.
        let zoom = RenderPlanZoomSegment {
            id: "zoom-reg".into(),
            start_ms: 0,
            end_ms: 2_000,
            target: RenderCropFloat {
                x: 30.0,
                y: 14.0,
                width: 64.0,
                height: 36.0,
            },
            scale: 2.0,
            easing: "linear".into(),
            transition_in_ms: 1_200,
            transition_out_ms: 0,
            enabled: true,
            mode: "manual".into(),
            source: "manual".into(),
            preset: "manual-only".into(),
            follow_deadzone_percent: None,
            follow_smoothing_alpha: None,
            label: None,
            from_target: None,
            from_scale: None,
            keyframes: None,
            motion_plan: None,
        };
        let plan = crate::exports::RenderPlan {
            zoom_segments: vec![zoom.clone()],
            ..tests_plan()
        };
        // canvas = output frame dims; zoompan input = the 256x144 source.
        let canvas = RenderCanvas {
            width: out_w,
            height: out_h,
            fps: 30,
            ..Default::default()
        };
        let (z_expr, x_expr, y_expr) =
            camera::build_zoompan_expressions(&plan, &canvas, src_w, src_h);
        let filter = format!(
            "drawbox=x=120:y=60:w=8:h=8:c=white:t=fill,format=yuv420p,zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={out_w}x{out_h}:fps=30"
        );

        let temp_dir =
            std::env::temp_dir().join(format!("rf-test-zoomreg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let raw_path = temp_dir.join("frames.gray");
        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=256x144:r=30:d=2",
                "-vf",
                &filter,
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
            ])
            .arg(&raw_path)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "zoompan render failed: {}",
            String::from_utf8_lossy(&status.stderr)
                .chars()
                .rev()
                .take(2_000)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        );
        let frames = std::fs::read(&raw_path).unwrap();
        let frame_len = out_w as usize * out_h as usize;
        assert_eq!(frames.len() % frame_len, 0, "rawvideo frame alignment");
        let frame_count = frames.len() / frame_len;

        let mut telemetry = make_v2_telemetry();
        telemetry.source_width = src_w;
        telemetry.source_height = src_h;
        telemetry.capture_bounds = Some(cursor_engine::CursorCaptureBounds {
            x: 0.0,
            y: 0.0,
            width: src_w,
            height: src_h,
        });
        let renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            telemetry,
            &segments(),
            &[zoom],
            &RenderCanvas {
                width: out_w,
                height: out_h,
                fps: 30,
                ..Default::default()
            },
            Some((0.0, 0.0, out_w as f64, out_h as f64)),
            None,
        )
        .expect("registration renderer");

        let mut max_error = 0.0f64;
        for frame_index in [3usize, 12, 24, 36, 48] {
            if frame_index >= frame_count {
                continue;
            }
            let t_ms = frame_index as f64 * 1_000.0 / 30.0;
            // Luminance-weighted centroid = where the square actually landed.
            // Subtracting a base level keeps bicubic edge pixels proportional
            // instead of clipping them asymmetrically.
            let frame = &frames[frame_index * frame_len..(frame_index + 1) * frame_len];
            let (mut sum_x, mut sum_y, mut weight) = (0.0f64, 0.0f64, 0.0f64);
            for (i, value) in frame.iter().enumerate() {
                let w = f64::from(value.saturating_sub(48));
                if w > 0.0 {
                    sum_x += (i % out_w as usize) as f64 * w;
                    sum_y += (i / out_w as usize) as f64 * w;
                    weight += w;
                }
            }
            assert!(weight > 0.0, "no bright pixels in frame {frame_index}");
            let (measured_x, measured_y) = (sum_x / weight, sum_y / weight);

            let (expected_x, expected_y) =
                renderer.map_source_at(t_ms, square_center.0, square_center.1);
            let error =
                ((expected_x - measured_x).powi(2) + (expected_y - measured_y).powi(2)).sqrt();
            max_error = max_error.max(error);
            assert!(
                error <= 0.75,
                "frame {frame_index} (t={t_ms}ms): measured ({measured_x},{measured_y}) vs cursor-mapped ({expected_x},{expected_y}), error {error}px"
            );
        }
        // Surface the measured worst-case for the report.
        eprintln!("zoompan registration max error: {max_error:.4}px");
    }

    fn tests_plan() -> crate::exports::RenderPlan {
        crate::exports::RenderPlan {
            project_id: "cursor-reg-test".into(),
            duration_ms: 2_000,
            segments: segments(),
            gaps: Vec::new(),
            overlays: Vec::new(),
            captions: Vec::new(),
            caption_mode: "burn-in".into(),
            chapters: Vec::new(),
            chapter_mode: "embed".into(),
            masks: Vec::new(),
            zoom_segments: Vec::new(),
            cursor_effects: Vec::new(),
            overlay_render_plan: None,
            canvas: Some(RenderCanvas {
                width: 128,
                height: 72,
                fps: 30,
                ..Default::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
        }
    }
}
