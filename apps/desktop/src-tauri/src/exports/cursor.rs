use crate::capture::cursor::{CursorTelemetryEvent, CursorTelemetryFile};

use super::{RenderPlanZoomSegment, RenderSegment};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CursorSettings {
    pub enabled: bool,
    pub preset: String,
    pub scale: f64,
    pub fill_color: String,
    pub fill_opacity: f64,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub stroke_opacity: f64,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur: f64,
    pub shadow_offset_x: f64,
    pub shadow_offset_y: f64,
    pub shadow_opacity: f64,
    pub click_feedback: String,
    pub click_color: String,
    pub click_size: f64,
    pub left_click_enabled: bool,
    pub right_click_enabled: bool,
    pub spotlight_mode: bool,
    pub spotlight_radius: f64,
    pub spotlight_dim_opacity: f64,
    pub hide_native_cursor: bool,
    pub smooth_movement: bool,
    pub smooth_factor: f64,
    pub auto_hide_idle: bool,
    pub idle_timeout_ms: u64,
}

impl Default for CursorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            preset: "modern-neon".into(),
            scale: 1.0,
            fill_color: "#3b82f6".into(),
            fill_opacity: 1.0,
            stroke_color: "#ffffff".into(),
            stroke_width: 2.0,
            stroke_opacity: 1.0,
            shadow_enabled: true,
            shadow_color: "#000000".into(),
            shadow_blur: 8.0,
            shadow_offset_x: 2.0,
            shadow_offset_y: 4.0,
            shadow_opacity: 0.4,
            click_feedback: "ripple".into(),
            click_color: "#60a5fa".into(),
            click_size: 36.0,
            left_click_enabled: true,
            right_click_enabled: true,
            spotlight_mode: false,
            spotlight_radius: 120.0,
            spotlight_dim_opacity: 0.5,
            hide_native_cursor: true,
            smooth_movement: true,
            smooth_factor: 0.25,
            auto_hide_idle: false,
            idle_timeout_ms: 2_000,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
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

#[derive(Debug, Clone)]
pub struct CursorRenderer {
    settings: CursorSettings,
    telemetry: CursorTelemetryFile,
    segments: Vec<RenderSegment>,
    zoom_segments: Vec<RenderPlanZoomSegment>,
    canvas_width: u32,
    canvas_height: u32,
    fit_scale: f64,
    fit_offset_x: f64,
    fit_offset_y: f64,
}

impl CursorRenderer {
    #[cfg(test)]
    pub fn new(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        canvas_width: u32,
        canvas_height: u32,
    ) -> Result<Self, String> {
        Self::new_with_zoom(
            settings,
            telemetry,
            segments,
            &[],
            canvas_width,
            canvas_height,
        )
    }

    pub fn new_with_zoom(
        settings: CursorSettings,
        telemetry: CursorTelemetryFile,
        segments: &[RenderSegment],
        zoom_segments: &[RenderPlanZoomSegment],
        canvas_width: u32,
        canvas_height: u32,
    ) -> Result<Self, String> {
        let telemetry = telemetry.normalize();
        if canvas_width == 0 || canvas_height == 0 {
            return Err("cursor canvas dimensions must be positive".into());
        }
        if telemetry.source_width == 0 || telemetry.source_height == 0 {
            return Err("cursor telemetry dimensions must be positive".into());
        }
        if segments.is_empty() {
            return Err("cursor renderer requires at least one video segment".into());
        }

        let fit_scale = (canvas_width as f64 / telemetry.source_width as f64)
            .min(canvas_height as f64 / telemetry.source_height as f64);
        let fit_width = telemetry.source_width as f64 * fit_scale;
        let fit_height = telemetry.source_height as f64 * fit_scale;

        Ok(Self {
            settings,
            telemetry,
            segments: segments.to_vec(),
            zoom_segments: zoom_segments.to_vec(),
            canvas_width,
            canvas_height,
            fit_scale,
            fit_offset_x: (canvas_width as f64 - fit_width) / 2.0,
            fit_offset_y: (canvas_height as f64 - fit_height) / 2.0,
        })
    }

