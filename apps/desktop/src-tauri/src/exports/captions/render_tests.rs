//! Render-level verification of the px-resolved ASS writer: each fixture
//! case is burned onto a flat mid-gray frame with the REAL bundled ffmpeg /
//! libass and the raster is measured back against the layout numbers.
//! Skipped with a clear message when no ffmpeg with a `subtitles` filter is
//! available (e.g. CI without the sidecar binaries).

use super::layout_plan::fixture;
use super::measure::measure_line_px;
use super::{escape_filter_path, write_burn_in_assets};
use crate::exports::RenderPlanCaption;
use std::path::{Path, PathBuf};
use std::process::Command;

const FPS: u32 = 30;

/// A working ffmpeg that actually carries the `subtitles` filter. Dev boxes
/// can expose chocolatey shimgen stubs in `target/debug/` that spawn and then
/// exit 127, so `-filters` output is checked, not just spawnability.
fn ffmpeg_with_subtitles() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resolved) = crate::media::resolve_executable("ffmpeg") {
        candidates.push(resolved);
    }
    for name in ["ffmpeg", "ffmpeg.exe"] {
        candidates.push(PathBuf::from(name));
    }
    candidates.push(PathBuf::from(
        "C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffmpeg.exe",
    ));
    for path in candidates {
        let output = Command::new(&path)
            .args(["-hide_banner", "-filters"])
            .output();
        if let Ok(output) = output {
            if output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains("subtitles")
            {
                return Some(path);
            }
        }
    }
    None
}

fn frame_index(time_ms: u64) -> u32 {
    ((time_ms as f64 / 1_000.0) * FPS as f64).round() as u32
}

