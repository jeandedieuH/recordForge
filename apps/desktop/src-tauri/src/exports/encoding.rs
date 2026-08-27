use std::process::Command;

use super::ExportSettings;

/// Encoder backend selected for an export render. Hardware variants mirror the
/// capture-side probe list; software is always available as the fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportEncoder {
    Software,
    VideoToolbox,
    Nvenc,
    Qsv,
    Amf,
    Mf,
}

const HARDWARE_PRIORITY: [ExportEncoder; 5] = [
    ExportEncoder::VideoToolbox,
    ExportEncoder::Nvenc,
    ExportEncoder::Qsv,
    ExportEncoder::Amf,
    ExportEncoder::Mf,
];

impl ExportEncoder {
    pub(crate) fn h264_id(self) -> &'static str {
        match self {
            ExportEncoder::Software => "libx264",
            ExportEncoder::VideoToolbox => "h264_videotoolbox",
            ExportEncoder::Nvenc => "h264_nvenc",
            ExportEncoder::Qsv => "h264_qsv",
            ExportEncoder::Amf => "h264_amf",
            ExportEncoder::Mf => "h264_mf",
        }
    }

    pub(crate) fn hevc_id(self) -> &'static str {
        match self {
            ExportEncoder::Software => "libx265",
            ExportEncoder::VideoToolbox => "hevc_videotoolbox",
            ExportEncoder::Nvenc => "hevc_nvenc",
            ExportEncoder::Qsv => "hevc_qsv",
            ExportEncoder::Amf => "hevc_amf",
            ExportEncoder::Mf => "hevc_mf",
        }
    }

    fn encoder_id(self, codec: &str) -> &'static str {
        if codec == "hevc" {
            self.hevc_id()
        } else {
            self.h264_id()
        }
    }

    pub(crate) fn display_name(self) -> &'static str {
        match self {
            ExportEncoder::Software => "software (x264/x265)",
            ExportEncoder::VideoToolbox => "Apple VideoToolbox",
            ExportEncoder::Nvenc => "NVIDIA NVENC",
            ExportEncoder::Qsv => "Intel Quick Sync",
            ExportEncoder::Amf => "AMD AMF",
            ExportEncoder::Mf => "Media Foundation",
        }
    }
}

/// Resolve the encoder for one export.
///
/// `available` holds encoder ids probed at startup (h264 variants only, shared
/// with the capture path). HEVC hardware variants are not part of the startup
/// probe, so `hevc_supported` must verify the candidate's hevc encoder can
/// actually initialize before it is selected for a hevc export.
pub(crate) fn resolve_export_encoder(
    preference: &str,
    codec: &str,
    available: &[String],
    mut hevc_supported: impl FnMut(ExportEncoder) -> bool,
) -> ExportEncoder {
    if preference == "software" {
        return ExportEncoder::Software;
    }
    for candidate in HARDWARE_PRIORITY {
        if !available.iter().any(|id| id == candidate.h264_id()) {
            continue;
        }
        if codec == "hevc" && !hevc_supported(candidate) {
            continue;
        }
        return candidate;
    }
    ExportEncoder::Software
}

fn software_preset(preset: &str) -> (&'static str, &'static str) {
    match preset {
        "fast-share" => ("ultrafast", "23"),
        "high-quality" => ("medium", "18"),
        "smooth-60fps" => ("veryfast", "20"),
        "ultra-4k" | "ultra-4k-60" => ("veryfast", "18"),
        "vertical" | "square" => ("veryfast", "20"),
        _ => ("veryfast", "20"),
    }
}

fn quality_crf(preset: &str) -> u8 {
    software_preset(preset).1.parse().unwrap_or(20)
}

