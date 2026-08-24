use std::collections::HashMap;

use cursor_engine::CursorTelemetryFile;

use resvg::tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Transform};
use resvg::usvg;

use super::{clamped_zoom_crop, clamped_zoom_target, RenderPlanZoomSegment, RenderSegment};

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

#[derive(Debug, Clone, Copy)]
pub struct ZoomTransformState {
    pub progress: f64,
    pub scale: f64,
    pub crop_x: f64,
    pub crop_y: f64,
    pub crop_w: f64,
    pub crop_h: f64,
}

fn ease_progress(progress: f64, easing: &str) -> f64 {
    let p = progress.clamp(0.0, 1.0);
    match easing {
        "linear" => p,
        "ease-in" => p * p,
        "ease-out" => 1.0 - (1.0 - p).powi(2),
        "snappy" => 1.0 - (1.0 - p).powi(3),
        "cinematic" => p * p * (3.0 - 2.0 * p),
        "smooth" => p * p * p * (p * (p * 6.0 - 15.0) + 10.0),
        "spring" => {
            let period = 0.4;
            (2.0f64.powf(-10.0 * p)
                * (((p - period / 4.0) * (2.0 * std::f64::consts::PI)) / period).sin()
                + 1.0)
                .clamp(0.0, 1.0)
        }
        _ => {
            if p < 0.5 {
                2.0 * p * p
            } else {
                1.0 - (-2.0 * p + 2.0).powi(2) / 2.0
            }
        }
    }
}

fn find_keyframe_target(
    keyframes: &[super::RenderPlanZoomKeyframe],
    time_ms: f64,
    fallback: &super::RenderCropFloat,
) -> super::RenderCropFloat {
    if keyframes.is_empty() {
        return fallback.clone();
    }
    if time_ms <= keyframes[0].time_ms as f64 {
        return keyframes[0].target.clone();
    }
    if time_ms >= keyframes[keyframes.len() - 1].time_ms as f64 {
        return keyframes[keyframes.len() - 1].target.clone();
    }
    for i in 0..keyframes.len() - 1 {
        let k0 = &keyframes[i];
        let k1 = &keyframes[i + 1];
        if time_ms >= k0.time_ms as f64 && time_ms <= k1.time_ms as f64 {
            let span = (k1.time_ms.saturating_sub(k0.time_ms).max(1)) as f64;
            let alpha = ((time_ms - k0.time_ms as f64) / span).clamp(0.0, 1.0);
            return super::RenderCropFloat {
                x: k0.target.x + (k1.target.x - k0.target.x) * alpha,
                y: k0.target.y + (k1.target.y - k0.target.y) * alpha,
                width: k0.target.width + (k1.target.width - k0.target.width) * alpha,
                height: k0.target.height + (k1.target.height - k0.target.height) * alpha,
            };
        }
    }
    fallback.clone()
}

/// Map a point already fitted into the screen rectangle through a crop in
/// normalized canvas coordinates. This is the native counterpart of the
/// preview's `mapCursorPointThroughZoom` helper.
fn map_screen_point_through_zoom(
    transform: ZoomTransformState,
    point: (f64, f64),
    canvas_width: f64,
    canvas_height: f64,
    screen: (f64, f64, f64, f64),
) -> (f64, f64) {
    if transform.scale <= 1.0001 && transform.progress < 1e-4 {
        return point;
    }

    let safe_canvas_width = canvas_width.max(1.0);
    let safe_canvas_height = canvas_height.max(1.0);
    let (screen_x, screen_y, screen_width, screen_height) = screen;
    let crop_x = transform.crop_x / safe_canvas_width * screen_width;
    let crop_y = transform.crop_y / safe_canvas_height * screen_height;
    let crop_width = (transform.crop_w / safe_canvas_width).max(1e-4);
    let crop_height = (transform.crop_h / safe_canvas_height).max(1e-4);
    let relative_x = point.0 - screen_x;
    let relative_y = point.1 - screen_y;

    (
        screen_x + (relative_x - crop_x) / crop_width,
        screen_y + (relative_y - crop_y) / crop_height,
    )
}

impl CursorRenderer {
    #[cfg(test)]
    pub fn new(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        canvas: &RenderCanvas,
    ) -> Result<Self, String> {
        Self::new_with_zoom(settings, telemetry, segments, &[], canvas, None)
    }

