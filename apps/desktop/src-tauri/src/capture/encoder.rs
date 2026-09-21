use serde::{Deserialize, Serialize};
use std::sync::RwLock;

/// Encoder description returned to the TypeScript front end.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    pub id: String,
    pub name: String,
    pub codec: String,
    pub vendor: Option<String>,
    pub available: bool,
    pub reason: Option<String>,
    pub supports_cbr: bool,
    pub supports_crf: bool,
    pub supports_cqp: bool,
}

/// Encoders we want to probe for H.264/AVC output.
const PROBED_ENCODERS: &[(&str, &str, &str, Option<&str>)] = &[
    (
        "h264_videotoolbox",
        "Apple VideoToolbox (H.264)",
        "h264",
        Some("apple"),
    ),
    (
        "hevc_videotoolbox",
        "Apple VideoToolbox (HEVC)",
        "hevc",
        Some("apple"),
    ),
    ("h264_nvenc", "NVIDIA NVENC", "h264", Some("nvidia")),
    ("h264_amf", "AMD AMF", "h264", Some("amd")),
    ("h264_qsv", "Intel Quick Sync", "h264", Some("intel")),
    ("h264_vaapi", "Linux VAAPI (H.264)", "h264", Some("vaapi")),
    ("hevc_vaapi", "Linux VAAPI (HEVC)", "hevc", Some("vaapi")),
    ("h264_mf", "Media Foundation", "h264", Some("microsoft")),
    ("libx264", "x264", "h264", None),
    ("libx265", "x265", "hevc", None),
];

static ENCODER_CACHE: RwLock<Option<Vec<EncoderInfo>>> = RwLock::new(None);

/// Clear cached encoder detection results (useful for tests or diagnostics refresh).
pub fn clear_encoder_cache() {
    if let Ok(mut lock) = ENCODER_CACHE.write() {
        *lock = None;
    }
}

