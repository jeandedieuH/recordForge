//! Camera-mode capture planning.
//!
//! Pure planner for camera-primary recordings: given a camera tier profile
//! and the device's advertised modes (`webcam::probe_camera_modes`), produce
//! the ordered list of capture attempts — best first — always ending in a
//! device-defaults fallback. Unlike the sidecar's `ordered_camera_modes`
//! (which ranks by input area), this planner ranks by *fitted output* area
//! and rejects modes that cannot sustain a watchable frame rate, so a USB2
//! raw 1080p@5 mode never beats a 720p@30 MJPEG mode.

use serde::{Deserialize, Serialize};

use super::config::{camera_profiles, camera_tier_spec, CameraTierSpec, RecordingProfile};
use super::webcam::CameraMode;

/// Cap on negotiated-mode attempts before the device-defaults fallback;
/// keeps startup bounded like the sidecar path.
const MAX_MODE_ATTEMPTS: usize = 4;

/// One ordered camera capture attempt: the negotiated input mode (or `None`
/// for device defaults) plus the exact output geometry, rate control, and
/// fit the FFmpeg builder must apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraCapturePlan {
    /// Camera tier id (`camera-low` … `camera-ultra`).
    pub profile_id: String,
    /// Negotiated input mode; `None` = device defaults (last resort, or
    /// platforms without mode negotiation).
    pub input: Option<CameraMode>,
    pub output_width: u32,
    pub output_height: u32,
    /// Output frame rate — may be fractional (29.97).
    pub output_fps: f64,
    pub video_bitrate_kbps: u32,
    pub max_bitrate_kbps: u32,
    pub buffer_kbps: u32,
    pub crf: u8,
    /// True when the camera cannot fill the tier's budget on BOTH axes —
    /// e.g. a 720p-only device under a 1080p budget. A 4:3 output that fills
    /// the budget height (1440x1080) is NOT limited.
    pub limited_by_camera: bool,
    /// True when the ENCODER (not the camera) capped the output below the
    /// tier's budget — e.g. Ultra plans 1080p instead of 4K on a machine with
    /// no hardware H.264 encoder. Serialized so the UI can explain the
    /// downscale instead of silently promising 4K.
    pub encoder_limited: bool,
    /// How the input frames map onto the output; runtime-only metadata for
    /// the command builder, never serialized into the contract payload.
    #[serde(skip)]
    pub fit: CameraFit,
}

/// How an input mode maps onto the planned output frame.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CameraFit {
    /// Input already matches the output exactly — no scale filter.
    #[default]
    Native,
    /// Aspect-preserving scale to the output size.
    Scale,
    /// Scale + pad to a locked output size (resume/segment-concat safety);
    /// upscaling is acceptable here because every segment must stay
    /// stream-copy-concat compatible.
    Letterbox,
    /// Device-defaults attempt: clamp with `min(iw,W)/min(ih,H)` so whatever
    /// the device delivers is bounded, never upscaled.
    Adaptive,
}

/// Forced output geometry for a resume/locked-segment capture. Once a
/// session's first segment committed to a size/rate, later segments must
/// match it exactly so the fragments concat without re-encoding.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CameraOutputLock {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// Frame rate below which a camera mode is unusable for primary capture —
/// `min(target, 24)`. Choppy-but-real video (24-30) still ranks; slideshow
/// rates like a USB2 raw 1080p@5 mode do not.
fn fps_floor(target_fps: f64) -> f64 {
    target_fps.min(24.0)
}