    pub fn new_with_zoom(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        zoom_segments: &[RenderPlanZoomSegment],
        canvas: &RenderCanvas,
        screen_rect: Option<(f64, f64, f64, f64)>,
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

        let video_screen = if let Some((sx, sy, sw, sh)) = screen_rect {
            ClipRect {
                x: sx.round().max(0.0) as u32,
                y: sy.round().max(0.0) as u32,
                w: sw.round().max(1.0) as u32,
                h: sh.round().max(1.0) as u32,
                border_radius: canvas.border_radius,
            }
        } else {
            let padding = canvas.padding as f64;
            let content_width = (canvas.width as f64 - padding * 2.0).max(1.0);
            let content_height = (canvas.height as f64 - padding * 2.0).max(1.0);
            let fit_scale = (content_width / telemetry.source_width)
                .min(content_height / telemetry.source_height);
            let fit_width = telemetry.source_width * fit_scale;
            let fit_height = telemetry.source_height * fit_scale;
            ClipRect {
                x: (padding + (content_width - fit_width) / 2.0).floor() as u32,
                y: (padding + (content_height - fit_height) / 2.0).floor() as u32,
                w: fit_width.floor().max(1.0) as u32,
                h: fit_height.floor().max(1.0) as u32,
                border_radius: canvas.border_radius,
            }
        };

        let options = cursor_engine::CursorEngineOptions::default();
        let engine = cursor_engine::CursorEngine::new(telemetry, options)
            .map_err(|e| format!("failed to build cursor engine: {e}"))?;
        let fit_scale = (video_screen.w as f64 / engine.telemetry().source_width.max(1.0))
            .min(video_screen.h as f64 / engine.telemetry().source_height.max(1.0));
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

    /// Map source coordinates from telemetry into the pixel boundaries of the
    /// fitted video screen on the canvas.
    fn fit_source_point(&self, source_x: f64, source_y: f64) -> (f64, f64) {
        let source_w = self.engine.telemetry().source_width.max(1.0);
        let source_h = self.engine.telemetry().source_height.max(1.0);
        let clamped_x = source_x.clamp(0.0, source_w);
        let clamped_y = source_y.clamp(0.0, source_h);
        let scale =
            (self.video_screen.w as f64 / source_w).min(self.video_screen.h as f64 / source_h);
        let offset_x = (self.video_screen.w as f64 - source_w * scale) / 2.0;
        let offset_y = (self.video_screen.h as f64 - source_h * scale) / 2.0;
        (
            self.video_screen.x as f64 + offset_x + clamped_x * scale,
            self.video_screen.y as f64 + offset_y + clamped_y * scale,
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

        let cursor_frame = self.engine.evaluate(source_time_ms, &self.settings);
        if !cursor_frame.visible {
            return;
        }

        let transform = self.resolve_zoom_transform_at(output_ms);
        let effective_cursor_scale = self.cursor_scale * transform.scale;

        let (px, py) = self.fit_source_point(cursor_frame.source_x, cursor_frame.source_y);
        let (x, y) = self.apply_zoom_at(output_ms, px, py);
        let clip = self.clip_for_output();

        if self.settings.spotlight_mode {
            self.render_spotlight(frame, x, y, effective_cursor_scale, &clip);
        }

        if self.settings.click_feedback != "none" {
            for click in &cursor_frame.active_clicks {
                let (cx_raw, cy_raw) = self.fit_source_point(click.source_x, click.source_y);
                let (cx, cy) = self.apply_zoom_at(output_ms, cx_raw, cy_raw);
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
            effective_cursor_scale,
            &clip,
        );
    }

    fn clip_for_output(&self) -> ClipRect {
        self.video_screen
    }

    /// Resolve zoom at a fractional output PTS so the cursor and video use the
    /// same transition progress between integer millisecond boundaries.
    pub fn resolve_zoom_transform_at(&self, output_ms: f64) -> ZoomTransformState {
        let canvas_w = self.canvas_width as f64;
        let canvas_h = self.canvas_height as f64;

        let Some(segment) = self
            .zoom_segments
            .iter()
            .filter(|segment| {
                segment.enabled
                    && output_ms >= segment.start_ms as f64
                    && output_ms < segment.end_ms as f64
            })
            // Match the editor's deterministic overlap rule: the latest
            // starting segment wins, with the id as the stable tie-breaker.
            .max_by(|left, right| {
                left.start_ms
                    .cmp(&right.start_ms)
                    .then_with(|| left.id.cmp(&right.id))
            })
        else {
            return ZoomTransformState {
                progress: 0.0,
                scale: 1.0,
                crop_x: 0.0,
                crop_y: 0.0,
                crop_w: canvas_w,
                crop_h: canvas_h,
            };
        };

        let duration = (segment.end_ms - segment.start_ms).max(1) as f64;
        let mut trans_in = (segment.transition_in_ms as f64).clamp(0.0, duration);
        let mut trans_out = (segment.transition_out_ms as f64).clamp(0.0, duration);
        if trans_in + trans_out > duration {
            trans_in = duration / 2.0;
            trans_out = duration - trans_in;
        }

        let elapsed = (output_ms - segment.start_ms as f64).max(0.0);
        let mut is_panned_from_prev = false;

        let progress = if elapsed <= 0.0 {
            let progress = if trans_in == 0.0 { 1.0 } else { 0.0 };
            if segment.from_target.is_some() && progress < 1.0 {
                is_panned_from_prev = true;
            }
            progress
        } else if elapsed < trans_in {
            if segment.from_target.is_some() {
                is_panned_from_prev = true;
            }
            let raw = (elapsed / trans_in.max(1.0)).clamp(0.0, 1.0);
            ease_progress(raw, &segment.easing)
        } else if elapsed <= duration - trans_out {
            1.0
        } else if elapsed <= duration {
            let remaining = duration - elapsed;
            let raw = (remaining / trans_out.max(1.0)).clamp(0.0, 1.0);
            ease_progress(raw, &segment.easing)
        } else {
            0.0
        };

        let fallback_target = clamped_zoom_target(
            self.canvas_width,
            self.canvas_height,
            self.canvas_padding,
            segment,
        );
        let target = if let Some(motion_plan) = &segment.motion_plan {
            if let Some(point) = cursor_engine::evaluate_cubic_motion_plan(motion_plan, output_ms) {
                let motion_target = super::RenderCropFloat {
                    x: point.x - fallback_target.width / 2.0,
                    y: point.y - fallback_target.height / 2.0,
                    width: fallback_target.width,
                    height: fallback_target.height,
                };
                clamped_zoom_crop(
                    self.canvas_width,
                    self.canvas_height,
                    self.canvas_padding,
                    &motion_target,
                    segment.scale,
                )
            } else {
                fallback_target.clone()
            }
        } else if let Some(keyframes) = &segment.keyframes {
            if !keyframes.is_empty() {
                let kf = find_keyframe_target(keyframes, output_ms, &segment.target);
                clamped_zoom_crop(
                    self.canvas_width,
                    self.canvas_height,
                    self.canvas_padding,
                    &kf,
                    segment.scale,
                )
            } else {
                fallback_target.clone()
            }
        } else {
            fallback_target
        };

        let full_cx = canvas_w / 2.0;
        let full_cy = canvas_h / 2.0;
        let target_cx = target.x + target.width / 2.0;
        let target_cy = target.y + target.height / 2.0;

        let (crop_w, crop_h, cur_cx, cur_cy) = if is_panned_from_prev {
            if let Some(from_raw) = &segment.from_target {
                let from = clamped_zoom_crop(
                    self.canvas_width,
                    self.canvas_height,
                    self.canvas_padding,
                    from_raw,
                    segment.from_scale.unwrap_or(segment.scale),
                );
                let from_cx = from.x + from.width / 2.0;
                let from_cy = from.y + from.height / 2.0;
                (
                    from.width + (target.width - from.width) * progress,
                    from.height + (target.height - from.height) * progress,
                    from_cx + (target_cx - from_cx) * progress,
                    from_cy + (target_cy - from_cy) * progress,
                )
            } else {
                (
                    canvas_w + (target.width - canvas_w) * progress,
                    canvas_h + (target.height - canvas_h) * progress,
                    full_cx + (target_cx - full_cx) * progress,
                    full_cy + (target_cy - full_cy) * progress,
                )
            }
        } else {
            (
                canvas_w + (target.width - canvas_w) * progress,
                canvas_h + (target.height - canvas_h) * progress,
                full_cx + (target_cx - full_cx) * progress,
                full_cy + (target_cy - full_cy) * progress,
            )
        };

        let crop_x = (cur_cx - crop_w / 2.0).clamp(0.0, (canvas_w - crop_w).max(0.0));
        let crop_y = (cur_cy - crop_h / 2.0).clamp(0.0, (canvas_h - crop_h).max(0.0));
        let scale = canvas_w / crop_w.max(1.0);

        ZoomTransformState {
            progress,
            scale,
            crop_x,
            crop_y,
            crop_w,
            crop_h,
        }
    }

    fn apply_zoom_at(&self, output_ms: f64, x: f64, y: f64) -> (f64, f64) {
        let transform = self.resolve_zoom_transform_at(output_ms);
        map_screen_point_through_zoom(
            transform,
            (x, y),
            self.canvas_width as f64,
            self.canvas_height as f64,
            (
                self.video_screen.x as f64,
                self.video_screen.y as f64,
                self.video_screen.w as f64,
                self.video_screen.h as f64,
            ),
        )
    }

    fn render_spotlight(
        &self,
        frame: &mut [u8],
        x: f64,
        y: f64,
        cursor_scale: f64,
        clip: &ClipRect,
    ) {
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
        let radius = self.settings.spotlight_radius.max(0.0) * cursor_scale;
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
        cursor_scale: f64,
        clip: &ClipRect,
    ) {
        let progress = click.progress.clamp(0.0, 1.0);
        // The preview scales the click effect with the cursor scale and then
        // expands it from 25% to 100% over the effect duration.
        let effect_scale = 0.25 + progress * 0.75;
        let click_size = self.settings.click_size.max(10.0) * cursor_scale;
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
                (3.0 * effect_scale * (cursor_scale / self.cursor_scale.max(0.01))).max(1.0),
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
        cursor_scale: f64,
        clip: &ClipRect,
    ) {
        let asset = cursor_engine::assets::resolve_cursor_asset_or_default(shape_id);
        let cache_key = if (cursor_scale - self.cursor_scale).abs() < 1e-4 {
            asset.id.clone()
        } else {
            let scale_bin = (cursor_scale * 100.0).round() as u32;
            format!("{}:{}", asset.id, scale_bin)
        };
        if !self.cursor_cache.contains_key(&cache_key) {
            match self.rasterize_cursor_asset(asset, cursor_scale) {
                Ok(cursor) => {
                    self.cursor_cache.insert(cache_key.clone(), cursor);
                }
                Err(error) => {
                    tracing::warn!(%error, asset_id = %asset.id, "failed to rasterize cursor asset; skipping cursor");
                    return;
                }
            }
        }
        if let Some(cursor) = self.cursor_cache.get(&cache_key) {
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
        cursor_scale: f64,
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

        let rendered_width = (asset.width * cursor_scale).max(1.0);
        let rendered_height = (asset.height * cursor_scale).max(1.0);
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
        for (a, val) in lut.iter_mut().enumerate().take(255).skip(1) {
            *val = 255.0 / a as f32;
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
        )
        .expect("valid cursor renderer");

        // In the 3-phase lifecycle, 500ms is in the sustained hold phase (progress 1.0)
        // Center is (100, 100). Point (120, 120) is +20px from center. At 2x zoom, +20px * 2 = +40px from center -> 140.0.
        let (x, y) = renderer.apply_zoom_at(500.0, 120.0, 120.0);
        assert!((x - 140.0).abs() < 0.1, "expected 140.0, got {x}");
        assert!((y - 140.0).abs() < 0.1, "expected 140.0, got {y}");

        let (no_zoom_x, no_zoom_y) = renderer.apply_zoom_at(1_001.0, 120.0, 120.0);
        assert!((no_zoom_x - 120.0).abs() < 0.01);
        assert!((no_zoom_y - 120.0).abs() < 0.01);
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
        let mut renderer = CursorRenderer::new_with_zoom(
            settings.clone(),
            fixture.telemetry,
            &fixture.segments,
            &fixture.zoom_segments,
            &fixture.canvas,
            Some(screen_rect),
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
            let cursor_frame = renderer.engine.evaluate(source_time, &settings);
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

            let fitted = renderer.fit_source_point(cursor_frame.source_x, cursor_frame.source_y);
            let cursor_point = renderer.apply_zoom_at(golden.time_ms, fitted.0, fitted.1);
            assert_within_half_pixel("cursor x", cursor_point.0, expected.cursor_point.x);
            assert_within_half_pixel("cursor y", cursor_point.1, expected.cursor_point.y);

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

        // The cache should hold all 3 resolved assets
        assert!(renderer.cursor_cache.contains_key("shape-arrow"));
        assert!(renderer.cursor_cache.contains_key("shape-ibeam"));
        assert!(renderer.cursor_cache.contains_key("shape-hand"));
    }
}