/// Test whether encoders are usable by probing them concurrently.
///
/// Probes all candidates in parallel using worker threads to minimize startup
/// latency, and caches the result in memory for instant subsequent lookups.
pub fn detect_encoders(ffmpeg_path: &str) -> crate::errors::Result<Vec<EncoderInfo>> {
    if let Ok(lock) = ENCODER_CACHE.read() {
        if let Some(cached) = lock.as_ref() {
            return Ok(cached.clone());
        }
    }

    let handles: Vec<_> = std::thread::scope(|s| {
        PROBED_ENCODERS
            .iter()
            .map(|(id, name, codec, vendor)| {
                s.spawn(move || {
                    let mut encoder = EncoderInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                        codec: codec.to_string(),
                        vendor: vendor.map(|s| s.to_string()),
                        available: false,
                        reason: None,
                        supports_cbr: false,
                        supports_crf: false,
                        supports_cqp: false,
                    };

                    match probe_single_encoder(ffmpeg_path, id) {
                        Ok(info) => {
                            encoder.available = true;
                            encoder.supports_cbr = info.supports_cbr;
                            encoder.supports_crf = info.supports_crf;
                            encoder.supports_cqp = info.supports_cqp;
                        }
                        Err(e) => {
                            encoder.reason = Some(e.to_string());
                        }
                    }

                    encoder
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join())
            .collect()
    });

    let mut results = Vec::with_capacity(PROBED_ENCODERS.len());
    for encoder in handles.into_iter().flatten() {
        results.push(encoder);
    }

    if let Ok(mut lock) = ENCODER_CACHE.write() {
        *lock = Some(results.clone());
    }

    Ok(results)
}

#[derive(Debug, Default)]
struct ProbeResult {
    supports_cbr: bool,
    supports_crf: bool,
    supports_cqp: bool,
}

/// Verify a single encoder id can initialize with a short test encode.
/// Used outside the startup probe for encoder variants (for example hevc
/// hardware encoders) that are not part of `PROBED_ENCODERS`.
pub fn probe_encoder(ffmpeg_path: &str, encoder: &str) -> bool {
    probe_single_encoder(ffmpeg_path, encoder).is_ok()
}

/// Run a short test encode to verify the encoder exists and can be initialized.
///
/// The source is a 320x240 synthetic color video so the test is deterministic
/// and satisfies hardware encoder minimum resolution requirements (e.g. NVENC).
fn probe_single_encoder(ffmpeg_path: &str, encoder: &str) -> crate::errors::Result<ProbeResult> {
    let unique_suffix = uuid::Uuid::new_v4();
    let output =
        std::env::temp_dir().join(format!("rf-encoder-probe-{encoder}-{unique_suffix}.mp4"));

    // Generate a fast synthetic color pattern and encode with the target encoder.
    let mut command = crate::process::create_command(ffmpeg_path);
    if encoder.contains("vaapi") {
        #[cfg(target_os = "linux")]
        {
            if !std::path::Path::new("/dev/dri/renderD128").exists() {
                return Err(crate::errors::InternalError::Media(
                    "VAAPI render device /dev/dri/renderD128 not found".into(),
                )
                .into());
            }
            command.args([
                "-vaapi_device",
                "/dev/dri/renderD128",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10:duration=0.1",
                "-vf",
                "format=nv12,hwupload",
                "-c:v",
                encoder,
                "-an",
                "-y",
            ]);
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err(crate::errors::InternalError::Media(
                "VAAPI is only supported on Linux".into(),
            )
            .into());
        }
    } else {
        command.args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10:duration=0.1",
            "-c:v",
            encoder,
        ]);
        command.args(probe_pixel_format_args(encoder));
        command.args(["-an", "-y"]);
    }
    command.arg(&output);

    let result = command.output().map_err(|e| {
        crate::errors::InternalError::Media(format!(
            "failed to run ffmpeg probe for {encoder}: {e}"
        ))
    })?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        // Clean the output file so we do not leak probe files.
        let _ = std::fs::remove_file(&output);
        return Err(crate::errors::InternalError::Media(format!(
            "encoder {encoder} probe failed: {stderr}"
        ))
        .into());
    }

    let _ = std::fs::remove_file(&output);

    let mut info = ProbeResult::default();

    // libx264 supports CRF, CQP and CBR. Hardware encoders have more limited rate-control.
    match encoder {
        "libx264" => {
            info.supports_crf = true;
            info.supports_cqp = true;
            info.supports_cbr = true;
        }
        "libx265" => {
            info.supports_crf = true;
            info.supports_cqp = true;
            info.supports_cbr = true;
        }
        "h264_nvenc" | "h264_amf" | "h264_qsv" | "h264_mf" | "h264_videotoolbox"
        | "hevc_videotoolbox" | "h264_vaapi" | "hevc_vaapi" => {
            info.supports_cbr = true;
            // Hardware encoders expose a QP / CQP mode instead of pure CRF.
            info.supports_cqp = true;
        }
        _ => {}
    }

    Ok(info)
}

/// Pixel-format/probe arguments for a single encoder test encode.
///
/// Media Foundation is forced into hardware mode (`-hw_encoding 1`) and fed
/// NV12. Hardware forcing, not the pixel format alone, prevents a software
/// implementation from being reported as available hardware acceleration.
fn probe_pixel_format_args(encoder: &str) -> Vec<&'static str> {
    if encoder == "h264_mf" {
        vec!["-hw_encoding", "1", "-pix_fmt", "nv12"]
    } else {
        vec!["-pix_fmt", "yuv420p"]
    }
}

/// Ordered list of encoder candidates for a recording/webcam attempt.
///
/// Keeps supported H.264 hardware paths in priority order, without duplicates.
/// The bundled libx264 encoder is always last; unrelated HEVC/software encoders
/// and hardware paths requiring a different filter graph are not tried.
pub fn recording_encoder_candidates(available: &[String], priority: &[String]) -> Vec<String> {
    let mut candidates = Vec::new();
    for candidate in priority {
        if candidate != "libx264"
            && available.contains(candidate)
            && matches!(
                candidate.as_str(),
                "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf" | "h264_videotoolbox"
            )
            && !candidates.contains(candidate)
        {
            candidates.push(candidate.clone());
        }
    }
    candidates.push("libx264".into());
    candidates
}