    pub fn render_frame(&self, output_ms: u64, frame: &mut [u8]) {
        frame.fill(0);
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
        let event_index = match closest_event(&self.telemetry.events, source_time_ms) {
            Some((index, event)) => {
                if !event.visible
                    || (self.settings.auto_hide_idle
                        && is_cursor_idle(
                            &self.telemetry.events,
                            index,
                            source_time_ms,
                            self.settings.idle_timeout_ms,
                        ))
                {
                    return;
                }
                index
            }
            None => return,
        };
        let (x, y) = self.position_for_event(event_index);
        let (x, y) = self.apply_zoom(output_ms, x, y);

        if self.settings.spotlight_mode {
            self.render_spotlight(frame, x, y);
        }

        if is_recent_click(
            &self.telemetry.events,
            source_time_ms,
            self.settings.left_click_enabled,
            self.settings.right_click_enabled,
        ) && self.settings.click_feedback != "none"
        {
            self.render_click_feedback(frame, x, y, source_time_ms);
        }

        let shadow = parse_color(&self.settings.shadow_color, Rgba::opaque(0, 0, 0))
            .with_alpha(self.settings.shadow_opacity);
        if self.settings.shadow_enabled {
            self.draw_cursor(
                frame,
                x + self.settings.shadow_offset_x,
                y + self.settings.shadow_offset_y,
                shadow,
                shadow,
                0.0,
            );
        }
        let fill = parse_color(&self.settings.fill_color, Rgba::opaque(59, 130, 246))
            .with_alpha(self.settings.fill_opacity);
        let stroke = parse_color(&self.settings.stroke_color, Rgba::opaque(255, 255, 255))
            .with_alpha(self.settings.stroke_opacity);
        self.draw_cursor(frame, x, y, fill, stroke, self.settings.stroke_width);
    }

    fn apply_zoom(&self, output_ms: u64, x: f64, y: f64) -> (f64, f64) {
        let Some(segment) = self.zoom_segments.iter().find(|segment| {
            segment.enabled && output_ms >= segment.start_ms && output_ms < segment.end_ms
        }) else {
            return (x, y);
        };
        let duration = (segment.end_ms - segment.start_ms).max(1) as f64;
        let progress =
            ((output_ms.saturating_sub(segment.start_ms) as f64) / duration).clamp(0.0, 1.0);
        let eased = match segment.easing.as_str() {
            "linear" => progress,
            "ease-in" => progress * progress,
            "ease-out" => 1.0 - (1.0 - progress).powi(2),
            _ => {
                if progress < 0.5 {
                    2.0 * progress * progress
                } else {
                    1.0 - (-2.0 * progress + 2.0).powi(2) / 2.0
                }
            }
        };
        let target_width =
            (segment.target.width / segment.scale.max(1.0)).clamp(1.0, self.canvas_width as f64);
        let target_height =
            (segment.target.height / segment.scale.max(1.0)).clamp(1.0, self.canvas_height as f64);
        let target_x = (segment.target.x + (segment.target.width - target_width) / 2.0)
            .clamp(0.0, self.canvas_width as f64 - target_width);
        let target_y = (segment.target.y + (segment.target.height - target_height) / 2.0)
            .clamp(0.0, self.canvas_height as f64 - target_height);
        let crop_x = target_x * eased;
        let crop_y = target_y * eased;
        let crop_width =
            self.canvas_width as f64 + (target_width - self.canvas_width as f64) * eased;
        let crop_height =
            self.canvas_height as f64 + (target_height - self.canvas_height as f64) * eased;
        (
            ((x - crop_x) * self.canvas_width as f64 / crop_width)
                .clamp(0.0, self.canvas_width as f64),
            ((y - crop_y) * self.canvas_height as f64 / crop_height)
                .clamp(0.0, self.canvas_height as f64),
        )
    }