/// Renders `frames` (absolute ms) of a flat mid-gray video with the script
/// burned in; returns one decoded image per requested time.
fn render_frames(
    ffmpeg: &Path,
    dir: &Path,
    caption: &RenderPlanCaption,
    width: u32,
    height: u32,
    times_ms: &[u64],
) -> Vec<image::RgbaImage> {
    write_burn_in_assets(dir, std::slice::from_ref(caption), width, height)
        .expect("write caption assets");
    let script = dir.join("captions.ass");
    let duration_s = (times_ms.iter().max().copied().unwrap_or(0) as f64 / 1_000.0) + 1.0;
    let filter = format!(
        "subtitles=filename='{}':fontsdir='{}'",
        escape_filter_path(&script),
        escape_filter_path(dir),
    );
    let mut images = Vec::new();
    for (index, &time_ms) in times_ms.iter().enumerate() {
        let out = dir.join(format!("frame-{index}.png"));
        let status = Command::new(ffmpeg)
            .args([
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=0x808080:s={width}x{height}:r={FPS}:d={duration_s}"),
                "-vf",
                &format!("{filter},select='eq(n,{})'", frame_index(time_ms)),
                "-frames:v",
                "1",
                out.to_str().expect("ascii path"),
            ])
            .output()
            .expect("spawn ffmpeg");
        assert!(
            status.status.success() && out.exists(),
            "ffmpeg caption render failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );
        images.push(image::open(&out).expect("decode rendered frame").to_rgba8());
    }
    images
}

fn hex_rgb(hex: &str) -> (u8, u8, u8) {
    let body = &hex[1..];
    (
        u8::from_str_radix(&body[0..2], 16).unwrap_or(0),
        u8::from_str_radix(&body[2..4], 16).unwrap_or(0),
        u8::from_str_radix(&body[4..6], 16).unwrap_or(0),
    )
}

fn near(pixel: &image::Rgba<u8>, rgb: (u8, u8, u8), tolerance: u8) -> bool {
    pixel[0].abs_diff(rgb.0) <= tolerance
        && pixel[1].abs_diff(rgb.1) <= tolerance
        && pixel[2].abs_diff(rgb.2) <= tolerance
        && pixel[3] > 250
}

struct Bbox {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    count: usize,
}

impl Bbox {
    fn new() -> Self {
        Self {
            min_x: f64::MAX,
            max_x: f64::MIN,
            min_y: f64::MAX,
            max_y: f64::MIN,
            count: 0,
        }
    }
    fn add(&mut self, x: u32, y: u32) {
        self.count += 1;
        self.min_x = self.min_x.min(x as f64);
        self.max_x = self.max_x.max(x as f64);
        self.min_y = self.min_y.min(y as f64);
        self.max_y = self.max_y.max(y as f64);
    }
    fn width(&self) -> f64 {
        (self.max_x - self.min_x).max(0.0)
    }
    fn height(&self) -> f64 {
        (self.max_y - self.min_y).max(0.0)
    }
    fn center_x(&self) -> f64 {
        (self.min_x + self.max_x) / 2.0
    }
}

fn bbox_where(img: &image::RgbaImage, pred: impl Fn(&image::Rgba<u8>) -> bool) -> Option<Bbox> {
    let mut bbox = Bbox::new();
    for (x, y, pixel) in img.enumerate_pixels() {
        if pred(pixel) {
            bbox.add(x, y);
        }
    }
    (bbox.count > 0).then_some(bbox)
}

/// Row profile split: cluster ink rows into per-line bands so 2-line pages
/// can be measured independently. Rows need a meaningful run of ink to count
/// (chip-edge antialiasing produces phantom pixels), and dips of up to
/// 12 sparse rows stay inside a band so descender tails do not split a line
/// into two bands.
fn line_row_bands(
    img: &image::RgbaImage,
    pred: &impl Fn(u32, u32, &image::Rgba<u8>) -> bool,
) -> Vec<(u32, u32)> {
    let ink_rows: Vec<u32> = (0..img.height())
        .filter(|&y| {
            (0..img.width())
                .step_by(2)
                .filter(|&x| pred(x, y, img.get_pixel(x, y)))
                .count()
                >= 12
        })
        .collect();
    let mut bands: Vec<(u32, u32)> = Vec::new();
    for row in ink_rows {
        match bands.last_mut() {
            Some((_, end)) if row <= *end + 12 => *end = row,
            _ => bands.push((row, row)),
        }
    }
    bands.retain(|(start, end)| end - start >= 6);
    bands
}

/// Ink bbox restricted to one vertical band.
fn bbox_in_band(
    img: &image::RgbaImage,
    band: (u32, u32),
    pred: &impl Fn(u32, u32, &image::Rgba<u8>) -> bool,
) -> Option<Bbox> {
    let mut bbox = Bbox::new();
    for y in band.0..=band.1 {
        for x in 0..img.width() {
            if pred(x, y, img.get_pixel(x, y)) {
                bbox.add(x, y);
            }
        }
    }
    (bbox.count > 0).then_some(bbox)
}

/// Tolerance: 2 px at the 1080 tier, 3 px at 2160-class canvases.
fn px_tol(canvas_height: u32) -> f64 {
    if canvas_height >= 2160 {
        3.0
    } else {
        2.0
    }
}

/// Any pixel materially different from the flat background — used where the
/// *shape* matters more than the color (faded-in animation frames).
fn non_bg(pixel: &image::Rgba<u8>) -> bool {
    let diff = pixel[0].abs_diff(128) as u16
        + pixel[1].abs_diff(128) as u16
        + pixel[2].abs_diff(128) as u16;
    diff > 8
}

fn plan_caption(case: &fixture::FixtureCase, cue_index: usize) -> RenderPlanCaption {
    let cue = &case.cues[cue_index];
    RenderPlanCaption {
        id: format!("{}:{}", case.id, cue_index),
        text: cue.input.text.clone(),
        start_ms: cue.input.start_ms,
        end_ms: cue.input.end_ms,
        style: case.id.split('-').next().unwrap_or("default").into(),
        placement: "bottom".into(),
        safe_area_margin: 48,
        layout: Some(cue.layout.clone()),
    }
}

#[test]
fn rendered_fixtures_match_their_layouts() {
    let Some(ffmpeg) = ffmpeg_with_subtitles() else {
        eprintln!("skipping caption render tests: no ffmpeg with subtitles filter found");
        return;
    };
    let fixture = fixture::load();
    let mut worst: Vec<String> = Vec::new();

    for case in &fixture.cases {
        let dir = tempfile::tempdir().expect("tempdir");
        let caption = plan_caption(case, 1); // the ~70-char cue
        let layout = case.cues[1].layout.clone();
        let mid_ms = (caption.start_ms + caption.end_ms) / 2;
        // At narrow ratios this cue paginates — measure the page visible at
        // mid-time, not page 0.
        let page = layout
            .pages
            .iter()
            .find(|p| mid_ms >= p.start_ms && mid_ms < p.end_ms)
            .unwrap_or(&layout.pages[layout.pages.len() - 1]);
        let block = &page.block;
        let frames = render_frames(
            &ffmpeg,
            dir.path(),
            &caption,
            case.canvas.width,
            case.canvas.height,
            &[mid_ms],
        );
        let img = &frames[0];
        let tol = px_tol(case.canvas.height);

        // (d-pre) the chip region, found first so text detection can key off
        // "non-chip pixels inside the chip" (the only way to spot focus's
        // dimmed words, which sit ~18 levels above the gray background).
        let text_rgb = hex_rgb(&layout.text_color);
        let accent_rgb = layout.highlight.as_ref().map(|h| hex_rgb(&h.active_color));
        let chip_found = layout.chip.as_ref().map(|chip| {
            let c = hex_rgb(&chip.color);
            let blended = (
                (c.0 as f64 * chip.opacity + 128.0 * (1.0 - chip.opacity)) as u8,
                (c.1 as f64 * chip.opacity + 128.0 * (1.0 - chip.opacity)) as u8,
                (c.2 as f64 * chip.opacity + 128.0 * (1.0 - chip.opacity)) as u8,
            );
            let bbox = bbox_where(img, |p| near(p, blended, 30))
                .unwrap_or_else(|| panic!("{}: no chip pixels", case.id));
            (blended, bbox)
        });

        // (b) text block horizontally centered on block.centerX. Highlight
        // looks render the active word in the accent color — include it.
        // With a chip, ink = non-chip pixels inside the chip rect, which
        // catches dimmed focus words without matching the background.
        let (chip_rgb, chip_rect) = match &chip_found {
            Some((rgb, bbox)) => (Some(*rgb), Some(bbox)),
            None => (None, None),
        };
        let text_pred = |p: &image::Rgba<u8>| {
            near(p, text_rgb, 40) || accent_rgb.is_some_and(|rgb| near(p, rgb, 40))
        };
        let ink_pred = |x: u32, y: u32, p: &image::Rgba<u8>| {
            if let Some((rgb, rect)) = chip_rgb.zip(chip_rect) {
                let inside = x as f64 >= rect.min_x
                    && x as f64 <= rect.max_x
                    && y as f64 >= rect.min_y
                    && y as f64 <= rect.max_y;
                // Rounded corners leave raw background inside the rect —
                // exclude it alongside the chip fill.
                inside && !near(p, rgb, 30) && non_bg(p)
            } else {
                text_pred(p)
            }
        };
        let mut text_bbox = Bbox::new();
        for (x, y, p) in img.enumerate_pixels() {
            if ink_pred(x, y, p) {
                text_bbox.add(x, y);
            }
        }
        let text = if text_bbox.count > 0 {
            text_bbox
        } else {
            panic!("{}: no text ink", case.id)
        };
        let center_err = (text.center_x() - block.center_x).abs();
        assert!(
            center_err <= tol,
            "{}: text center {} vs {} (err {center_err})",
            case.id,
            text.center_x(),
            block.center_x,
        );
        worst.push(format!("{} center_x err {center_err:.2}", case.id));

        // (c) two-line page pitch == lineHeightPx
        let bands = line_row_bands(img, &ink_pred);
        if page.lines.len() > 1 {
            assert_eq!(
                bands.len(),
                page.lines.len(),
                "{}: expected {} line bands, got {}",
                case.id,
                page.lines.len(),
                bands.len()
            );
            if bands.len() == 2 {
                // Band TOPS: both fixture lines contain ascender-height
                // glyphs, so top-to-top distance tracks the true line pitch;
                // band centers skew when only one line has descenders.
                let pitch_err =
                    (bands[1].0 as f64 - bands[0].0 as f64 - layout.line_height_px).abs();
                assert!(
                    pitch_err <= 1.5,
                    "{}: line pitch {} vs lineHeightPx {} (err {pitch_err})",
                    case.id,
                    bands[1].0 - bands[0].0,
                    layout.line_height_px,
                );
                worst.push(format!("{} pitch err {pitch_err:.2}", case.id));
            }
        }

        // (a) cap-height: pop is uppercase — every line band's text-colored
        // ink height should be ~0.7275·fontPx.
        if layout.look_id == "pop" {
            for (index, band) in bands.iter().enumerate() {
                let Some(line_ink) = bbox_in_band(img, *band, &ink_pred) else {
                    continue;
                };
                let expected = 0.7275 * layout.font_px;
                let err = (line_ink.height() - expected).abs() / expected;
                assert!(
                    err <= 0.06,
                    "{}: line {index} cap height {} vs {expected} ({err:.3})",
                    case.id,
                    line_ink.height(),
                );
                worst.push(format!("{} cap-height err {err:.3}", case.id));
            }
        }

        // (d) chip: bbox == (maxLineWidth + 2·padX) × (height + 2·padY)
        // centered on the block.
        if let Some(chip) = &layout.chip {
            let (_, chip_bbox) = chip_found.as_ref().expect("chip found above");
            let expected_w = page
                .lines
                .iter()
                .map(|line| {
                    measure_line_px(
                        layout.font_weight,
                        &line.text,
                        layout.font_px,
                        layout.letter_spacing_px,
                    )
                })
                .fold(0.0, f64::max)
                + 2.0 * chip.pad_x_px;
            let expected_h = block.height + 2.0 * chip.pad_y_px;
            // The chip's antialiased edge and the shadow bleed widen the
            // measured bbox by a few px on each side — allow 4 px extra.
            let w_err = (chip_bbox.width() - expected_w).abs();
            let h_err = (chip_bbox.height() - expected_h).abs();
            assert!(
                w_err <= tol + 4.0,
                "{}: chip width {} vs {expected_w} (err {w_err})",
                case.id,
                chip_bbox.width(),
            );
            assert!(
                h_err <= tol + 4.0,
                "{}: chip height {} vs {expected_h} (err {h_err})",
                case.id,
                chip_bbox.height(),
            );
            let cx_err = (chip_bbox.center_x() - block.center_x).abs();
            let cy_err = ((chip_bbox.min_y + chip_bbox.max_y) / 2.0 - block.center_y).abs();
            assert!(
                cx_err <= tol && cy_err <= tol + 4.0,
                "{}: chip center ({}, {}) vs ({}, {})",
                case.id,
                chip_bbox.center_x(),
                (chip_bbox.min_y + chip_bbox.max_y) / 2.0,
                block.center_x,
                block.center_y,
            );
            worst.push(format!(
                "{} chip w {w_err:.2} h {h_err:.2} cx {cx_err:.2} cy {cy_err:.2}",
                case.id
            ));
        }

        // (e) outline looks: outline-colored ink extends ≈ widthPx beyond the
        // text ink bbox.
        if let Some(outline) = &layout.outline {
            let outline_rgb = hex_rgb(&outline.color);
            let out_bbox = bbox_where(img, |p| near(p, outline_rgb, 30))
                .unwrap_or_else(|| panic!("{}: no outline ink", case.id));
            let spread = (out_bbox.height() - text.height()) / 2.0;
            let spread_err = (spread - outline.width_px).abs();
            assert!(
                spread_err <= tol + 1.0,
                "{}: outline spread {spread} vs {} (err {spread_err})",
                case.id,
                outline.width_px,
            );
            worst.push(format!("{} outline err {spread_err:.2}", case.id));
        }

        // (f) highlight: at mid-page, accent pixels exist inside the text band.
        if let Some(highlight) = &layout.highlight {
            let accent_rgb = hex_rgb(&highlight.active_color);
            let accent = bbox_where(img, |p| near(p, accent_rgb, 40))
                .unwrap_or_else(|| panic!("{}: no accent ink", case.id));
            assert!(
                accent.min_x >= text.min_x - 4.0 && accent.max_x <= text.max_x + 4.0,
                "{}: accent ink outside the text bbox",
                case.id,
            );
            if highlight.mode == "focus" {
                // Non-active words are dimmed — look for mid-luminance ink
                // inside the chip rect: brighter than the chip fill but not
                // the full-opacity text color.
                let (chip_rgb, chip_rect) = chip_rgb.zip(chip_rect).expect("focus has a chip");
                let dimmed = img
                    .enumerate_pixels()
                    .filter(|(x, y, p)| {
                        let inside = *x as f64 >= chip_rect.min_x
                            && *x as f64 <= chip_rect.max_x
                            && *y as f64 >= chip_rect.min_y
                            && *y as f64 <= chip_rect.max_y;
                        inside
                            && !near(p, chip_rgb, 30)
                            && !near(p, text_rgb, 40)
                            && p[0] as u16 + p[1] as u16 + p[2] as u16
                                > chip_rgb.0 as u16 + chip_rgb.1 as u16 + chip_rgb.2 as u16 + 60
                    })
                    .count();
                assert!(
                    dimmed > 20,
                    "{}: focus mode should dim non-active words ({dimmed} px)",
                    case.id,
                );
            }
            worst.push(format!("{} accent ok", case.id));
        }
    }
    eprintln!("render-tolerance report:\n{}", worst.join("\n"));
}

/// Calibrates the `\blur` → effective σ factor: a white rect is rendered at
/// `\blur B` over black; the 10→90% luminance falloff at its edge is
/// 2.563·σ for a Gaussian, so `σ_measured = edge / 2.563` tells us how many
/// σ one libass blur unit is.
#[test]
fn blur_unit_calibration() {
    let Some(ffmpeg) = ffmpeg_with_subtitles() else {
        eprintln!("skipping: no ffmpeg with subtitles filter");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let script = dir.path().join("cal.ass");
    std::fs::write(
        &script,
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 800\nPlayResY: 600\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n\
         [V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n\
         Style: t,Inter,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n\
         [Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n\
         Dialogue: 0,0:00:00.00,0:00:05.00,t,,0,0,0,,{\\an5\\pos(400,300)\\bord0\\shad0\\1c&HFFFFFF&\\1a&H00&\\blur20\\p1}m 0 0 l 300 0 l 300 200 l 0 200{\\p0}\n",
    )
    .expect("write cal ass");
    let out = dir.path().join("cal.png");
    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=800x600:r=30:d=2",
            "-vf",
            &format!(
                "subtitles=filename='{}',select='eq(n,30)'",
                escape_filter_path(&script)
            ),
            "-frames:v",
            "1",
            out.to_str().expect("ascii path"),
        ])
        .output()
        .expect("spawn ffmpeg");
    assert!(status.status.success(), "calibration render failed");
    let img = image::open(&out).expect("decode").to_rgba8();

    // Horizontal luminance profile through the rect's left edge (rect spans
    // x=250..550 after \an5 centering) at its vertical center.
    let row = 300;
    let mut first_10 = None;
    let mut first_90 = None;
    for x in 100..400u32 {
        let lum = img.get_pixel(x, row)[0] as f64 / 255.0;
        if first_10.is_none() && lum >= 0.10 {
            first_10 = Some(x as f64);
        }
        if first_90.is_none() && lum >= 0.90 {
            first_90 = Some(x as f64);
        }
    }
    let edge = first_90.expect("90% crossing") - first_10.expect("10% crossing");
    let sigma = edge / 2.563;
    eprintln!("blur calibration: blur=20 → edge {edge:.1}px → σ {sigma:.2}");
    // Measured on the bundled ffmpeg/libass 0.17.5: one \blur unit behaves
    // like σ ≈ 0.84 (edge ≈ 2.15 px/unit). ass_layout.rs bakes the
    // complementary factor into BLUR_SIGMA_PER_UNIT.
    assert!(
        (sigma / 20.0 - 0.839).abs() < 0.06,
        "blur unit σ {sigma} for \\blur20 drifted — recalibrate BLUR_SIGMA_PER_UNIT"
    );
}

#[test]
fn rendered_animation_scales_in_concentrically() {
    let Some(ffmpeg) = ffmpeg_with_subtitles() else {
        eprintln!("skipping: no ffmpeg with subtitles filter");
        return;
    };
    let fixture = fixture::load();
    // The default look has fromScale 0.96; pop has 0.9 — both scale in.
    for look in ["default", "pop"] {
        let case = fixture
            .cases
            .iter()
            .find(|c| c.id == format!("{look}-16:9"))
            .expect("fixture case");
        if case.cues[0].layout.animation.from_scale >= 1.0 {
            continue;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let caption = plan_caption(case, 0);
        let start = caption.start_ms;
        let mid = (caption.start_ms + caption.end_ms) / 2;
        // Sample 35% into the fade-in: alpha ≈ 35% (measurable) while the
        // ease-out scale is still ~2–4% short of final.
        let sample_ms = start + (case.cues[0].layout.animation.in_ms * 35 / 100).max(5);
        let frames = render_frames(
            &ffmpeg,
            dir.path(),
            &caption,
            case.canvas.width,
            case.canvas.height,
            &[sample_ms, mid],
        );
        // At mid-fade the ink is translucent — detect the shape via luminance
        // distance from the flat background, not the color.
        let early = bbox_where(&frames[0], non_bg).expect("early frame ink");
        let mid_ink = bbox_where(&frames[1], non_bg).expect("mid frame ink");
        assert!(
            early.width() < mid_ink.width() - 2.0,
            "{look}: early width {} should be smaller than mid {}",
            early.width(),
            mid_ink.width(),
        );
        let drift = (early.center_x() - mid_ink.center_x()).abs();
        assert!(
            drift <= 3.0,
            "{look}: animation drifted {drift}px horizontally"
        );
    }
}
