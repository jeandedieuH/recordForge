//! Webcam Sidecar Capture & Validation Engine
//!
//! Provides dedicated webcam stream handling, capability preflight check,
//! camera mode negotiation, and sidecar recording (`webcam_000.mp4`).

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::config::RecordingProfile;
use crate::errors::Result;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamCapabilities {
    pub device_id: String,
    pub device_name: String,
    pub available: bool,
    pub formats: Vec<String>,
}

/// Preflight check for a webcam device before starting recording.
pub fn validate_webcam_device(ffmpeg_path: &str, device_name: &str) -> Result<WebcamCapabilities> {
    // Pass the dshow device as a single argument without inner quotes.  FFmpeg
    // receives one argv token, so spaces in the device name are preserved and
    // the dshow parser sees the name correctly.
    let spec = format!("video={device_name}");
    let available = super::media::probe_dshow_device(ffmpeg_path, &spec);

    Ok(WebcamCapabilities {
        device_id: device_name.to_string(),
        device_name: device_name.to_string(),
        available,
        formats: vec!["YUY2".into(), "MJPEG".into(), "NV12".into()],
    })
}

/// One camera input mode negotiated with the device. Exactly one of
/// `pixel_format` (raw video) or `codec` (compressed stream the camera emits,
/// decoded by FFmpeg) is set — dshow advertises them on separate lines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraMode {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub pixel_format: Option<String>,
    pub codec: Option<String>,
}

/// Effective capture profile for the camera sidecar. Webcam resolution and
/// frame rate are deliberately decoupled from the screen profile: the camera
/// is rendered as a picture-in-picture overlay, and capping at <=30fps keeps
/// encoder CPU low without hurting perceived preview/recording quality.
pub fn camera_profile(profile: &RecordingProfile) -> RecordingProfile {
    let mut camera = profile.clone();
    let (w, h) = match profile.id.as_str() {
        "low-impact" => (854, 480),
        "camera-only" => (profile.width, profile.height),
        _ => (1280, 720),
    };
    camera.width = w;
    camera.height = h;
    camera.fps = profile.fps.clamp(1, 30);
    camera
}

/// Raw pixel formats we accept from dshow (cheap or free to convert to the
/// encoder's input format).
const RAW_PIXEL_FORMATS: &[&str] = &["nv12", "yuv420p", "yuyv422", "uyvy422", "bgr24", "bgra"];

/// Compressed camera codecs FFmpeg can decode directly.
const CAMERA_CODECS: &[&str] = &["mjpeg", "h264"];

/// Sanitity bounds for advertised modes: absurd fps/dimensions in a listing are
/// treated as parse noise rather than real modes.
const MAX_ADVERTISED_FPS: f64 = 240.0;
const MAX_ADVERTISED_DIMENSION: u32 = 16_384;