    fn position_for_event(&self, event_index: usize) -> (f64, f64) {
        let event = &self.telemetry.events[event_index];
        let (capture_width, capture_height) = self
            .telemetry
            .capture_bounds
            .as_ref()
            .map(|bounds| (bounds.width, bounds.height))
            .unwrap_or((self.telemetry.source_width, self.telemetry.source_height));
        let dpi_scale = self
            .telemetry
            .dpi_scale
            .as_ref()
            .map(|scale| (scale.x, scale.y))
            .unwrap_or((1.0, 1.0));
        let coordinate_scale_x =
            self.telemetry.source_width as f64 / capture_width.max(1) as f64 * dpi_scale.0;
        let coordinate_scale_y =
            self.telemetry.source_height as f64 / capture_height.max(1) as f64 * dpi_scale.1;
        let (mut source_x, mut source_y) =
            (event.x * coordinate_scale_x, event.y * coordinate_scale_y);
        source_x = source_x.clamp(0.0, self.telemetry.source_width as f64);
        source_y = source_y.clamp(0.0, self.telemetry.source_height as f64);
        if self.settings.smooth_movement {
            let factor = self.settings.smooth_factor.clamp(0.05, 1.0);
            let window_size = 5;
            let mut total_weight = 0.0;
            source_x = 0.0;
            source_y = 0.0;
            for cursor_index in event_index.saturating_sub(window_size)..=event_index {
                let weight = (1.0 - factor).powi((event_index - cursor_index) as i32);
                source_x += self.telemetry.events[cursor_index].x * weight;
                source_y += self.telemetry.events[cursor_index].y * weight;
                total_weight += weight;
            }
            source_x /= total_weight;
            source_y /= total_weight;
        }

        (
            self.fit_offset_x + source_x * self.fit_scale,
            self.fit_offset_y + source_y * self.fit_scale,
        )
    }

    fn render_spotlight(&self, frame: &mut [u8], x: f64, y: f64) {
        let dim = parse_color(&self.settings.shadow_color, Rgba::opaque(0, 0, 0))
            .with_alpha(self.settings.spotlight_dim_opacity);
        fill_rect(
            frame,
            self.canvas_width,
            self.canvas_height,
            0,
            0,
            self.canvas_width,
            self.canvas_height,
            dim,
        );
        clear_circle(
            frame,
            self.canvas_width,
            self.canvas_height,
            x,
            y,
            self.settings.spotlight_radius.max(0.0),
        );
    }

    fn render_click_feedback(&self, frame: &mut [u8], x: f64, y: f64, time_ms: u64) {
        let click = closest_click(
            &self.telemetry.events,
            time_ms,
            self.settings.left_click_enabled,
            self.settings.right_click_enabled,
        );
        let elapsed = click
            .map(|event| time_ms.saturating_sub(event.t_ms) as f64)
            .unwrap_or(0.0);
        let progress = (elapsed / 350.0).clamp(0.0, 1.0);
        let color = parse_color(&self.settings.click_color, Rgba::opaque(96, 165, 250));
        let radius = self.settings.click_size.max(10.0) * (0.55 + progress * 0.45);

        match self.settings.click_feedback.as_str() {
            "pulse" => fill_circle(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius / 2.0,
                color.with_alpha(0.65 * (1.0 - progress)),
            ),
            "spotlight" => fill_circle(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius / 2.0,
                color.with_alpha(0.55 * (1.0 - progress)),
            ),
            "ripple" => draw_ring(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                radius,
                (3.0 * (1.0 - progress)).max(1.0),
                color.with_alpha(0.8 * (1.0 - progress)),
            ),
            _ => {}
        }
    }