/// Append encoder arguments for one export render. Hardware encoders have no
/// CRF mode, so the export preset's CRF target maps to each vendor's closest
/// constant-quality mode; software output is unchanged from the legacy path.
pub(crate) fn append_export_video_args(
    command: &mut Command,
    settings: &ExportSettings,
    encoder: ExportEncoder,
    fps: u32,
    canvas_width: u32,
    canvas_height: u32,
) {
    let target_fps = match settings.preset.as_str() {
        "smooth-60fps" | "ultra-4k-60" => 60,
        _ => fps,
    };
    let crf = quality_crf(&settings.preset);
    // `fast-share` favors speed, `high-quality`/`ultra-*` favor quality, and
    // everything else sits in the balanced tier.
    let quality_tier = matches!(
        settings.preset.as_str(),
        "high-quality" | "ultra-4k" | "ultra-4k-60"
    );

    command.arg("-c:v").arg(encoder.encoder_id(&settings.codec));
    match encoder {
        ExportEncoder::Software => {
            let (preset, crf) = software_preset(&settings.preset);
            command.arg("-preset").arg(preset).arg("-crf").arg(crf);
        }
        ExportEncoder::VideoToolbox => {
            let bits_per_pixel = if settings.preset == "fast-share" {
                0.07
            } else if quality_tier {
                0.14
            } else {
                0.10
            };
            let bitrate_kbps =
                (canvas_width as f64 * canvas_height as f64 * target_fps as f64 * bits_per_pixel
                    / 1000.0)
                    .clamp(2_500.0, 80_000.0) as u32;
            command
                .arg("-b:v")
                .arg(format!("{bitrate_kbps}k"))
                .arg("-allow_sw")
                .arg("1")
                .arg("-realtime")
                .arg("0");
        }
        ExportEncoder::Nvenc => {
            command
                .arg("-preset")
                .arg(if quality_tier { "p6" } else { "p4" })
                .arg("-tune")
                .arg("hq")
                .arg("-rc")
                .arg("vbr")
                .arg("-cq")
                .arg(crf.to_string())
                // A nonzero default bitrate cap would override -cq, so pin it to 0.
                .arg("-b:v")
                .arg("0");
        }
        ExportEncoder::Qsv => {
            command
                .arg("-preset")
                .arg(if settings.preset == "fast-share" {
                    "veryfast"
                } else if quality_tier {
                    "slow"
                } else {
                    "medium"
                })
                .arg("-global_quality")
                .arg(crf.to_string());
            if settings.codec != "hevc" {
                command.arg("-look_ahead").arg("1");
            }
        }
        ExportEncoder::Amf => {
            command
                .arg("-quality")
                .arg(if settings.preset == "fast-share" {
                    "balanced"
                } else {
                    "quality"
                })
                .arg("-rc")
                .arg("cqp")
                .arg("-qp_i")
                .arg(crf.to_string())
                .arg("-qp_p")
                .arg((crf + 2).min(51).to_string());
        }
        ExportEncoder::Mf => {
            // Media Foundation has no constant-quality mode that is reliable
            // across MFT implementations, so quality maps to a resolution- and
            // framerate-derived CBR target.
            let bits_per_pixel = if settings.preset == "fast-share" {
                0.06
            } else if quality_tier {
                0.12
            } else {
                0.09
            };
            let bitrate_kbps =
                (canvas_width as f64 * canvas_height as f64 * target_fps as f64 * bits_per_pixel
                    / 1000.0)
                    .clamp(2_000.0, 60_000.0) as u32;
            command
                .arg("-rate_control")
                .arg("cbr")
                .arg("-b:v")
                .arg(format!("{bitrate_kbps}k"));
        }
    }
    command
        .arg("-r")
        .arg(target_fps.to_string())
        .args(["-pix_fmt", "yuv420p"]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(preset: &str, codec: &str, encoder: &str) -> ExportSettings {
        ExportSettings {
            preset: preset.into(),
            codec: codec.into(),
            encoder: encoder.into(),
            container: "mp4".into(),
            caption_mode: "burn-in".into(),
            chapter_mode: "embed".into(),
            range: None,
        }
    }

    fn args_of(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect()
    }

    fn available(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn software_preference_always_forces_software() {
        let resolved = resolve_export_encoder(
            "software",
            "h264",
            &available(&["h264_nvenc", "h264_qsv"]),
            |_| true,
        );
        assert_eq!(resolved, ExportEncoder::Software);
    }

    #[test]
    fn auto_prefers_hardware_in_priority_order() {
        let resolved = resolve_export_encoder(
            "auto",
            "h264",
            &available(&["libx264", "h264_amf", "h264_qsv"]),
            |_| true,
        );
        assert_eq!(resolved, ExportEncoder::Qsv);

        let resolved = resolve_export_encoder(
            "auto",
            "h264",
            &available(&["h264_nvenc", "h264_amf"]),
            |_| true,
        );
        assert_eq!(resolved, ExportEncoder::Nvenc);

        let resolved = resolve_export_encoder("auto", "h264", &available(&["libx264"]), |_| true);
        assert_eq!(resolved, ExportEncoder::Software);
    }

    #[test]
    fn hevc_exports_verify_the_vendor_hevc_encoder() {
        let mut probed = Vec::new();
        let resolved = resolve_export_encoder(
            "auto",
            "hevc",
            &available(&["h264_nvenc", "h264_qsv"]),
            |candidate| {
                probed.push(candidate);
                candidate != ExportEncoder::Nvenc
            },
        );
        // NVENC h264 is available but its hevc variant was rejected, so the
        // resolver falls through to Quick Sync.
        assert_eq!(resolved, ExportEncoder::Qsv);
        assert_eq!(probed, vec![ExportEncoder::Nvenc, ExportEncoder::Qsv]);
    }

    #[test]
    fn encoder_ids_follow_the_selected_codec() {
        assert_eq!(ExportEncoder::Nvenc.encoder_id("h264"), "h264_nvenc");
        assert_eq!(ExportEncoder::Nvenc.encoder_id("hevc"), "hevc_nvenc");
        assert_eq!(ExportEncoder::Software.encoder_id("h264"), "libx264");
        assert_eq!(ExportEncoder::Software.encoder_id("hevc"), "libx265");
        assert_eq!(ExportEncoder::Mf.encoder_id("hevc"), "hevc_mf");
    }

    #[test]
    fn software_args_keep_the_legacy_preset_and_crf_mapping() {
        let mut command = Command::new("ffmpeg");
        append_export_video_args(
            &mut command,
            &settings("fast-share", "h264", "auto"),
            ExportEncoder::Software,
            30,
            1920,
            1080,
        );
        let args = args_of(&command);
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|pair| pair == ["-preset", "ultrafast"]));
        assert!(args.windows(2).any(|pair| pair == ["-crf", "23"]));
        assert!(args.windows(2).any(|pair| pair == ["-r", "30"]));
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "yuv420p"]));
    }

    #[test]
    fn nvenc_args_use_constant_quality_vbr() {
        let mut command = Command::new("ffmpeg");
        append_export_video_args(
            &mut command,
            &settings("high-quality", "h264", "auto"),
            ExportEncoder::Nvenc,
            30,
            1920,
            1080,
        );
        let args = args_of(&command);
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "h264_nvenc"]));
        assert!(args.windows(2).any(|pair| pair == ["-preset", "p6"]));
        assert!(args.windows(2).any(|pair| pair == ["-tune", "hq"]));
        assert!(args.windows(2).any(|pair| pair == ["-rc", "vbr"]));
        assert!(args.windows(2).any(|pair| pair == ["-cq", "18"]));
        assert!(args.windows(2).any(|pair| pair == ["-b:v", "0"]));
        assert!(!args.contains(&"-crf".to_string()));
    }

    #[test]
    fn hevc_hw_args_select_the_vendor_hevc_encoder() {
        let mut command = Command::new("ffmpeg");
        append_export_video_args(
            &mut command,
            &settings("balanced", "hevc", "auto"),
            ExportEncoder::Qsv,
            30,
            1920,
            1080,
        );
        let args = args_of(&command);
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "hevc_qsv"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-global_quality", "20"]));
        // Lookahead is only exposed for the h264 qsv encoder.
        assert!(!args.contains(&"-look_ahead".to_string()));
    }

    #[test]
    fn amf_args_use_constant_qp() {
        let mut command = Command::new("ffmpeg");
        append_export_video_args(
            &mut command,
            &settings("default-mp4", "h264", "auto"),
            ExportEncoder::Amf,
            30,
            1920,
            1080,
        );
        let args = args_of(&command);
        assert!(args.windows(2).any(|pair| pair == ["-rc", "cqp"]));
        assert!(args.windows(2).any(|pair| pair == ["-qp_i", "20"]));
        assert!(args.windows(2).any(|pair| pair == ["-qp_p", "22"]));
    }

    #[test]
    fn mf_args_use_a_resolution_aware_cbr_target() {
        let mut command = Command::new("ffmpeg");
        append_export_video_args(
            &mut command,
            &settings("default-mp4", "h264", "auto"),
            ExportEncoder::Mf,
            30,
            1920,
            1080,
        );
        let args = args_of(&command);
        assert!(args.windows(2).any(|pair| pair == ["-rate_control", "cbr"]));
        // 1920*1080*30*0.09/1000 ≈ 5599k
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-b:v", "5598k"] || pair == ["-b:v", "5599k"]));
    }

    #[test]
    fn sixty_fps_presets_raise_the_output_framerate() {
        let mut command = Command::new("ffmpeg");
        append_export_video_args(
            &mut command,
            &settings("smooth-60fps", "h264", "auto"),
            ExportEncoder::Software,
            30,
            1920,
            1080,
        );
        assert!(args_of(&command)
            .windows(2)
            .any(|pair| pair == ["-r", "60"]));

        let mut high_fps_command = Command::new("ffmpeg");
        append_export_video_args(
            &mut high_fps_command,
            &settings("ultra-4k-60", "h264", "auto"),
            ExportEncoder::Software,
            120,
            3_840,
            2_160,
        );
        assert!(args_of(&high_fps_command)
            .windows(2)
            .any(|pair| pair == ["-r", "60"]));
    }

    #[test]
    fn videotoolbox_args_use_hardware_bitrate_and_software_fallback() {
        let mut command = Command::new("ffmpeg");
        append_export_video_args(
            &mut command,
            &settings("high-quality", "h264", "auto"),
            ExportEncoder::VideoToolbox,
            60,
            1920,
            1080,
        );
        let args = args_of(&command);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-c:v", "h264_videotoolbox"]));
        assert!(args.windows(2).any(|pair| pair == ["-allow_sw", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["-realtime", "0"]));
        assert!(args.windows(2).any(|pair| pair == ["-r", "60"]));
    }
}