/// Parse the mode lines from `ffmpeg -f dshow -list_options true -i video=<dev>`.
///
/// Pure so it is unit-testable without hardware. Each advertised line carries
/// a `min s=WxH fps=F` / `max s=WxH fps=F` pair:
/// - Same min/max size: the camera supports the full fps range, so we take
///   `fps = min(max_reported, max_fps)` when it stays >= the reported minimum.
/// - Differing sizes: only the two advertised endpoints are taken (each with
///   its own reported fps <= max_fps). Intermediate sizes/rates are never
///   invented — dshow does not promise arbitrary (size, fps) combinations.
pub fn parse_camera_modes(text: &str, max_fps: f64) -> Vec<CameraMode> {
    if !max_fps.is_finite() || max_fps <= 0.0 || max_fps > MAX_ADVERTISED_FPS {
        return Vec::new();
    }
    let re = Regex::new(
        r"(?:pixel_format=(\w+)|vcodec=(\w+))\s+min s=(\d+)x(\d+) fps=([\d.]+)\s+max s=(\d+)x(\d+) fps=([\d.]+)",
    )
    .expect("dshow mode regex is static and valid");

    let mut modes = Vec::new();
    for caps in re.captures_iter(text) {
        let pixel_format = caps.get(1).map(|m| m.as_str().to_string());
        let codec = caps.get(2).map(|m| m.as_str().to_string());

        // Whitelist: reject formats/codecs we cannot feed the encoder cheaply.
        let supported = pixel_format
            .as_deref()
            .map(|f| RAW_PIXEL_FORMATS.contains(&f))
            .unwrap_or(false)
            || codec
                .as_deref()
                .map(|c| CAMERA_CODECS.contains(&c))
                .unwrap_or(false);
        if !supported {
            continue;
        }

        let (min_w, min_h, min_fps) = match (
            caps[3].parse::<u32>(),
            caps[4].parse::<u32>(),
            caps[5].parse::<f64>(),
        ) {
            (Ok(w), Ok(h), Ok(f)) => (w, h, f),
            _ => continue,
        };
        let (max_w, max_h, max_fps_reported) = match (
            caps[6].parse::<u32>(),
            caps[7].parse::<u32>(),
            caps[8].parse::<f64>(),
        ) {
            (Ok(w), Ok(h), Ok(f)) => (w, h, f),
            _ => continue,
        };

        let valid_dims = |w: u32, h: u32| {
            (1..=MAX_ADVERTISED_DIMENSION).contains(&w)
                && (1..=MAX_ADVERTISED_DIMENSION).contains(&h)
        };
        let valid_fps = |f: f64| f.is_finite() && f > 0.0 && f <= MAX_ADVERTISED_FPS;
        if !valid_fps(min_fps) || !valid_fps(max_fps_reported) || min_fps > max_fps_reported {
            continue;
        }

        let build = |width: u32, height: u32, fps: f64| CameraMode {
            width,
            height,
            fps,
            pixel_format: pixel_format.clone(),
            codec: codec.clone(),
        };

        if min_w == max_w && min_h == max_h {
            // Fixed size with a real fps range: pick the highest rate our
            // camera budget allows that the device can sustain.
            let fps = max_fps_reported.min(max_fps);
            if fps >= min_fps && valid_dims(min_w, min_h) {
                modes.push(build(min_w, min_h, fps));
            }
        } else {
            // The size itself varies across the range; only the two endpoints
            // are guaranteed combinations.
            if valid_dims(min_w, min_h) && min_fps <= max_fps {
                modes.push(build(min_w, min_h, min_fps));
            }
            if valid_dims(max_w, max_h) && max_fps_reported <= max_fps {
                modes.push(build(max_w, max_h, max_fps_reported));
            }
        }
    }

    // Deduplicate exact modes — cameras commonly re-advertise the same
    // combination under both a pixel_format and its vcodec alias.
    let mut deduped: Vec<CameraMode> = Vec::with_capacity(modes.len());
    for mode in modes {
        if !deduped.contains(&mode) {
            deduped.push(mode);
        }
    }
    deduped
}

/// Prefer cheaper formats at equal size/fps: NV12/YUV420P feed the encoder
/// directly, MJPEG needs a decode step but is cheap, other raw formats cost a
/// conversion, and camera-supplied H.264 needs a full decode.
fn format_rank(mode: &CameraMode) -> u8 {
    if let Some(format) = mode.pixel_format.as_deref() {
        return match format {
            "nv12" | "yuv420p" => 0,
            _ => 2,
        };
    }
    match mode.codec.as_deref() {
        Some("mjpeg") => 1,
        _ => 3,
    }
}

