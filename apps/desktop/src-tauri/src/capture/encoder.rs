use serde::{Deserialize, Serialize};
use std::process::Command;

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
    ("h264_nvenc", "NVIDIA NVENC", "h264", Some("nvidia")),
    ("h264_amf", "AMD AMF", "h264", Some("amd")),
    ("h264_qsv", "Intel Quick Sync", "h264", Some("intel")),
    ("h264_mf", "Media Foundation", "h264", Some("microsoft")),
    ("libx264", "x264", "h264", None),
    ("libx265", "x265", "hevc", None),
];

/// Test whether an encoder is usable by trying to run a one-frame encode.
///
/// We intentionally use a tiny, short capture (or a testsrc if no display
/// input is available) so that the probe is fast and does not produce a real
/// recording. The output is discarded.
pub fn detect_encoders(ffmpeg_path: &str) -> crate::errors::Result<Vec<EncoderInfo>> {
    let mut results = Vec::new();

    for (id, name, codec, vendor) in PROBED_ENCODERS {
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

        // If the codec cannot be supported without commercial/GPU drivers,
        // we still report it so the UI can show why it is unavailable.
        results.push(encoder);
    }

    Ok(results)
}

#[derive(Debug, Default)]
struct ProbeResult {
    supports_cbr: bool,
    supports_crf: bool,
    supports_cqp: bool,
}

/// Run a one-second test encode to verify the encoder exists and can be initialized.
///
/// The source is a 320x240 synthetic color video so the test is deterministic
/// and satisfies hardware encoder minimum resolution requirements (e.g. NVENC).
fn probe_single_encoder(ffmpeg_path: &str, encoder: &str) -> crate::errors::Result<ProbeResult> {
    let output = std::env::temp_dir().join(format!("rf-encoder-probe-{encoder}.mp4"));

    // Generate a tiny 1-second 30fps color pattern and encode with the target encoder.
    let mut command = Command::new(ffmpeg_path);
    command
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=30:duration=1",
            "-c:v",
            encoder,
            "-pix_fmt",
            "yuv420p",
            "-an",
            "-y",
        ])
        .arg(&output);

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
        "h264_nvenc" | "h264_amf" | "h264_qsv" | "h264_mf" => {
            info.supports_cbr = true;
            // Some hardware encoders expose a QP mode instead of CRF.
            info.supports_cqp = true;
        }
        _ => {}
    }

    Ok(info)
}

/// Select the highest-priority encoder from `priority` that is present in `available`.
/// Falls back to the first priority item or `"libx264"` if no candidate matches.
pub fn select_best_encoder(available: &[String], priority: &[String]) -> String {
    for candidate in priority {
        if available.iter().any(|a| a == candidate) {
            return candidate.clone();
        }
    }
    priority
        .first()
        .cloned()
        .unwrap_or_else(|| "libx264".to_string())
}
