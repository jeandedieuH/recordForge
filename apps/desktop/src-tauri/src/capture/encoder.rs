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
    // The VAAPI node is part of the same probe result — a stale node would
    // point the next recording at a device that may no longer be present.
    store_vaapi_node(None);
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
    // VAAPI is a device + encoder pair: the working render node has to be
    // discovered and remembered, not assumed. The probe also runs a real
    // upload+encode through a null muxer, so no temp file is involved.
    if encoder.contains("vaapi") {
        #[cfg(target_os = "linux")]
        {
            let node = probe_vaapi_node(ffmpeg_path, encoder).ok_or_else(|| {
                crate::errors::InternalError::Media(format!(
                    "no usable VAAPI render node for {encoder} under /dev/dri"
                ))
            })?;
            // The canonical recording/export encoder owns the stored node;
            // `hevc_vaapi` reuses it so a later h264 session can never be
            // pointed at a node only the HEVC encoder accepted.
            if encoder == "h264_vaapi" {
                store_vaapi_node(Some(node));
            }
            return Ok(ProbeResult {
                supports_cbr: true,
                supports_cqp: true,
                supports_crf: false,
            });
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err(crate::errors::InternalError::Media(
                "VAAPI is only supported on Linux".into(),
            )
            .into());
        }
    }

    let unique_suffix = uuid::Uuid::new_v4();
    let output =
        std::env::temp_dir().join(format!("rf-encoder-probe-{encoder}-{unique_suffix}.mp4"));

    // Generate a fast synthetic color pattern and encode with the target encoder.
    let mut command = crate::process::create_command(ffmpeg_path);
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

/// Find the first render node that can encode with `encoder`.
///
/// Node numbering is driver/enumeration dependent (and a discrete GPU is often
/// *not* `renderD128`), so every node is tried in order with a real upload +
/// encode. A null muxer keeps the probe file-free.
#[cfg(target_os = "linux")]
fn probe_vaapi_node(ffmpeg_path: &str, encoder: &str) -> Option<String> {
    vaapi_render_nodes()
        .into_iter()
        .find(|node| probe_vaapi_on(ffmpeg_path, node, encoder))
}

/// One node/encoder VAAPI probe. `true` means the node opened, the upload
/// stage initialised, and the encoder produced output.
#[cfg(target_os = "linux")]
fn probe_vaapi_on(ffmpeg_path: &str, node: &str, encoder: &str) -> bool {
    crate::process::create_command(ffmpeg_path)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-vaapi_device",
            node,
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10:duration=0.1",
            "-vf",
            "format=nv12,hwupload",
            "-c:v",
            encoder,
            "-an",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
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

/// First render node tried when `/dev/dri` cannot be enumerated, and the
/// defensive fallback before a probe has run.
pub const VAAPI_RENDER_NODE: &str = "/dev/dri/renderD128";

/// Render node validated by the last successful VAAPI probe.
///
/// Multi-GPU Linux machines expose one node per GPU (`renderD128`, `renderD129`,
/// …) and the working encoder is not always node 128, so the builders must pass
/// the node the probe actually encoded on rather than a hardcoded path.
static VAAPI_NODE: RwLock<Option<String>> = RwLock::new(None);

/// Every `/dev/dri/renderD*` node, in numeric order.
///
/// Linux-only: it feeds the VAAPI probe, which has no meaning elsewhere.
#[cfg(target_os = "linux")]
fn vaapi_render_nodes() -> Vec<String> {
    let mut nodes: Vec<(u32, String)> = std::fs::read_dir("/dev/dri")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let index = name.strip_prefix("renderD")?.parse::<u32>().ok()?;
            Some((index, entry.path().to_string_lossy().into_owned()))
        })
        .collect();
    nodes.sort_unstable_by_key(|(index, _)| *index);
    nodes.into_iter().map(|(_, path)| path).collect()
}

/// The render node the capture/export builders must pass to `-vaapi_device`.
///
/// Falls back to [`VAAPI_RENDER_NODE`] before a probe has run (tests, or a
/// defensive path) — production callers only reach this after the probe
/// validated a node, because VAAPI is only offered when the probe succeeded.
pub(crate) fn vaapi_render_node() -> String {
    VAAPI_NODE
        .read()
        .ok()
        .and_then(|node| node.clone())
        .unwrap_or_else(|| VAAPI_RENDER_NODE.to_string())
}

/// Record (or clear) the validated node. Called by the probe and its tests.
pub(crate) fn store_vaapi_node(node: Option<String>) {
    if let Ok(mut current) = VAAPI_NODE.write() {
        *current = node;
    }
}

