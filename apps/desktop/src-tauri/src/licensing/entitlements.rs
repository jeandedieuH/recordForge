//! Pro-feature detection and export entitlement enforcement.
//!
//! Rust is the authority here: the UI may hide or badge gated controls, but a
//! crafted render plan sent straight to `export_timeline` hits these checks
//! before any job is persisted or resumed. Detection inspects both the
//! legacy `annotations`/`texts` fields and the canonical
//! `overlay_render_plan` items so either representation is caught.

use crate::errors::{AppError, ErrorCategory, Result};
use crate::exports::{ExportOutputCap, ExportSettings, RenderPlan};
use overlay_engine::titles::TitleTemplate;

/// Feature keys shared with `PRO_FEATURES` in `packages/contracts`.
pub const PRO_FEATURE_KEYS: &[&str] = &[
    "high-res-export",
    "custom-aspect-ratio",
    "chapters",
    "premium-titles",
    "annotations",
    "instant-share",
    "studio-audio",
    "smart-cut",
    "brand-kit",
    "ai-captions",
    "teleprompter",
    "keystroke-overlay",
    "auto-reframe",
    "youtube-publish",
    "virtual-background",
];

const HIGH_RES_EXPORT: &str = "high-res-export";
const CUSTOM_ASPECT: &str = "custom-aspect-ratio";
const CHAPTERS: &str = "chapters";
const PREMIUM_TITLES: &str = "premium-titles";
const ANNOTATIONS: &str = "annotations";
const STUDIO_AUDIO: &str = "studio-audio";
const BRAND_KIT: &str = "brand-kit";
const KEYSTROKE_OVERLAY: &str = "keystroke-overlay";
const AUTO_REFRAME: &str = "auto-reframe";
const VIRTUAL_BACKGROUND: &str = "virtual-background";

/// Free canvases must measure 16:9 on their actual pixel dimensions,
/// allowing ±0.5% for rounding on odd source sizes.
const SIXTEEN_NINE: f64 = 16.0 / 9.0;
const ASPECT_TOLERANCE: f64 = 0.005;

/// Entitlement snapshot consulted by export validation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Entitlements {
    pub pro_enabled: bool,
}

impl Entitlements {
    /// Free exports are downscaled to fit 1920×1080; Pro exports render at
    /// the canvas size (`None` = uncapped).
    pub fn output_cap(&self) -> Option<ExportOutputCap> {
        if self.pro_enabled {
            None
        } else {
            Some(ExportOutputCap::FULL_HD)
        }
    }
}

/// Pro feature keys present in this plan/settings pair. Order is stable so
/// the UI can show the first-hit badge and tests compare directly.
pub fn required_pro_features(plan: &RenderPlan, settings: &ExportSettings) -> Vec<&'static str> {
    let mut features: Vec<&'static str> = Vec::new();
    let mut push = |feature: &'static str| {
        if !features.contains(&feature) {
            features.push(feature);
        }
    };

    // High-res is gated by the Ultra presets; a >1080p canvas alone does not
    // reject — Free output is downscaled by the output cap instead.
    if matches!(settings.preset.as_str(), "ultra-4k" | "ultra-4k-60") {
        push(HIGH_RES_EXPORT);
    }

    let non_standard_ratio = plan
        .canvas
        .as_ref()
        .is_some_and(|canvas| !is_sixteen_nine(canvas.width, canvas.height));
    if non_standard_ratio || matches!(settings.preset.as_str(), "vertical" | "square") {
        push(CUSTOM_ASPECT);
    }

    if !plan.chapters.is_empty() && (plan.chapter_mode != "none" || settings.chapter_mode != "none")
    {
        push(CHAPTERS);
    }

    if has_premium_titles(plan) {
        push(PREMIUM_TITLES);
    }

    if has_annotations(plan) {
        push(ANNOTATIONS);
    }

    // Studio Audio is an export settings flag, not timeline content — the
    // gate triggers only when mastering is actually engaged.
    if settings
        .audio_mastering
        .as_ref()
        .is_some_and(|mastering| mastering.denoise || mastering.loudness_target.is_some())
    {
        push(STUDIO_AUDIO);
    }

    if settings
        .brand_watermark
        .as_ref()
        .and_then(|watermark| watermark.active_logo())
        .is_some()
        || settings
            .brand_cards
            .as_ref()
            .and_then(|cards| cards.card_durations())
            .is_some()
    {
        push(BRAND_KIT);
    }

    if settings
        .keystroke_overlay
        .as_ref()
        .is_some_and(|overlay| overlay.enabled)
    {
        push(KEYSTROKE_OVERLAY);
    }

    // Auto-reframe is gated on the plan field — Free exports never carry one
    // because `freeExportSettings` forces `reframeMode: "fit"`.
    if plan.reframe.is_some() {
        push(AUTO_REFRAME);
    }

    // Only real work counts — an enabled flag with no camera overlay never
    // spawns a mask, so it never gates either.
    let camera_in_plan = plan
        .overlays
        .iter()
        .any(|overlay| overlay.visible && overlay.output_end_ms > overlay.output_start_ms);
    if camera_in_plan
        && settings
            .webcam_background
            .as_ref()
            .is_some_and(|bg| bg.is_active())
    {
        push(VIRTUAL_BACKGROUND);
    }

    features
}

