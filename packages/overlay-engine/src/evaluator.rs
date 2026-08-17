use crate::animation::animation_at;
use crate::scene::{
    DisplayAnnotation, DisplayImage, DisplayItem, DisplayList, DisplayText, OverlayItem,
    OverlayTransform, Scene,
};

pub(crate) fn evaluate(scene: &Scene, time_ms: u64) -> DisplayList {
    let items = scene
        .items()
        .iter()
        .filter_map(|item| display_item_at_time(item, time_ms))
        .collect();

    DisplayList { time_ms, items }
}

fn display_item_at_time(item: &OverlayItem, time_ms: u64) -> Option<DisplayItem> {
    let (start_ms, end_ms) = item.timing();
    if !item.enabled() || time_ms < start_ms || time_ms >= end_ms {
        return None;
    }

    let source_transform = *item.transform();
    let frame = animation_at(
        item.animation(),
        time_ms,
        start_ms,
        end_ms,
        source_transform.width,
        source_transform.height,
    );
    if frame.opacity <= 0.0 {
        return None;
    }

    let transform = apply_animation(
        source_transform,
        frame.scale,
        frame.translate_x,
        frame.translate_y,
        frame.opacity,
    );
    let animation_progress = frame.progress;

    Some(match item {
        OverlayItem::Annotation { details, .. } => DisplayItem::Annotation {
            item: DisplayAnnotation {
                id: item.id().to_string(),
                z_index: transform.z_index,
                transform,
                animation_progress,
                draw_progress: frame.draw_progress,
                annotation_type: details.annotation_type.clone(),
                end_x: details.end_x,
                end_y: details.end_y,
                stroke_color: details.stroke_color.clone(),
                stroke_width: details.stroke_width,
                stroke_style: details.stroke_style.clone(),
                fill_color: details.fill_color.clone(),
                fill_opacity: details.fill_opacity,
                corner_radius: details.corner_radius,
                arrow_end_head: details.arrow_end_head.clone(),
                arrow_start_head: details.arrow_start_head.clone(),
                shadow_enabled: details.shadow_enabled,
                shadow_color: details.shadow_color.clone(),
                shadow_blur: details.shadow_blur,
                text: details.text.clone(),
                text_color: details.text_color.clone(),
                font_size: details.font_size,
            },
        },
        OverlayItem::Text { details, .. } => DisplayItem::Text {
            item: DisplayText {
                id: item.id().to_string(),
                z_index: transform.z_index,
                transform,
                animation_progress,
                text_progress: frame.text_progress,
                preset_id: details.preset_id.clone(),
                category: details.category.clone(),
                primary_text: details.primary_text.clone(),
                secondary_text: details.secondary_text.clone(),
                tag_text: details.tag_text.clone(),
                alignment: details.alignment.clone(),
                font_family: details.font_family.clone(),
                font_size: details.font_size,
                font_weight: details.font_weight.clone(),
                text_color: details.text_color.clone(),
                secondary_text_color: details.secondary_text_color.clone(),
                accent_color: details.accent_color.clone(),
                backdrop_style: details.backdrop_style.clone(),
                backdrop_color: details.backdrop_color.clone(),
                backdrop_opacity: details.backdrop_opacity,
                backdrop_blur: details.backdrop_blur,
                backdrop_border_radius: details.backdrop_border_radius,
                backdrop_padding_x: details.backdrop_padding_x,
                backdrop_padding_y: details.backdrop_padding_y,
                shadow_enabled: details.shadow_enabled,
                shadow_color: details.shadow_color.clone(),
                shadow_blur: details.shadow_blur,
            },
        },
        OverlayItem::Image { details, .. } => DisplayItem::Image {
            item: DisplayImage {
                id: item.id().to_string(),
                z_index: transform.z_index,
                transform,
                animation_progress,
                asset_id: details.asset_id.clone(),
                fit: details.fit.clone(),
                border_radius: details.border_radius,
                border_width: details.border_width,
                border_color: details.border_color.clone(),
                shadow_enabled: details.shadow_enabled,
                shadow_color: details.shadow_color.clone(),
                shadow_blur: details.shadow_blur,
            },
        },
    })
}

fn apply_animation(
    source: OverlayTransform,
    scale: f64,
    translate_x: f64,
    translate_y: f64,
    opacity: f64,
) -> OverlayTransform {
    let origin_x = source.x + source.width * source.anchor_x;
    let origin_y = source.y + source.height * source.anchor_y;
    let width = source.width * scale;
    let height = source.height * scale;

    OverlayTransform {
        x: origin_x - width * source.anchor_x + translate_x,
        y: origin_y - height * source.anchor_y + translate_y,
        width,
        height,
        opacity: source.opacity * opacity,
        ..source
    }
}
