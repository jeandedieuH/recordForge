//! Encoder arguments for camera-primary captures.
//!
//! Unlike `ffmpeg::add_video_encoder` (tuned for realtime sidecar/screen work
//! — ultrafast + zerolatency + CBR), camera recordings are the primary
//! output: quality-oriented VBR with a maxrate/bufsize ceiling from the
//! capture plan, x264 without zerolatency, and hardware encoders in their
//! quality VBR modes. Option sets were verified against the pinned FFmpeg
//! 9.0.1 sidecar where the hardware is present (see M1 notes).

use std::process::Command;

use super::camera_plan::{x264_preset_for, x264_threads, CameraCapturePlan};

/// Append encoder selection and rate-control args for a camera capture.
///
/// `plan.output_fps` drives both the `-r` output rate and the GOP sizing so
/// the keyframe cadence stays ~1s on fractional rates like 29.97.
pub(crate) fn add_camera_encoder_args(
    command: &mut Command,
    plan: &CameraCapturePlan,
    encoder: &str,
) {
    command.arg("-c:v").arg(encoder);
    // No `-hw_encoding 1` for h264_mf (see the match arm below); MF accepts
    // nv12 either way so the pixel format stays consistent with the sidecar.
    command.args([
        "-pix_fmt",
        if encoder == "h264_mf" {
            "nv12"
        } else {
            "yuv420p"
        },
    ]);

    let target = format!("{}k", plan.video_bitrate_kbps);
    let maxrate = format!("{}k", plan.max_bitrate_kbps);
    let bufsize = format!("{}k", plan.buffer_kbps);

    let gop_size = plan.output_fps.round().max(1.0) as i32;
    command.args([
        "-g",
        &gop_size.to_string(),
        "-keyint_min",
        &(gop_size / 2).max(1).to_string(),
    ]);

    match encoder {
        "h264_nvenc" => {
            // Quality VBR: `-cq` sets the quality floor while `-b:v`/`-maxrate`
            // bound the average. `p4`/`hq` trade a little speed for detail —
            // the camera pipe has no realtime deadline like the sidecar.
            command.args([
                "-preset",
                "p4",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                &plan.crf.to_string(),
                "-b:v",
                &target,
                "-maxrate",
                &maxrate,
                "-bufsize",
                &bufsize,
            ]);
        }
        "h264_qsv" => {
            command.args([
                "-preset", "medium", "-b:v", &target, "-maxrate", &maxrate, "-bufsize", &bufsize,
            ]);
        }
        "h264_amf" => {
            command.args([
                "-quality", "quality", "-rc", "vbr_peak", "-b:v", &target, "-maxrate", &maxrate,
                "-bufsize", &bufsize,
            ]);
        }
        "h264_mf" => {
            // Verified on the pinned sidecar (FFmpeg 9.0.1): u_vbr accepts
            // -b:v as the VBR target and -maxrate/-bufsize ARE honored. Do
            // NOT pass `-hw_encoding 1` on this path: (a) with `+empty_moov`
            // the hw MFT's format-change extradata lands after the moov is
            // written and corrupts the stream — the mux side now drops
            // `empty_moov` for h264_mf (see `segment_movflags` in ffmpeg.rs);
            // (b) forced activation can stall past the 8s readiness window
            // while a sleeping discrete GPU wakes (observed on a dual-MFT
            // machine: NVIDIA + Intel). MF auto-selection still prefers a
            // hardware MFT when one exists, without either failure mode.
            command.args([
                "-rate_control",
                "u_vbr",
                "-b:v",
                &target,
                "-maxrate",
                &maxrate,
                "-bufsize",
                &bufsize,
            ]);
        }
        "h264_videotoolbox" | "hevc_videotoolbox" => {
            // Same knobs the sidecar uses, but at the plan's bitrate.
            command.args(["-b:v", &target, "-allow_sw", "1", "-realtime", "1"]);
        }
        "libx264" | "libx265" => {
            command.args([
                "-preset",
                x264_preset_for(&plan.profile_id, plan),
                "-threads",
                &x264_threads().to_string(),
            ]);
            if encoder == "libx264" {
                // No scenecut (a fixed camera framing produces false cuts on
                // lighting flicker), no lookahead/bframes — and deliberately
                // NO `-tune zerolatency`: this is the primary recording, not
                // a sidecar, so quality beats latency.
                command.args([
                    "-x264-params",
                    "no-scenecut=1:sync-lookahead=0:bframes=0",
                    "-crf",
                    &plan.crf.to_string(),
                    "-maxrate",
                    &maxrate,
                    "-bufsize",
                    &bufsize,
                ]);
            } else {
                command.args(["-crf", &plan.crf.to_string()]);
            }
        }
        _ => {
            command.args(["-preset", "ultrafast", "-crf", &plan.crf.to_string()]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::camera_plan::CameraCapturePlan;

    fn plan() -> CameraCapturePlan {
        CameraCapturePlan {
            profile_id: "camera-balanced".into(),
            input: None,
            output_width: 1920,
            output_height: 1080,
            output_fps: 30.0,
            video_bitrate_kbps: 6843,
            max_bitrate_kbps: 10264,
            buffer_kbps: 10264,
            crf: 21,
            limited_by_camera: false,
            fit: Default::default(),
        }
    }

    fn args(encoder: &str) -> Vec<String> {
        let mut command = Command::new("ffmpeg");
        add_camera_encoder_args(&mut command, &plan(), encoder);
        command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn paired<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1).map(String::as_str))
    }

    #[test]
    fn libx264_uses_quality_rate_control_without_zerolatency() {
        let args = args("libx264");
        assert_eq!(paired(&args, "-preset"), Some("superfast")); // 1080p30 > 35 Mpx/s
        assert_eq!(paired(&args, "-crf"), Some("21"));
        assert_eq!(paired(&args, "-maxrate"), Some("10264k"));
        assert_eq!(paired(&args, "-bufsize"), Some("10264k"));
        assert_eq!(paired(&args, "-pix_fmt"), Some("yuv420p"));
        assert_eq!(paired(&args, "-g"), Some("30"));
        assert!(paired(&args, "-threads").is_some());
        assert!(args.iter().any(|a| a.contains("no-scenecut=1")));
        // Camera-primary must not carry the sidecar's realtime tuning.
        assert!(!args.iter().any(|a| a == "zerolatency" || a == "-tune"));
        assert!(!args.iter().any(|a| a.contains("rc-lookahead=0")));
    }

    #[test]
    fn nvenc_uses_quality_vbr() {
        let args = args("h264_nvenc");
        assert_eq!(paired(&args, "-preset"), Some("p4"));
        assert_eq!(paired(&args, "-tune"), Some("hq"));
        assert_eq!(paired(&args, "-rc"), Some("vbr"));
        assert_eq!(paired(&args, "-cq"), Some("21"));
        assert_eq!(paired(&args, "-b:v"), Some("6843k"));
        assert_eq!(paired(&args, "-maxrate"), Some("10264k"));
        assert_eq!(paired(&args, "-bufsize"), Some("10264k"));
        assert!(!args.iter().any(|a| a == "ll"));
    }

    #[test]
    fn qsv_and_amf_use_vbr_with_caps() {
        let qsv = args("h264_qsv");
        assert_eq!(paired(&qsv, "-preset"), Some("medium"));
        assert_eq!(paired(&qsv, "-b:v"), Some("6843k"));
        assert_eq!(paired(&qsv, "-maxrate"), Some("10264k"));
        assert_eq!(paired(&qsv, "-bufsize"), Some("10264k"));

        let amf = args("h264_amf");
        assert_eq!(paired(&amf, "-quality"), Some("quality"));
        assert_eq!(paired(&amf, "-rc"), Some("vbr_peak"));
        assert_eq!(paired(&amf, "-maxrate"), Some("10264k"));
    }

    #[test]
    fn mediafoundation_uses_vbr_without_forced_hw() {
        let args = args("h264_mf");
        // `-hw_encoding 1` corrupts `+empty_moov` output and can stall MFT
        // activation past the readiness window — auto-selection still picks
        // hardware when available (see the match arm comment).
        assert!(!args.iter().any(|a| a == "-hw_encoding"));
        assert_eq!(paired(&args, "-pix_fmt"), Some("nv12"));
        assert_eq!(paired(&args, "-rate_control"), Some("u_vbr"));
        assert_eq!(paired(&args, "-b:v"), Some("6843k"));
        assert_eq!(paired(&args, "-maxrate"), Some("10264k"));
        assert_eq!(paired(&args, "-bufsize"), Some("10264k"));
    }

    #[test]
    fn videotoolbox_matches_sidecar_shape() {
        let args = args("h264_videotoolbox");
        assert_eq!(paired(&args, "-b:v"), Some("6843k"));
        assert_eq!(paired(&args, "-allow_sw"), Some("1"));
        assert_eq!(paired(&args, "-realtime"), Some("1"));
    }

    #[test]
    fn unknown_encoder_falls_back_to_crf() {
        let args = args("some_other_encoder");
        assert_eq!(paired(&args, "-crf"), Some("21"));
        assert!(!args.iter().any(|a| a == "-b:v"));
    }

    #[test]
    fn gop_tracks_fractional_rates() {
        let mut plan = plan();
        plan.output_fps = 29.97;
        let mut command = Command::new("ffmpeg");
        add_camera_encoder_args(&mut command, &plan, "libx264");
        let args: Vec<String> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // 29.97 rounds to a 30-frame GOP (~1s cadence).
        assert_eq!(paired(&args, "-g"), Some("30"));
        assert_eq!(paired(&args, "-keyint_min"), Some("15"));
    }
}