/// Input pixel-format/codec cheapness for `camera-low`/`camera-balanced`:
/// same order the sidecar uses — formats the encoder consumes directly
/// first, MJPEG decode next, other raw conversions after, camera H.264 last.
fn low_overhead_format_rank(mode: &CameraMode) -> u8 {
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

/// Input format rank for `camera-high`/`camera-ultra`: quality-first, so
/// uncompressed formats beat MJPEG (compression artifacts in, detail out).
fn high_quality_format_rank(mode: &CameraMode) -> u8 {
    if let Some(format) = mode.pixel_format.as_deref() {
        return match format {
            "nv12" | "yuv420p" => 0,
            "yuyv422" | "uyvy422" => 1,
            _ => 2,
        };
    }
    match mode.codec.as_deref() {
        Some("mjpeg") => 3,
        _ => 4,
    }
}

fn format_rank(profile_id: &str, mode: &CameraMode) -> u8 {
    match profile_id {
        "camera-high" | "camera-ultra" => high_quality_format_rank(mode),
        _ => low_overhead_format_rank(mode),
    }
}

/// Round a dimension down to the next even number, never below 2.
fn even_down(value: u32) -> u32 {
    (value & !1).max(2)
}

/// Aspect-preserving fit of `w x h` inside `bw x bh`, never upscaling, with
/// even output dimensions.
fn fit_within_budget(w: u32, h: u32, bw: u32, bh: u32) -> (u32, u32, CameraFit) {
    if w <= bw && h <= bh {
        let (ow, oh) = (even_down(w), even_down(h));
        // Parity rounding that changes a dimension is still a scale.
        let fit = if ow == w && oh == h {
            CameraFit::Native
        } else {
            CameraFit::Scale
        };
        return (ow, oh, fit);
    }
    let factor = (bw as f64 / w as f64).min(bh as f64 / h as f64);
    let ow = even_down((w as f64 * factor) as u32);
    let oh = even_down((h as f64 * factor) as u32);
    (ow, oh, CameraFit::Scale)
}

/// Bitrate ladder for one attempt, from the OUTPUT geometry (never the
/// sensor size): `round(bpp * w * h * fps / 1000)` clamped to the tier's
/// [min,max] kbps, maxrate/buffer at 1.5x target.
fn rate_control(spec: &CameraTierSpec, out_w: u32, out_h: u32, out_fps: f64) -> (u32, u32, u32) {
    let target = (spec.bpp * out_w as f64 * out_h as f64 * out_fps / 1000.0).round() as u32;
    let target = target.clamp(spec.min_kbps, spec.max_kbps);
    let max = target * 3 / 2;
    (target, max, max)
}

fn build_plan(
    profile: &RecordingProfile,
    spec: &CameraTierSpec,
    input: Option<CameraMode>,
    out_w: u32,
    out_h: u32,
    out_fps: f64,
    fit: CameraFit,
) -> CameraCapturePlan {
    let (video_bitrate_kbps, max_bitrate_kbps, buffer_kbps) =
        rate_control(spec, out_w, out_h, out_fps);
    CameraCapturePlan {
        profile_id: profile.id.clone(),
        input,
        output_width: out_w,
        output_height: out_h,
        output_fps: out_fps,
        video_bitrate_kbps,
        max_bitrate_kbps,
        buffer_kbps,
        crf: spec.crf,
        // "Limited" only when the camera fills neither budget axis — a 4:3
        // sensor that reaches the full budget height still gets the tier's
        // real output density on the axis that matters.
        limited_by_camera: out_w < profile.width as u32 && out_h < profile.height as u32,
        encoder_limited: false,
        fit,
    }
}

/// Order camera-mode capture attempts for a tier: best fitted output first.
///
/// `lock` forces every attempt's output to the locked geometry — used when
/// resuming a session so each segment stays stream-copy-concat compatible
/// (Letterbox pads odd aspects rather than changing the output size).
///
/// Returns an empty vec for non-camera-tier profiles. Otherwise always ends
/// with a device-defaults attempt so the caller can retry without a
/// negotiated mode.
pub fn plan_camera_capture(
    profile: &RecordingProfile,
    modes: &[CameraMode],
    lock: Option<CameraOutputLock>,
) -> Vec<CameraCapturePlan> {
    let Some(spec) = camera_tier_spec(&profile.id) else {
        return Vec::new();
    };
    let (budget_w, budget_h) = (profile.width.max(1) as u32, profile.height.max(1) as u32);
    let target_fps = profile.fps as f64;
    let floor = fps_floor(target_fps);

    // Geometry + rate for one mode under the (optional) lock.
    let fitted = |mode: &CameraMode| -> (u32, u32, f64, CameraFit) {
        if let Some(lock) = lock {
            let fit = if mode.width == lock.width && mode.height == lock.height {
                CameraFit::Native
            } else if mode.width as u64 * lock.height as u64
                == mode.height as u64 * lock.width as u64
            {
                CameraFit::Scale
            } else {
                CameraFit::Letterbox
            };
            return (lock.width, lock.height, lock.fps, fit);
        }
        let (ow, oh, fit) = fit_within_budget(mode.width, mode.height, budget_w, budget_h);
        (ow, oh, mode.fps.min(target_fps), fit)
    };

    let mut eligible: Vec<&CameraMode> = modes.iter().filter(|m| m.fps >= floor).collect();
    if eligible.is_empty() {
        // Everything advertised is below the floor — the user still gets a
        // recording, ranked by the closest thing to real-time the device has.
        eligible = modes.iter().collect();
        eligible.sort_by(|a, b| {
            b.fps
                .partial_cmp(&a.fps)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    (b.width as u64 * b.height as u64).cmp(&(a.width as u64 * a.height as u64))
                })
        });
    } else {
        eligible.sort_by(|a, b| {
            let (aw, ah, afps, afit) = fitted(a);
            let (bw, bh, bfps, bfit) = fitted(b);
            (bw as u64 * bh as u64)
                .cmp(&(aw as u64 * ah as u64))
                .then_with(|| {
                    (afit == CameraFit::Native)
                        .cmp(&(bfit == CameraFit::Native))
                        .reverse()
                })
                .then_with(|| bfps.partial_cmp(&afps).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| format_rank(&profile.id, a).cmp(&format_rank(&profile.id, b)))
                .then_with(|| {
                    (a.width as u64 * a.height as u64).cmp(&(b.width as u64 * b.height as u64))
                })
        });
    }

    let mut attempts: Vec<CameraCapturePlan> = Vec::with_capacity(MAX_MODE_ATTEMPTS + 1);
    let mut seen_inputs: Vec<&CameraMode> = Vec::new();
    for mode in eligible {
        if attempts.len() >= MAX_MODE_ATTEMPTS {
            break;
        }
        if seen_inputs.contains(&mode) {
            continue;
        }
        seen_inputs.push(mode);
        let (ow, oh, ofps, fit) = fitted(mode);
        attempts.push(build_plan(
            profile,
            &spec,
            Some(mode.clone()),
            ow,
            oh,
            ofps,
            fit,
        ));
    }

    // Last resort: let the device pick its default mode. Under a lock the
    // output is still forced to the locked frame; otherwise the budget is
    // the ceiling the Adaptive clamp enforces.
    let (ow, oh, ofps, fit) = match lock {
        Some(lock) => (lock.width, lock.height, lock.fps, CameraFit::Letterbox),
        None => (budget_w, budget_h, target_fps, CameraFit::Adaptive),
    };
    attempts.push(build_plan(profile, &spec, None, ow, oh, ofps, fit));

    attempts
}