/// Select the highest-priority encoder from `priority` that is present in `available`.
/// Falls back to the bundled `"libx264"` — never an undetected priority entry —
/// so proxy/media jobs always select an encoder that can actually initialize.
pub fn select_best_encoder(available: &[String], priority: &[String]) -> String {
    for candidate in priority {
        if available.iter().any(|a| a == candidate) {
            return candidate.clone();
        }
    }
    "libx264".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_follow_priority_then_available_then_x264() {
        let available = vec![
            "h264_mf".to_string(),
            "h264_nvenc".to_string(),
            "libx264".to_string(),
        ];
        let priority = vec![
            "h264_qsv".to_string(), // not available — skipped
            "h264_nvenc".to_string(),
            "h264_mf".to_string(),
        ];
        assert_eq!(
            recording_encoder_candidates(&available, &priority),
            vec!["h264_nvenc", "h264_mf", "libx264"]
        );
    }

    #[test]
    fn candidates_dedupe_and_always_end_with_x264() {
        let available = vec![
            "h264_nvenc".to_string(),
            "h264_nvenc".to_string(),
            "libx264".to_string(),
        ];
        let priority = vec!["h264_nvenc".to_string(), "libx264".to_string()];
        let candidates = recording_encoder_candidates(&available, &priority);
        assert_eq!(candidates, vec!["h264_nvenc", "libx264"]);
    }

    #[test]
    fn candidates_fall_back_to_x264_when_nothing_detected() {
        // An empty detection result must still yield the bundled software
        // encoder so recording can proceed.
        assert_eq!(
            recording_encoder_candidates(&[], &["h264_nvenc".to_string()]),
            vec!["libx264"]
        );
        // Priority encoders absent from detection are never selected (e.g.
        // NVENC when only libx264 was detected).
        assert_eq!(
            recording_encoder_candidates(
                &["libx264".to_string()],
                &["h264_nvenc".to_string(), "h264_mf".to_string()],
            ),
            vec!["libx264"]
        );
    }

    #[test]
    fn candidates_exclude_other_codecs_and_put_software_last() {
        let available = [
            "libx264",
            "libx265",
            "h264_vaapi",
            "hevc_videotoolbox",
            "h264_mf",
        ]
        .map(String::from);
        let priority = ["libx264", "libx265", "h264_vaapi", "h264_mf", "h264_mf"].map(String::from);
        assert_eq!(
            recording_encoder_candidates(&available, &priority),
            ["h264_mf", "libx264"]
        );
    }

    #[test]
    fn select_best_encoder_never_returns_undetected_hardware() {
        // Requested hardware that was not detected must fall back to x264 —
        // returning the first priority entry would pick an encoder that
        // cannot initialize on this machine.
        assert_eq!(
            select_best_encoder(&["libx264".to_string()], &["h264_nvenc".to_string()]),
            "libx264"
        );
        assert_eq!(
            select_best_encoder(&["h264_nvenc".to_string()], &["h264_nvenc".to_string()]),
            "h264_nvenc"
        );
    }

    #[test]
    fn mediafoundation_probe_forces_hardware_nv12() {
        assert_eq!(
            probe_pixel_format_args("h264_mf"),
            vec!["-hw_encoding", "1", "-pix_fmt", "nv12"]
        );
        assert_eq!(
            probe_pixel_format_args("h264_nvenc"),
            vec!["-pix_fmt", "yuv420p"]
        );
        assert_eq!(
            probe_pixel_format_args("libx264"),
            vec!["-pix_fmt", "yuv420p"]
        );
    }
}
