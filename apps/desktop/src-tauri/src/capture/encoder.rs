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
    command
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10:duration=0.1",
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
        "h264_nvenc" | "h264_amf" | "h264_qsv" | "h264_mf" | "h264_videotoolbox"
        | "hevc_videotoolbox" => {
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