/// First (best) attempt for each camera tier, in tier order — the shape the
/// UI needs after a single device probe to preview all four qualities.
///
/// `hardware_encoder` applies the software-encoder output cap (see
/// [`plan_camera_capture_for_encoders`]) so the picker never advertises 4K on
/// a machine that would encode it with libx264.
pub fn plan_all_tiers(modes: &[CameraMode], hardware_encoder: bool) -> Vec<CameraCapturePlan> {
    camera_profiles()
        .iter()
        .filter_map(|profile| {
            plan_camera_capture_for_encoders(profile, modes, None, hardware_encoder)
                .into_iter()
                .next()
        })
        .collect()
}

/// Output height a software-only encoder may not exceed.
///
/// Software x264 at 4K30 measured ~1.24 cores and 427 MB RSS on an i5-11400H
/// before preview and UI — the 4C/8T low-end target cannot sustain it, and a
/// camera-only recording has no second encoder to offload to. 1080p at the
/// tier's bitrate is the honest ceiling.
pub const SOFTWARE_OUTPUT_HEIGHT_CAP: u32 = 1080;

/// Plan a tier for the encoders this machine actually has.
///
/// With no hardware H.264 encoder available, the tier's output budget is
/// clamped to [`SOFTWARE_OUTPUT_HEIGHT_CAP`] (aspect preserved) and every plan
/// is marked `encoder_limited` so the UI can explain the downscale. A locked
/// segment geometry is never clamped: pause/resume fragments must stay
/// stream-copy-concat compatible with the first segment.
pub fn plan_camera_capture_for_encoders(
    profile: &RecordingProfile,
    modes: &[CameraMode],
    lock: Option<CameraOutputLock>,
    hardware_encoder: bool,
) -> Vec<CameraCapturePlan> {
    if hardware_encoder || lock.is_some() {
        return plan_camera_capture(profile, modes, lock);
    }

    let budget_height = profile.height.max(0) as u32;
    if budget_height <= SOFTWARE_OUTPUT_HEIGHT_CAP {
        return plan_camera_capture(profile, modes, lock);
    }

    // Preserve the aspect ratio rather than distorting: only the 16:9 4K tier
    // exceeds the cap today, so 3840x2160 becomes 1920x1080.
    let factor = SOFTWARE_OUTPUT_HEIGHT_CAP as f64 / budget_height as f64;
    let capped_width = even_down((profile.width.max(0) as f64 * factor) as u32);
    let mut capped = profile.clone();
    capped.width = capped_width as i32;
    capped.height = SOFTWARE_OUTPUT_HEIGHT_CAP as i32;

    plan_camera_capture(&capped, modes, lock)
        .into_iter()
        .map(|plan| CameraCapturePlan {
            encoder_limited: true,
            ..plan
        })
        .collect()
}