/// Reject the export when Free and Pro-only content is present. The error
/// carries the feature keys so the UI can route to the upgrade dialog.
pub fn enforce_export_entitlements(
    plan: &RenderPlan,
    settings: &ExportSettings,
    entitlements: Entitlements,
) -> Result<()> {
    if entitlements.pro_enabled {
        return Ok(());
    }
    let required = required_pro_features(plan, settings);
    if required.is_empty() {
        return Ok(());
    }
    let mut details = serde_json::Map::new();
    details.insert(
        "features".to_string(),
        serde_json::Value::from(
            required
                .iter()
                .map(|feature| feature.to_string())
                .collect::<Vec<_>>(),
        ),
    );
    Err(AppError::new(
        ErrorCategory::Licensing,
        "pro_feature_required",
        "This export uses RecordForge Pro features",
    )
    .with_details(details))
}

fn is_sixteen_nine(width: u32, height: u32) -> bool {
    if height == 0 {
        return false;
    }
    ((width as f64 / height as f64) / SIXTEEN_NINE - 1.0).abs() <= ASPECT_TOLERANCE
}

/// Only `clean-text` is Free; a missing `titleDesign` means the clip came
/// from a pre-template preset, which is Pro per the product rules.
fn text_is_free(design: Option<&overlay_engine::titles::TitleDesign>) -> bool {
    design.is_some_and(|design| design.template == TitleTemplate::CleanText)
}

