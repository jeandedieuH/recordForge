#[cfg(test)]
use resvg::tiny_skia::{Pixmap, Transform};
#[cfg(test)]
use resvg::usvg;

/// Vector shape or annotation entry in the render plan.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanAnnotation {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub annotation_type: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub end_x: Option<f64>,
    #[serde(default)]
    pub end_y: Option<f64>,
    #[serde(default = "default_stroke_color")]
    pub stroke_color: String,
    #[serde(default = "default_stroke_width")]
    pub stroke_width: f64,
    #[serde(default = "default_stroke_style")]
    pub stroke_style: String,
    #[serde(default = "default_fill_color")]
    pub fill_color: String,
    #[serde(default)]
    pub fill_opacity: f64,
    #[serde(default = "default_corner_radius")]
    pub corner_radius: f64,
    #[serde(default = "default_arrow_head")]
    pub arrow_end_head: String,
    #[serde(default = "default_none")]
    pub arrow_start_head: String,
    #[serde(default)]
    pub shadow_enabled: bool,
    #[serde(default = "default_shadow_color")]
    pub shadow_color: String,
    #[serde(default = "default_shadow_blur")]
    pub shadow_blur: f64,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default = "default_white")]
    pub text_color: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_animation")]
    pub animation_in: String,
    #[serde(default = "default_animation")]
    pub animation_out: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Text clip or title preset entry in the render plan.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanText {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default = "default_category")]
    pub category: String,
    pub primary_text: String,
    #[serde(default)]
    pub secondary_text: Option<String>,
    #[serde(default)]
    pub tag_text: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_alignment")]
    pub alignment: String,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_title_font_size")]
    pub font_size: f64,
    #[serde(default = "default_font_weight")]
    pub font_weight: String,
    #[serde(default = "default_white")]
    pub text_color: String,
    #[serde(default = "default_secondary_text_color")]
    pub secondary_text_color: String,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default = "default_backdrop_style")]
    pub backdrop_style: String,
    #[serde(default = "default_backdrop_color")]
    pub backdrop_color: String,
    #[serde(default = "default_backdrop_opacity")]
    pub backdrop_opacity: f64,
    #[serde(default = "default_backdrop_blur")]
    pub backdrop_blur: f64,
    #[serde(default = "default_backdrop_radius")]
    pub backdrop_border_radius: f64,
    #[serde(default = "default_padding_x")]
    pub backdrop_padding_x: f64,
    #[serde(default = "default_padding_y")]
    pub backdrop_padding_y: f64,
    #[serde(default)]
    pub shadow_enabled: bool,
    #[serde(default = "default_shadow_color")]
    pub shadow_color: String,
    #[serde(default = "default_shadow_blur")]
    pub shadow_blur: f64,
    #[serde(default = "default_animation")]
    pub animation_in: String,
    #[serde(default = "default_animation")]
    pub animation_out: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Image graphic overlay entry in the render plan.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlanImage {
    pub id: String,
    pub asset_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub border_radius: f64,
    #[serde(default)]
    pub border_width: f64,
    #[serde(default = "default_white")]
    pub border_color: String,
    #[serde(default)]
    pub shadow_enabled: bool,
    #[serde(default = "default_shadow_color")]
    pub shadow_color: String,
    #[serde(default = "default_shadow_blur")]
    pub shadow_blur: f64,
    #[serde(default = "default_fit")]
    pub fit: String,
    #[serde(default = "default_animation")]
    pub animation_in: String,
    #[serde(default = "default_animation")]
    pub animation_out: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn default_stroke_color() -> String {
    "#38bdf8".into()
}
fn default_stroke_width() -> f64 {
    4.0
}
fn default_stroke_style() -> String {
    "solid".into()
}
fn default_fill_color() -> String {
    "#38bdf8".into()
}
fn default_corner_radius() -> f64 {
    8.0
}
fn default_arrow_head() -> String {
    "arrow".into()
}
fn default_none() -> String {
    "none".into()
}
fn default_white() -> String {
    "#ffffff".into()
}
fn default_shadow_color() -> String {
    "rgba(0, 0, 0, 0.5)".into()
}
fn default_shadow_blur() -> f64 {
    8.0
}
fn default_font_size() -> f64 {
    16.0
}
fn default_animation() -> String {
    "fade".into()
}
fn default_category() -> String {
    "title".into()
}
fn default_alignment() -> String {
    "left".into()
}
fn default_font_family() -> String {
    "sans".into()
}
fn default_title_font_size() -> f64 {
    32.0
}
fn default_font_weight() -> String {
    "700".into()
}
fn default_secondary_text_color() -> String {
    "#94a3b8".into()
}
fn default_accent_color() -> String {
    "#38bdf8".into()
}
fn default_backdrop_style() -> String {
    "glass".into()
}
fn default_backdrop_color() -> String {
    "#0f172a".into()
}
fn default_backdrop_opacity() -> f64 {
    0.8
}
fn default_backdrop_blur() -> f64 {
    16.0
}
fn default_backdrop_radius() -> f64 {
    12.0
}
fn default_padding_x() -> f64 {
    24.0
}
fn default_padding_y() -> f64 {
    16.0
}
fn default_opacity() -> f64 {
    1.0
}
fn default_fit() -> String {
    "contain".into()
}

#[cfg(test)]
fn calculate_animation_opacity(
    current_ms: u64,
    start_ms: u64,
    end_ms: u64,
    anim_in: &str,
    anim_out: &str,
) -> f64 {
    let transition_ms = 300.0;
    let mut opacity = 1.0;

    if anim_in != "none" && current_ms >= start_ms {
        let elapsed = (current_ms - start_ms) as f64;
        if elapsed < transition_ms {
            opacity = (elapsed / transition_ms).clamp(0.0, 1.0);
        }
    }

    if anim_out != "none" && current_ms < end_ms {
        let remaining = (end_ms - current_ms) as f64;
        if remaining < transition_ms {
            opacity = opacity.min((remaining / transition_ms).clamp(0.0, 1.0));
        }
    }

    opacity
}

#[cfg(test)]
fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
fn stroke_dasharray_attr(style: &str, _width: f64) -> &'static str {
    match style {
        "dashed" => " stroke-dasharray=\"8 6\"",
        "dotted" => " stroke-dasharray=\"3 4\"",
        _ => "",
    }
}

