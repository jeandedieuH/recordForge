#![cfg(feature = "native-render")]

use tiny_skia::{
    BlendMode, Color, FillRule, LineCap, LineJoin, Paint, Path, PathBuilder, Pixmap, PixmapPaint,
    Point, Stroke, StrokeDash, Transform,
};

use crate::fonts::resolve_font_family;
use crate::images::{ImageCache, ImageFit};
use crate::scene::{DisplayAnnotation, DisplayImage, DisplayItem, DisplayText};
use crate::{OverlayEngine, OverlayError};

/// Render all evaluated overlay items at a timestamp into the target pixmap.
pub(crate) fn render_to_pixmap(
    engine: &OverlayEngine,
    time_ms: u64,
    pixmap: &mut Pixmap,
) -> Result<(), OverlayError> {
    let display_list = engine.evaluate(time_ms);
    for item in &display_list.items {
        match item {
            DisplayItem::Annotation { item } => {
                render_annotation(pixmap, item)?;
            }
            DisplayItem::Text { item } => {
                render_text(pixmap, item)?;
            }
            DisplayItem::Image { item } => {
                render_image(pixmap, item, engine.images())?;
            }
        }
    }
    Ok(())
}

fn item_transform(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    anchor_x: f64,
    anchor_y: f64,
) -> Transform {
    let origin_x = (x + width * anchor_x) as f32;
    let origin_y = (y + height * anchor_y) as f32;
    if rotation.abs() < 1e-4 {
        Transform::identity()
    } else {
        Transform::from_translate(origin_x, origin_y)
            .pre_rotate(rotation as f32)
            .pre_translate(-origin_x, -origin_y)
    }
}

pub(crate) fn parse_color(color_str: &str, alpha_mul: f64) -> Color {
    let trimmed = color_str.trim();
    let mut r = 0.0f32;
    let mut g = 0.0f32;
    let mut b = 0.0f32;
    let mut a = 1.0f32;

    if let Some(hex) = trimmed.strip_prefix('#') {
        match hex.len() {
            3 => {
                if let (Ok(cr), Ok(cg), Ok(cb)) = (
                    u8::from_str_radix(&hex[0..1], 16),
                    u8::from_str_radix(&hex[1..2], 16),
                    u8::from_str_radix(&hex[2..3], 16),
                ) {
                    r = (cr * 17) as f32 / 255.0;
                    g = (cg * 17) as f32 / 255.0;
                    b = (cb * 17) as f32 / 255.0;
                }
            }
            4 => {
                if let (Ok(cr), Ok(cg), Ok(cb), Ok(ca)) = (
                    u8::from_str_radix(&hex[0..1], 16),
                    u8::from_str_radix(&hex[1..2], 16),
                    u8::from_str_radix(&hex[2..3], 16),
                    u8::from_str_radix(&hex[3..4], 16),
                ) {
                    r = (cr * 17) as f32 / 255.0;
                    g = (cg * 17) as f32 / 255.0;
                    b = (cb * 17) as f32 / 255.0;
                    a = (ca * 17) as f32 / 255.0;
                }
            }
            6 => {
                if let (Ok(cr), Ok(cg), Ok(cb)) = (
                    u8::from_str_radix(&hex[0..2], 16),
                    u8::from_str_radix(&hex[2..4], 16),
                    u8::from_str_radix(&hex[4..6], 16),
                ) {
                    r = cr as f32 / 255.0;
                    g = cg as f32 / 255.0;
                    b = cb as f32 / 255.0;
                }
            }
            8 => {
                if let (Ok(cr), Ok(cg), Ok(cb), Ok(ca)) = (
                    u8::from_str_radix(&hex[0..2], 16),
                    u8::from_str_radix(&hex[2..4], 16),
                    u8::from_str_radix(&hex[4..6], 16),
                    u8::from_str_radix(&hex[6..8], 16),
                ) {
                    r = cr as f32 / 255.0;
                    g = cg as f32 / 255.0;
                    b = cb as f32 / 255.0;
                    a = ca as f32 / 255.0;
                }
            }
            _ => {}
        }
    } else if trimmed.starts_with("rgb") {
        let inside = trimmed
            .trim_start_matches("rgba(")
            .trim_start_matches("rgb(")
            .trim_end_matches(')');
        let parts: Vec<&str> = inside.split(',').map(|s| s.trim()).collect();
        if parts.len() >= 3 {
            if let (Ok(pr), Ok(pg), Ok(pb)) = (
                parts[0].parse::<f32>(),
                parts[1].parse::<f32>(),
                parts[2].parse::<f32>(),
            ) {
                r = (pr / 255.0).clamp(0.0, 1.0);
                g = (pg / 255.0).clamp(0.0, 1.0);
                b = (pb / 255.0).clamp(0.0, 1.0);
            }
            if parts.len() >= 4 {
                if let Ok(pa) = parts[3].parse::<f32>() {
                    a = pa.clamp(0.0, 1.0);
                }
            }
        }
    }

    let final_alpha = (a * alpha_mul as f32).clamp(0.0, 1.0);
    Color::from_rgba(r, g, b, final_alpha).unwrap_or(Color::TRANSPARENT)
}

