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

    // v2 per-element sizes land under `elements.<role>.size` and apply
    // independently of each other and of the shared base size.
    let v2 = |elements: Value| -> Value {
        let mut p = plan("clean-text", "none", 4000);
        p["items"][0]["titleDesign"] = json!({
            "version": 2, "template": "clean", "elements": elements
        });
        title(&engine(&p), 2100)
    };
    assert_eq!(v2(json!({})), v2(json!({"primary": null})));
    for role in ["tag", "primary", "secondary"] {
        let scene = v2(json!({ role: { "size": 30.0 } }));
        assert_ne!(scene, v2(json!({})), "{role} size should change the scene");
    }
    // Out-of-range sizes invalidate the design: the clip falls back to
    // legacy rendering with no title scene.
    for bad in [1.0, 9999.0] {
        assert!(v2(json!({ "primary": { "size": bad } })).is_null(), "{bad}");
    }
}
#[cfg(feature = "native-render")]
#[test]
fn designed_title_text_is_visible_without_backdrop_in_export() {
    let mut p = plan("clean-text", "none", 4000);
    p["items"][0]["titleDesign"]["appearance"] = json!("transparent");
    p["items"][0]["backdropStyle"] = json!("none");
    let engine = engine(&p);
    let mut pixmap = tiny_skia::Pixmap::new(640, 360).unwrap();
    engine.render_to_pixmap(2100, &mut pixmap).unwrap();
    assert!(
        pixmap.data().as_chunks::<4>().0.iter().any(|p| p[3] > 0),
        "transparent clean-text should render visible text glyphs in export"
    );
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
                    pixmap.data().as_chunks::<4>().0.iter().any(|p| p[3] > 0),
                    "{template}"
                );
            }
            if time == 4100 {
                assert!(pixmap.data().iter().all(|p| *p == 0));
            }
        }
    }
}

#[cfg(feature = "native-render")]
const V2_TEMPLATES: [&str; 28] = [
    "clean",
    "hook",
    "hook-emphasis",
    "editorial",
    "chapter",
    "kinetic",
    "highlight",
    "banner",
    "lower-third-bar",
    "lower-third-glass",
    "lower-third-line",
    "source",
    "social-handle",
    "cta-follow",
    "cta-link",
    "cta",
    "step",
    "checklist",
    "shortcut",
    "terminal",
    "callout",
    "quote",
    "location",
    "stat",
    "stat-before-after",
    "countdown",
    "agenda",
    "outro",
];

#[cfg(feature = "native-render")]
fn v2_plan(template: &str, primary: &str, secondary: &str, tag: &str, design: Value) -> Value {
    let mut design = design;
    let object = design.as_object_mut().unwrap();
    object.insert("version".into(), json!(2));
    object.insert("template".into(), json!(template));
    json!({"version":1,"canvas":{"width":1280,"height":720},"items":[{
        "kind":"text","id":"title","startMs":0,"endMs":4000,
        "animation":{"inType":"none","outType":"none","inDurationMs":0,"outDurationMs":0},
        "transform":{"x":140,"y":60,"width":1000,"height":600},
        "presetId":"title","category":"title",
        "primaryText":primary,"secondaryText":secondary,"tagText":tag,
        "alignment":"left","fontFamily":"sans","fontSize":64,"fontWeight":700,
        "textColor":"#ffffff","secondaryTextColor":"#cbd5e1","accentColor":"#65e0b5",
        "backdropStyle":"none","backdropColor":"#111827","backdropOpacity":0.0,
        "backdropBlur":0,"backdropBorderRadius":0,"backdropPaddingX":0,"backdropPaddingY":0,
        "shadowEnabled":false,"shadowColor":"#000000","shadowBlur":0,
        "titleDesign":design
    }]})
}

