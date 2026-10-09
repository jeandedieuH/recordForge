//! Brand Kit intro/outro cards — synthetic color segments rendered through
//! the same encoder settings as the export, then concat-muxed around the
//! finished partial. Cards carry a silent stereo track when the export has
//! audio so no timestamp offsetting is needed; chapters embedded earlier are
//! re-injected with their timestamps shifted past the intro.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::errors::{InternalError, Result};
use crate::exports::encoding::{self, ExportEncoder};
use crate::exports::{
    escape_concat_path, generate_ffmetadata, hvc1_tag_args, run_export_ffmpeg, seconds,
    ExportSettings, RenderPlanChapter,
};

pub const MAX_CARD_MS: u64 = 10_000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandCards {
    #[serde(default)]
    pub enabled: bool,
    /// 0 disables each side independently.
    #[serde(default)]
    pub intro_ms: u64,
    #[serde(default)]
    pub outro_ms: u64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default = "default_card_bg")]
    pub background: String,
    #[serde(default = "default_card_text")]
    pub text_color: String,
    #[serde(default)]
    pub font_path: Option<String>,
}

fn default_card_bg() -> String {
    "#0f172a".to_string()
}
fn default_card_text() -> String {
    "#f8fafc".to_string()
}

impl BrandCards {
    /// Milliseconds added to the export by each card; inactive when nothing
    /// renders so callers can skip the concat pass entirely.
    pub fn card_durations(&self) -> Option<(u64, u64)> {
        if !self.enabled {
            return None;
        }
        let intro = self.intro_ms.min(MAX_CARD_MS);
        let outro = self.outro_ms.min(MAX_CARD_MS);
        (intro > 0 || outro > 0).then_some((intro, outro))
    }

    /// The card font falls back to the staged Inter when the picked file is
    /// missing — same degrade-don't-fail rule as the watermark logo.
    fn resolved_font(&self, fallback: &Path) -> PathBuf {
        self.font_path
            .as_deref()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .unwrap_or_else(|| fallback.to_path_buf())
    }
}

/// Escape a user string for drawtext `text='…'` inside a `-/filter_complex`
/// script. One unescape pass runs at the filter-arg layer, so `\\`→`\`,
/// `\:`→`:`, and `\\%`→`\%` which drawtext then renders as a literal `%`
/// (a bare `%{` in user text would expand). An ASCII `'` can't survive the
/// quoted-arg parser at all — it becomes the typographic apostrophe, which
/// also reads better on a brand card.
fn escape_drawtext(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\'', "\u{2019}")
        .replace(':', "\\:")
        .replace('%', "\\\\%")
        .replace(['\n', '\r'], " ")
        .replace(';', "\\;")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace(',', "\\,")
}

/// Sanitize a `#rrggbb`-style color for `color=c=`/`fontcolor=` — anything
/// malformed falls back to the provided default so settings can't inject
/// filter syntax.
pub(crate) fn sanitize_color(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    let valid = (hex.len() == 6 || hex.len() == 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    if valid {
        format!("0x{hex}")
    } else {
        fallback.to_string()
    }
}

/// drawtext needs a real font file — reuse the embedded Inter staged by the
/// keystroke overlay when no brand font is set.
fn stage_default_font(work_dir: &Path) -> Result<PathBuf> {
    crate::exports::keystrokes::write_font(work_dir)
}

/// The main export's audio layout — the card's silent track must match it
/// exactly or the `-c copy` concat remux hits a mid-stream param change.
fn probe_audio_layout(ffprobe_path: &Path, media: &Path) -> Option<(u32, &'static str)> {
    let probe = crate::process::create_command(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channel_layout",
            "-of",
            "json",
        ])
        .arg(media)
        .output()
        .ok()?;
    if !probe.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&probe.stdout).ok()?;
    let stream = json["streams"].as_array()?.first()?;
    let rate = stream["sample_rate"].as_str()?.parse::<u32>().ok()?;
    // Channel layout names come back like "stereo"/"5.1(side)" — pass the
    // raw name through when known, else map a channel count to a layout.
    let channels = stream["channels"].as_u64().unwrap_or(2);
    let layout = stream["channel_layout"]
        .as_str()
        .map(|name| name.split('(').next().unwrap_or(name).to_string())
        .filter(|name| !name.is_empty() && name != "unknown")
        .unwrap_or_else(|| {
            match channels {
                1 => "mono",
                2 => "stereo",
                6 => "5.1",
                8 => "7.1",
                _ => "stereo",
            }
            .to_string()
        });
    let layout_static: &'static str = match layout.as_str() {
        "mono" => "mono",
        "stereo" => "stereo",
        "5.1" | "5.1(side)" | "6.1" => "5.1",
        "7.1" => "7.1",
        "quad" => "quad",
        _ => "stereo",
    };
    Some((rate, layout_static))
}

