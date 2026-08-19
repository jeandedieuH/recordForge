use std::collections::HashMap;

use cursor_engine::CursorTelemetryFile;

use resvg::tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Transform};
use resvg::usvg;

use super::{clamped_zoom_target, RenderPlanZoomSegment, RenderSegment};

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
    pub aspect_ratio: Option<String>,
    pub cursor_settings: CursorSettings,
}

fn default_canvas_background() -> String {
    "#000000".into()
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
#[derive(Debug, Clone)]
struct RasterizedCursor {
    width: u32,
    height: u32,
    hotspot_x: i32,
    hotspot_y: i32,
    data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct CursorRenderer {
    settings: CursorSettings,
    pub(crate) engine: cursor_engine::CursorEngine,
    segments: Vec<RenderSegment>,
    zoom_segments: Vec<RenderPlanZoomSegment>,
    canvas_width: u32,
    canvas_height: u32,
    canvas_padding: u32,
    /// The recorded video screen in full-canvas coordinates. Cursor drawing is
    /// clipped to this rectangle unless a zoom effect expands the view to the
    /// full canvas.
    video_screen: ClipRect,
    /// The final cursor scale is the user setting combined with the fit scale
    /// so the rendered cursor stays visually proportional to the output video.
    cursor_scale: f64,
    /// Cached rasterizations of cursor assets by canonical asset ID.
    /// Expensive SVG parsing and rendering is done on-demand per shape type.
    cursor_cache: HashMap<String, RasterizedCursor>,
}

impl CursorRenderer {
    #[cfg(test)]
    pub fn new(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        canvas: &RenderCanvas,
    ) -> Result<Self, String> {
        Self::new_with_zoom(settings, telemetry, segments, &[], canvas)
    }

    pub fn new_with_zoom(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        zoom_segments: &[RenderPlanZoomSegment],
        canvas: &RenderCanvas,
    ) -> Result<Self, String> {
        if canvas.width == 0 || canvas.height == 0 {
            return Err("cursor canvas dimensions must be positive".into());
        }
        if telemetry.source_width == 0.0 || telemetry.source_height == 0.0 {
            return Err("cursor telemetry dimensions must be positive".into());
        }
        if segments.is_empty() {
            return Err("cursor renderer requires at least one video segment".into());
        }

        let padding = canvas.padding as f64;
        let content_width = (canvas.width as f64 - padding * 2.0).max(1.0);
        let content_height = (canvas.height as f64 - padding * 2.0).max(1.0);
        let fit_scale =
            (content_width / telemetry.source_width).min(content_height / telemetry.source_height);
        let fit_width = telemetry.source_width * fit_scale;
        let fit_height = telemetry.source_height * fit_scale;
        let video_screen = ClipRect {
            x: (padding + (content_width - fit_width) / 2.0).round() as u32,
            y: (padding + (content_height - fit_height) / 2.0).round() as u32,
            w: fit_width.round() as u32,
            h: fit_height.round() as u32,
            border_radius: canvas.border_radius,
        };

        let options = cursor_engine::CursorEngineOptions::default();
        let engine = cursor_engine::CursorEngine::new(telemetry, options)
            .map_err(|e| format!("failed to build cursor engine: {e}"))?;
        let cursor_scale = settings.scale.clamp(0.2, 5.0) * fit_scale;

        Ok(Self {
            settings,
            engine,
            segments: segments.to_vec(),
            zoom_segments: zoom_segments.to_vec(),
            canvas_width: canvas.width,
            canvas_height: canvas.height,
            canvas_padding: canvas.padding,
            video_screen,
            cursor_scale,
            cursor_cache: HashMap::new(),
        })
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
        let mapped = cursor_engine::assets::resolve_cursor_shape_id(
            frame_shape_id,
            &self.engine.telemetry().shapes,
        );
        if cursor_engine::assets::resolve_cursor_asset(&mapped).is_some() {
            return mapped;
        }

        self.settings.preset.clone()
    }

    pub fn render_frame(&mut self, output_ms: u64, frame: &mut [u8]) {
        let expected_len = self.canvas_width as usize * self.canvas_height as usize * 4;
        if frame.len() != expected_len {
            return;
        }

        let source_time_ms = match source_time_for_output(&self.segments, output_ms) {
            Some(time) => time,
            None => return,
        };
        if !self.settings.enabled {
            return;
        }

        let cursor_frame = self.engine.evaluate(source_time_ms as f64, &self.settings);
        if !cursor_frame.visible {
            return;
        }

        let point = self.engine.fit(
            cursor_frame.source_x,
            cursor_frame.source_y,
            self.canvas_width as f64,
            self.canvas_height as f64,
            self.canvas_padding as f64,
        );
        let (x, y) = self.apply_zoom(output_ms, point.x, point.y);
        let clip = self.clip_for_output(output_ms);

        if self.settings.spotlight_mode {
            self.render_spotlight(frame, x, y, &clip);
        }

        if self.settings.click_feedback != "none" {
            for click in &cursor_frame.active_clicks {
                let click_point = self.engine.fit(
                    click.source_x,
                    click.source_y,
                    self.canvas_width as f64,
                    self.canvas_height as f64,
                    self.canvas_padding as f64,
                );
                let (cx, cy) = self.apply_zoom(output_ms, click_point.x, click_point.y);
                self.render_click_feedback(frame, cx, cy, click, &clip);
            }
        }

        let shape_id = self.resolve_cursor_shape_id(&cursor_frame.shape_id);
        // Apply the idle fade opacity computed by the canonical engine. The
        // cached asset is rendered at full opacity and modulated per-frame.
        self.draw_cursor(frame, x, y, cursor_frame.opacity, &shape_id, &clip);
    }

    fn clip_for_output(&self, _output_ms: u64) -> ClipRect {
        self.video_screen
    }

    fn apply_zoom(&self, output_ms: u64, x: f64, y: f64) -> (f64, f64) {
        let Some(segment) = self.zoom_segments.iter().find(|segment| {
            segment.enabled && output_ms >= segment.start_ms && output_ms < segment.end_ms
        }) else {
            return (x, y);
        };
        let duration = (segment.end_ms - segment.start_ms).max(1) as f64;
        let mut trans_in = (segment.transition_in_ms as f64).clamp(10.0, duration);
        let mut trans_out = (segment.transition_out_ms as f64).clamp(10.0, duration);
        if trans_in + trans_out > duration {
            trans_in = duration / 2.0;
            trans_out = duration - trans_in;
        }

        let elapsed = output_ms.saturating_sub(segment.start_ms) as f64;
        let progress = if elapsed <= 0.0 {
            0.0
        } else if elapsed < trans_in {
            (elapsed / trans_in.max(1.0)).clamp(0.0, 1.0)
        } else if elapsed <= duration - trans_out {
            1.0
        } else if elapsed <= duration {
            ((duration - elapsed) / trans_out.max(1.0)).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let eased = match segment.easing.as_str() {
            "linear" => progress,
            "ease-in" => progress * progress,
            "ease-out" => 1.0 - (1.0 - progress).powi(2),
            "snappy" => 1.0 - (1.0 - progress).powi(3),
            "cinematic" => progress * progress * (3.0 - 2.0 * progress),
            "smooth" => {
                progress * progress * progress * (progress * (progress * 6.0 - 15.0) + 10.0)
            }
            "spring" => {
                let p = 0.4;
                (2.0f64.powf(-10.0 * progress)
                    * (((progress - p / 4.0) * (2.0 * std::f64::consts::PI)) / p).sin()
                    + 1.0)
                    .clamp(0.0, 1.5)
            }
            _ => {
                if progress < 0.5 {
                    2.0 * progress * progress
                } else {
                    1.0 - (-2.0 * progress + 2.0).powi(2) / 2.0
                }
            }
        };

        // Use the same normalized crop transform as the editor preview and FFmpeg
        // so the cursor tracks the video frame with sub-pixel precision.
        let target = clamped_zoom_target(
            self.canvas_width,
            self.canvas_height,
            self.canvas_padding,
            segment,
        );
        let canvas_w = self.canvas_width as f64;
        let canvas_h = self.canvas_height as f64;
        let padding = self.canvas_padding as f64;
        let screen_w = (canvas_w - padding * 2.0).max(1.0);
        let screen_h = (canvas_h - padding * 2.0).max(1.0);
        let screen_x = padding;
        let screen_y = padding;

        let full_cx = canvas_w / 2.0;
        let full_cy = canvas_h / 2.0;
        let target_cx = target.x + target.width / 2.0;
        let target_cy = target.y + target.height / 2.0;

        let cur_cx = full_cx + (target_cx - full_cx) * eased;
        let cur_cy = full_cy + (target_cy - full_cy) * eased;
        let crop_width = canvas_w + (target.width - canvas_w) * eased;
        let crop_height = canvas_h + (target.height - canvas_h) * eased;
        let crop_x = (cur_cx - crop_width / 2.0).clamp(0.0, canvas_w - crop_width);
        let crop_y = (cur_cy - crop_height / 2.0).clamp(0.0, canvas_h - crop_height);

        let norm_crop_x = crop_x / canvas_w;
        let norm_crop_y = crop_y / canvas_h;
        let norm_crop_w = (crop_width / canvas_w).max(1e-4);
        let norm_crop_h = (crop_height / canvas_h).max(1e-4);

        let rel_x = x - screen_x;
        let rel_y = y - screen_y;

        let zoomed_rel_x = (rel_x - norm_crop_x * screen_w) / norm_crop_w;
        let zoomed_rel_y = (rel_y - norm_crop_y * screen_h) / norm_crop_h;

        (
            (screen_x + zoomed_rel_x).clamp(0.0, canvas_w),
            (screen_y + zoomed_rel_y).clamp(0.0, canvas_h),
        )
    }

    fn render_spotlight(&self, frame: &mut [u8], x: f64, y: f64, clip: &ClipRect) {
        let dim = parse_color(&self.settings.shadow_color, Rgba::opaque(0, 0, 0))
            .with_alpha(self.settings.spotlight_dim_opacity);
        fill_rect(
            frame,
            self.canvas_width,
            self.canvas_height,
            clip.x,
            clip.y,
            clip.w,
            clip.h,
            dim,
            clip,
        );
        // The spotlight radius scales with the cursor so it stays proportional
        // to the fitted video, matching the preview overlay.
        let radius = self.settings.spotlight_radius.max(0.0) * self.cursor_scale;
        clear_circle(
            frame,
            self.canvas_width,
            self.canvas_height,
            x,
            y,
            radius,
            clip,
        );
    }

    fn render_click_feedback(
        &self,
        frame: &mut [u8],
        x: f64,
        y: f64,
        click: &cursor_engine::CursorClickEffect,
        clip: &ClipRect,
    ) {
        let progress = click.progress.clamp(0.0, 1.0);
        // The preview scales the click effect with the cursor scale and then
        // expands it from 25% to 100% over the effect duration.
        let effect_scale = 0.25 + progress * 0.75;
        let click_size = self.settings.click_size.max(10.0) * self.cursor_scale;
        let radius = (click_size / 2.0 * effect_scale).max(1.0);
        let color = parse_color(&self.settings.click_color, Rgba::opaque(96, 165, 250));
        let alpha = 0.75 * click.intensity;

        match self.settings.click_feedback.as_str() {
            "spotlight" => fill_radial_glow(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius,
                radius * 0.8,
                color,
                alpha,
                clip,
            ),
            "pulse" => fill_circle(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius,
                color.with_alpha(alpha),
                clip,
            ),
            "ripple" => draw_ring(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius,
                (3.0 * effect_scale).max(1.0),
                color.with_alpha(alpha),
                clip,
            ),
            _ => {}
        }
    }

    fn draw_cursor(
        &mut self,
        frame: &mut [u8],
        x: f64,
        y: f64,
        opacity: f64,
        shape_id: &str,
        clip: &ClipRect,
    ) {
        let asset = cursor_engine::assets::resolve_cursor_asset_or_default(shape_id);
        if !self.cursor_cache.contains_key(&asset.id) {
            match self.rasterize_cursor_asset(asset) {
                Ok(cursor) => {
                    self.cursor_cache.insert(asset.id.clone(), cursor);
                }
                Err(error) => {
                    tracing::warn!(%error, asset_id = %asset.id, "failed to rasterize cursor asset; skipping cursor");
                    return;
                }
            }
        }
        if let Some(cursor) = self.cursor_cache.get(&asset.id) {
            self.blit_cursor(frame, cursor, x, y, opacity, clip);
        }
    }

    fn blit_cursor(
        &self,
        frame: &mut [u8],
        cursor: &RasterizedCursor,
        x: f64,
        y: f64,
        opacity: f64,
        clip: &ClipRect,
    ) {
        let opacity = opacity.clamp(0.0, 1.0) as f32;
        if opacity <= 0.0 {
            return;
        }
        let x0 = x.round() as i32 - cursor.hotspot_x;
        let y0 = y.round() as i32 - cursor.hotspot_y;
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

    /// Renders the shared SVG cursor asset to a straight-alpha RGBA buffer.
    /// The result includes the configured drop shadow (if enabled) and uses the
    /// asset hotspot so the blit position matches the preview overlay exactly.
    fn rasterize_cursor_asset(
        &self,
        asset: &cursor_engine::assets::CursorAsset,
    ) -> Result<RasterizedCursor, String> {
        let view_box: Vec<f64> = asset
            .view_box
            .split_whitespace()
            .filter_map(|part| part.parse().ok())
            .collect();
        let (vb_x, vb_y, vb_w, vb_h) = match view_box.as_slice() {
            &[x, y, w, h] if w > 0.0 && h > 0.0 => (x, y, w, h),
            _ => (0.0, 0.0, asset.width, asset.height),
        };

        let rendered_width = (asset.width * self.cursor_scale).max(1.0);
        let rendered_height = (asset.height * self.cursor_scale).max(1.0);
        let unit_scale_x = rendered_width / vb_w;
        let unit_scale_y = rendered_height / vb_h;
        let unit_scale = unit_scale_x.min(unit_scale_y);

        let shadow = self.settings.shadow_enabled
            && self.settings.shadow_opacity > 0.0
            && (self.settings.shadow_blur.abs() > f64::EPSILON
                || self.settings.shadow_offset_x.abs() > f64::EPSILON
                || self.settings.shadow_offset_y.abs() > f64::EPSILON);

        let pad_vb = if shadow {
            let blur_extent = self.settings.shadow_blur * 2.0;
            let max_offset = self
                .settings
                .shadow_offset_x
                .abs()
                .max(self.settings.shadow_offset_y.abs());
            ((max_offset + blur_extent) / unit_scale).ceil()
        } else {
            0.0
        };

        let svg_width = (vb_w + pad_vb * 2.0) * unit_scale_x;
        let svg_height = (vb_h + pad_vb * 2.0) * unit_scale_y;
        let hotspot_x = (asset.hotspot_x - vb_x + pad_vb) * unit_scale_x;
        let hotspot_y = (asset.hotspot_y - vb_y + pad_vb) * unit_scale_y;

        let svg = build_cursor_svg(
            asset,
            &self.settings,
            shadow,
            pad_vb,
            svg_width,
            svg_height,
            vb_x,
            vb_y,
            vb_w,
            vb_h,
        );

        let options = usvg::Options::default();
        let tree = usvg::Tree::from_str(&svg, &options)
            .map_err(|error| format!("failed to parse cursor SVG: {error}"))?;
        let size = tree.size().to_int_size();
        let Some(mut pixmap) = Pixmap::new(size.width(), size.height()) else {
            return Err("failed to allocate cursor pixmap".into());
        };
        resvg::render(&tree, Transform::identity(), &mut pixmap.as_mut());

        let mut data = pixmap.data().to_vec();
        unpremultiply_rgba(&mut data);

        Ok(RasterizedCursor {
            width: size.width(),
            height: size.height(),
            hotspot_x: hotspot_x.round() as i32,
            hotspot_y: hotspot_y.round() as i32,
            data,
        })
    }
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

/// tiny-skia / resvg store pixels as premultiplied RGBA. The export frame uses
/// straight-alpha RGBA, so convert once when the cursor asset is cached or in-place per frame.
pub(crate) fn unpremultiply_rgba(data: &mut [u8]) {
    static INV_ALPHA: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    let inv_lut = INV_ALPHA.get_or_init(|| {
        let mut lut = [0.0f32; 256];
        for a in 1..255 {
            lut[a] = 255.0 / a as f32;
        }
        lut[255] = 1.0;
        lut
    });

    for pixel in data.chunks_exact_mut(4) {
        let alpha = pixel[3] as usize;
        if alpha > 0 && alpha < 255 {
            let inv = inv_lut[alpha];
            pixel[0] = (pixel[0] as f32 * inv).min(255.0) as u8;
            pixel[1] = (pixel[1] as f32 * inv).min(255.0) as u8;
            pixel[2] = (pixel[2] as f32 * inv).min(255.0) as u8;
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

fn source_time_for_output(segments: &[RenderSegment], output_ms: u64) -> Option<u64> {
    let segment = segments.iter().find(|segment| {
        output_ms >= segment.output_start_ms && output_ms < segment.output_end_ms
    })?;
    let output_duration = segment
        .output_end_ms
        .saturating_sub(segment.output_start_ms);
    let source_duration = segment.source_out_ms.saturating_sub(segment.source_in_ms);
    if output_duration == 0 || source_duration == 0 {
        return None;
    }
    let elapsed = output_ms.saturating_sub(segment.output_start_ms) as f64;
    let ratio = source_duration as f64 / output_duration as f64;
    Some(
        segment
            .source_in_ms
            .saturating_add((elapsed * ratio) as u64),
    )
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

#[allow(clippy::too_many_arguments)]
fn fill_rect(
    frame: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    rect_width: u32,
    rect_height: u32,
    color: Rgba,
    clip: &ClipRect,
) {
    let end_x = x.saturating_add(rect_width).min(width);
    let end_y = y.saturating_add(rect_height).min(height);
    for py in y..end_y {
        for px in x..end_x {
            blend_pixel(frame, width, px as i32, py as i32, color, clip);
        }
    }
}

fn clear_circle(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    clip: &ClipRect,
) {
    let min_x = (cx - radius).floor().max(0.0) as u32;
    let max_x = (cx + radius).ceil().min(width as f64) as u32;
    let min_y = (cy - radius).floor().max(0.0) as u32;
    let max_y = (cy + radius).ceil().min(height as f64) as u32;
    let radius_squared = radius * radius;
    for py in min_y..max_y {
        for px in min_x..max_x {
            if !clip.contains(px as i32, py as i32) {
                continue;
            }
            let dx = px as f64 - cx;
            let dy = py as f64 - cy;
            if dx * dx + dy * dy <= radius_squared {
                let index = (py as usize * width as usize + px as usize) * 4;
                frame[index..index + 4].fill(0);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn fill_circle(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    color: Rgba,
    clip: &ClipRect,
) {
    let min_x = (cx - radius).floor().max(0.0) as u32;
    let max_x = (cx + radius).ceil().min(width as f64) as u32;
    let min_y = (cy - radius).floor().max(0.0) as u32;
    let max_y = (cy + radius).ceil().min(height as f64) as u32;
    let radius_squared = radius * radius;
    for py in min_y..max_y {
        for px in min_x..max_x {
            if !clip.contains(px as i32, py as i32) {
                continue;
            }
            let dx = px as f64 - cx;
            let dy = py as f64 - cy;
            if dx * dx + dy * dy <= radius_squared {
                blend_pixel(frame, width, px as i32, py as i32, color, clip);
            }
        }
    }
}

/// Approximate a CSS `box-shadow` style radial glow around a solid disc.
/// `core_radius` is the filled-disc radius; `glow_radius` controls how far the
/// blurred halo extends. Alpha falls from the supplied `alpha` at the disc edge
/// to 0 at the outer edge.
#[allow(clippy::too_many_arguments)]
fn fill_radial_glow(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    core_radius: f64,
    glow_radius: f64,
    color: Rgba,
    alpha: f64,
    clip: &ClipRect,
) {
    let outer = core_radius + glow_radius.max(0.0);
    let min_x = (cx - outer).floor().max(0.0) as u32;
    let max_x = (cx + outer).ceil().min(width as f64) as u32;
    let min_y = (cy - outer).floor().max(0.0) as u32;
    let max_y = (cy + outer).ceil().min(height as f64) as u32;
    let outer_squared = outer * outer;
    let core_squared = core_radius * core_radius;
    let alpha = alpha.clamp(0.0, 1.0) as f32;

    for py in min_y..max_y {
        for px in min_x..max_x {
            if !clip.contains(px as i32, py as i32) {
                continue;
            }
            let dx = px as f64 - cx;
            let dy = py as f64 - cy;
            let distance_squared = dx * dx + dy * dy;
            if distance_squared > outer_squared {
                continue;
            }

            let pixel_color = if distance_squared <= core_squared {
                color.with_alpha(alpha as f64)
            } else {
                let distance = distance_squared.sqrt();
                let t = ((distance - core_radius) / glow_radius.max(f64::EPSILON)).clamp(0.0, 1.0);
                let glow_alpha = alpha * ((1.0 - t * t) as f32) * 0.5;
                color.with_alpha(glow_alpha as f64)
            };
            blend_pixel(frame, width, px as i32, py as i32, pixel_color, clip);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_ring(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    thickness: f64,
    color: Rgba,
    clip: &ClipRect,
) {
    let outer = radius.max(0.0);
    let inner = (outer - thickness.max(1.0)).max(0.0);
    let min_x = (cx - outer).floor().max(0.0) as u32;
    let max_x = (cx + outer).ceil().min(width as f64) as u32;
    let min_y = (cy - outer).floor().max(0.0) as u32;
    let max_y = (cy + outer).ceil().min(height as f64) as u32;
    let outer_squared = outer * outer;
    let inner_squared = inner * inner;
    for py in min_y..max_y {
        for px in min_x..max_x {
            if !clip.contains(px as i32, py as i32) {
                continue;
            }
            let dx = px as f64 - cx;
            let dy = py as f64 - cy;
            let distance_squared = dx * dx + dy * dy;
            if distance_squared <= outer_squared && distance_squared >= inner_squared {
                blend_pixel(frame, width, px as i32, py as i32, color, clip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::RenderCropFloat;

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
        assert_eq!(source_time_for_output(&segments(), 500), Some(500));
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
        renderer.render_frame(100, &mut frame);
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
        renderer.render_frame(0, &mut frame);

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
        renderer.render_frame(100, &mut frame);

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
        let frame = renderer.engine.evaluate(0.0, &renderer.settings);
        assert!(frame.visible);
        let point = renderer
            .engine
            .fit(frame.source_x, frame.source_y, 1_920.0, 1_080.0, 0.0);
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
        renderer.render_frame(100, &mut frame);
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
        };
        let renderer = CursorRenderer::new_with_zoom(
            CursorSettings::default(),
            make_v2_telemetry(),
            &segments(),
            &[zoom],
            &test_canvas(200, 200, 20),
        )
        .expect("valid cursor renderer");

        // In the 3-phase lifecycle, 500ms is in the sustained hold phase (progress 1.0)
        // Center is (100, 100). Point (120, 120) is +20px from center. At 2x zoom, +20px * 2 = +40px from center -> 140.0.
        let (x, y) = renderer.apply_zoom(500, 120.0, 120.0);
        assert!((x - 140.0).abs() < 0.1, "expected 140.0, got {x}");
        assert!((y - 140.0).abs() < 0.1, "expected 140.0, got {y}");

        let (no_zoom_x, no_zoom_y) = renderer.apply_zoom(1_001, 120.0, 120.0);
        assert!((no_zoom_x - 120.0).abs() < 0.01);
        assert!((no_zoom_y - 120.0).abs() < 0.01);
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
        renderer.render_frame(0, &mut frame_arrow);

        let mut frame_ibeam = vec![0; 100 * 100 * 4];
        renderer.render_frame(200, &mut frame_ibeam);

        let mut frame_hand = vec![0; 100 * 100 * 4];
        renderer.render_frame(400, &mut frame_hand);

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

        // The cache should hold all 3 resolved assets
        assert!(renderer.cursor_cache.contains_key("shape-arrow"));
        assert!(renderer.cursor_cache.contains_key("shape-ibeam"));
        assert!(renderer.cursor_cache.contains_key("shape-hand"));
    }
}