/// Order negotiated camera modes for capture attempts.
///
/// Modes that fit the camera profile's resolution budget come first (largest
/// area, then highest fps, then cheapest format). Oversized modes follow,
/// smallest first — a larger sensor mode is still usable because the filter
/// graph scales it down, but it costs more USB bandwidth and decode work.
/// Returns at most 4 candidates so startup stays bounded.
pub fn ordered_camera_modes(
    modes: &[CameraMode],
    budget_width: u32,
    budget_height: u32,
) -> Vec<CameraMode> {
    let mut within: Vec<&CameraMode> = modes
        .iter()
        .filter(|m| m.width <= budget_width && m.height <= budget_height)
        .collect();
    within.sort_by(|a, b| {
        (b.width as u64 * b.height as u64)
            .cmp(&(a.width as u64 * a.height as u64))
            .then_with(|| {
                b.fps
                    .partial_cmp(&a.fps)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| format_rank(a).cmp(&format_rank(b)))
    });

    let mut outside: Vec<&CameraMode> = modes
        .iter()
        .filter(|m| m.width > budget_width || m.height > budget_height)
        .collect();
    outside.sort_by(|a, b| {
        (a.width as u64 * a.height as u64)
            .cmp(&(b.width as u64 * b.height as u64))
            .then_with(|| {
                b.fps
                    .partial_cmp(&a.fps)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| format_rank(a).cmp(&format_rank(b)))
    });

    within.into_iter().chain(outside).take(4).cloned().collect()
}

/// Bytes of `-list_options` stderr retained for parsing. The listing is small;
/// the cap only guards against a device spewing diagnostics without bound.
/// Windows-only because only the dshow probe path consumes it.
#[cfg(windows)]
const LIST_OPTIONS_RETAINED_BYTES: usize = 128 * 1024;

/// Probe the camera's advertised modes once before starting a segment.
///
/// Runs `ffmpeg -hide_banner -list_options true -f dshow -i video=<device>`
/// with a 3-second bound. A nonzero exit is normal for `-list_options` (no
/// output is produced); failure of the probe itself just yields no modes and
/// the caller falls back to device defaults. The raw listing, device name,
/// and paths are never logged (privacy: camera names can identify hardware).
#[cfg(windows)]
pub fn probe_camera_modes(ffmpeg_path: &str, device: &str, max_fps: f64) -> Vec<CameraMode> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let mut command = crate::process::create_command(ffmpeg_path);
    command
        .args(["-hide_banner", "-list_options", "true", "-f", "dshow"])
        // One argv token so spaces in the device name survive unchanged.
        .arg("-i")
        .arg(format!("video={device}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Vec::new(),
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };

    // Drain stderr on a reader thread so a verbose listing cannot fill the
    // pipe and stall the probe; retained bytes are capped.
    let reader = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut retained: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let remaining = LIST_OPTIONS_RETAINED_BYTES.saturating_sub(retained.len());
                    retained.extend_from_slice(&chunk[..n.min(remaining)]);
                }
            }
        }
        retained
    });

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                // Device enumeration hung (e.g. a driver that never answers);
                // kill and reap so the probe cannot leak a process.
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }

    let text = reader
        .join()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    parse_camera_modes(&text, max_fps)
}

/// Camera mode probing is DirectShow-specific; other platforms keep their
/// existing input defaults (bounded by the <=30fps camera profile).
#[cfg(not(windows))]
pub fn probe_camera_modes(_ffmpeg_path: &str, _device: &str, _max_fps: f64) -> Vec<CameraMode> {
    Vec::new()
}

/// Classify whether a webcam start failure looks like the device being held
/// by another application — the only startup error worth a same-combination
/// retry. Works on the surfaced error message; never matched against paths.
pub(crate) fn is_device_busy_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("device or resource busy")
        || m.contains("could not run graph")
        || m.contains("already in use")
        || m.contains("in use by")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LISTING: &str = r#"