/// Render one card as a video+audio mp4 segment matching the export's
/// codec/geometry/fps so the final concat demuxer can `-c copy` it.
#[allow(clippy::too_many_arguments)]
fn render_card(
    ffmpeg_path: &Path,
    out_path: &Path,
    duration_ms: u64,
    spec: &BrandCards,
    canvas_width: u32,
    canvas_height: u32,
    fps: u32,
    audio: Option<(u32, &'static str)>,
    logo_path: Option<&Path>,
    settings: &ExportSettings,
    encoder: ExportEncoder,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    work_dir: &Path,
) -> Result<()> {
    let secs = seconds(duration_ms);
    let bg = sanitize_color(&spec.background, "0x0f172a");
    let fg = sanitize_color(&spec.text_color, "0xf8fafc");
    let color_src = format!("color=c={bg}:s={canvas_width}x{canvas_height}:r={fps}:d={secs}");

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .args(["-f", "lavfi", "-i", &color_src]);
    if let Some((rate, layout)) = audio {
        command.args([
            "-f",
            "lavfi",
            "-i",
            &format!("anullsrc=cl={layout}:r={rate}:d={secs}"),
        ]);
    }
    let has_logo = logo_path.is_some();
    if let Some(logo) = logo_path {
        command.args(["-loop", "1", "-i"]).arg(logo);
    }

    // Layout: logo ~30% up, title centered slightly below middle, subtitle
    // under it — scaled relative to canvas so 9:16 cards read correctly.
    let font = spec.resolved_font(&stage_default_font(work_dir)?);
    let font_arg = crate::exports::captions::escape_filter_path(&font);
    let mut chain = String::from("[0:v]format=yuv420p");
    let title_size = (canvas_height as f64 * 0.075).round().max(24.0) as u32;
    let subtitle_size = (canvas_height as f64 * 0.032).round().max(14.0) as u32;

    if let Some(title) = spec.title.as_deref().filter(|t| !t.trim().is_empty()) {
        chain.push_str(&format!(
            ",drawtext=fontfile='{font_arg}':text='{}':fontsize={title_size}:fontcolor={fg}:x=(w-text_w)/2:y=(h*0.55)-(text_h/2)",
            escape_drawtext(title.trim())
        ));
    }
    if let Some(subtitle) = spec.subtitle.as_deref().filter(|t| !t.trim().is_empty()) {
        chain.push_str(&format!(
            ",drawtext=fontfile='{font_arg}':text='{}':fontsize={subtitle_size}:fontcolor={fg}@0.8:x=(w-text_w)/2:y=h*0.62",
            escape_drawtext(subtitle.trim())
        ));
    }
    chain.push_str("[cardbase]");
    if has_logo {
        // Logo input is index 1 when the card is video-only, index 2 when a
        // silent audio lavfi source sits between.
        let logo_index = if audio.is_some() { 2 } else { 1 };
        let logo_h = (canvas_height as f64 * 0.16).round().max(32.0) as u32;
        chain.push_str(&format!(
            ";[{logo_index}:v]scale=-1:{logo_h}[cardlogo];[cardbase][cardlogo]overlay=(W-w)/2:H*0.28[cardv]"
        ));
    } else {
        chain.push_str(";[cardbase]null[cardv]");
    }

    let filter_path = work_dir.join("card-filter.txt");
    std::fs::write(&filter_path, &chain)
        .map_err(|e| InternalError::Storage(format!("write card filter: {e}")))?;
    command
        .arg("-/filter_complex")
        .arg(&filter_path)
        .args(["-map", "[cardv]"]);
    if audio.is_some() {
        command.args(["-map", "1:a", "-c:a", "aac", "-b:a", "96k"]);
    }

    encoding::append_export_video_args(
        &mut command,
        settings,
        encoder,
        fps,
        canvas_width,
        canvas_height,
    );
    command.args(["-t", &secs]).arg(out_path);
    run_export_ffmpeg(
        &mut command,
        cancel,
        None,
        out_path,
        "brand card",
        None,
        None,
        None,
    )
}

/// Wrap the finished partial with rendered brand cards. The concat demuxer
/// remuxes `-c copy`, so this is a fast pass — one tiny encode per card.
/// Returns the total added milliseconds (used for output validation).
#[allow(clippy::too_many_arguments)]
pub fn apply_brand_cards(
    ffmpeg_path: &Path,
    ffprobe_path: &Path,
    partial_path: &Path,
    spec: &BrandCards,
    logo_path: Option<&Path>,
    canvas_width: u32,
    canvas_height: u32,
    fps: u32,
    has_audio: bool,
    project_name: &str,
    chapters: &[RenderPlanChapter],
    settings: &ExportSettings,
    encoder: ExportEncoder,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<u64> {
    let Some((intro_ms, outro_ms)) = spec.card_durations() else {
        return Ok(0);
    };

    let work_dir = std::env::temp_dir().join(format!("recordforge_cards_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| InternalError::Storage(format!("create card dir: {e}")))?;
    let _guard = super::TempExportDir(work_dir.clone());

    // The card's silent track must share the main stream's sample rate and
    // layout — a mid-stream param change under `-c copy` fails the remux.
    let audio = if has_audio {
        probe_audio_layout(ffprobe_path, partial_path)
    } else {
        None
    };

    let mut entries: Vec<PathBuf> = Vec::new();
    if intro_ms > 0 {
        let intro_path = work_dir.join("intro.mp4");
        render_card(
            ffmpeg_path,
            &intro_path,
            intro_ms,
            spec,
            canvas_width,
            canvas_height,
            fps,
            audio,
            logo_path,
            settings,
            encoder,
            cancel,
            &work_dir,
        )?;
        entries.push(intro_path);
    }
    // Move the finished partial aside — the concat output takes its name.
    let main_path = work_dir.join("main.mp4");
    std::fs::rename(partial_path, &main_path)
        .map_err(|e| InternalError::Storage(format!("stage main for card mux: {e}")))?;
    entries.push(main_path);
    if outro_ms > 0 {
        let outro_path = work_dir.join("outro.mp4");
        render_card(
            ffmpeg_path,
            &outro_path,
            outro_ms,
            spec,
            canvas_width,
            canvas_height,
            fps,
            audio,
            logo_path,
            settings,
            encoder,
            cancel,
            &work_dir,
        )?;
        entries.push(outro_path);
    }

    // Shift embedded chapters past the intro — the concat remux drops
    // container chapters, so they're re-injected from a shifted ffmetadata.
    // The mp4 muxer rebases chapter times by the FIRST chapter's start, so a
    // leading anchor covering the intro region is required for times to land
    // correctly; the card itself is a natural, viewer-visible anchor.
    let mut shifted: Vec<RenderPlanChapter> = Vec::new();
    if intro_ms > 0 {
        shifted.push(RenderPlanChapter {
            id: "card-intro".into(),
            title: spec
                .title
                .clone()
                .unwrap_or_else(|| project_name.to_string()),
            start_ms: 0,
            end_ms: intro_ms,
        });
    }
    shifted.extend(chapters.iter().map(|chapter| RenderPlanChapter {
        id: chapter.id.clone(),
        start_ms: chapter.start_ms + intro_ms,
        end_ms: chapter.end_ms + intro_ms,
        title: chapter.title.clone(),
    }));
    let has_chapters = !shifted.is_empty()
        && (settings.chapter_mode == "embed" || settings.chapter_mode == "both");
    let chapters_path = work_dir.join("chapters.ffmeta");
    if has_chapters {
        let meta = generate_ffmetadata(project_name, &shifted);
        std::fs::write(&chapters_path, meta)
            .map_err(|e| InternalError::Storage(format!("write card chapters: {e}")))?;
    }

    let list_path = work_dir.join("cards.txt");
    let list: String = entries
        .iter()
        .map(|path| format!("file '{}'", escape_concat_path(path)))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&list_path, list)
        .map_err(|e| InternalError::Storage(format!("write card concat list: {e}")))?;

    let mut mux = crate::process::create_command(ffmpeg_path);
    mux.arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path);
    if has_chapters {
        mux.args(["-f", "ffmetadata", "-i"]).arg(&chapters_path);
    }
    mux.args(["-map", "0:v"]);
    if audio.is_some() {
        mux.args(["-map", "0:a"]);
    }
    if has_chapters {
        // concat input is 0, the ffmetadata chapter source is 1.
        mux.args(["-map_chapters", "1"]);
    }
    mux.args(["-c", "copy", "-movflags", "+faststart"]);
    mux.args(hvc1_tag_args(settings));
    mux.arg(partial_path);
    run_export_ffmpeg(
        &mut mux,
        cancel,
        None,
        partial_path,
        "brand card mux",
        None,
        None,
        None,
    )?;

    Ok(intro_ms + outro_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_durations_respects_enabled_flag_and_cap() {
        let cards = BrandCards {
            enabled: false,
            intro_ms: 2000,
            outro_ms: 0,
            title: None,
            subtitle: None,
            background: default_card_bg(),
            text_color: default_card_text(),
            font_path: None,
        };
        assert!(cards.card_durations().is_none());
        let cards = BrandCards {
            enabled: true,
            intro_ms: 50_000,
            outro_ms: 1500,
            ..cards
        };
        assert_eq!(cards.card_durations(), Some((MAX_CARD_MS, 1500)));
        let cards = BrandCards {
            enabled: true,
            intro_ms: 0,
            outro_ms: 0,
            ..cards
        };
        assert!(cards.card_durations().is_none());
    }

    #[test]
    fn drawtext_escapes_filter_hostile_chars() {
        assert_eq!(escape_drawtext("it's 5:00"), "it\u{2019}s 5\\:00");
        // `\\%` in the script de-escapes to `\%`, which drawtext prints as `%`.
        assert_eq!(escape_drawtext("50% off"), "50\\\\% off");
        assert_eq!(escape_drawtext("a\nb"), "a b");
        assert_eq!(escape_drawtext("a;b,c"), "a\\;b\\,c");
        assert_eq!(escape_drawtext("a\\b"), "a\\\\b");
    }

    #[test]
    fn sanitize_color_accepts_hex_and_rejects_injection() {
        assert_eq!(sanitize_color("#ff0000", "0x000"), "0xff0000");
        assert_eq!(sanitize_color("ff0000ff", "0x000"), "0xff0000ff");
        assert_eq!(sanitize_color("red", "0x000"), "0x000");
        // A filter-injection attempt degrades to the fallback.
        assert_eq!(sanitize_color("x],evil[", "0x000"), "0x000");
    }

    /// End-to-end: a real main mp4 gets intro+outro cards concat-muxed around
    /// it; ffprobe must see the extended duration and the shifted chapter.
    #[test]
    fn apply_brand_cards_wraps_real_media() {
        let ffmpeg = match crate::media::resolve_executable("ffmpeg") {
            Ok(p) => p,
            Err(_) => return,
        };
        let ffprobe = match crate::media::resolve_executable("ffprobe") {
            Ok(p) => p,
            Err(_) => return,
        };
        let dir = std::env::temp_dir().join(format!("rf-test-cards-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let partial = dir.join("partial.mp4");
        // 1.5s 640x360 main clip with audio — cards must match its streams.
        let status = crate::process::create_command(&*ffmpeg.to_string_lossy())
            .args(["-y", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=640x360:rate=24:duration=1.5")
            .args(["-f", "lavfi", "-i"])
            .arg("sine=frequency=440:duration=1.5")
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&partial)
            .status()
            .unwrap();
        assert!(status.success(), "generate main media");

        let settings: ExportSettings = serde_json::from_value(serde_json::json!({})).unwrap();
        let spec = BrandCards {
            enabled: true,
            intro_ms: 800,
            outro_ms: 800,
            title: Some("it's 50% done: hello".into()),
            subtitle: Some("sub, [x]".into()),
            background: "#1a2b3c".into(),
            text_color: "#ffffff".into(),
            font_path: None,
        };
        let chapters = vec![RenderPlanChapter {
            id: "c1".into(),
            title: "Part one".into(),
            start_ms: 0,
            end_ms: 1500,
        }];
        let added = apply_brand_cards(
            &ffmpeg,
            &ffprobe,
            &partial,
            &spec,
            None,
            640,
            360,
            24,
            true,
            "test",
            &chapters,
            &settings,
            ExportEncoder::Software,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .expect("brand cards");
        assert_eq!(added, 1600);

        // ffprobe: duration ≈ 1.5 + 1.6s, both streams present.
        let probe = crate::process::create_command(&*ffprobe.to_string_lossy())
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-show_chapters",
            ])
            .arg(&partial)
            .output()
            .unwrap();
        assert!(probe.status.success(), "ffprobe wrapped output");
        let json: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
        let duration: f64 = json["format"]["duration"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            (duration - 3.1).abs() < 0.35,
            "duration {duration} should be ~3.1s"
        );
        let video = json["streams"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["codec_type"] == "video");
        let audio = json["streams"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["codec_type"] == "audio");
        assert!(video && audio, "wrapped output keeps v+a");
        // chapters[0] = intro-card anchor (0..800ms, card title); the real
        // chapter follows, shifted past the intro.
        let chapters = json["chapters"].as_array().unwrap();
        assert_eq!(chapters.len(), 2, "anchor + shifted chapter");
        let anchor_end: f64 = chapters[0]["end_time"].as_str().unwrap().parse().unwrap();
        assert!((anchor_end - 0.8).abs() < 0.1, "anchor ends at intro end");
        let chapter_start: f64 = chapters[1]["start_time"].as_str().unwrap().parse().unwrap();
        assert!(
            (chapter_start - 0.8).abs() < 0.2,
            "chapter start {chapter_start} shifted by intro"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