fn overlay_item_enabled(item: &serde_json::Value) -> bool {
    item.get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

fn overlay_items(plan: &RenderPlan) -> impl Iterator<Item = &serde_json::Value> {
    plan.overlay_render_plan
        .as_ref()
        .and_then(|overlay| overlay.get("items"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
}

fn has_annotations(plan: &RenderPlan) -> bool {
    if plan.annotations.iter().any(|item| item.enabled) {
        return true;
    }
    overlay_items(plan).any(|item| {
        item.get("kind").and_then(serde_json::Value::as_str) == Some("annotation")
            && overlay_item_enabled(item)
    })
}

fn has_premium_titles(plan: &RenderPlan) -> bool {
    if plan
        .texts
        .iter()
        .any(|text| text.enabled && !text_is_free(text.title_design.as_ref()))
    {
        return true;
    }
    overlay_items(plan).any(|item| {
        if item.get("kind").and_then(serde_json::Value::as_str) != Some("text")
            || !overlay_item_enabled(item)
        {
            return false;
        }
        item.get("titleDesign")
            .and_then(|design| design.get("template"))
            .and_then(serde_json::Value::as_str)
            != Some("clean-text")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exports::{
        ExportSettings, RenderCanvas, RenderPlan, RenderPlanAnnotation, RenderPlanText,
        RenderSegment,
    };
    use overlay_engine::titles::TitleDesign;

    fn segment() -> RenderSegment {
        serde_json::from_value(serde_json::json!({
            "assetId": "screen",
            "speed": 1.0,
            "sourceInMs": 0,
            "sourceOutMs": 1000,
            "outputStartMs": 0,
            "outputEndMs": 1000,
        }))
        .expect("segment")
    }

    fn plan_with_canvas(width: u32, height: u32) -> RenderPlan {
        RenderPlan {
            reframe: None,
            project_id: "p".to_string(),
            duration_ms: 1000,
            segments: vec![segment()],
            gaps: vec![],
            overlays: vec![],
            captions: vec![],
            caption_mode: "burn-in".to_string(),
            chapters: vec![],
            chapter_mode: "none".to_string(),
            masks: vec![],
            zoom_segments: vec![],
            cursor_effects: vec![],
            overlay_render_plan: None,
            canvas: Some(RenderCanvas {
                width,
                height,
                fps: 30,
                ..RenderCanvas::default()
            }),
            audio: None,
            audio_tracks: None,
            annotations: vec![],
            texts: vec![],
            images: vec![],
            keystrokes: Vec::new(),
        }
    }

    fn mp4_settings(preset: &str) -> ExportSettings {
        ExportSettings {
            reframe_mode: None,
            webcam_background: None,
            preset: preset.to_string(),
            codec: "h264".to_string(),
            encoder: "auto".to_string(),
            container: "mp4".to_string(),
            caption_mode: "burn-in".to_string(),
            chapter_mode: "none".to_string(),
            range: None,
            audio_mastering: None,
            brand_watermark: None,
            brand_cards: None,
            keystroke_overlay: None,
        }
    }

    fn annotation() -> RenderPlanAnnotation {
        serde_json::from_value(serde_json::json!({
            "id": "a1",
            "startMs": 0,
            "endMs": 500,
            "annotationType": "rectangle",
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0,
        }))
        .expect("annotation")
    }

    fn text_with_template(template: &str) -> RenderPlanText {
        serde_json::from_value(serde_json::json!({
            "id": "t1",
            "startMs": 0,
            "endMs": 500,
            "primaryText": "Hello",
            "x": 0.0, "y": 0.0, "width": 200.0, "height": 60.0,
            "titleDesign": { "template": template },
        }))
        .expect("text")
    }

    fn legacy_text() -> RenderPlanText {
        serde_json::from_value(serde_json::json!({
            "id": "t2",
            "startMs": 0,
            "endMs": 500,
            "primaryText": "Hello",
            "presetId": "lower-third-bold",
            "x": 0.0, "y": 0.0, "width": 200.0, "height": 60.0,
        }))
        .expect("text")
    }

    #[test]
    fn free_16x9_1080p_plan_is_clean() {
        let plan = plan_with_canvas(1920, 1080);
        assert!(required_pro_features(&plan, &mp4_settings("high-quality")).is_empty());
    }

    #[test]
    fn ultra_presets_require_high_res() {
        let plan = plan_with_canvas(3840, 2160);
        let features = required_pro_features(&plan, &mp4_settings("ultra-4k"));
        assert_eq!(features, vec![HIGH_RES_EXPORT]);
    }

    #[test]
    fn four_k_canvas_without_ultra_preset_is_not_rejected() {
        // Fallback path: the output cap downscales instead of blocking.
        let plan = plan_with_canvas(3840, 2160);
        assert!(required_pro_features(&plan, &mp4_settings("high-quality")).is_empty());
    }

    #[test]
    fn non_16x9_canvas_requires_custom_aspect() {
        let plan = plan_with_canvas(1080, 1920);
        let features = required_pro_features(&plan, &mp4_settings("vertical"));
        assert_eq!(features, vec![CUSTOM_ASPECT]);
    }

    #[test]
    fn square_canvas_requires_custom_aspect() {
        let plan = plan_with_canvas(1080, 1080);
        let features = required_pro_features(&plan, &mp4_settings("square"));
        assert_eq!(features, vec![CUSTOM_ASPECT]);
    }

    #[test]
    fn near_16x9_canvas_within_tolerance_is_free() {
        // 1918×1080 is 0.11% off 16:9 — inside the ±0.5% rounding allowance.
        let plan = plan_with_canvas(1918, 1080);
        assert!(required_pro_features(&plan, &mp4_settings("balanced")).is_empty());
    }

    #[test]
    fn chapters_require_chapters_feature() {
        let mut plan = plan_with_canvas(1920, 1080);
        plan.chapter_mode = "embed".to_string();
        plan.chapters.push(
            serde_json::from_value(serde_json::json!({
                "id": "c1", "title": "Intro", "startMs": 0, "endMs": 500,
            }))
            .expect("chapter"),
        );
        let mut settings = mp4_settings("balanced");
        settings.chapter_mode = "embed".to_string();
        assert_eq!(required_pro_features(&plan, &settings), vec![CHAPTERS]);

        // Chapter mode none → markers exist but produce no chapter output.
        plan.chapter_mode = "none".to_string();
        settings.chapter_mode = "none".to_string();
        assert!(required_pro_features(&plan, &settings).is_empty());
    }

    #[test]
    fn legacy_annotations_flag_pro() {
        let mut plan = plan_with_canvas(1920, 1080);
        plan.annotations.push(annotation());
        assert_eq!(
            required_pro_features(&plan, &mp4_settings("balanced")),
            vec![ANNOTATIONS]
        );
    }

    #[test]
    fn overlay_plan_annotations_flag_pro() {
        let mut plan = plan_with_canvas(1920, 1080);
        plan.overlay_render_plan = Some(serde_json::json!({
            "version": 1,
            "items": [{
                "id": "a1", "kind": "annotation", "enabled": true,
                "startMs": 0, "endMs": 500, "annotationType": "arrow",
            }],
        }));
        assert_eq!(
            required_pro_features(&plan, &mp4_settings("balanced")),
            vec![ANNOTATIONS]
        );
    }

    #[test]
    fn disabled_annotations_do_not_flag() {
        let mut item = annotation();
        item.enabled = false;
        let mut plan = plan_with_canvas(1920, 1080);
        plan.annotations.push(item);
        assert!(required_pro_features(&plan, &mp4_settings("balanced")).is_empty());
    }

    #[test]
    fn clean_text_template_is_free_others_are_pro() {
        let mut plan = plan_with_canvas(1920, 1080);
        plan.texts.push(text_with_template("clean-text"));
        assert!(required_pro_features(&plan, &mp4_settings("balanced")).is_empty());

        plan.texts.push(text_with_template("emphasis"));
        assert_eq!(
            required_pro_features(&plan, &mp4_settings("balanced")),
            vec![PREMIUM_TITLES]
        );
    }

    #[test]
    fn legacy_preset_text_is_pro() {
        let mut plan = plan_with_canvas(1920, 1080);
        plan.texts.push(legacy_text());
        assert_eq!(
            required_pro_features(&plan, &mp4_settings("balanced")),
            vec![PREMIUM_TITLES]
        );
    }

    #[test]
    fn overlay_text_uses_template_field() {
        let mut plan = plan_with_canvas(1920, 1080);
        plan.overlay_render_plan = Some(serde_json::json!({
            "version": 1,
            "items": [{
                "id": "t1", "kind": "text", "enabled": true,
                "startMs": 0, "endMs": 500,
                "titleDesign": { "template": "kinetic-hook" },
            }],
        }));
        assert_eq!(
            required_pro_features(&plan, &mp4_settings("balanced")),
            vec![PREMIUM_TITLES]
        );
    }

    #[test]
    fn enforce_blocks_free_and_allows_pro() {
        let mut plan = plan_with_canvas(1080, 1920);
        plan.annotations.push(annotation());
        let settings = mp4_settings("balanced");

        let error =
            enforce_export_entitlements(&plan, &settings, Entitlements { pro_enabled: false })
                .expect_err("free tier must reject pro exports");
        assert_eq!(error.code, "pro_feature_required");
        let features = error
            .details
            .as_ref()
            .and_then(|details| details.get("features"))
            .and_then(serde_json::Value::as_array)
            .expect("features detail");
        assert!(features.contains(&serde_json::Value::from(CUSTOM_ASPECT)));
        assert!(features.contains(&serde_json::Value::from(ANNOTATIONS)));

        assert!(
            enforce_export_entitlements(&plan, &settings, Entitlements { pro_enabled: true })
                .is_ok()
        );
    }

    #[test]
    fn studio_audio_mastering_requires_pro() {
        let plan = plan_with_canvas(1920, 1080);
        let mut settings = mp4_settings("balanced");
        // Denoise OR a loudness target is enough to trip the gate.
        settings.audio_mastering = Some(crate::exports::AudioMastering {
            denoise: true,
            loudness_target: None,
        });
        assert_eq!(required_pro_features(&plan, &settings), vec![STUDIO_AUDIO]);

        settings.audio_mastering = Some(crate::exports::AudioMastering {
            denoise: false,
            loudness_target: Some(-16.0),
        });
        assert_eq!(required_pro_features(&plan, &settings), vec![STUDIO_AUDIO]);

        // Defaults stay Free.
        settings.audio_mastering = Some(crate::exports::AudioMastering {
            denoise: false,
            loudness_target: None,
        });
        assert!(required_pro_features(&plan, &settings).is_empty());
    }

    #[test]
    fn output_cap_only_applies_to_free() {
        assert_eq!(
            Entitlements { pro_enabled: false }.output_cap(),
            Some(ExportOutputCap::FULL_HD)
        );
        assert_eq!(Entitlements { pro_enabled: true }.output_cap(), None);
    }

    #[test]
    fn title_design_deserializes_clean_text_default() {
        // Default TitleDesign (template CleanText) must count as free.
        let design = TitleDesign::default();
        assert!(text_is_free(Some(&design)));
    }
}
