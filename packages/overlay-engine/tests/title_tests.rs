#![recursion_limit = "256"]
use overlay_engine::{DisplayItem, OverlayEngine};
use serde_json::{json, Value};

const TEMPLATES: [&str; 14] = [
    "clean-text",
    "emphasis",
    "editorial-opener",
    "kinetic-hook",
    "chapter-marker",
    "speaker-id",
    "source-credit",
    "step-guide",
    "shortcut",
    "command-line",
    "note",
    "pull-quote",
    "metric",
    "call-to-action",
];

fn plan(template: &str, motion: &str, duration: u64) -> Value {
    json!({"version":1,"canvas":{"width":640,"height":360},"items":[{
        "kind":"text","id":"title","startMs":100,"endMs":100+duration,
        "animation":{"inType":"none","outType":"none","inDurationMs":0,"outDurationMs":0},
        "transform":{"x":30,"y":30,"width":580,"height":280},
        "presetId":"title","category":"title","primaryText":"Build something better",
        "secondaryText":"A thoughtful detail changes everything.","tagText":"FIELD NOTES",
        "alignment":"left","fontFamily":"sans","fontSize":52,"fontWeight":700,
        "textColor":"#ffffff","secondaryTextColor":"#cbd5e1","accentColor":"#65e0b5",
        "backdropStyle":"solid","backdropColor":"#111827","backdropOpacity":0.95,
        "backdropBlur":0,"backdropBorderRadius":16,"backdropPaddingX":24,"backdropPaddingY":24,
        "shadowEnabled":false,"shadowColor":"#000000","shadowBlur":0,
        "titleDesign":{"version":1,"template":template,"motion":motion,"emphasisText":"something",
            "metric":{"from":-12.5,"to":98.5,"decimals":1,"prefix":"$","suffix":"M"}}
    }]})
}
fn engine(plan: &Value) -> OverlayEngine {
    OverlayEngine::from_render_plan_json(&plan.to_string()).unwrap()
}
fn title(engine: &OverlayEngine, time: u64) -> Value {
    serde_json::to_value(engine.evaluate(time)).unwrap()["items"][0]["titleScene"].clone()
}
#[test]
fn all_fourteen_titles_compile_paths_and_seek_deterministically() {
    let mut layouts = std::collections::HashSet::new();
    for template in TEMPLATES {
        let engine = engine(&plan(template, "designed", 4000));
        let held = title(&engine, 2100);
        assert!(held["elements"].as_array().unwrap().len() > 3, "{template}");
        assert!(held["elements"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["path"]
                .as_str()
                .is_some_and(|p| !p.is_empty() && !p.contains("<text"))));
        layouts.insert(held.to_string());
        let early = title(&engine, 220);
        assert_eq!(title(&engine, 2100), held);
        assert_eq!(title(&engine, 220), early);
        assert_eq!(title(&engine, 2700), held, "no idle motion: {template}");
        assert!(engine.evaluate(99).items.is_empty());
        assert!(engine.evaluate(4100).items.is_empty());
        assert_ne!(title(&engine, 100), held, "entrance: {template}");
        assert_ne!(title(&engine, 4099), held, "exit: {template}");
    }
    assert_eq!(layouts.len(), 14);
}
#[test]
fn short_and_disabled_motion_are_finite_and_have_a_hold() {
    for duration in [1, 20, 100, 400, 4000] {
        for template in TEMPLATES {
            let still = engine(&plan(template, "none", duration));
            assert_eq!(title(&still, 100), title(&still, 100 + duration - 1));
            let animated = engine(&plan(template, "designed", duration));
            let middle = title(&animated, 100 + duration / 2);
            assert!(middle["elements"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["opacity"].as_f64().unwrap().is_finite()));
        }
    }
}
#[test]
fn legacy_and_serialization_are_backward_compatible() {
    let mut p = plan("clean-text", "none", 4000);
    p["items"][0].as_object_mut().unwrap().remove("titleDesign");
    let engine = engine(&p);
    let display = engine.evaluate(2000);
    assert!(matches!(&display.items[0], DisplayItem::Text { .. }));
    let value = serde_json::to_value(&display).unwrap();
    assert!(value["items"][0].get("titleScene").is_none());
    assert_eq!(
        serde_json::from_value::<overlay_engine::DisplayList>(value).unwrap(),
        display
    );
}
#[test]
fn unicode_long_lines_and_explicit_newlines_are_supported() {
    for text in [
        "Café e\u{301}\nПривет мир",
        "東京の新しい物語",
        "مرحبا بالعالم",
        "👩‍💻 + ⌘ + Shift",
        "averylongunbrokenstring",
    ] {
        for template in ["clean-text", "command-line", "shortcut", "emphasis"] {
            let mut p = plan(template, "designed", 2000);
            p["items"][0]["primaryText"] = json!(text.repeat(8));
            let engine = engine(&p);
            assert!(title(&engine, 1100)["elements"].as_array().unwrap().len() > 3);
            assert_eq!(title(&engine, 250), title(&engine, 250));
        }
    }
}
#[test]
fn per_element_font_size_overrides_apply_independently() {
    let default = title(&engine(&plan("clean-text", "none", 4000)), 2100);
    // An empty overrides object behaves exactly like no overrides.
    let mut p = plan("clean-text", "none", 4000);
    p["items"][0]["titleDesign"]["fontSizes"] = json!({});
    assert_eq!(title(&engine(&p), 2100), default);
    // Each element sizes on its own instead of following the shared base.
    for (key, value) in [("primary", 30.0), ("secondary", 42.0), ("tag", 46.0)] {
        let mut p = plan("clean-text", "none", 4000);
        p["items"][0]["titleDesign"]["fontSizes"] = json!({ key: value });
        let scene = title(&engine(&p), 2100);
        assert_ne!(scene, default, "{key} override should change the scene");
        assert!(!scene["elements"].as_array().unwrap().is_empty());
    }
    // The metric count-up number has its own override on the metric template.
    let metric_default = title(&engine(&plan("metric", "none", 4000)), 2100);
    let mut p = plan("metric", "none", 4000);
    p["items"][0]["titleDesign"]["fontSizes"] = json!({ "metric": 40.0 });
    assert_ne!(title(&engine(&p), 2100), metric_default);
    // Out-of-range overrides invalidate the design and fall back to legacy rendering.
    for bad in [3.0, 601.0] {
        let mut p = plan("clean-text", "none", 4000);
        p["items"][0]["titleDesign"]["fontSizes"] = json!({ "primary": bad });
        assert!(title(&engine(&p), 2100).is_null(), "{bad}");
    }
}
#[cfg(feature = "native-render")]
#[test]
fn every_title_rasterizes_without_system_text_layout() {
    for template in TEMPLATES {
        let engine = engine(&plan(template, "designed", 4000));
        for time in [100, 220, 2100, 4099, 4100] {
            let mut pixmap = tiny_skia::Pixmap::new(640, 360).unwrap();
            engine.render_to_pixmap(time, &mut pixmap).unwrap();
            if time == 2100 {
                assert!(
                    pixmap.data().chunks_exact(4).any(|p| p[3] > 0),
                    "{template}"
                );
            }
            if time == 4100 {
                assert!(pixmap.data().iter().all(|p| *p == 0));
            }
        }
    }
}