[dshow @ 0000000001] DirectShow video device options (from video devices)
[dshow @ 0000000001]  Pixel Format: yuyv422
[dshow @ 0000000001]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
[dshow @ 0000000001]   pixel_format=yuyv422  min s=1280x720 fps=10 max s=1280x720 fps=30
[dshow @ 0000000001]   vcodec=mjpeg  min s=1280x720 fps=15 max s=1280x720 fps=60
[dshow @ 0000000001]   pixel_format=rgb24  min s=640x480 fps=5 max s=640x480 fps=30
"#;

    #[test]
    fn parses_raw_and_mjpeg_modes() {
        let modes = parse_camera_modes(SAMPLE_LISTING, 30.0);
        assert!(modes
            .iter()
            .any(|m| m.pixel_format.as_deref() == Some("yuyv422")
                && m.width == 640
                && m.fps == 30.0));
        assert!(modes
            .iter()
            .any(|m| m.codec.as_deref() == Some("mjpeg") && m.width == 1280));
        // rgb24 is not whitelisted.
        assert!(!modes
            .iter()
            .any(|m| m.pixel_format.as_deref() == Some("rgb24")));
    }

    #[test]
    fn clamps_same_size_fps_to_budget() {
        // Camera advertises up to 60fps but the budget is 30.
        let modes = parse_camera_modes(SAMPLE_LISTING, 30.0);
        let mjpeg = modes
            .iter()
            .find(|m| m.codec.as_deref() == Some("mjpeg"))
            .unwrap();
        assert_eq!(mjpeg.fps, 30.0);

        // If the advertised minimum exceeds the budget the mode is unusable.
        let high_min = "pixel_format=nv12  min s=640x480 fps=50 max s=640x480 fps=60";
        assert!(parse_camera_modes(high_min, 30.0).is_empty());
    }

    #[test]
    fn keeps_fractional_fps() {
        let text = "pixel_format=nv12  min s=1280x720 fps=10 max s=1280x720 fps=29.97";
        let modes = parse_camera_modes(text, 30.0);
        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].fps, 29.97);
    }

    #[test]
    fn ranged_modes_emit_only_advertised_endpoints() {
        let text = "pixel_format=yuyv422  min s=160x120 fps=5 max s=1280x720 fps=30";
        let modes = parse_camera_modes(text, 30.0);
        assert_eq!(modes.len(), 2);
        assert!(modes.iter().any(|m| m.width == 160 && m.fps == 5.0));
        assert!(modes.iter().any(|m| m.width == 1280 && m.fps == 30.0));
        // No intermediate sizes or clamped rates are invented.
        assert!(!modes.iter().any(|m| m.width == 640));

        // Max endpoint above the fps budget is dropped, not clamped.
        let modes = parse_camera_modes(text, 20.0);
        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].width, 160);
    }

    #[test]
    fn rejects_malformed_infinite_and_negative_values() {
        assert!(parse_camera_modes(
            "pixel_format=nv12  min s=640x480 fps=nan max s=640x480 fps=30",
            30.0
        )
        .is_empty());
        assert!(parse_camera_modes(
            "pixel_format=nv12  min s=640x480 fps=0 max s=640x480 fps=30",
            30.0
        )
        .is_empty());
        assert!(parse_camera_modes(
            "pixel_format=nv12  min s=640x480 fps=5 max s=640x480 fps=300",
            30.0
        )
        .is_empty());
        // An out-of-range endpoint in a ranged line is dropped, but the other
        // advertised endpoint remains valid.
        let modes = parse_camera_modes(
            "pixel_format=nv12  min s=0x480 fps=5 max s=640x480 fps=30",
            30.0,
        );
        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].width, 640);
        assert!(parse_camera_modes("not a mode line at all", 30.0).is_empty());
        assert!(parse_camera_modes(
            "vcodec=h265  min s=640x480 fps=5 max s=640x480 fps=30",
            30.0
        )
        .is_empty());
    }

    #[test]
    fn deduplicates_exact_modes() {
        let text = "pixel_format=nv12  min s=640x480 fps=5 max s=640x480 fps=30\n\
                    pixel_format=nv12  min s=640x480 fps=5 max s=640x480 fps=30";
        let modes = parse_camera_modes(text, 30.0);
        assert_eq!(modes.len(), 1);
    }

    #[test]
    fn ordering_prefers_budget_fit_then_cheap_formats() {
        let modes = parse_camera_modes(
            "vcodec=mjpeg  min s=1280x720 fps=15 max s=1280x720 fps=30\n\
             pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30\n\
             pixel_format=nv12  min s=1280x720 fps=10 max s=1280x720 fps=30\n\
             pixel_format=nv12  min s=1920x1080 fps=10 max s=1920x1080 fps=30",
            30.0,
        );
        let ordered = ordered_camera_modes(&modes, 1280, 720);
        assert!(ordered.len() <= 4);
        // 1280x720 nv12 beats 1280x720 mjpeg (cheaper format at same area/fps).
        assert_eq!(ordered[0].pixel_format.as_deref(), Some("nv12"));
        assert_eq!(ordered[0].width, 1280);
        // Oversized 1920x1080 sorts after every within-budget mode.
        assert_eq!(ordered.last().unwrap().width, 1920);
    }

    #[test]
    fn camera_profile_caps_fps_and_resolution() {
        let mut profile = super::super::config::builtin_profiles()
            .into_iter()
            .find(|p| p.id == "smooth-60fps")
            .unwrap();
        profile.fps = 60;
        let camera = camera_profile(&profile);
        assert_eq!(camera.fps, 30);
        assert_eq!((camera.width, camera.height), (1280, 720));

        let low = super::super::config::builtin_profiles()
            .into_iter()
            .find(|p| p.id == "low-impact")
            .unwrap();
        let camera = camera_profile(&low);
        assert_eq!((camera.width, camera.height), (854, 480));
    }

    #[test]
    fn busy_classifier_matches_known_messages() {
        assert!(is_device_busy_error(
            "ffmpeg exited: Could not run graph (device already in use by another application)"
        ));
        assert!(is_device_busy_error("device or resource busy"));
        assert!(!is_device_busy_error("Unknown encoder 'h264_mf'"));
        assert!(!is_device_busy_error("invalid argument"));
    }
}