/// x264 speed preset for a camera attempt, traded against the output pixel
/// rate so realtime encoding survives on low-end CPUs. Ultra is already
/// expensive at 4K30 (~249 Mpx/s), so it takes the cheapest preset.
///
/// Software x264 cannot hold realtime at 1080p30+ with a quality preset on the
/// 4C/8T low-end target (measured ~0.86 core for `superfast` at 1080p30 on an
/// i5-11400H; a 2018-era mobile CPU needs roughly 1.5x that), and a camera-only
/// recording has no second encoder to offload to. Above the 35 Mpx/s knee
/// (1080p30) the ladder therefore drops one rung and the tier's `crf`/bitrate
/// budget — not the preset — carries the quality difference.
pub fn x264_preset_for(profile_id: &str, plan: &CameraCapturePlan) -> &'static str {
    let mpx_per_s = plan.output_width as f64 * plan.output_height as f64 * plan.output_fps / 1e6;
    let heavy = mpx_per_s > 35.0;
    match profile_id {
        "camera-low" => "ultrafast",
        "camera-balanced" => {
            if heavy {
                "ultrafast"
            } else {
                "superfast"
            }
        }
        "camera-high" => {
            if heavy {
                "superfast"
            } else {
                "veryfast"
            }
        }
        "camera-ultra" => "ultrafast",
        // Camera profiles only; anything else gets a safe middle preset.
        _ => "veryfast",
    }
}