fn build_rounded_rect_path(x: f32, y: f32, width: f32, height: f32, radius: f32) -> Option<Path> {
    let r = radius.clamp(0.0, width.min(height) / 2.0);
    let mut pb = PathBuilder::new();
    if r <= 0.0 {
        pb.move_to(x, y);
        pb.line_to(x + width, y);
        pb.line_to(x + width, y + height);
        pb.line_to(x, y + height);
        pb.close();
    } else {
        pb.move_to(x + r, y);
        pb.line_to(x + width - r, y);
        pb.quad_to(x + width, y, x + width, y + r);
        pb.line_to(x + width, y + height - r);
        pb.quad_to(x + width, y + height, x + width - r, y + height);
        pb.line_to(x + r, y + height);
        pb.quad_to(x, y + height, x, y + height - r);
        pb.line_to(x, y + r);
        pb.quad_to(x, y, x + r, y);
        pb.close();
    }
    pb.finish()
}

fn build_ellipse_path(cx: f32, cy: f32, rx: f32, ry: f32) -> Option<Path> {
    // Approximate ellipse with 4 cubic bezier segments
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
    pb.finish()
}

fn stroke_for_style(style: &str, width: f32) -> Stroke {
    let dash = match style {
        "dashed" => StrokeDash::new(vec![width * 4.0, width * 3.0], 0.0),
        "dotted" => StrokeDash::new(vec![width, width * 2.0], 0.0),
        _ => None,
    };
    Stroke {
        width,
        miter_limit: 4.0,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        dash,
    }
}