    fn draw_cursor(
        &self,
        frame: &mut [u8],
        x: f64,
        y: f64,
        fill: Rgba,
        stroke: Rgba,
        stroke_width: f64,
    ) {
        let scale = self.settings.scale.clamp(0.2, 5.0);
        match self.settings.preset.as_str() {
            "highlighter-circle" => {
                fill_circle(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y,
                    15.0 * scale,
                    fill.with_alpha(0.35),
                );
                draw_ring(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y,
                    15.0 * scale,
                    stroke_width * scale,
                    stroke,
                );
                fill_circle(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y,
                    3.0 * scale,
                    stroke,
                );
            }
            "minimal-dot" => {
                fill_circle(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y,
                    7.0 * scale,
                    fill,
                );
                draw_ring(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y,
                    7.0 * scale,
                    stroke_width * scale,
                    stroke,
                );
            }
            "cyberpunk" => {
                draw_ring(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y,
                    12.0 * scale,
                    stroke_width.max(2.0) * scale,
                    fill,
                );
                let length = 6.0 * scale;
                let gap = 8.0 * scale;
                draw_line(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y - gap,
                    x,
                    y - gap - length,
                    stroke,
                    2.0 * scale,
                );
                draw_line(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y + gap,
                    x,
                    y + gap + length,
                    stroke,
                    2.0 * scale,
                );
                draw_line(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x - gap,
                    y,
                    x - gap - length,
                    y,
                    stroke,
                    2.0 * scale,
                );
                draw_line(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x + gap,
                    y,
                    x + gap + length,
                    y,
                    stroke,
                    2.0 * scale,
                );
                fill_circle(
                    frame,
                    self.canvas_width,
                    self.canvas_height,
                    x,
                    y,
                    3.0 * scale,
                    fill,
                );
            }
            "sleek-dark" => draw_arrow(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                scale,
                Rgba::opaque(18, 18, 18).with_alpha(self.settings.fill_opacity),
                stroke,
                stroke_width.max(2.0),
            ),
            "mac-pro" => draw_arrow(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                scale,
                Rgba::opaque(255, 255, 255).with_alpha(self.settings.fill_opacity),
                Rgba::opaque(30, 30, 30).with_alpha(self.settings.stroke_opacity),
                stroke_width.max(1.5),
            ),
            _ => draw_arrow(
                frame,
                self.canvas_width,
                self.canvas_height,
                x,
                y,
                scale,
                fill,
                stroke,
                stroke_width,
            ),
        }
    }
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

fn closest_event(
    events: &[CursorTelemetryEvent],
    time_ms: u64,
) -> Option<(usize, &CursorTelemetryEvent)> {
    if events.is_empty() {
        return None;
    }

    let mut low = 0;
    let mut high = events.len();
    while low < high {
        let middle = low + (high - low) / 2;
        if events[middle].t_ms < time_ms {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    let right = low.min(events.len() - 1);
    let left = right.saturating_sub(1);
    let index = if events[left].t_ms.abs_diff(time_ms) <= events[right].t_ms.abs_diff(time_ms) {
        left
    } else {
        right
    };
    Some((index, &events[index]))
}

fn closest_click(
    events: &[CursorTelemetryEvent],
    time_ms: u64,
    left_enabled: bool,
    right_enabled: bool,
) -> Option<&CursorTelemetryEvent> {
    let mut low = 0;
    let mut high = events.len();
    while low < high {
        let middle = low + (high - low) / 2;
        if events[middle].t_ms <= time_ms {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    for index in (0..low).rev() {
        let event = &events[index];
        let elapsed = time_ms.saturating_sub(event.t_ms);
        if elapsed >= 350 {
            break;
        }
        let is_edge =
            event.button_event == "down" || (event.button_event == "none" && event.clicked);
        let is_enabled = match event.button.as_str() {
            "left" => left_enabled,
            "right" => right_enabled,
            _ => true,
        };
        if is_edge && is_enabled {
            return Some(event);
        }
    }
    None
}

fn is_recent_click(
    events: &[CursorTelemetryEvent],
    time_ms: u64,
    left_enabled: bool,
    right_enabled: bool,
) -> bool {
    closest_click(events, time_ms, left_enabled, right_enabled).is_some()
}

fn is_cursor_idle(
    events: &[CursorTelemetryEvent],
    event_index: usize,
    time_ms: u64,
    timeout_ms: u64,
) -> bool {
    if event_index == 0 || timeout_ms == 0 {
        return false;
    }
    let current = &events[event_index];
    for previous in events[..event_index].iter().rev() {
        if previous.x != current.x
            || previous.y != current.y
            || previous.button_event == "down"
            || (previous.button_event == "none" && previous.clicked)
        {
            return time_ms.saturating_sub(previous.t_ms) >= timeout_ms;
        }
    }
    time_ms.saturating_sub(current.t_ms) >= timeout_ms
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

fn blend_pixel(frame: &mut [u8], width: u32, x: i32, y: i32, color: Rgba) {
    if x < 0 || y < 0 || x >= width as i32 {
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
) {
    let end_x = x.saturating_add(rect_width).min(width);
    let end_y = y.saturating_add(rect_height).min(height);
    for py in y..end_y {
        for px in x..end_x {
            blend_pixel(frame, width, px as i32, py as i32, color);
        }
    }
}

fn clear_circle(frame: &mut [u8], width: u32, height: u32, cx: f64, cy: f64, radius: f64) {
    let min_x = (cx - radius).floor().max(0.0) as u32;
    let max_x = (cx + radius).ceil().min(width as f64) as u32;
    let min_y = (cy - radius).floor().max(0.0) as u32;
    let max_y = (cy + radius).ceil().min(height as f64) as u32;
    let radius_squared = radius * radius;
    for py in min_y..max_y {
        for px in min_x..max_x {
            let dx = px as f64 - cx;
            let dy = py as f64 - cy;
            if dx * dx + dy * dy <= radius_squared {
                let index = (py as usize * width as usize + px as usize) * 4;
                frame[index..index + 4].fill(0);
            }
        }
    }
}

fn fill_circle(
    frame: &mut [u8],
    width: u32,
    height: u32,
    cx: f64,
    cy: f64,
    radius: f64,
    color: Rgba,
) {
    let min_x = (cx - radius).floor().max(0.0) as u32;
    let max_x = (cx + radius).ceil().min(width as f64) as u32;
    let min_y = (cy - radius).floor().max(0.0) as u32;
    let max_y = (cy + radius).ceil().min(height as f64) as u32;
    let radius_squared = radius * radius;
    for py in min_y..max_y {
        for px in min_x..max_x {
            let dx = px as f64 - cx;
            let dy = py as f64 - cy;
            if dx * dx + dy * dy <= radius_squared {
                blend_pixel(frame, width, px as i32, py as i32, color);
            }
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
            let dx = px as f64 - cx;
            let dy = py as f64 - cy;
            let distance_squared = dx * dx + dy * dy;
            if distance_squared <= outer_squared && distance_squared >= inner_squared {
                blend_pixel(frame, width, px as i32, py as i32, color);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_arrow(
    frame: &mut [u8],
    width: u32,
    height: u32,
    x: f64,
    y: f64,
    scale: f64,
    fill: Rgba,
    stroke: Rgba,
    stroke_width: f64,
) {
    let points = [
        (x + 3.0 * scale, y + 3.0 * scale),
        (x + 10.5 * scale, y + 20.5 * scale),
        (x + 13.8 * scale, y + 13.8 * scale),
        (x + 20.5 * scale, y + 10.5 * scale),
    ];
    fill_polygon(frame, width, height, &points, fill);
    for index in 0..points.len() {
        let next = points[(index + 1) % points.len()];
        draw_line(
            frame,
            width,
            height,
            points[index].0,
            points[index].1,
            next.0,
            next.1,
            stroke,
            stroke_width * scale,
        );
    }
}

fn fill_polygon(frame: &mut [u8], width: u32, height: u32, points: &[(f64, f64)], color: Rgba) {
    if points.len() < 3 {
        return;
    }
    let min_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as u32;
    let max_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(width as f64) as u32;
    let min_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as u32;
    let max_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(height as f64) as u32;
    for py in min_y..max_y {
        for px in min_x..max_x {
            if point_in_polygon(px as f64 + 0.5, py as f64 + 0.5, points) {
                blend_pixel(frame, width, px as i32, py as i32, color);
            }
        }
    }
}

fn point_in_polygon(x: f64, y: f64, points: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let mut previous = points.len() - 1;
    for current in 0..points.len() {
        let (current_x, current_y) = points[current];
        let (previous_x, previous_y) = points[previous];
        let intersects = (current_y > y) != (previous_y > y)
            && x < (previous_x - current_x) * (y - current_y) / (previous_y - current_y)
                + current_x;
        if intersects {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

#[allow(clippy::too_many_arguments)]
fn draw_line(
    frame: &mut [u8],
    width: u32,
    height: u32,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    color: Rgba,
    thickness: f64,
) {
    let distance = (x2 - x1).hypot(y2 - y1).max(1.0);
    let steps = distance.ceil() as usize;
    let radius = (thickness / 2.0).max(0.5);
    for step in 0..=steps {
        let ratio = step as f64 / steps as f64;
        fill_circle(
            frame,
            width,
            height,
            x1 + (x2 - x1) * ratio,
            y1 + (y2 - y1) * ratio,
            radius,
            color,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn telemetry() -> CursorTelemetryFile {
        CursorTelemetryFile::new(
            "recording".into(),
            100,
            100,
            crate::capture::cursor::CursorCaptureBounds {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            vec![
                CursorTelemetryEvent {
                    t_ms: 0,
                    x: 10.0,
                    y: 20.0,
                    clicked: false,
                    button: "none".into(),
                    button_event: "none".into(),
                    visible: true,
                },
                CursorTelemetryEvent {
                    t_ms: 100,
                    x: 40.0,
                    y: 50.0,
                    clicked: true,
                    button: "left".into(),
                    button_event: "down".into(),
                    visible: true,
                },
            ],
        )
    }

    fn segments() -> Vec<RenderSegment> {
        vec![RenderSegment {
            asset_id: Some("recording".into()),
            stream_index: None,
            volume: None,
            fade_in_ms: None,
            fade_out_ms: None,
            source_in_ms: 0,
            source_out_ms: 1_000,
            output_start_ms: 0,
            output_end_ms: 1_000,
        }]
    }

    #[test]
    fn maps_output_time_to_source_time_for_a_segment() {
        assert_eq!(source_time_for_output(&segments(), 500), Some(500));
    }

    #[test]
    fn renders_a_non_empty_cursor_frame() {
        let renderer = CursorRenderer::new(
            CursorSettings::default(),
            telemetry(),
            &segments(),
            100,
            100,
        )
        .expect("valid cursor renderer");
        let mut frame = vec![0; 100 * 100 * 4];
        renderer.render_frame(100, &mut frame);
        assert!(frame.chunks_exact(4).any(|pixel| pixel[3] > 0));
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
        assert_eq!(telemetry.schema_version, 1);
        assert_eq!(telemetry.asset_id, "asset-cursor-events");
        let renderer = CursorRenderer::new(
            CursorSettings::default(),
            telemetry,
            &segments(),
            1_920,
            1_080,
        )
        .expect("valid cursor renderer");
        let (x, y) = renderer.position_for_event(0);
        assert!((x - 352.5).abs() < 0.01);
        assert!((y - 135.0).abs() < 0.01);
    }

    #[test]
    fn does_not_render_hidden_cursor_events() {
        let mut data = telemetry();
        data.events[1].visible = false;
        let renderer = CursorRenderer::new(CursorSettings::default(), data, &segments(), 100, 100)
            .expect("valid cursor renderer");
        let mut frame = vec![0; 100 * 100 * 4];
        renderer.render_frame(100, &mut frame);
        assert!(frame.chunks_exact(4).all(|pixel| pixel[3] == 0));
    }
}