/// Encoder thread budget for camera captures: half the logical cores,
/// clamped so low-end machines aren't starved and high-end ones don't
/// thrash the rest of the session.
pub fn x264_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 4))
        .unwrap_or(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tier(id: &str) -> RecordingProfile {
        camera_profiles()
            .into_iter()
            .find(|p| p.id == id)
            .expect("camera tier")
    }

    fn mode(
        width: u32,
        height: u32,
        fps: f64,
        pixel_format: Option<&str>,
        codec: Option<&str>,
    ) -> CameraMode {
        CameraMode {
            width,
            height,
            fps,
            pixel_format: pixel_format.map(str::to_string),
            codec: codec.map(str::to_string),
        }
    }

    /// Typical USB webcam: raw modes stall above 720p, MJPEG carries 1080p.
    fn typical_webcam() -> Vec<CameraMode> {
        vec![
            mode(640, 480, 30.0, Some("yuyv422"), None),
            mode(1280, 720, 30.0, Some("yuyv422"), None),
            mode(1280, 720, 30.0, None, Some("mjpeg")),
            mode(1920, 1080, 30.0, None, Some("mjpeg")),
            mode(1920, 1080, 5.0, Some("yuyv422"), None),
        ]
    }

    #[test]
    fn balanced_picks_native_1080p_mjpeg_over_low_fps_raw() {
        let plans = plan_camera_capture(&tier("camera-balanced"), &typical_webcam(), None);
        let first = &plans[0];
        let input = first.input.as_ref().expect("mode-based attempt");
        assert_eq!(input.codec.as_deref(), Some("mjpeg"));
        assert_eq!((input.width, input.height), (1920, 1080));
        assert_eq!((first.output_width, first.output_height), (1920, 1080));
        assert_eq!(first.output_fps, 30.0);
        assert_eq!(first.fit, CameraFit::Native);
        assert!(!first.limited_by_camera);
        // 0.11 bpp * 1920*1080 * 30 = 6843 kbps nominal.
        assert!((first.video_bitrate_kbps as f64 - 6842.0).abs() <= 6842.0 * 0.01);
        assert_eq!(first.max_bitrate_kbps, first.video_bitrate_kbps * 3 / 2);
        assert_eq!(first.buffer_kbps, first.max_bitrate_kbps);
        // The 5fps raw 1080p mode must never appear as an attempt.
        assert!(!plans
            .iter()
            .any(|p| p.input.as_ref().map(|m| m.fps < 24.0).unwrap_or(false)));
        // Device-defaults attempt is always last.
        let last = plans.last().unwrap();
        assert!(last.input.is_none());
        assert_eq!(last.fit, CameraFit::Adaptive);
        assert_eq!((last.output_width, last.output_height), (1920, 1080));
        assert!(!last.limited_by_camera);
    }

    #[test]
    fn low_tier_picks_a_720p_mode() {
        let plans = plan_camera_capture(&tier("camera-low"), &typical_webcam(), None);
        let first = &plans[0];
        assert_eq!((first.output_width, first.output_height), (1280, 720));
        assert_eq!(first.output_fps, 30.0);
        // Budget filled on both axes of the 720p tier → not limited.
        assert!(!first.limited_by_camera);
    }

    #[test]
    fn ultra_picks_4k_and_high_picks_native_1080p() {
        let modes = vec![
            mode(3840, 2160, 30.0, Some("nv12"), None),
            mode(1920, 1080, 30.0, Some("nv12"), None),
            mode(1280, 720, 30.0, Some("yuyv422"), None),
        ];
        let ultra = plan_camera_capture(&tier("camera-ultra"), &modes, None);
        assert_eq!(
            (ultra[0].output_width, ultra[0].output_height),
            (3840, 2160)
        );
        assert_eq!(ultra[0].fit, CameraFit::Native);

        let high = plan_camera_capture(&tier("camera-high"), &modes, None);
        // The 4K mode fits the budget only by scaling down to 1080p — the
        // native 1080p mode wins on identical output geometry (native first).
        let input = high[0].input.as_ref().unwrap();
        assert_eq!((input.width, input.height), (1920, 1080));
        assert_eq!(high[0].fit, CameraFit::Native);
        // The scaled-from-4K attempt still exists as a fallback.
        assert!(high
            .iter()
            .any(|p| p.input.as_ref().map(|m| m.width == 3840).unwrap_or(false)));
    }

    #[test]
    fn small_camera_marks_limited() {
        let modes = vec![mode(1280, 720, 30.0, Some("nv12"), None)];
        let plans = plan_camera_capture(&tier("camera-balanced"), &modes, None);
        assert_eq!((plans[0].output_width, plans[0].output_height), (1280, 720));
        assert!(plans[0].limited_by_camera);
        // The defaults attempt still advertises the budget ceiling.
        assert!(!plans.last().unwrap().limited_by_camera);
    }

    #[test]
    fn scaled_4x3_outranks_smaller_native() {
        // 1600x1200 scaled to 1440x1080 carries more output detail than a
        // native 1280x960 — output area decides, not "native at any size".
        let modes = vec![
            mode(1600, 1200, 30.0, Some("yuyv422"), None),
            mode(1280, 960, 30.0, Some("yuyv422"), None),
        ];
        let plans = plan_camera_capture(&tier("camera-balanced"), &modes, None);
        assert_eq!(
            (plans[0].output_width, plans[0].output_height),
            (1440, 1080)
        );
        assert_eq!(plans[0].fit, CameraFit::Scale);
        assert_eq!(plans[0].input.as_ref().unwrap().width, 1600);
        // Fills the budget height → not limited.
        assert!(!plans[0].limited_by_camera);
        assert_eq!((plans[1].output_width, plans[1].output_height), (1280, 960));
        assert_eq!(plans[1].fit, CameraFit::Native);
        assert!(plans[1].limited_by_camera);
    }

    #[test]
    fn all_modes_below_floor_still_return_ranked_fallback() {
        let modes = vec![
            mode(1920, 1080, 5.0, Some("yuyv422"), None),
            mode(640, 480, 15.0, Some("yuyv422"), None),
            mode(1280, 720, 10.0, None, Some("mjpeg")),
        ];
        let plans = plan_camera_capture(&tier("camera-balanced"), &modes, None);
        // Sorted by fps desc: 15fps 480p first despite the smaller area.
        assert_eq!(plans[0].input.as_ref().unwrap().fps, 15.0);
        assert_eq!(plans[1].input.as_ref().unwrap().fps, 10.0);
        assert!(plans.last().unwrap().input.is_none());
    }

    #[test]
    fn empty_modes_yield_only_device_defaults() {
        let plans = plan_camera_capture(&tier("camera-balanced"), &[], None);
        assert_eq!(plans.len(), 1);
        assert!(plans[0].input.is_none());
        assert_eq!(plans[0].fit, CameraFit::Adaptive);
        assert_eq!(
            (plans[0].output_width, plans[0].output_height),
            (1920, 1080)
        );
        assert_eq!(plans[0].output_fps, 30.0);
    }

    #[test]
    fn fractional_fps_is_kept_and_counts_as_30() {
        let modes = vec![mode(1920, 1080, 29.97, None, Some("mjpeg"))];
        let plans = plan_camera_capture(&tier("camera-balanced"), &modes, None);
        assert_eq!(plans[0].output_fps, 29.97);
        assert_eq!(plans[0].input.as_ref().unwrap().fps, 29.97);
        // Bitrate derives from the fractional rate.
        let expected = (0.11_f64 * 1920.0 * 1080.0 * 29.97 / 1000.0).round() as u32;
        assert_eq!(plans[0].video_bitrate_kbps, expected);
    }

    #[test]
    fn lock_forces_geometry_and_fit() {
        let lock = CameraOutputLock {
            width: 1440,
            height: 1080,
            fps: 30.0,
        };
        let modes = vec![
            mode(1440, 1080, 30.0, Some("nv12"), None),
            mode(1600, 1200, 30.0, Some("nv12"), None),
            mode(1920, 1080, 30.0, Some("nv12"), None),
        ];
        let plans = plan_camera_capture(&tier("camera-balanced"), &modes, lock.into());
        assert!(plans.iter().all(|p| {
            p.output_width == 1440 && p.output_height == 1080 && p.output_fps == 30.0
        }));
        let by_input = |w: u32| {
            plans
                .iter()
                .find(|p| p.input.as_ref().map(|m| m.width == w).unwrap_or(false))
                .unwrap()
        };
        assert_eq!(by_input(1440).fit, CameraFit::Native);
        assert_eq!(by_input(1600).fit, CameraFit::Scale);
        assert_eq!(by_input(1920).fit, CameraFit::Letterbox);
        // Device-defaults attempt letterboxes to the lock too.
        let last = plans.last().unwrap();
        assert!(last.input.is_none());
        assert_eq!(last.fit, CameraFit::Letterbox);
    }

    #[test]
    fn non_camera_profile_yields_no_plans() {
        let screen = RecordingProfile {
            id: "balanced".into(),
            label: "Balanced".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: Some(4000),
            crf: Some(23),
            encoder_priority: vec![],
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 128,
        };
        assert!(plan_camera_capture(&screen, &typical_webcam(), None).is_empty());
    }

    #[test]
    fn plan_all_tiers_returns_one_plan_per_tier_in_order() {
        let plans = plan_all_tiers(&typical_webcam(), true);
        assert_eq!(plans.len(), 4);
        let ids: Vec<&str> = plans.iter().map(|p| p.profile_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "camera-low",
                "camera-balanced",
                "camera-high",
                "camera-ultra"
            ]
        );
    }

    #[test]
    fn software_only_caps_ultra_to_1080p() {
        let modes = vec![mode(3840, 2160, 30.0, Some("nv12"), None)];
        let ultra = tier("camera-ultra");

        // Hardware encoder: the tier's 4K budget stands.
        let hardware = plan_camera_capture_for_encoders(&ultra, &modes, None, true);
        assert_eq!(
            (hardware[0].output_width, hardware[0].output_height),
            (3840, 2160)
        );
        assert!(!hardware[0].encoder_limited);

        // Software encoder: 4K30 libx264 measured ~1.24 cores + 427 MB before
        // preview/UI, so Ultra plans 1080p instead and says why.
        let software = plan_camera_capture_for_encoders(&ultra, &modes, None, false);
        assert_eq!(
            (software[0].output_width, software[0].output_height),
            (1920, 1080)
        );
        assert!(software[0].encoder_limited);
        // The camera fills the capped budget → the camera is not the limit.
        assert!(!software[0].limited_by_camera);
        // Rate control re-derives from the capped geometry, still inside the
        // tier's clamp (ultra min 10000 kbps at 1080p30).
        assert_eq!(software[0].video_bitrate_kbps, 10_000);
        // The device-defaults attempt is capped too.
        assert!(software.last().unwrap().encoder_limited);
        assert_eq!(
            (
                software.last().unwrap().output_width,
                software.last().unwrap().output_height
            ),
            (1920, 1080)
        );

        // Tiers already at or below the cap are untouched and unflagged.
        let balanced = tier("camera-balanced");
        let plans = plan_camera_capture_for_encoders(&balanced, &modes, None, false);
        assert_eq!(
            (plans[0].output_width, plans[0].output_height),
            (1920, 1080)
        );
        assert!(!plans[0].encoder_limited);
    }

    #[test]
    fn software_only_cap_is_aspect_preserving_and_even() {
        let mut ultra = tier("camera-ultra");
        // A DCI-ish 4096x2160 budget becomes 2048x1080, not 1920x1080.
        ultra.width = 4096;
        let modes = vec![mode(4096, 2160, 30.0, Some("nv12"), None)];
        let plans = plan_camera_capture_for_encoders(&ultra, &modes, None, false);
        assert_eq!(
            (plans[0].output_width, plans[0].output_height),
            (2048, 1080)
        );
        assert_eq!(plans[0].output_width % 2, 0);
        assert!(plans[0].encoder_limited);
    }

    #[test]
    fn output_lock_wins_over_the_software_cap() {
        // A resumed segment must match segment 0 exactly so the fragments
        // concat without a re-encode — even if the encoder set changed.
        let lock = CameraOutputLock {
            width: 3840,
            height: 2160,
            fps: 30.0,
        };
        let modes = vec![mode(3840, 2160, 30.0, Some("nv12"), None)];
        let plans =
            plan_camera_capture_for_encoders(&tier("camera-ultra"), &modes, lock.into(), false);
        assert!(plans
            .iter()
            .all(|p| p.output_width == 3840 && p.output_height == 2160));
        assert!(plans.iter().all(|p| !p.encoder_limited));
    }

    #[test]
    fn high_tier_prefers_raw_over_mjpeg() {
        let modes = vec![
            mode(1920, 1080, 30.0, Some("yuyv422"), None),
            mode(1920, 1080, 30.0, None, Some("mjpeg")),
        ];
        let high = plan_camera_capture(&tier("camera-high"), &modes, None);
        assert_eq!(
            high[0].input.as_ref().unwrap().pixel_format.as_deref(),
            Some("yuyv422")
        );
        // Balanced keeps the cheapness order — MJPEG beats raw yuyv422.
        let balanced = plan_camera_capture(&tier("camera-balanced"), &modes, None);
        assert_eq!(
            balanced[0].input.as_ref().unwrap().codec.as_deref(),
            Some("mjpeg")
        );
    }

    #[test]
    fn attempts_are_capped_and_deduped() {
        let mut modes = typical_webcam();
        // Duplicate an advertised mode and add extra distinct modes.
        modes.push(mode(1920, 1080, 30.0, None, Some("mjpeg")));
        modes.push(mode(800, 600, 30.0, Some("nv12"), None));
        modes.push(mode(960, 720, 30.0, Some("nv12"), None));
        modes.push(mode(176, 144, 30.0, Some("nv12"), None));
        let plans = plan_camera_capture(&tier("camera-balanced"), &modes, None);
        let mode_attempts = plans.iter().filter(|p| p.input.is_some()).count();
        assert!(mode_attempts <= MAX_MODE_ATTEMPTS);
        assert!(plans.last().unwrap().input.is_none());
    }

    #[test]
    fn output_dimensions_are_always_even() {
        let modes = vec![
            mode(1919, 1079, 30.0, Some("nv12"), None),
            mode(641, 481, 30.0, Some("nv12"), None),
        ];
        let plans = plan_camera_capture(&tier("camera-balanced"), &modes, None);
        for plan in &plans {
            assert_eq!(plan.output_width % 2, 0, "{}", plan.output_width);
            assert_eq!(plan.output_height % 2, 0, "{}", plan.output_height);
        }
    }

    #[test]
    fn presets_follow_output_pixel_rate() {
        let balanced = tier("camera-balanced");
        let small = plan_camera_capture(
            &balanced,
            &[mode(1280, 720, 30.0, Some("nv12"), None)],
            None,
        );
        // 720p30 = 27.6 Mpx/s (below the 35 Mpx/s knee) → superfast.
        assert_eq!(x264_preset_for("camera-balanced", &small[0]), "superfast");
        let big = plan_camera_capture(
            &balanced,
            &[mode(1920, 1080, 30.0, Some("nv12"), None)],
            None,
        );
        // 1080p30 = 62.2 Mpx/s: software x264 drops to ultrafast so the
        // default tier stays realtime on low-end CPUs (0.44 vs 0.86 core).
        assert_eq!(x264_preset_for("camera-balanced", &big[0]), "ultrafast");
        assert_eq!(x264_preset_for("camera-low", &small[0]), "ultrafast");
        assert_eq!(x264_preset_for("camera-ultra", &big[0]), "ultrafast");
        let high_big = plan_camera_capture(
            &tier("camera-high"),
            &[mode(1920, 1080, 30.0, Some("nv12"), None)],
            None,
        );
        // High Quality keeps one rung above the default tier at 1080p, not
        // the two-rung `veryfast` that costs a full core.
        assert_eq!(x264_preset_for("camera-high", &high_big[0]), "superfast");
    }

    #[test]
    fn x264_threads_is_bounded() {
        let threads = x264_threads();
        assert!((2..=4).contains(&threads));
    }
}
