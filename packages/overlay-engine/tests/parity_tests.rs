use std::path::PathBuf;
use overlay_engine::{
    AnnotationDetails, ImageDetails, OverlayAnimation, OverlayCanvas, OverlayEngine, OverlayItem,
    OverlayItemBase, OverlayRenderPlan, OverlayTransform, TextDetails,
};

#[test]
fn parity_test_renders_fixture_project_overlays() {
    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tooling/fixtures/editor-fixtures/project-overlays.json");
    let json_content = std::fs::read_to_string(&fixture_path)
        .unwrap_or_else(|_| panic!("failed to read fixture at {:?}", fixture_path));
    let project_json: serde_json::Value = serde_json::from_str(&json_content).expect("parse project JSON");

    let canvas_obj = &project_json["canvas"];
    let canvas_width = canvas_obj["width"].as_u64().unwrap_or(1920) as u32;
    let canvas_height = canvas_obj["height"].as_u64().unwrap_or(1080) as u32;

    // Load external-logo.svg
    let logo_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tooling/fixtures/editor-fixtures/external-logo.svg");
    let logo_svg_bytes = std::fs::read(&logo_path)
        .unwrap_or_else(|_| panic!("failed to read logo SVG at {:?}", logo_path));

    // Construct overlay items from the fixture clips
    let mut items = Vec::new();
    if let Some(tracks) = project_json["tracks"].as_array() {
        for track in tracks {
            if track["kind"].as_str() == Some("overlay") {
                if let Some(clips) = track["clips"].as_array() {
                    for clip in clips {
                        let id = clip["id"].as_str().unwrap().to_string();
                        let kind = clip["kind"].as_str().unwrap();
                        let start_ms = clip["startMs"].as_u64().unwrap();
                        let duration_ms = clip["durationMs"].as_u64().unwrap();
                        let end_ms = start_ms + duration_ms;
                        let x = clip["x"].as_f64().unwrap_or(0.0);
                        let y = clip["y"].as_f64().unwrap_or(0.0);
                        let width = clip["width"].as_f64().unwrap_or(200.0);
                        let height = clip["height"].as_f64().unwrap_or(100.0);
                        let rotation = clip["rotation"].as_f64().unwrap_or(0.0);
                        let z_index = clip["zIndex"].as_i64().unwrap_or(0) as i32;

                        let base = OverlayItemBase {
                            id: id.clone(),
                            start_ms,
                            end_ms,
                            transform: OverlayTransform {
                                x,
                                y,
                                width,
                                height,
                                rotation,
                                anchor_x: 0.5,
                                anchor_y: 0.5,
                                z_index,
                                opacity: clip["opacity"].as_f64().unwrap_or(1.0),
                            },
                            animation: OverlayAnimation::default(),
                            enabled: true,
                        };

                        match kind {
                            "annotation" => {
                                items.push(OverlayItem::Annotation {
                                    base,
                                    details: AnnotationDetails {
                                        annotation_type: clip["annotationType"].as_str().unwrap_or("rectangle").to_string(),
                                        end_x: clip["endX"].as_f64(),
                                        end_y: clip["endY"].as_f64(),
                                        stroke_color: clip["strokeColor"].as_str().unwrap_or("#38bdf8").to_string(),
                                        stroke_width: clip["strokeWidth"].as_f64().unwrap_or(4.0),
                                        stroke_style: clip["strokeStyle"].as_str().unwrap_or("solid").to_string(),
                                        fill_color: clip["fillColor"].as_str().unwrap_or("#38bdf8").to_string(),
                                        fill_opacity: clip["fillOpacity"].as_f64().unwrap_or(0.0),
                                        corner_radius: clip["cornerRadius"].as_f64().unwrap_or(0.0),
                                        arrow_end_head: clip["arrowEndHead"].as_str().unwrap_or("none").to_string(),
                                        arrow_start_head: clip["arrowStartHead"].as_str().unwrap_or("none").to_string(),
                                        shadow_enabled: clip["shadowEnabled"].as_bool().unwrap_or(false),
                                        shadow_color: clip["shadowColor"].as_str().unwrap_or("#000000").to_string(),
                                        shadow_blur: clip["shadowBlur"].as_f64().unwrap_or(0.0),
                                        text: clip["text"].as_str().map(String::from),
                                        text_color: clip["textColor"].as_str().unwrap_or("#ffffff").to_string(),
                                        font_size: clip["fontSize"].as_f64().unwrap_or(16.0),
                                    },
                                });
                            }
                            "text" => {
                                items.push(OverlayItem::Text {
                                    base,
                                    details: TextDetails {
                                        preset_id: clip["presetId"].as_str().unwrap_or("title-modern").to_string(),
                                        category: clip["category"].as_str().unwrap_or("title").to_string(),
                                        primary_text: clip["primaryText"].as_str().unwrap_or("").to_string(),
                                        secondary_text: clip["secondaryText"].as_str().map(String::from),
                                        tag_text: clip["tagText"].as_str().map(String::from),
                                        alignment: clip["alignment"].as_str().unwrap_or("left").to_string(),
                                        font_family: clip["fontFamily"].as_str().unwrap_or("sans").to_string(),
                                        font_size: clip["fontSize"].as_f64().unwrap_or(36.0),
                                        font_weight: clip["fontWeight"].as_str().unwrap_or("700").to_string(),
                                        text_color: clip["textColor"].as_str().unwrap_or("#ffffff").to_string(),
                                        secondary_text_color: clip["secondaryTextColor"].as_str().unwrap_or("#94a3b8").to_string(),
                                        accent_color: clip["accentColor"].as_str().unwrap_or("#38bdf8").to_string(),
                                        backdrop_style: clip["backdropStyle"].as_str().unwrap_or("glass").to_string(),
                                        backdrop_color: clip["backdropColor"].as_str().unwrap_or("#0f172a").to_string(),
                                        backdrop_opacity: clip["backdropOpacity"].as_f64().unwrap_or(0.8),
                                        backdrop_blur: clip["backdropBlur"].as_f64().unwrap_or(16.0),
                                        backdrop_border_radius: clip["backdropBorderRadius"].as_f64().unwrap_or(16.0),
                                        backdrop_padding_x: clip["backdropPaddingX"].as_f64().unwrap_or(24.0),
                                        backdrop_padding_y: clip["backdropPaddingY"].as_f64().unwrap_or(18.0),
                                        shadow_enabled: clip["shadowEnabled"].as_bool().unwrap_or(false),
                                        shadow_color: clip["shadowColor"].as_str().unwrap_or("rgba(0,0,0,0.5)").to_string(),
                                        shadow_blur: clip["shadowBlur"].as_f64().unwrap_or(8.0),
                                    },
                                });
                            }
                            "image" => {
                                items.push(OverlayItem::Image {
                                    base,
                                    details: ImageDetails {
                                        asset_id: clip["assetId"].as_str().unwrap_or("").to_string(),
                                        fit: clip["fit"].as_str().unwrap_or("contain").to_string(),
                                        border_radius: clip["borderRadius"].as_f64().unwrap_or(0.0),
                                        border_width: clip["borderWidth"].as_f64().unwrap_or(0.0),
                                        border_color: clip["borderColor"].as_str().unwrap_or("#ffffff").to_string(),
                                        shadow_enabled: clip["shadowEnabled"].as_bool().unwrap_or(false),
                                        shadow_color: clip["shadowColor"].as_str().unwrap_or("#000000").to_string(),
                                        shadow_blur: clip["shadowBlur"].as_f64().unwrap_or(0.0),
                                    },
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    assert_eq!(items.len(), 4, "all 4 overlay fixture clips should be parsed");

    let plan = OverlayRenderPlan {
        version: 1,
        canvas: OverlayCanvas {
            width: canvas_width,
            height: canvas_height,
        },
        items,
        assets: Vec::new(),
        fonts: Vec::new(),
    };

    let mut engine = OverlayEngine::from_render_plan(plan).expect("construct overlay engine from fixture");
    engine.register_image_svg("asset-external-logo", &logo_svg_bytes).expect("register SVG image asset");

    // Test timeline timestamps across the project
    let timestamps_to_verify = [0u64, 500, 1500, 2500, 3500, 4500, 5500, 9500];
    for &time_ms in &timestamps_to_verify {
        let display_list = engine.evaluate(time_ms);
        let mut pixmap = tiny_skia::Pixmap::new(canvas_width, canvas_height).expect("create canvas pixmap");
        engine.render_to_pixmap(time_ms, &mut pixmap).expect("render frame to pixmap");

        if !display_list.items.is_empty() {
            let non_transparent = pixmap.data().chunks_exact(4).any(|p| p[3] > 0);
            assert!(
                non_transparent,
                "frame at {time_ms}ms with {} items should render pixels",
                display_list.items.len()
            );
        }
    }
}