/// Build full SVG markup for an active vector annotation.
#[cfg(test)]
pub fn build_annotation_svg(
    ann: &RenderPlanAnnotation,
    canvas_w: u32,
    canvas_h: u32,
    current_ms: u64,
) -> String {
    let opacity = calculate_animation_opacity(
        current_ms,
        ann.start_ms,
        ann.end_ms,
        &ann.animation_in,
        &ann.animation_out,
    );

    let dash_attr = stroke_dasharray_attr(&ann.stroke_style, ann.stroke_width);
    let mut defs = String::new();
    let mut filter_attr = String::new();

    if ann.shadow_enabled {
        defs.push_str(&format!(
            r##"<filter id="ann-shadow-{id}" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="2" stdDeviation="{blur}" flood-color="{color}" flood-opacity="0.6"/>
            </filter>"##,
            id = ann.id,
            blur = ann.shadow_blur.clamp(1.0, 30.0) / 2.0,
            color = ann.shadow_color,
        ));
        filter_attr = format!(r##" filter="url(#ann-shadow-{})""##, ann.id);
    }

    // Arrow markers
    if ann.annotation_type == "arrow" || ann.annotation_type == "line" {
        defs.push_str(&format!(
            r##"<marker id="arrowhead-{id}" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="{color}" />
            </marker>"##,
            id = ann.id,
            color = ann.stroke_color,
        ));
    }

    let body = match ann.annotation_type.as_str() {
        "rectangle" => format!(
            r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" fill-opacity="{fill_op}" stroke="{stroke}" stroke-width="{sw}"{dash}{filter_attr}/>"##,
            x = ann.x,
            y = ann.y,
            w = ann.width.max(1.0),
            h = ann.height.max(1.0),
            fill = ann.fill_color,
            fill_op = ann.fill_opacity,
            stroke = ann.stroke_color,
            sw = ann.stroke_width,
            dash = dash_attr,
            filter_attr = filter_attr,
        ),
        "rounded-rect" => format!(
            r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" fill="{fill}" fill-opacity="{fill_op}" stroke="{stroke}" stroke-width="{sw}"{dash}{filter_attr}/>"##,
            x = ann.x,
            y = ann.y,
            w = ann.width.max(1.0),
            h = ann.height.max(1.0),
            r = ann.corner_radius.clamp(0.0, 100.0),
            fill = ann.fill_color,
            fill_op = ann.fill_opacity,
            stroke = ann.stroke_color,
            sw = ann.stroke_width,
            dash = dash_attr,
            filter_attr = filter_attr,
        ),
        "circle" => {
            let rx = ann.width / 2.0;
            let ry = ann.height / 2.0;
            let cx = ann.x + rx;
            let cy = ann.y + ry;
            format!(
                r##"<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{fill}" fill-opacity="{fill_op}" stroke="{stroke}" stroke-width="{sw}"{dash}{filter_attr}/>"##,
                cx = cx,
                cy = cy,
                rx = rx.max(1.0),
                ry = ry.max(1.0),
                fill = ann.fill_color,
                fill_op = ann.fill_opacity,
                stroke = ann.stroke_color,
                sw = ann.stroke_width,
                dash = dash_attr,
                filter_attr = filter_attr,
            )
        }
        "arrow" => {
            let end_x = ann.end_x.unwrap_or(ann.x + ann.width);
            let end_y = ann.end_y.unwrap_or(ann.y + ann.height);
            let marker = format!(r##"marker-end="url(#arrowhead-{})""##, ann.id);
            format!(
                r##"<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round"{dash} {marker}/>"##,
                x1 = ann.x,
                y1 = ann.y,
                x2 = end_x,
                y2 = end_y,
                stroke = ann.stroke_color,
                sw = ann.stroke_width,
                dash = dash_attr,
                marker = marker,
            )
        }
        "line" => {
            let end_x = ann.end_x.unwrap_or(ann.x + ann.width);
            let end_y = ann.end_y.unwrap_or(ann.y + ann.height);
            format!(
                r##"<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round"{dash}/>"##,
                x1 = ann.x,
                y1 = ann.y,
                x2 = end_x,
                y2 = end_y,
                stroke = ann.stroke_color,
                sw = ann.stroke_width,
                dash = dash_attr,
            )
        }
        "callout" => {
            let x = ann.x;
            let y = ann.y;
            let w = ann.width.max(60.0);
            let h = (ann.height - 18.0).max(30.0);
            let r = ann.corner_radius.clamp(2.0, 30.0);
            let bubble = format!(
                r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" fill="{fill}" fill-opacity="{fill_op}" stroke="{stroke}" stroke-width="{sw}"{dash}{filter_attr}/>"##,
                x = x,
                y = y,
                w = w,
                h = h,
                r = r,
                fill = ann.fill_color,
                fill_op = ann.fill_opacity.max(0.85),
                stroke = ann.stroke_color,
                sw = ann.stroke_width,
                dash = dash_attr,
                filter_attr = filter_attr,
            );
            let tail = format!(
                r##"<polygon points="{x1},{y1} {x2},{y2} {x3},{y3}" fill="{fill}" fill-opacity="{fill_op}"/>"##,
                x1 = x + 24.0,
                y1 = y + h - 1.0,
                x2 = x + 44.0,
                y2 = y + h - 1.0,
                x3 = x + 16.0,
                y3 = y + h + 18.0,
                fill = ann.fill_color,
                fill_op = ann.fill_opacity.max(0.85),
            );
            let text_elem = if let Some(text) = &ann.text {
                format!(
                    r##"<text x="{tx}" y="{ty}" fill="{tc}" font-family="sans-serif" font-size="{fs}" font-weight="600" text-anchor="middle" dominant-baseline="central">{txt}</text>"##,
                    tx = x + w / 2.0,
                    ty = y + h / 2.0,
                    tc = ann.text_color,
                    fs = ann.font_size.clamp(10.0, 72.0),
                    txt = escape_xml(text),
                )
            } else {
                String::new()
            };
            format!("{bubble}{tail}{text_elem}")
        }
        "spotlight" => {
            // Darkened mask covering entire canvas with clear rectangular aperture
            format!(
                r##"<path d="M0,0 L{cw},0 L{cw},{ch} L0,{ch} Z M{x},{y} L{x},{y2} L{x2},{y2} L{x2},{y} Z" fill="#000000" fill-opacity="0.6" fill-rule="evenodd"/>
                <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" ry="6" fill="none" stroke="{stroke}" stroke-width="{sw}"{dash}/>"##,
                cw = canvas_w,
                ch = canvas_h,
                x = ann.x,
                y = ann.y,
                x2 = ann.x + ann.width,
                y2 = ann.y + ann.height,
                w = ann.width,
                h = ann.height,
                stroke = ann.stroke_color,
                sw = ann.stroke_width,
                dash = dash_attr,
            )
        }
        "badge" => {
            let x = ann.x;
            let y = ann.y;
            let w = ann.width.max(50.0);
            let h = ann.height.max(24.0);
            let r = h / 2.0;
            let bg = format!(
                r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" fill="{fill}" fill-opacity="{fill_op}" stroke="{stroke}" stroke-width="{sw}"{filter_attr}/>"##,
                x = x,
                y = y,
                w = w,
                h = h,
                r = r,
                fill = ann.fill_color,
                fill_op = ann.fill_opacity.max(0.9),
                stroke = ann.stroke_color,
                sw = ann.stroke_width,
                filter_attr = filter_attr,
            );
            let text_elem = if let Some(text) = &ann.text {
                format!(
                    r##"<text x="{tx}" y="{ty}" fill="{tc}" font-family="sans-serif" font-size="{fs}" font-weight="700" text-anchor="middle" dominant-baseline="central">{txt}</text>"##,
                    tx = x + w / 2.0,
                    ty = y + h / 2.0,
                    tc = ann.text_color,
                    fs = ann.font_size.clamp(10.0, 48.0),
                    txt = escape_xml(text),
                )
            } else {
                String::new()
            };
            format!("{bg}{text_elem}")
        }
        _ => String::new(),
    };

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{cw}" height="{ch}" viewBox="0 0 {cw} {ch}">
            <defs>{defs}</defs>
            <g opacity="{opacity}">
                {body}
            </g>
        </svg>"##,
        cw = canvas_w,
        ch = canvas_h,
        defs = defs,
        opacity = opacity,
        body = body,
    )
}

/// Build full SVG markup for an active styled title / text preset.
#[cfg(test)]
pub fn build_text_preset_svg(
    text: &RenderPlanText,
    canvas_w: u32,
    canvas_h: u32,
    current_ms: u64,
) -> String {
    let opacity = calculate_animation_opacity(
        current_ms,
        text.start_ms,
        text.end_ms,
        &text.animation_in,
        &text.animation_out,
    );

    let font_family = match text.font_family.as_str() {
        "serif" => "serif",
        "mono" => "monospace",
        _ => "sans-serif",
    };

    let text_anchor = match text.alignment.as_str() {
        "center" => "middle",
        "right" => "end",
        _ => "start",
    };

    let text_x = match text.alignment.as_str() {
        "center" => text.x + text.width / 2.0,
        "right" => text.x + text.width - text.backdrop_padding_x,
        _ => text.x + text.backdrop_padding_x,
    };

    let mut backdrop_markup = String::new();
    if text.backdrop_style != "none" {
        let border_stroke = if text.backdrop_style == "glass" || text.backdrop_style == "outline" {
            format!(r##"stroke="{}" stroke-width="1.5""##, text.accent_color)
        } else {
            r##"stroke="rgba(255,255,255,0.1)" stroke-width="1""##.into()
        };

        let radius = if text.backdrop_style == "pill" {
            text.height / 2.0
        } else {
            text.backdrop_border_radius.clamp(0.0, 60.0)
        };

        backdrop_markup.push_str(&format!(
            r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" fill="{bg}" fill-opacity="{op}" {stroke}/>"##,
            x = text.x,
            y = text.y,
            w = text.width.max(20.0),
            h = text.height.max(20.0),
            r = radius,
            bg = text.backdrop_color,
            op = text.backdrop_opacity.clamp(0.1, 1.0),
            stroke = border_stroke,
        ));

        // Accent strip for accent-bar preset
        if text.backdrop_style == "accent-bar" {
            backdrop_markup.push_str(&format!(
                r##"<rect x="{x}" y="{y}" width="5" height="{h}" rx="2" ry="2" fill="{accent}"/>"##,
                x = text.x,
                y = text.y,
                h = text.height,
                accent = text.accent_color,
            ));
        }
    }

    let mut content_markup = String::new();
    let mut cursor_y = text.y + text.backdrop_padding_y + text.font_size * 0.8;

    // Optional tag / badge above title
    if let Some(tag) = &text.tag_text {
        if !tag.trim().is_empty() {
            let tag_fs = (text.font_size * 0.35).clamp(10.0, 18.0);
            content_markup.push_str(&format!(
                r##"<text x="{x}" y="{y}" fill="{accent}" font-family="{ff}" font-size="{fs}" font-weight="700" letter-spacing="1.5" text-anchor="{anchor}">{tag}</text>"##,
                x = text_x,
                y = cursor_y,
                accent = text.accent_color,
                ff = font_family,
                fs = tag_fs,
                anchor = text_anchor,
                tag = escape_xml(tag),
            ));
            cursor_y += tag_fs + 8.0;
        }
    }

    // Primary main title
    content_markup.push_str(&format!(
        r##"<text x="{x}" y="{y}" fill="{color}" font-family="{ff}" font-size="{fs}" font-weight="{weight}" text-anchor="{anchor}">{txt}</text>"##,
        x = text_x,
        y = cursor_y,
        color = text.text_color,
        ff = font_family,
        fs = text.font_size.clamp(12.0, 120.0),
        weight = text.font_weight,
        anchor = text_anchor,
        txt = escape_xml(&text.primary_text),
    ));
    cursor_y += text.font_size * 0.8 + 6.0;

    // Secondary subtitle
    if let Some(subtitle) = &text.secondary_text {
        if !subtitle.trim().is_empty() {
            let sub_fs = (text.font_size * 0.5).clamp(11.0, 48.0);
            content_markup.push_str(&format!(
                r##"<text x="{x}" y="{y}" fill="{color}" font-family="{ff}" font-size="{fs}" font-weight="500" text-anchor="{anchor}" opacity="0.85">{txt}</text>"##,
                x = text_x,
                y = cursor_y,
                color = text.secondary_text_color,
                ff = font_family,
                fs = sub_fs,
                anchor = text_anchor,
                txt = escape_xml(subtitle),
            ));
        }
    }

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{cw}" height="{ch}" viewBox="0 0 {cw} {ch}">
            <g opacity="{opacity}">
                {backdrop}
                {content}
            </g>
        </svg>"##,
        cw = canvas_w,
        ch = canvas_h,
        opacity = opacity,
        backdrop = backdrop_markup,
        content = content_markup,
    )
}

/// Render a generated SVG document onto a tiny-skia Pixmap buffer.
#[cfg(test)]
pub fn render_svg_to_pixmap(svg: &str, target: &mut Pixmap) -> Result<(), String> {
    let options = usvg::Options::default();
    let tree =
        usvg::Tree::from_str(svg, &options).map_err(|e| format!("parse overlay SVG: {e}"))?;
    resvg::render(&tree, Transform::identity(), &mut target.as_mut());
    Ok(())
}

/// Convert legacy separate arrays of annotations, text presets, and image overlays
/// into a unified `OverlayRenderPlan` for the canonical `overlay-engine`.
pub fn build_overlay_render_plan_from_legacy(
    canvas_w: u32,
    canvas_h: u32,
    annotations: &[RenderPlanAnnotation],
    texts: &[RenderPlanText],
    images: &[RenderPlanImage],
) -> overlay_engine::OverlayRenderPlan {
    let mut items = Vec::new();

    for (idx, img) in images.iter().filter(|i| i.enabled).enumerate() {
        let anim_in = match img.animation_in.as_str() {
            "none" => overlay_engine::OverlayAnimationType::None,
            "scale-up" => overlay_engine::OverlayAnimationType::ScaleUp,
            "scale-down" => overlay_engine::OverlayAnimationType::ScaleDown,
            "slide-up" => overlay_engine::OverlayAnimationType::SlideUp,
            "slide-down" => overlay_engine::OverlayAnimationType::SlideDown,
            _ => overlay_engine::OverlayAnimationType::Fade,
        };
        let anim_out = match img.animation_out.as_str() {
            "none" => overlay_engine::OverlayAnimationOutType::None,
            "scale-up" => overlay_engine::OverlayAnimationOutType::ScaleUp,
            "scale-down" => overlay_engine::OverlayAnimationOutType::ScaleDown,
            "slide-up" => overlay_engine::OverlayAnimationOutType::SlideUp,
            "slide-down" => overlay_engine::OverlayAnimationOutType::SlideDown,
            _ => overlay_engine::OverlayAnimationOutType::Fade,
        };
        items.push(overlay_engine::OverlayItem::Image {
            base: overlay_engine::OverlayItemBase {
                id: img.id.clone(),
                start_ms: img.start_ms,
                end_ms: img.end_ms,
                transform: overlay_engine::OverlayTransform {
                    x: img.x,
                    y: img.y,
                    width: img.width,
                    height: img.height,
                    rotation: 0.0,
                    anchor_x: 0.5,
                    anchor_y: 0.5,
                    z_index: idx as i32,
                    opacity: img.opacity,
                },
                animation: overlay_engine::OverlayAnimation {
                    in_type: anim_in,
                    out_type: anim_out,
                    in_duration_ms: 350,
                    out_duration_ms: 350,
                    easing: Default::default(),
                },
                enabled: true,
            },
            details: overlay_engine::ImageDetails {
                asset_id: img.asset_id.clone(),
                fit: img.fit.clone(),
                border_radius: img.border_radius,
                border_width: img.border_width,
                border_color: img.border_color.clone(),
                shadow_enabled: img.shadow_enabled,
                shadow_color: img.shadow_color.clone(),
                shadow_blur: img.shadow_blur,
            },
        });
    }

    for (idx, ann) in annotations.iter().filter(|a| a.enabled).enumerate() {
        let anim_in = match ann.animation_in.as_str() {
            "none" => overlay_engine::OverlayAnimationType::None,
            "scale-up" => overlay_engine::OverlayAnimationType::ScaleUp,
            "scale-down" => overlay_engine::OverlayAnimationType::ScaleDown,
            "slide-up" => overlay_engine::OverlayAnimationType::SlideUp,
            "slide-down" => overlay_engine::OverlayAnimationType::SlideDown,
            "draw" => overlay_engine::OverlayAnimationType::Draw,
            _ => overlay_engine::OverlayAnimationType::Fade,
        };
        let anim_out = match ann.animation_out.as_str() {
            "none" => overlay_engine::OverlayAnimationOutType::None,
            "scale-up" => overlay_engine::OverlayAnimationOutType::ScaleUp,
            "scale-down" => overlay_engine::OverlayAnimationOutType::ScaleDown,
            "slide-up" => overlay_engine::OverlayAnimationOutType::SlideUp,
            "slide-down" => overlay_engine::OverlayAnimationOutType::SlideDown,
            _ => overlay_engine::OverlayAnimationOutType::Fade,
        };
        items.push(overlay_engine::OverlayItem::Annotation {
            base: overlay_engine::OverlayItemBase {
                id: ann.id.clone(),
                start_ms: ann.start_ms,
                end_ms: ann.end_ms,
                transform: overlay_engine::OverlayTransform {
                    x: ann.x,
                    y: ann.y,
                    width: ann.width,
                    height: ann.height,
                    rotation: 0.0,
                    anchor_x: 0.5,
                    anchor_y: 0.5,
                    z_index: 1_000_000 + idx as i32,
                    opacity: 1.0,
                },
                animation: overlay_engine::OverlayAnimation {
                    in_type: anim_in,
                    out_type: anim_out,
                    in_duration_ms: 350,
                    out_duration_ms: 350,
                    easing: Default::default(),
                },
                enabled: true,
            },
            details: overlay_engine::AnnotationDetails {
                annotation_type: ann.annotation_type.clone(),
                end_x: ann.end_x,
                end_y: ann.end_y,
                stroke_color: ann.stroke_color.clone(),
                stroke_width: ann.stroke_width,
                stroke_style: ann.stroke_style.clone(),
                fill_color: ann.fill_color.clone(),
                fill_opacity: ann.fill_opacity,
                corner_radius: ann.corner_radius,
                arrow_end_head: ann.arrow_end_head.clone(),
                arrow_start_head: ann.arrow_start_head.clone(),
                shadow_enabled: ann.shadow_enabled,
                shadow_color: ann.shadow_color.clone(),
                shadow_blur: ann.shadow_blur,
                text: ann.text.clone(),
                text_color: ann.text_color.clone(),
                font_size: ann.font_size,
            },
        });
    }

    for (idx, txt) in texts.iter().filter(|t| t.enabled).enumerate() {
        let anim_in = match txt.animation_in.as_str() {
            "none" => overlay_engine::OverlayAnimationType::None,
            "scale-up" => overlay_engine::OverlayAnimationType::ScaleUp,
            "scale-down" => overlay_engine::OverlayAnimationType::ScaleDown,
            "slide-up" => overlay_engine::OverlayAnimationType::SlideUp,
            "slide-down" => overlay_engine::OverlayAnimationType::SlideDown,
            "typewriter" => overlay_engine::OverlayAnimationType::Typewriter,
            _ => overlay_engine::OverlayAnimationType::Fade,
        };
        let anim_out = match txt.animation_out.as_str() {
            "none" => overlay_engine::OverlayAnimationOutType::None,
            "scale-up" => overlay_engine::OverlayAnimationOutType::ScaleUp,
            "scale-down" => overlay_engine::OverlayAnimationOutType::ScaleDown,
            "slide-up" => overlay_engine::OverlayAnimationOutType::SlideUp,
            "slide-down" => overlay_engine::OverlayAnimationOutType::SlideDown,
            _ => overlay_engine::OverlayAnimationOutType::Fade,
        };
        items.push(overlay_engine::OverlayItem::Text {
            base: overlay_engine::OverlayItemBase {
                id: txt.id.clone(),
                start_ms: txt.start_ms,
                end_ms: txt.end_ms,
                transform: overlay_engine::OverlayTransform {
                    x: txt.x,
                    y: txt.y,
                    width: txt.width,
                    height: txt.height,
                    rotation: 0.0,
                    anchor_x: 0.5,
                    anchor_y: 0.5,
                    z_index: 2_000_000 + idx as i32,
                    opacity: 1.0,
                },
                animation: overlay_engine::OverlayAnimation {
                    in_type: anim_in,
                    out_type: anim_out,
                    in_duration_ms: 350,
                    out_duration_ms: 350,
                    easing: Default::default(),
                },
                enabled: true,
            },
            details: overlay_engine::TextDetails {
                preset_id: txt
                    .preset_id
                    .clone()
                    .unwrap_or_else(|| "title-modern".into()),
                category: txt.category.clone(),
                primary_text: txt.primary_text.clone(),
                secondary_text: txt.secondary_text.clone(),
                tag_text: txt.tag_text.clone(),
                alignment: txt.alignment.clone(),
                font_family: txt.font_family.clone(),
                font_size: txt.font_size,
                font_weight: txt.font_weight.clone(),
                text_color: txt.text_color.clone(),
                secondary_text_color: txt.secondary_text_color.clone(),
                accent_color: txt.accent_color.clone(),
                backdrop_style: txt.backdrop_style.clone(),
                backdrop_color: txt.backdrop_color.clone(),
                backdrop_opacity: txt.backdrop_opacity,
                backdrop_blur: txt.backdrop_blur,
                backdrop_border_radius: txt.backdrop_border_radius,
                backdrop_padding_x: txt.backdrop_padding_x,
                backdrop_padding_y: txt.backdrop_padding_y,
                shadow_enabled: txt.shadow_enabled,
                shadow_color: txt.shadow_color.clone(),
                shadow_blur: txt.shadow_blur,
            },
        });
    }

    overlay_engine::OverlayRenderPlan {
        version: 1,
        canvas: overlay_engine::OverlayCanvas {
            width: canvas_w,
            height: canvas_h,
        },
        items,
        assets: Vec::new(),
        fonts: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_annotation_svg_rectangle() {
        let ann = RenderPlanAnnotation {
            id: "rect-1".into(),
            start_ms: 1000,
            end_ms: 5000,
            annotation_type: "rounded-rect".into(),
            x: 100.0,
            y: 120.0,
            width: 300.0,
            height: 180.0,
            end_x: None,
            end_y: None,
            stroke_color: "#38bdf8".into(),
            stroke_width: 4.0,
            stroke_style: "solid".into(),
            fill_color: "#38bdf8".into(),
            fill_opacity: 0.2,
            corner_radius: 12.0,
            arrow_end_head: "none".into(),
            arrow_start_head: "none".into(),
            shadow_enabled: true,
            shadow_color: "#000000".into(),
            shadow_blur: 8.0,
            text: None,
            text_color: "#ffffff".into(),
            font_size: 16.0,
            animation_in: "fade".into(),
            animation_out: "fade".into(),
            enabled: true,
        };

        let svg = build_annotation_svg(&ann, 1920, 1080, 2000);
        assert!(svg.contains("<rect"));
        assert!(svg.contains("rx=\"12\""));
        assert!(svg.contains("#38bdf8"));

        let mut pixmap = Pixmap::new(1920, 1080).unwrap();
        let res = render_svg_to_pixmap(&svg, &mut pixmap);
        assert!(res.is_ok(), "render failed: {:?}", res);
    }

    #[test]
    fn test_build_annotation_shapes_all() {
        let shapes = [
            "rectangle",
            "circle",
            "arrow",
            "line",
            "callout",
            "spotlight",
            "badge",
        ];
        for shape in shapes {
            let ann = RenderPlanAnnotation {
                id: format!("{shape}-1"),
                start_ms: 0,
                end_ms: 5000,
                annotation_type: shape.into(),
                x: 150.0,
                y: 150.0,
                width: 200.0,
                height: 120.0,
                end_x: Some(350.0),
                end_y: Some(270.0),
                stroke_color: "#ef4444".into(),
                stroke_width: 3.0,
                stroke_style: "dashed".into(),
                fill_color: "#ef4444".into(),
                fill_opacity: 0.3,
                corner_radius: 8.0,
                arrow_end_head: "arrow".into(),
                arrow_start_head: "none".into(),
                shadow_enabled: false,
                shadow_color: "#000000".into(),
                shadow_blur: 4.0,
                text: Some("Callout Text".into()),
                text_color: "#ffffff".into(),
                font_size: 14.0,
                animation_in: "scale-up".into(),
                animation_out: "fade".into(),
                enabled: true,
            };

            let svg = build_annotation_svg(&ann, 1920, 1080, 1000);
            let mut pixmap = Pixmap::new(1920, 1080).unwrap();
            let res = render_svg_to_pixmap(&svg, &mut pixmap);
            assert!(res.is_ok(), "shape {} failed: {:?}", shape, res);
        }
    }

    #[test]
    fn test_build_text_preset_svg_glass() {
        let text = RenderPlanText {
            id: "text-1".into(),
            start_ms: 500,
            end_ms: 6000,
            preset_id: Some("glass-title".into()),
            category: "title".into(),
            primary_text: "Next Generation Audio".into(),
            secondary_text: Some("High fidelity screen recording".into()),
            tag_text: Some("PRO V1".into()),
            x: 80.0,
            y: 100.0,
            width: 500.0,
            height: 160.0,
            alignment: "left".into(),
            font_family: "sans".into(),
            font_size: 36.0,
            font_weight: "700".into(),
            text_color: "#ffffff".into(),
            secondary_text_color: "#94a3b8".into(),
            accent_color: "#38bdf8".into(),
            backdrop_style: "glass".into(),
            backdrop_color: "#0f172a".into(),
            backdrop_opacity: 0.8,
            backdrop_blur: 16.0,
            backdrop_border_radius: 16.0,
            backdrop_padding_x: 24.0,
            backdrop_padding_y: 20.0,
            shadow_enabled: true,
            shadow_color: "rgba(0,0,0,0.5)".into(),
            shadow_blur: 12.0,
            animation_in: "fade".into(),
            animation_out: "fade".into(),
            enabled: true,
        };

        let svg = build_text_preset_svg(&text, 1920, 1080, 1500);
        assert!(svg.contains("Next Generation Audio"));
        assert!(svg.contains("PRO V1"));

        let mut pixmap = Pixmap::new(1920, 1080).unwrap();
        let res = render_svg_to_pixmap(&svg, &mut pixmap);
        assert!(res.is_ok(), "render failed: {:?}", res);
    }

    #[test]
    fn test_serde_roundtrip_with_enabled_field() {
        let json_ann = serde_json::json!({
            "id": "ann-test",
            "startMs": 100,
            "endMs": 2000,
            "annotationType": "rectangle",
            "x": 10.0,
            "y": 20.0,
            "width": 100.0,
            "height": 50.0,
            "strokeColor": "#38bdf8",
            "strokeWidth": 2.0,
            "strokeStyle": "solid",
            "fillColor": "#38bdf8",
            "fillOpacity": 0.5,
            "cornerRadius": 4.0,
            "arrowEndHead": "none",
            "arrowStartHead": "none",
            "shadowEnabled": false,
            "shadowColor": "black",
            "shadowBlur": 0.0,
            "textColor": "#ffffff",
            "fontSize": 14.0,
            "animationIn": "fade",
            "animationOut": "fade",
            "enabled": true
        });
        let parsed_ann: RenderPlanAnnotation = serde_json::from_value(json_ann).unwrap();
        assert!(parsed_ann.enabled);

        let json_text = serde_json::json!({
            "id": "txt-test",
            "startMs": 100,
            "endMs": 2000,
            "presetId": "title-1",
            "category": "title",
            "primaryText": "Hello",
            "x": 10.0,
            "y": 20.0,
            "width": 100.0,
            "height": 50.0,
            "alignment": "left",
            "fontFamily": "sans",
            "fontSize": 24.0,
            "fontWeight": "700",
            "textColor": "#ffffff",
            "secondaryTextColor": "#94a3b8",
            "accentColor": "#38bdf8",
            "backdropStyle": "none",
            "backdropColor": "#000000",
            "backdropOpacity": 0.5,
            "backdropBlur": 0.0,
            "backdropBorderRadius": 0.0,
            "backdropPaddingX": 0.0,
            "backdropPaddingY": 0.0,
            "shadowEnabled": false,
            "shadowColor": "black",
            "shadowBlur": 0.0,
            "animationIn": "fade",
            "animationOut": "fade",
            "enabled": true
        });
        let parsed_text: RenderPlanText = serde_json::from_value(json_text).unwrap();
        assert!(parsed_text.enabled);

        let json_img = serde_json::json!({
            "id": "img-test",
            "assetId": "asset-img-1",
            "startMs": 100,
            "endMs": 2000,
            "x": 10.0,
            "y": 20.0,
            "width": 100.0,
            "height": 50.0,
            "opacity": 1.0,
            "borderRadius": 0.0,
            "borderWidth": 0.0,
            "borderColor": "#ffffff",
            "shadowEnabled": false,
            "shadowColor": "black",
            "shadowBlur": 0.0,
            "fit": "contain",
            "animationIn": "fade",
            "animationOut": "fade",
            "enabled": true
        });
        let parsed_img: RenderPlanImage = serde_json::from_value(json_img).unwrap();
        assert!(parsed_img.enabled);
    }
}