#[cfg(feature = "native-render")]
fn alpha_bbox(pixmap: &tiny_skia::Pixmap) -> (u32, u32, u32, u32) {
    let (w, h) = (pixmap.width(), pixmap.height());
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
    for (i, px) in pixmap.data().chunks_exact(4).enumerate() {
        if px[3] > 8 {
            let (x, y) = ((i as u32) % w, (i as u32) / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    (x0, y0, x1, y1)
}

#[cfg(feature = "native-render")]
#[test]
fn v2_templates_render_inside_the_clip_box() {
    let (bx, by, bw, bh) = (140.0f64, 60.0, 1000.0, 600.0);
    for template in V2_TEMPLATES {
        let engine = engine(&v2_plan(
            template,
            "Build something better",
            "A thoughtful detail changes everything.",
            "FIELD NOTES",
            json!({}),
        ));
        let mut pixmap = tiny_skia::Pixmap::new(1280, 720).unwrap();
        engine.render_to_pixmap(2100, &mut pixmap).unwrap();
        let (x0, y0, x1, y1) = alpha_bbox(&pixmap);
        // A pixel or two of anti-aliased edge is allowed; nothing may spill
        // further outside the authored clip box.
        let tol = 2.0;
        assert!(
            x0 as f64 >= bx - tol
                && y0 as f64 >= by - tol
                && (x1 + 1) as f64 <= bx + bw + tol
                && (y1 + 1) as f64 <= by + bh + tol,
            "{template}: content {x0},{y0}-{x1},{y1} escaped box {bx},{by} {bw}x{bh}"
        );
    }
}

#[cfg(feature = "native-render")]
#[test]
fn v2_center_aligned_stacks_stay_centered() {
    for template in [
        "clean",
        "hook",
        "hook-emphasis",
        "kinetic",
        "highlight",
        "banner",
        "social-handle",
        "cta-follow",
        "cta-link",
        "cta",
        "stat",
        "stat-before-after",
        "countdown",
        "outro",
    ] {
        let mut plan = v2_plan(
            template,
            "Build something better",
            "A thoughtful detail changes everything.",
            "FIELD NOTES",
            json!({}),
        );
        plan["items"][0]["alignment"] = json!("center");
        let engine = engine(&plan);
        let mut pixmap = tiny_skia::Pixmap::new(1280, 720).unwrap();
        engine.render_to_pixmap(2100, &mut pixmap).unwrap();
        let (x0, _y0, x1, _y1) = alpha_bbox(&pixmap);
        let content_cx = (x0 + x1 + 1) as f64 / 2.0;
        let box_cx = 140.0 + 500.0;
        assert!(
            (content_cx - box_cx).abs() <= 1000.0 * 0.04,
            "{template}: content center {content_cx} vs box center {box_cx}"
        );
    }
}

#[cfg(feature = "native-render")]
#[test]
fn v2_metric_number_renders_at_metric_size() {
    let engine = engine(&v2_plan(
        "stat",
        "Less time on busywork",
        "Compared with our previous workflow",
        "THIS QUARTER",
        json!({"metric": {"from": 0, "to": 42, "decimals": 0, "prefix": "", "suffix": "%"}}),
    ));
    let scene = title(&engine, 2100);
    // The count-up number must be sized from the metric element (fontSize*1.7),
    // not from the primary ratio.
    let expected = 64.0 * 1.7;
    let digits: Vec<&Value> = scene["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| (e["scaleY"].as_f64().unwrap_or(0.0) - expected).abs() < expected * 0.05)
        .collect();
    assert!(!digits.is_empty(), "no glyph at metric size {expected}");
    // Glyph paths carry even-parameter commands, so odd-indexed numbers are the
    // y coordinates; digits must stand at least half their em tall.
    for digit in digits {
        let numbers: Vec<f64> = digit["path"]
            .as_str()
            .unwrap()
            .split(|c: char| c.is_alphabetic() || c == ' ')
            .filter_map(|s| s.parse::<f64>().ok())
            .collect();
        let ys: Vec<f64> = numbers.iter().skip(1).step_by(2).copied().collect();
        let extent =
            ys.iter().fold(f64::MIN, |a, b| a.max(*b)) - ys.iter().fold(f64::MAX, |a, b| a.min(*b));
        assert!(extent >= 0.5, "metric glyph too short: {extent}");
    }
}

#[cfg(feature = "native-render")]
#[test]
fn v2_checklist_items_share_their_checkbox_row() {
    let engine = engine(&v2_plan(
        "checklist",
        "Before you record",
        "Close notifications\nCheck your mic level\nFrame the window",
        "",
        json!({}),
    ));
    let scene = title(&engine, 2100);
    let clips: Vec<(f64, f64, f64, f64)> = scene["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| {
            let c = &e["clip"];
            Some((
                c["x"].as_f64()?,
                c["y"].as_f64()?,
                c["width"].as_f64()?,
                c["height"].as_f64()?,
            ))
        })
        .collect();
    // Each checkbox row emits two elements sharing one clip (square + check).
    let mut checkboxes: Vec<(f64, f64, f64, f64)> = Vec::new();
    for c in clips
        .iter()
        .filter(|(_, _, w, h)| (w - h).abs() < 2.0 && *w < 60.0)
    {
        if !checkboxes
            .iter()
            .any(|b| (b.0 - c.0).abs() < 0.5 && (b.1 - c.1).abs() < 0.5)
        {
            checkboxes.push(*c);
        }
    }
    let text_lines: Vec<_> = clips.iter().filter(|(_, _, w, h)| *w > *h * 4.0).collect();
    assert_eq!(checkboxes.len(), 3, "three items need three checkboxes");
    // Regression for the multi-line baseline bug: every checkbox row must be
    // vertically overlapped by the item text that belongs to it.
    for &(cx, cy, cw, ch) in &checkboxes {
        let cy = cy + ch / 2.0;
        assert!(
            text_lines
                .iter()
                .any(|&(tx, ty, _, th)| *tx > cx + cw && cy >= *ty && cy <= *ty + *th),
            "no item text on the checkbox row at y {cy}"
        );
    }
}

#[cfg(feature = "native-render")]
#[test]
fn v2_headlines_are_not_accent_colored() {
    // Regression: empty emphasis text used to select the whole headline, so
    // Clean/Hook rendered entirely in the accent color.
    for template in ["clean", "hook"] {
        let engine = engine(&v2_plan(
            template,
            "Build something better",
            "",
            "",
            json!({}),
        ));
        let scene = title(&engine, 2100);
        for e in scene["elements"].as_array().unwrap() {
            let tall = e["clip"]
                .as_object()
                .and_then(|c| c["height"].as_f64())
                .unwrap_or(0.0)
                >= 40.0;
            assert!(
                !(tall && e["fill"].as_str() == Some("#65e0b5")),
                "{template}: headline glyph painted in accent color"
            );
        }
    }
}

#[cfg(feature = "native-render")]
#[test]
fn v2_marker_emphasis_is_one_band_per_line() {
    let engine = engine(&v2_plan(
        "hook-emphasis",
        "Less noise. More focus.",
        "",
        "",
        json!({"emphasis": {"text": "More focus.", "style": "marker"}}),
    ));
    let scene = title(&engine, 2100);
    let bands: Vec<&Value> = scene["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| (e["opacity"].as_f64().unwrap_or(1.0) - 0.34).abs() < 0.01)
        .collect();
    // The selected span sits on one line, so there must be exactly one
    // contiguous band — no per-word gaps or double-darkened overlaps.
    assert_eq!(bands.len(), 1, "expected one marker band");
}

#[cfg(feature = "native-render")]
fn text_run_extents(scene: &Value, fill: &str) -> Vec<(f64, f64, f64)> {
    // One (clip_y, min_x, max_x) per rendered text line in the given color.
    // Run paths live in absolute line space, so an element's extent is its
    // translate plus the path's x coordinates (even-indexed numbers).
    let mut lines: Vec<(f64, f64, f64)> = Vec::new();
    for e in scene["elements"].as_array().unwrap() {
        if e["fill"].as_str() != Some(fill) {
            continue;
        }
        let Some(c) = e["clip"].as_object() else {
            continue;
        };
        if c["width"].as_f64().unwrap_or(0.0) < 100.0 {
            continue;
        }
        let cy = c["y"].as_f64().unwrap();
        let numbers: Vec<f64> = e["path"]
            .as_str()
            .unwrap_or("")
            .split(|ch: char| ch.is_alphabetic() || ch == ' ')
            .filter_map(|s| s.parse::<f64>().ok())
            .collect();
        if numbers.is_empty() {
            continue;
        }
        let tx = e["translateX"].as_f64().unwrap_or(0.0);
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for x in numbers.iter().step_by(2) {
            lo = lo.min(tx + x);
            hi = hi.max(tx + x);
        }
        match lines.iter_mut().find(|l| (l.0 - cy).abs() < 1.0) {
            Some(l) => {
                l.1 = l.1.min(lo);
                l.2 = l.2.max(hi);
            }
            None => lines.push((cy, lo, hi)),
        }
    }
    lines.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    lines
}

#[cfg(feature = "native-render")]
#[test]
fn v2_centered_primary_balances_its_wrap() {
    let text = "Stop doing it twice. Every single time.";
    let mut centered_plan = v2_plan("hook", text, "", "", json!({}));
    centered_plan["items"][0]["alignment"] = json!("center");
    let centered = title(&engine(&centered_plan), 2100);
    let left = title(&engine(&v2_plan("hook", text, "", "", json!({}))), 2100);
    let center_lines = text_run_extents(&centered, "#ffffff");
    let left_lines = text_run_extents(&left, "#ffffff");
    // Balancing only changes where lines break, never how many there are.
    assert_eq!(center_lines.len(), 2, "balance must keep the line count");
    assert_eq!(left_lines.len(), 2);
    let width = |l: &(f64, f64, f64)| l.2 - l.1;
    let cw: Vec<f64> = center_lines.iter().map(width).collect();
    let lw: Vec<f64> = left_lines.iter().map(width).collect();
    let (c_min, c_max) = (
        cw.iter().fold(f64::MAX, |a, b| a.min(*b)),
        cw.iter().fold(0.0f64, |a, b| a.max(*b)),
    );
    let l_max = lw.iter().fold(0.0f64, |a, b| a.max(*b));
    // The greedy wrap leaves a short last line; balanced lines even out.
    assert!(c_min >= c_max * 0.9, "centered lines unbalanced: {cw:?}");
    // ...and no balanced line is wider than the widest greedy line.
    assert!(
        c_max <= l_max + 1.0,
        "balanced line wider than greedy: {cw:?} vs {lw:?}"
    );
    // Left alignment keeps the greedy wrap: the first line stays the widest
    // and both lines still start on the same left edge.
    assert!(
        lw[0] > lw[1],
        "left-aligned first line should be widest: {lw:?}"
    );
    assert!(
        (left_lines[0].1 - left_lines[1].1).abs() < 2.0,
        "left-aligned lines must share the left edge: {left_lines:?}"
    );
    // For this text the greedy and balanced splits provably differ, so the
    // center run actually re-broke the lines instead of reusing the wrap.
    assert!(
        lw[0] > c_max + 5.0,
        "expected the greedy first line to exceed the balanced width: {lw:?} vs {cw:?}"
    );
}

#[cfg(feature = "native-render")]
#[test]
fn v2_banner_supporting_line_centers_on_the_band() {
    // Clip alignment stays "left": the band still centers its label, so the
    // supporting line must sit on the same centered axis.
    let engine = engine(&v2_plan(
        "banner",
        "New in this release",
        "Available today for everyone",
        "",
        json!({}),
    ));
    let scene = title(&engine, 2100);
    let band_cx = scene["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|e| {
            let c = e["clip"].as_object()?;
            (c["x"].as_f64()? == 0.0 && c["width"].as_f64()? == 1000.0)
                .then(|| c["width"].as_f64().unwrap() * 0.5)
        })
        .expect("banner band element");
    let lines = text_run_extents(&scene, "#cbd5e1");
    assert_eq!(lines.len(), 1, "one supporting line");
    let cx = (lines[0].1 + lines[0].2) * 0.5;
    assert!(
        (cx - band_cx).abs() <= 2.0,
        "supporting line center {cx} vs band center {band_cx}"
    );
}