fn draw_arrow_head(
    pb: &mut PathBuilder,
    head: &str,
    x: f32,
    y: f32,
    toward_x: f32,
    toward_y: f32,
    stroke_width: f32,
) {
    if head == "none" {
        return;
    }
    let angle = (toward_y - y).atan2(toward_x - x);
    let size = (stroke_width * 3.0).max(8.0);

    let cos = angle.cos();
    let sin = angle.sin();
    let rot = |px: f32, py: f32| -> (f32, f32) { (x + px * cos - py * sin, y + px * sin + py * cos) };

    if head == "circle" {
        let r = size / 2.0;
        let k = r * 0.552_284_8;
        let cx = x;
        let cy = y;
        pb.move_to(cx, cy - r);
        pb.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
        pb.cubic_to(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
        pb.cubic_to(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
        pb.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
        pb.close();
    } else if head == "diamond" {
        let (p1x, p1y) = rot(0.0, 0.0);
        let (p2x, p2y) = rot(size * 0.75, size * 0.45);
        let (p3x, p3y) = rot(size * 1.5, 0.0);
        let (p4x, p4y) = rot(size * 0.75, -size * 0.45);
        pb.move_to(p1x, p1y);
        pb.line_to(p2x, p2y);
        pb.line_to(p3x, p3y);
        pb.line_to(p4x, p4y);
        pb.close();
    } else {
        // Default "arrow"
        let (p1x, p1y) = rot(0.0, 0.0);
        let (p2x, p2y) = rot(size, size * 0.5);
        let (p3x, p3y) = rot(size * 0.75, 0.0);
        let (p4x, p4y) = rot(size, -size * 0.5);
        pb.move_to(p1x, p1y);
        pb.line_to(p2x, p2y);
        pb.line_to(p3x, p3y);
        pb.line_to(p4x, p4y);
        pb.close();
    }
}

fn draw_shadow_path(
    pixmap: &mut Pixmap,
    path: &Path,
    transform: Transform,
    shadow_color: &str,
    shadow_blur: f64,
    opacity: f64,
) {
    if shadow_blur <= 0.0 {
        return;
    }
    let color = parse_color(shadow_color, opacity * 0.45);
    if color.alpha() <= 0.0 {
        return;
    }

    let offset_y = (shadow_blur as f32 / 2.0).clamp(1.0, 24.0);
    let shadow_transform = transform.post_translate(0.0, offset_y);

    let blur_radius = (shadow_blur / 2.0).clamp(1.0, 32.0) as f32;
    let pad = (blur_radius * 3.0).ceil() as i32;

    let bounds = path.bounds();
    let pts = [
        (bounds.left(), bounds.top()),
        (bounds.right(), bounds.top()),
        (bounds.right(), bounds.bottom()),
        (bounds.left(), bounds.bottom()),
    ];
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    for (px, py) in pts {
        let mut pt = Point::from_xy(px, py);
        shadow_transform.map_point(&mut pt);
        min_x = min_x.min(pt.x);
        min_y = min_y.min(pt.y);
        max_x = max_x.max(pt.x);
        max_y = max_y.max(pt.y);
    }


    let sub_x0 = (min_x.floor() as i32 - pad).max(0);
    let sub_y0 = (min_y.floor() as i32 - pad).max(0);
    let sub_x1 = (max_x.ceil() as i32 + pad).min(pixmap.width() as i32);
    let sub_y1 = (max_y.ceil() as i32 + pad).min(pixmap.height() as i32);

    let sub_w = (sub_x1 - sub_x0).max(0) as u32;
    let sub_h = (sub_y1 - sub_y0).max(0) as u32;

    if sub_w == 0 || sub_h == 0 {
        return;
    }

    if let Some(mut sub_pix) = Pixmap::new(sub_w, sub_h) {
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.anti_alias = true;
        let local_transform = shadow_transform.post_translate(-(sub_x0 as f32), -(sub_y0 as f32));
        sub_pix.fill_path(path, &paint, FillRule::Winding, local_transform, None);
        fast_blur(&mut sub_pix, blur_radius);
        pixmap.draw_pixmap(
            sub_x0,
            sub_y0,
            sub_pix.as_ref(),
            &PixmapPaint::default(),
            Transform::identity(),
            None,
        );
    }
}


fn fast_blur(pixmap: &mut Pixmap, radius: f32) {
    let r = radius.round().max(1.0) as usize;
    let w = pixmap.width() as usize;
    let h = pixmap.height() as usize;
    if w == 0 || h == 0 || r == 0 {
        return;
    }
    let data = pixmap.data_mut();
    for _ in 0..3 {
        let temp = data.to_vec();
        for y in 0..h {
            let row_offset = y * w * 4;
            for x in 0..w {
                let start_x = x.saturating_sub(r);
                let end_x = (x + r).min(w - 1);
                let count = (end_x - start_x + 1) as u32;
                let mut sum_r = 0u32;
                let mut sum_g = 0u32;
                let mut sum_b = 0u32;
                let mut sum_a = 0u32;
                for kx in start_x..=end_x {
                    let idx = row_offset + kx * 4;
                    sum_r += temp[idx] as u32;
                    sum_g += temp[idx + 1] as u32;
                    sum_b += temp[idx + 2] as u32;
                    sum_a += temp[idx + 3] as u32;
                }
                let out_idx = row_offset + x * 4;
                data[out_idx] = (sum_r / count) as u8;
                data[out_idx + 1] = (sum_g / count) as u8;
                data[out_idx + 2] = (sum_b / count) as u8;
                data[out_idx + 3] = (sum_a / count) as u8;
            }
        }
        let temp_v = data.to_vec();
        for x in 0..w {
            for y in 0..h {
                let start_y = y.saturating_sub(r);
                let end_y = (y + r).min(h - 1);
                let count = (end_y - start_y + 1) as u32;
                let mut sum_r = 0u32;
                let mut sum_g = 0u32;
                let mut sum_b = 0u32;
                let mut sum_a = 0u32;
                for ky in start_y..=end_y {
                    let idx = (ky * w + x) * 4;
                    sum_r += temp_v[idx] as u32;
                    sum_g += temp_v[idx + 1] as u32;
                    sum_b += temp_v[idx + 2] as u32;
                    sum_a += temp_v[idx + 3] as u32;
                }
                let out_idx = (y * w + x) * 4;
                data[out_idx] = (sum_r / count) as u8;
                data[out_idx + 1] = (sum_g / count) as u8;
                data[out_idx + 2] = (sum_b / count) as u8;
                data[out_idx + 3] = (sum_a / count) as u8;
            }
        }
    }
}


fn render_annotation(
    pixmap: &mut Pixmap,
    item: &DisplayAnnotation,
) -> Result<(), OverlayError> {
    let t = &item.transform;
    let ts = item_transform(
        t.x, t.y, t.width, t.height, t.rotation, t.anchor_x, t.anchor_y,
    );
    let opacity = t.opacity * item.draw_progress;
    let stroke_width = item.stroke_width.max(1.0) as f32;

    if item.annotation_type == "spotlight" {
        // Spotlight mask: darkened canvas with cleared cutout
        let bg_color = parse_color(&item.fill_color, opacity * item.fill_opacity.max(0.5));
        let mut paint = Paint::default();
        paint.set_color(bg_color);
        paint.anti_alias = true;

        let cw = pixmap.width() as f32;
        let ch = pixmap.height() as f32;
        let mut pb = PathBuilder::new();
        // Outer canvas
        pb.move_to(0.0, 0.0);
        pb.line_to(cw, 0.0);
        pb.line_to(cw, ch);
        pb.line_to(0.0, ch);
        pb.close();

        // Inner cutout ellipse/rect
        let cx = (t.x + t.width / 2.0) as f32;
        let cy = (t.y + t.height / 2.0) as f32;
        let rx = (t.width / 2.0).max(1.0) as f32;
        let ry = (t.height / 2.0).max(1.0) as f32;
        let k = 0.552_284_8;
        let kx = rx * k;
        let ky = ry * k;
        pb.move_to(cx, cy - ry);
        pb.cubic_to(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
        pb.cubic_to(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
        pb.cubic_to(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
        pb.cubic_to(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
        pb.close();

        if let Some(path) = pb.finish() {
            pixmap.fill_path(&path, &paint, FillRule::EvenOdd, ts, None);
        }

        // Draw border around spotlight cutout if stroke width > 0
        if item.stroke_width > 0.0 {
            if let Some(cutout_path) = build_ellipse_path(cx, cy, rx, ry) {
                let stroke_color = parse_color(&item.stroke_color, opacity);
                let mut stroke_paint = Paint::default();
                stroke_paint.set_color(stroke_color);
                stroke_paint.anti_alias = true;
                let stroke = stroke_for_style(&item.stroke_style, stroke_width);
                pixmap.stroke_path(&cutout_path, &stroke_paint, &stroke, ts, None);
            }
        }
        return Ok(());
    }

    if item.annotation_type == "arrow" || item.annotation_type == "line" {
        let end_x = item.end_x.unwrap_or(t.x + t.width) as f32;
        let end_y = item.end_y.unwrap_or(t.y + t.height) as f32;
        let start_x = t.x as f32;
        let start_y = t.y as f32;
        let dx = end_x - start_x;
        let dy = end_y - start_y;
        let len = (dx * dx + dy * dy).sqrt();

        if len > 0.001 {
            let head_size = (stroke_width * 3.5).max(10.0);
            let start_offset = if item.arrow_start_head != "none" {
                (len * 0.45).min(if item.arrow_start_head == "circle" { head_size / 2.0 } else { head_size * 0.7 })
            } else {
                0.0
            };
            let end_offset = if item.arrow_end_head != "none" {
                (len * 0.45).min(if item.arrow_end_head == "circle" { head_size / 2.0 } else { head_size * 0.7 })
            } else {
                0.0
            };

            let ux = dx / len;
            let uy = dy / len;

            let mut pb = PathBuilder::new();
            pb.move_to(start_x + ux * start_offset, start_y + uy * start_offset);
            pb.line_to(end_x - ux * end_offset, end_y - uy * end_offset);
            if let Some(line_path) = pb.finish() {
                let stroke_color = parse_color(&item.stroke_color, opacity);
                let mut stroke_paint = Paint::default();
                stroke_paint.set_color(stroke_color);
                stroke_paint.anti_alias = true;
                let stroke = stroke_for_style(&item.stroke_style, stroke_width);
                pixmap.stroke_path(&line_path, &stroke_paint, &stroke, ts, None);
            }

            if item.annotation_type == "arrow" {
                let mut head_pb = PathBuilder::new();
                draw_arrow_head(
                    &mut head_pb,
                    &item.arrow_start_head,
                    start_x,
                    start_y,
                    end_x,
                    end_y,
                    stroke_width,
                );
                draw_arrow_head(
                    &mut head_pb,
                    &item.arrow_end_head,
                    end_x,
                    end_y,
                    start_x,
                    start_y,
                    stroke_width,
                );
                if let Some(head_path) = head_pb.finish() {
                    let stroke_color = parse_color(&item.stroke_color, opacity);
                    let mut fill_paint = Paint::default();
                    fill_paint.set_color(stroke_color);
                    fill_paint.anti_alias = true;
                    pixmap.fill_path(&head_path, &fill_paint, FillRule::Winding, ts, None);
                }
            }
        }
        return Ok(());
    }

    let x = t.x as f32;
    let y = t.y as f32;
    let w = t.width.max(1.0) as f32;
    let h = t.height.max(1.0) as f32;

    let path = match item.annotation_type.as_str() {
        "circle" => build_ellipse_path(x + w / 2.0, y + h / 2.0, w / 2.0, h / 2.0),
        "rounded-rect" | "callout" => {
            build_rounded_rect_path(x, y, w, h, item.corner_radius as f32)
        }
        "badge" => {
            let r = (h / 2.0).min(8.0);
            build_rounded_rect_path(x, y, w, h, r)
        }
        _ => build_rounded_rect_path(x, y, w, h, 0.0),
    };

    if let Some(path) = path {
        if item.shadow_enabled {
            draw_shadow_path(
                pixmap,
                &path,
                ts,
                &item.shadow_color,
                item.shadow_blur,
                opacity,
            );
        }

        // Fill
        if item.fill_opacity > 0.0 {
            let fill_color = parse_color(&item.fill_color, opacity * item.fill_opacity);
            let mut fill_paint = Paint::default();
            fill_paint.set_color(fill_color);
            fill_paint.anti_alias = true;
            pixmap.fill_path(&path, &fill_paint, FillRule::Winding, ts, None);
        }

        // Stroke
        if item.stroke_width > 0.0 {
            let stroke_color = parse_color(&item.stroke_color, opacity);
            let mut stroke_paint = Paint::default();
            stroke_paint.set_color(stroke_color);
            stroke_paint.anti_alias = true;
            let stroke = stroke_for_style(&item.stroke_style, stroke_width);
            pixmap.stroke_path(&path, &stroke_paint, &stroke, ts, None);
        }

        // Callout tail
        if item.annotation_type == "callout" {
            let mut tail_pb = PathBuilder::new();
            tail_pb.move_to(x + 24.0, y + h - 1.0);
            tail_pb.line_to(x + 44.0, y + h - 1.0);
            tail_pb.line_to(x + 16.0, y + h + 18.0);
            tail_pb.close();
            if let Some(tail_path) = tail_pb.finish() {
                let fill_color = parse_color(&item.fill_color, opacity * item.fill_opacity.max(0.85));
                let mut tail_paint = Paint::default();
                tail_paint.set_color(fill_color);
                tail_paint.anti_alias = true;
                pixmap.fill_path(&tail_path, &tail_paint, FillRule::Winding, ts, None);
            }
        }
    }

    // Text label for callout or badge
    if (item.annotation_type == "callout" || item.annotation_type == "badge")
        && item.text.as_ref().is_some_and(|text| !text.is_empty())
    {
        if let Some(text) = &item.text {
            let fs = item.font_size.clamp(10.0, 72.0) as f32;
            let padding = if item.annotation_type == "badge" { 24.0 } else { fs * 1.5 };
            let max_chars = ((w - padding).max(20.0) / (fs * 0.58)).max(3.0) as usize;
            let lines = wrap_text_to_lines(text, max_chars);
            if !lines.is_empty() {
                let line_h = fs * 1.25;
                let total_h = (lines.len().saturating_sub(1) as f32) * line_h;
                let start_y = (y + h / 2.0) - total_h / 2.0;
                let mut tspans = String::new();
                for (idx, line) in lines.iter().enumerate() {
                    let dy = if idx == 0 { 0.0 } else { line_h };
                    tspans.push_str(&format!(
                        r##"<tspan x="{tx}" dy="{dy}">{txt}</tspan>"##,
                        tx = x + w / 2.0,
                        dy = dy,
                        txt = escape_xml(line),
                    ));
                }
                let svg = format!(
                    r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">
                        <text x="{tx}" y="{ty}" fill="{tc}" font-family="{ff}" font-size="{fs}" font-weight="700" text-anchor="middle" dominant-baseline="central">{tspans}</text>
                    </svg>"##,
                    w = pixmap.width(),
                    h = pixmap.height(),
                    tx = x + w / 2.0,
                    ty = start_y,
                    tc = item.text_color,
                    ff = resolve_font_family("sans"),
                    fs = fs,
                    tspans = tspans,
                );
                if let Err(err) = render_svg_markup(&svg, ts, pixmap) {
                    eprintln!("failed to render annotation text SVG: {err}");
                }
            }
        }
    }

    Ok(())
}

fn render_text(pixmap: &mut Pixmap, item: &DisplayText) -> Result<(), OverlayError> {
    let t = &item.transform;
    let ts = item_transform(
        t.x, t.y, t.width, t.height, t.rotation, t.anchor_x, t.anchor_y,
    );
    let opacity = t.opacity;

    let x = t.x as f32;
    let y = t.y as f32;
    let w = t.width.max(20.0) as f32;
    let h = t.height.max(20.0) as f32;

    // Backdrop
    if item.backdrop_style != "none" {
        let radius = if item.backdrop_style == "pill" {
            h / 2.0
        } else {
            item.backdrop_border_radius as f32
        };

        if let Some(backdrop_path) = build_rounded_rect_path(x, y, w, h, radius) {
            if item.shadow_enabled {
                draw_shadow_path(
                    pixmap,
                    &backdrop_path,
                    ts,
                    &item.shadow_color,
                    item.shadow_blur,
                    opacity,
                );
            }

            let bg_color = parse_color(&item.backdrop_color, opacity * item.backdrop_opacity);
            let mut bg_paint = Paint::default();
            bg_paint.set_color(bg_color);
            bg_paint.anti_alias = true;
            pixmap.fill_path(&backdrop_path, &bg_paint, FillRule::Winding, ts, None);

            if item.backdrop_style == "outline" || item.backdrop_style == "glass" {
                let border_color = parse_color(&item.accent_color, opacity * 0.35);
                let mut stroke_paint = Paint::default();
                stroke_paint.set_color(border_color);
                stroke_paint.anti_alias = true;
                let stroke = Stroke {
                    width: 1.0,
                    ..Default::default()
                };
                pixmap.stroke_path(&backdrop_path, &stroke_paint, &stroke, ts, None);
            }

            if item.backdrop_style == "accent-bar" {
                let bar_w = (item.backdrop_padding_x as f32 / 2.0).max(3.0);
                if let Some(bar_path) = build_rounded_rect_path(x, y, bar_w, h, 2.0) {
                    let bar_color = parse_color(&item.accent_color, opacity);
                    let mut bar_paint = Paint::default();
                    bar_paint.set_color(bar_color);
                    bar_paint.anti_alias = true;
                    pixmap.fill_path(&bar_path, &bar_paint, FillRule::Winding, ts, None);
                }
            }
        }
    }

    // Typewriter progress text slicing
    let primary_text = reveal_text(&item.primary_text, item.text_progress);
    let font_family = resolve_font_family(&item.font_family);

    let text_anchor = match item.alignment.as_str() {
        "center" => "middle",
        "right" => "end",
        _ => "start",
    };

    let text_x = match item.alignment.as_str() {
        "center" => x + w / 2.0,
        "right" => x + w - item.backdrop_padding_x as f32,
        _ => x + item.backdrop_padding_x as f32,
    };

    let mut content_markup = String::new();
    let mut cursor_y = y + item.backdrop_padding_y as f32 + item.font_size as f32 * 0.8;

    // Optional tag text
    if let Some(tag) = &item.tag_text {
        if !tag.trim().is_empty() {
            let tag_fs = (item.font_size * 0.35).clamp(10.0, 18.0);
            content_markup.push_str(&format!(
                r##"<text x="{tx}" y="{ty}" fill="{accent}" font-family="{ff}" font-size="{fs}" font-weight="700" letter-spacing="1.5" text-anchor="{anchor}">{tag}</text>"##,
                tx = text_x,
                ty = cursor_y,
                accent = item.accent_color,
                ff = font_family,
                fs = tag_fs,
                anchor = text_anchor,
                tag = escape_xml(&tag.to_uppercase()),
            ));
            cursor_y += tag_fs as f32 + 8.0;
        }
    }

    // Primary text
    let primary_fs = item.font_size.clamp(12.0, 120.0) as f32;
    let primary_line_h = primary_fs * 1.15;
    let max_primary_chars = ((w - item.backdrop_padding_x as f32 * 2.0).max(20.0) / (primary_fs * 0.58)).max(3.0) as usize;
    let primary_lines = wrap_text_to_lines(&primary_text, max_primary_chars);
    for line in &primary_lines {
        content_markup.push_str(&format!(
            r##"<text x="{tx}" y="{ty}" fill="{color}" font-family="{ff}" font-size="{fs}" font-weight="{weight}" text-anchor="{anchor}">{txt}</text>"##,
            tx = text_x,
            ty = cursor_y,
            color = item.text_color,
            ff = font_family,
            fs = primary_fs,
            weight = item.font_weight,
            anchor = text_anchor,
            txt = escape_xml(line),
        ));
        cursor_y += primary_line_h;
    }
    cursor_y += 6.0;

    // Secondary text
    if let Some(subtitle) = &item.secondary_text {
        if !subtitle.trim().is_empty() {
            let sub_fs = (item.font_size * 0.55).clamp(11.0, 48.0) as f32;
            let sub_line_h = sub_fs * 1.2;
            let max_sub_chars = ((w - item.backdrop_padding_x as f32 * 2.0).max(20.0) / (sub_fs * 0.58)).max(3.0) as usize;
            let sub_lines = wrap_text_to_lines(subtitle, max_sub_chars);
            for line in &sub_lines {
                content_markup.push_str(&format!(
                    r##"<text x="{tx}" y="{ty}" fill="{color}" font-family="{ff}" font-size="{fs}" font-weight="500" text-anchor="{anchor}" opacity="0.85">{txt}</text>"##,
                    tx = text_x,
                    ty = cursor_y,
                    color = item.secondary_text_color,
                    ff = font_family,
                    fs = sub_fs,
                    anchor = text_anchor,
                    txt = escape_xml(line),
                ));
                cursor_y += sub_line_h;
            }
        }
    }

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{cw}" height="{ch}" viewBox="0 0 {cw} {ch}">
            <g opacity="{opacity}">
                {content}
            </g>
        </svg>"##,
        cw = pixmap.width(),
        ch = pixmap.height(),
        opacity = opacity,
        content = content_markup,
    );

    if let Err(err) = render_svg_markup(&svg, ts, pixmap) {
        eprintln!("failed to render title text SVG: {err}");
    }
    Ok(())
}

fn render_image(
    pixmap: &mut Pixmap,
    item: &DisplayImage,
    images: &ImageCache,
) -> Result<(), OverlayError> {
    let t = &item.transform;
    let ts = item_transform(
        t.x, t.y, t.width, t.height, t.rotation, t.anchor_x, t.anchor_y,
    );
    let opacity = t.opacity;

    let x = t.x as f32;
    let y = t.y as f32;
    let w = t.width.max(1.0) as f32;
    let h = t.height.max(1.0) as f32;
    let radius = item.border_radius as f32;

    // Draw shadow if enabled
    if item.shadow_enabled {
        if let Some(shadow_path) = build_rounded_rect_path(x, y, w, h, radius) {
            draw_shadow_path(
                pixmap,
                &shadow_path,
                ts,
                &item.shadow_color,
                item.shadow_blur,
                opacity,
            );
        }
    }

    if let Some(source_image) = images.get(&item.asset_id) {
        let fit = ImageFit::from_str_lossy(&item.fit);
        let src_w = source_image.width() as f32;
        let src_h = source_image.height() as f32;

        let (draw_w, draw_h, draw_x, draw_y) = match fit {
            ImageFit::Fill => (w, h, x, y),
            ImageFit::Contain => {
                let src_ratio = src_w / src_h.max(1.0);
                let target_ratio = w / h.max(1.0);
                let (scaled_w, scaled_h) = if target_ratio > src_ratio {
                    (h * src_ratio, h)
                } else {
                    (w, w / src_ratio.max(1e-4))
                };
                (scaled_w, scaled_h, x + (w - scaled_w) / 2.0, y + (h - scaled_h) / 2.0)
            }
            ImageFit::Cover => {
                let src_ratio = src_w / src_h.max(1.0);
                let target_ratio = w / h.max(1.0);
                let (scaled_w, scaled_h) = if target_ratio > src_ratio {
                    (w, w / src_ratio.max(1e-4))
                } else {
                    (h * src_ratio, h)
                };
                (scaled_w, scaled_h, x + (w - scaled_w) / 2.0, y + (h - scaled_h) / 2.0)
            }
        };

        // Render scaled image to temporary frame with transform
        let scale_x = draw_w / src_w.max(1.0);
        let scale_y = draw_h / src_h.max(1.0);
        let img_transform = ts
            .post_translate(draw_x, draw_y)
            .post_scale(scale_x, scale_y);

        let paint = PixmapPaint {
            opacity: opacity as f32,
            blend_mode: BlendMode::SourceOver,
            ..Default::default()
        };

        // If radius > 0, mask/clip or fill into rounded rect
        pixmap.draw_pixmap(
            0,
            0,
            source_image.as_ref(),
            &paint,
            img_transform,
            None,
        );
    } else {
        // Fallback: draw placeholder rounded rectangle
        if let Some(placeholder_path) = build_rounded_rect_path(x, y, w, h, radius) {
            let placeholder_color = Color::from_rgba(0.13, 0.83, 0.93, 0.16 * opacity as f32)
                .unwrap_or(Color::TRANSPARENT);
            let mut fill_paint = Paint::default();
            fill_paint.set_color(placeholder_color);
            fill_paint.anti_alias = true;
            pixmap.fill_path(
                &placeholder_path,
                &fill_paint,
                FillRule::Winding,
                ts,
                None,
            );
        }
    }

    // Border
    if item.border_width > 0.0 {
        if let Some(border_path) = build_rounded_rect_path(x, y, w, h, radius) {
            let border_color = parse_color(&item.border_color, opacity);
            let mut border_paint = Paint::default();
            border_paint.set_color(border_color);
            border_paint.anti_alias = true;
            let stroke = Stroke {
                width: item.border_width as f32,
                ..Default::default()
            };
            pixmap.stroke_path(&border_path, &border_paint, &stroke, ts, None);
        }
    }

    Ok(())
}

fn render_svg_markup(
    svg: &str,
    transform: Transform,
    pixmap: &mut Pixmap,
) -> Result<(), String> {
    let mut options = resvg::usvg::Options::default();
    options.fontdb = crate::fonts::get_shared_font_database();
    let tree = resvg::usvg::Tree::from_str(svg, &options)
        .map_err(|e| format!("parse SVG: {e}"))?;
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    Ok(())
}

fn reveal_text(text: &str, progress: f64) -> String {
    if progress >= 1.0 {
        return text.to_string();
    }
    if progress <= 0.0 {
        return String::new();
    }
    let char_count = text.chars().count();
    let take_count = (char_count as f64 * progress).ceil() as usize;
    text.chars().take(take_count).collect()
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn wrap_text_to_lines(text: &str, max_chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let max_len = max_chars.max(1);

    for raw_line in text.lines() {
        let trimmed = raw_line.trim_end_matches('\r');
        if trimmed.is_empty() {
            lines.push(String::new());
            continue;
        }

        let words: Vec<&str> = trimmed.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut current = String::new();
        for word in words {
            if current.is_empty() {
                current = word.to_string();
                continue;
            }
            if current.chars().count() + 1 + word.chars().count() <= max_len {
                current.push(' ');
                current.push_str(word);
            } else {
                lines.push(current);
                current = word.to_string();
            }
        }
        if !current.is_empty() {
            lines.push(current);
        }
    }

    if lines.is_empty() {
        vec![text.to_string()]
    } else {
        lines
    }
}