/// Test-only serialization for the process-wide VAAPI node.
///
/// The node is global state (like the probe cache), so tests that mutate it and
/// tests that assert the fallback must not run concurrently.
#[cfg(test)]
pub(crate) static VAAPI_NODE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// True when `encoder` consumes VAAPI hardware frames: the filter graph must
/// end with an upload stage (`format=nv12,hwupload`) and the command needs
/// `-vaapi_device`, and it must not be given a system `-pix_fmt`.
pub(crate) fn is_vaapi_encoder(encoder: &str) -> bool {
    matches!(encoder, "h264_vaapi" | "hevc_vaapi")
}

/// Ordered list of encoder candidates for a recording/webcam attempt.
///
/// Keeps supported H.264 hardware paths in priority order, without duplicates.
/// The bundled libx264 encoder is always last; unrelated HEVC/software encoders
/// and hardware paths requiring a different filter graph are not tried.
///
/// VAAPI is appended here rather than in [`crate::capture::config::default_encoder_priority`]
/// because it needs an upload stage that only the capture builders emit —
/// proxy/export jobs share the default priority and must not select it. The
/// startup probe is the gate: `available` only contains `h264_vaapi` when a
/// usable render node was validated.
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
    // The loop above never yields VAAPI (it is not in the match list), so a
    // single push is enough — no dedupe needed.
    if available.iter().any(|id| id == "h264_vaapi") {
        candidates.push("h264_vaapi".into());
    }
    candidates.push("libx264".into());
    candidates
}

/// Whether a candidate list contains a hardware encoder ahead of the bundled
/// software fallback.
///
/// [`recording_encoder_candidates`] only ever emits detected hardware H.264
/// ids plus `libx264`, so any other entry is a hardware path. Used to decide
/// whether a camera tier may plan an output the software encoder cannot
/// sustain (see `camera_plan::plan_camera_capture_for_encoders`).
pub fn has_hardware_candidate(candidates: &[String]) -> bool {
    candidates
        .iter()
        .any(|candidate| candidate.as_str() != "libx264")
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
        // VAAPI needs the capture builders' upload stage, so it is appended
        // ahead of the software fallback rather than taken from `priority`.
        assert_eq!(
            recording_encoder_candidates(&available, &priority),
            ["h264_mf", "h264_vaapi", "libx264"]
        );
    }

    #[test]
    fn vaapi_is_only_offered_when_the_probe_found_it() {
        let priority = crate::capture::config::default_encoder_priority();
        // No render node → the probe never reports it → recording stays x264.
        assert_eq!(
            recording_encoder_candidates(&["libx264".to_string()], &priority),
            ["libx264"]
        );
        // Probed → offered once, ahead of software, never duplicated.
        let candidates = recording_encoder_candidates(
            &["libx264".to_string(), "h264_vaapi".to_string()],
            &priority,
        );
        assert_eq!(candidates, ["h264_vaapi", "libx264"]);
        // VAAPI counts as hardware for the camera output cap.
        assert!(has_hardware_candidate(&candidates));
    }

    #[test]
    fn vaapi_probe_and_encoder_helpers_agree() {
        assert!(is_vaapi_encoder("h264_vaapi"));
        assert!(is_vaapi_encoder("hevc_vaapi"));
        assert!(!is_vaapi_encoder("libx264"));
        assert!(!is_vaapi_encoder("h264_mf"));
    }

    /// The builders must consume the node the probe validated, not a hardcoded
    /// `renderD128` (multi-GPU machines commonly encode on `renderD129`).
    #[test]
    fn validated_vaapi_node_replaces_the_hardcoded_default() {
        let _guard = VAAPI_NODE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        store_vaapi_node(None);
        assert_eq!(vaapi_render_node(), VAAPI_RENDER_NODE);

        store_vaapi_node(Some("/dev/dri/renderD129".into()));
        assert_eq!(vaapi_render_node(), "/dev/dri/renderD129");

        // Clearing the cache forgets the node with the probe results.
        clear_encoder_cache();
        assert_eq!(vaapi_render_node(), VAAPI_RENDER_NODE);
    }

    #[test]
    fn hardware_candidate_detection_ignores_the_software_fallback() {
        assert!(has_hardware_candidate(&[
            "h264_nvenc".to_string(),
            "libx264".to_string()
        ]));
        // Only software → the camera planner must cap the output.
        assert!(!has_hardware_candidate(&["libx264".to_string()]));
        assert!(!has_hardware_candidate(&[]));
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
