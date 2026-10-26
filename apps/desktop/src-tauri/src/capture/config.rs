use serde::{Deserialize, Serialize};

use super::source::{Bounds, CaptureSource};

/// Recording profile that maps to concrete FFmpeg settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingProfile {
    pub id: String,
    pub label: String,
    pub width: i32,
    pub height: i32,
    pub fps: i32,
    pub video_bitrate_kbps: Option<i32>,
    pub crf: Option<i32>,
    pub encoder_priority: Vec<String>,
    pub audio_codec: String,
    pub audio_bitrate_kbps: i32,
}

impl RecordingProfile {
    /// Adapt this profile's output geometry to the capture source's aspect
    /// ratio.
    ///
    /// Screen frames are scaled into the profile box; when the source aspect
    /// differs from the profile's the historic graph letterboxes the frame
    /// (`Bounds::build_aspect_fit_filter`), which wastes encoded pixels, wastes
    /// capture CPU on the pad stage, and — on Windows — disqualifies the
    /// zero-copy `scale_d3d11` path, whose graph must never distort
    /// (`gpu_screen_filter`). Deriving the output size from the source keeps
    /// the profile's budget (the limiting dimension is unchanged) and removes
    /// the bars, so window and region captures reach the GPU path too.
    ///
    /// Camera profiles are returned untouched: their `width`/`height` is a
    /// device budget handled by `capture::camera_plan`, not a screen box.
    pub fn for_source_bounds(&self, bounds: Bounds) -> RecordingProfile {
        if is_camera_profile(&self.id)
            || bounds.width <= 1
            || bounds.height <= 1
            || self.width <= 1
            || self.height <= 1
        {
            return self.clone();
        }

        // The source is scaled to fill the profile box, exactly like the fit
        // filter's `force_original_aspect_ratio=decrease` — but both sides are
        // derived, so neither gains a letterbox.
        let scale = (f64::from(self.width) / f64::from(bounds.width))
            .min(f64::from(self.height) / f64::from(bounds.height));
        let width = even_dimension(f64::from(bounds.width) * scale);
        let height = even_dimension(f64::from(bounds.height) * scale);
        if width == self.width && height == self.height {
            return self.clone();
        }
        RecordingProfile {
            width,
            height,
            ..self.clone()
        }
    }
}

/// Round a dimension to the nearest even value ≥ 2 — H.264 4:2:0 needs even
/// geometry, and the derived profile must stay encodable on every backend.
fn even_dimension(value: f64) -> i32 {
    let rounded = value.round().max(2.0) as i64;
    (rounded - rounded % 2).max(2) as i32
}

/// Preview quality preference for the in-app webcam feed.
///
/// The preview is decoded from a second FFmpeg output (MJPEG over stdout), so
/// each level trades encoder CPU against preview smoothness. `Off` removes the
/// split/preview output entirely so the camera process does no extra work.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebcamPreviewMode {
    Off,
    #[default]
    Low,
    Standard,
}

impl WebcamPreviewMode {
    /// Frame rate of the preview MJPEG stream, or `None` when preview is off.
    pub fn fps(self) -> Option<i32> {
        match self {
            Self::Off => None,
            Self::Low => Some(5),
            Self::Standard => Some(15),
        }
    }
}

/// Runtime recording configuration received from the React UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub source: CaptureSource,
    pub profile: String,
    pub capture_microphone: bool,
    pub capture_system_audio: bool,
    pub capture_webcam: bool,
    pub webcam_device_id: Option<String>,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
    #[serde(default)]
    pub webcam_preview_mode: WebcamPreviewMode,
    #[serde(default = "default_gpu_screen_capture")]
    pub gpu_screen_capture: bool,
    #[serde(default)]
    pub smart_zoom_enabled: bool,
    #[serde(default = "default_smart_zoom_preset")]
    pub smart_zoom_preset: String,
    /// Opt-in keystroke overlay capture (Pro): modifier combos only — plain
    /// typing is never logged.
    #[serde(default)]
    pub capture_keystrokes: bool,
}

fn default_gpu_screen_capture() -> bool {
    true
}

fn default_smart_zoom_preset() -> String {
    "product-demo".into()
}

impl RecordingConfig {
    /// Validate the untrusted IPC payload before it reaches FFmpeg arguments.
    pub fn validate(&self) -> crate::errors::Result<()> {
        let camera_source = self.source.kind == "camera";
        if !matches!(
            self.source.kind.as_str(),
            "display" | "window" | "region" | "camera"
        ) {
            return Err(crate::errors::InternalError::Capture(
                "unsupported capture source kind".into(),
            )
            .into());
        }

        if self.source.id.trim().is_empty() || self.source.name.trim().is_empty() {
            return Err(crate::errors::InternalError::Capture(
                "capture source identity is required".into(),
            )
            .into());
        }

        // Camera ids flow verbatim into `-i video=<id>`; bound their length and
        // reject control characters so a hostile payload cannot inject into the
        // dshow device specifier.
        if camera_source && !is_valid_camera_device_id(&self.source.id) {
            return Err(crate::errors::InternalError::Capture(
                "camera device id is invalid".into(),
            )
            .into());
        }

        let bounds = self.source.bounds;
        if bounds.width <= 0
            || bounds.height <= 0
            || bounds.width > 16_384
            || bounds.height > 16_384
            || bounds.x < -32_768
            || bounds.y < -32_768
        {
            return Err(crate::errors::InternalError::Capture(
                "capture source bounds are outside the supported range".into(),
            )
            .into());
        }

        if self.capture_microphone && self.microphone_device_id.is_none() {
            return Err(crate::errors::InternalError::Capture(
                "microphone capture requires a device".into(),
            )
            .into());
        }
        if self.capture_system_audio && self.system_audio_device_id.is_none() {
            return Err(crate::errors::InternalError::Capture(
                "system audio capture requires a device".into(),
            )
            .into());
        }
        if self.capture_webcam && self.webcam_device_id.is_none() {
            return Err(crate::errors::InternalError::Capture(
                "webcam capture requires a device".into(),
            )
            .into());
        }

        if camera_source {
            // Camera mode is single-input: no screen, no webcam sidecar, and
            // none of the screen-recording features (smart zoom, keystrokes).
            if !is_camera_profile(&self.profile) {
                return Err(crate::errors::InternalError::Capture(
                    "camera recordings require a camera quality profile".into(),
                )
                .into());
            }
            if self.capture_webcam {
                return Err(crate::errors::InternalError::Capture(
                    "camera mode cannot also record a webcam sidecar".into(),
                )
                .into());
            }
            if self.smart_zoom_enabled {
                return Err(crate::errors::InternalError::Capture(
                    "smart zoom is not available for camera recordings".into(),
                )
                .into());
            }
            if self.capture_keystrokes {
                return Err(crate::errors::InternalError::Capture(
                    "keystroke capture is not available for camera recordings".into(),
                )
                .into());
            }
        } else if is_camera_profile(&self.profile) {
            // Camera tiers encode quality budgets that only make sense for a
            // camera source; the legacy `camera-only` id stays valid here.
            return Err(crate::errors::InternalError::Capture(
                "camera quality profiles require a camera source".into(),
            )
            .into());
        }

        if self.resolve_profile().is_none() {
            return Err(crate::errors::InternalError::Capture(format!(
                "unknown profile: {}",
                self.profile
            ))
            .into());
        }

        if !matches!(
            self.smart_zoom_preset.as_str(),
            "subtle" | "product-demo" | "cinematic" | "developer" | "manual-only"
        ) {
            return Err(crate::errors::InternalError::Capture(
                "unsupported smart zoom preset".into(),
            )
            .into());
        }

        Ok(())
    }

    /// Resolve the requested profile to a concrete set of encoder/codec parameters.
    pub fn resolve_profile(&self) -> Option<RecordingProfile> {
        resolve_profile_by_id(&self.profile)
    }

    /// Resolve the profile and pin its output geometry to the source aspect.
    ///
    /// Used by the recorder so the encode size, the cursor telemetry transform
    /// and the manifest all describe the same frame — see
    /// [`RecordingProfile::for_source_bounds`].
    pub fn resolve_profile_for_source(&self) -> Option<RecordingProfile> {
        self.resolve_profile()
            .map(|profile| profile.for_source_bounds(self.source.bounds))
    }

    /// Effective pixel bounds for the recording. For displays and windows this
    /// is the source bounds; for regions it is the region itself.
    pub fn effective_bounds(&self) -> Bounds {
        self.source.bounds
    }
}

/// Encoder preference shared by recording, export, and proxy jobs: use any
/// detected hardware encoder before falling back to software x264.
/// `h264_videotoolbox` leads the list — it is the only hardware encoder that
/// ever probes available on macOS, and it is simply skipped by
/// `recording_encoder_candidates` on platforms where detection fails.
pub fn default_encoder_priority() -> Vec<String> {
    vec![
        "h264_videotoolbox".into(),
        "h264_nvenc".into(),
        "h264_qsv".into(),
        "h264_amf".into(),
        "h264_mf".into(),
        "libx264".into(),
    ]
}

/// Built-in profiles tuned for low-end to high-performance Windows hardware.
///
/// This is the SCREEN list offered by the UI and the benchmark — camera tiers
/// live in [`camera_profiles`] and the retired `camera-only` placeholder in
/// [`legacy_profiles`].
///
/// - `low-impact`: 720p30, ultrafast x264/hardware, low CPU cost.
/// - `balanced`: 1080p30, reasonable quality.
/// - `smooth-demo`: 1080p60, prioritize fluid 60fps screen capture.
/// - `smooth-60fps`: 1080p60, high quality 60fps for animations & games.
/// - `high-quality`: 1080p30, higher fidelity master recording.
/// - `ultra-4k`: 2160p30 (3840x2160), crisp 4K UHD presentation.
/// - `ultra-4k-60`: 2160p60 (3840x2160), pristine 4K UHD at 60fps for powerful workstations.
pub fn builtin_profiles() -> Vec<RecordingProfile> {
    vec![
        RecordingProfile {
            id: "low-impact".into(),
            label: "Low Impact".into(),
            width: 1280,
            height: 720,
            fps: 30,
            video_bitrate_kbps: Some(2500),
            crf: Some(28),
            encoder_priority: default_encoder_priority(),
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 128,
        },
        RecordingProfile {
            id: "balanced".into(),
            label: "Balanced".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: Some(4000),
            crf: Some(23),
            encoder_priority: default_encoder_priority(),
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 128,
        },
        RecordingProfile {
            id: "smooth-demo".into(),
            label: "Smooth Demo".into(),
            width: 1920,
            height: 1080,
            fps: 60,
            video_bitrate_kbps: Some(5000),
            crf: Some(24),
            encoder_priority: default_encoder_priority(),
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 128,
        },
        RecordingProfile {
            id: "smooth-60fps".into(),
            label: "Smooth 60 FPS".into(),
            width: 1920,
            height: 1080,
            fps: 60,
            video_bitrate_kbps: Some(6000),
            crf: Some(20),
            encoder_priority: default_encoder_priority(),
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 128,
        },
        RecordingProfile {
            id: "high-quality".into(),
            label: "High Quality".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: Some(8000),
            crf: Some(18),
            encoder_priority: default_encoder_priority(),
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 192,
        },
        RecordingProfile {
            id: "ultra-4k".into(),
            label: "Ultra 4K".into(),
            width: 3840,
            height: 2160,
            fps: 30,
            video_bitrate_kbps: Some(12000),
            crf: Some(18),
            encoder_priority: default_encoder_priority(),
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 192,
        },
        RecordingProfile {
            id: "ultra-4k-60".into(),
            label: "Ultra 4K 60 FPS".into(),
            width: 3840,
            height: 2160,
            fps: 60,
            video_bitrate_kbps: Some(20000),
            crf: Some(18),
            encoder_priority: default_encoder_priority(),
            audio_codec: "pcm_s16le".into(),
            audio_bitrate_kbps: 192,
        },
    ]
}

/// Bitrate/quality tuning for one camera tier — the single source of truth
/// shared by [`camera_profiles`] and the camera capture planner
/// (`capture::camera_plan`). `bpp` is the target bits per output pixel per
/// frame; `min_kbps`/`max_kbps` clamp the computed target.
#[derive(Debug, Clone, Copy)]
pub struct CameraTierSpec {
    pub bpp: f64,
    pub min_kbps: u32,
    pub max_kbps: u32,
    pub crf: u8,
}

/// Look up the tuning spec for a camera tier id (`camera-low` …
/// `camera-ultra`). `None` for screen and legacy profile ids.
pub fn camera_tier_spec(profile_id: &str) -> Option<CameraTierSpec> {
    let spec = match profile_id {
        "camera-low" => CameraTierSpec {
            bpp: 0.12,
            min_kbps: 1500,
            max_kbps: 6000,
            crf: 24,
        },
        "camera-balanced" => CameraTierSpec {
            bpp: 0.11,
            min_kbps: 2500,
            max_kbps: 12000,
            crf: 21,
        },
        "camera-high" => CameraTierSpec {
            bpp: 0.19,
            min_kbps: 4500,
            max_kbps: 20000,
            crf: 18,
        },
        "camera-ultra" => CameraTierSpec {
            bpp: 0.10,
            min_kbps: 10000,
            max_kbps: 40000,
            crf: 19,
        },
        _ => return None,
    };
    Some(spec)
}

/// Camera-only recording tiers offered by the UI. `width`/`height` are the
/// output BUDGET (never upscale); `video_bitrate_kbps` is the nominal target
/// at the budget size and 30fps, `crf` the tier's x264 quality floor. Real
/// captures re-derive bitrate from the negotiated output size in
/// `capture::camera_plan`.
///
/// - `camera-low`: 720p30 budget, lowest USB/CPU cost.
/// - `camera-balanced`: 1080p30 budget, the default.
/// - `camera-high`: 1080p30 budget, higher fidelity.
/// - `camera-ultra`: 2160p30 budget for 4K-capable cameras.
pub fn camera_profiles() -> Vec<RecordingProfile> {
    const TIERS: &[(&str, &str, i32, i32)] = &[
        ("camera-low", "Low Impact", 1280, 720),
        ("camera-balanced", "Balanced", 1920, 1080),
        ("camera-high", "High Quality", 1920, 1080),
        ("camera-ultra", "Ultra", 3840, 2160),
    ];
    TIERS
        .iter()
        .map(|(id, label, width, height)| {
            let spec = camera_tier_spec(id).expect("tier table has a spec");
            let target =
                (spec.bpp * (*width as f64) * (*height as f64) * 30.0 / 1000.0).round() as i32;
            RecordingProfile {
                id: (*id).into(),
                label: (*label).into(),
                width: *width,
                height: *height,
                fps: 30,
                video_bitrate_kbps: Some(target.clamp(spec.min_kbps as i32, spec.max_kbps as i32)),
                crf: Some(spec.crf as i32),
                encoder_priority: default_encoder_priority(),
                audio_codec: "pcm_s16le".into(),
                audio_bitrate_kbps: 128,
            }
        })
        .collect()
}

/// Retired profiles that must stay resolvable for old manifests, recovery
/// sessions, and stored preferences, but are never offered by the UI.
/// `camera-only` predates the camera tiers and behaved like `balanced`.
pub fn legacy_profiles() -> Vec<RecordingProfile> {
    vec![RecordingProfile {
        id: "camera-only".into(),
        label: "Camera Only".into(),
        width: 1920,
        height: 1080,
        fps: 30,
        video_bitrate_kbps: Some(4000),
        crf: Some(23),
        encoder_priority: default_encoder_priority(),
        audio_codec: "pcm_s16le".into(),
        audio_bitrate_kbps: 128,
    }]
}

/// Whether `id` is one of the four camera tiers (`camera-low` …
/// `camera-ultra`). Legacy `camera-only` is NOT a camera profile — it keeps
/// resolving for old screen captures.
/// A camera device id is usable as a `video=<id>` dshow specifier: non-empty
/// after trimming, bounded, and free of control characters. Shared by
/// `RecordingConfig::validate` and the `plan_camera_tiers` command.
pub fn is_valid_camera_device_id(id: &str) -> bool {
    let trimmed = id.trim();
    !trimmed.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
}

pub fn is_camera_profile(id: &str) -> bool {
    camera_tier_spec(id).is_some()
}

/// Resolve any known profile id — screen, camera tier, or legacy — to its
/// parameters. Use this anywhere a stored profile name must keep working
/// (recovery, library listing); the UI list only surfaces [`builtin_profiles`].
pub fn resolve_profile_by_id(id: &str) -> Option<RecordingProfile> {
    builtin_profiles()
        .into_iter()
        .chain(camera_profiles())
        .chain(legacy_profiles())
        .find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::source::Bounds;

    fn screen_config(profile: &str) -> RecordingConfig {
        RecordingConfig {
            source: CaptureSource {
                kind: "display".into(),
                id: "display-0".into(),
                name: "Display".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            profile: profile.into(),
            capture_microphone: false,
            capture_system_audio: false,
            capture_webcam: false,
            webcam_device_id: None,
            microphone_device_id: None,
            system_audio_device_id: None,
            webcam_preview_mode: Default::default(),
            gpu_screen_capture: true,
            smart_zoom_enabled: false,
            smart_zoom_preset: "product-demo".into(),
            capture_keystrokes: false,
        }
    }

    fn camera_config(profile: &str) -> RecordingConfig {
        RecordingConfig {
            source: CaptureSource {
                kind: "camera".into(),
                id: "USB Camera".into(),
                name: "Integrated Webcam".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
            ..screen_config(profile)
        }
    }

    fn validate_error(config: &RecordingConfig) -> String {
        config
            .validate()
            .expect_err("config must be rejected")
            .to_string()
    }

    #[test]
    fn test_builtin_profiles_includes_60fps_and_4k() {
        let profiles = builtin_profiles();
        let smooth_60 = profiles
            .iter()
            .find(|p| p.id == "smooth-60fps")
            .expect("smooth-60fps profile");
        assert_eq!(smooth_60.fps, 60);
        assert_eq!(smooth_60.width, 1920);
        assert_eq!(smooth_60.height, 1080);

        let ultra_4k = profiles
            .iter()
            .find(|p| p.id == "ultra-4k")
            .expect("ultra-4k profile");
        assert_eq!(ultra_4k.width, 3840);
        assert_eq!(ultra_4k.height, 2160);
        assert_eq!(ultra_4k.fps, 30);

        let ultra_4k_60 = profiles
            .iter()
            .find(|p| p.id == "ultra-4k-60")
            .expect("ultra-4k-60 profile");
        assert_eq!(ultra_4k_60.width, 3840);
        assert_eq!(ultra_4k_60.height, 2160);
        assert_eq!(ultra_4k_60.fps, 60);
    }

    #[test]
    fn builtin_profiles_is_screen_only() {
        // The UI profile list and the benchmark must never surface camera
        // tiers or the retired camera-only placeholder.
        let profiles = builtin_profiles();
        let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), 7);
        assert!(!ids.contains(&"camera-only"));
        assert!(ids.iter().all(|id| !is_camera_profile(id)));
    }

    #[test]
    fn camera_profiles_match_the_tier_table() {
        let profiles = camera_profiles();
        assert_eq!(profiles.len(), 4);
        let by_id = |id: &str| profiles.iter().find(|p| p.id == id).expect(id);

        let low = by_id("camera-low");
        assert_eq!((low.width, low.height, low.fps), (1280, 720, 30));
        assert_eq!(low.video_bitrate_kbps, Some(3318));
        assert_eq!(low.crf, Some(24));

        let balanced = by_id("camera-balanced");
        assert_eq!(
            (balanced.width, balanced.height, balanced.fps),
            (1920, 1080, 30)
        );
        // 0.11 bpp * 1920*1080 * 30fps = 6842.88 kbps → 6843.
        assert_eq!(balanced.video_bitrate_kbps, Some(6843));
        assert_eq!(balanced.crf, Some(21));

        let high = by_id("camera-high");
        assert_eq!((high.width, high.height), (1920, 1080));
        assert_eq!(high.video_bitrate_kbps, Some(11820));
        assert_eq!(high.crf, Some(18));

        let ultra = by_id("camera-ultra");
        assert_eq!((ultra.width, ultra.height), (3840, 2160));
        assert_eq!(ultra.video_bitrate_kbps, Some(24883));
        assert_eq!(ultra.crf, Some(19));

        assert!(profiles
            .iter()
            .all(|p| p.audio_codec == "pcm_s16le" && p.audio_bitrate_kbps == 128));
    }

    #[test]
    fn legacy_and_tier_resolution() {
        assert!(is_camera_profile("camera-low"));
        assert!(is_camera_profile("camera-balanced"));
        assert!(is_camera_profile("camera-high"));
        assert!(is_camera_profile("camera-ultra"));
        assert!(!is_camera_profile("camera-only"));
        assert!(!is_camera_profile("balanced"));

        // Legacy id resolves with its original values; unknown ids do not.
        let legacy = resolve_profile_by_id("camera-only").expect("legacy resolves");
        assert_eq!((legacy.width, legacy.height, legacy.fps), (1920, 1080, 30));
        assert_eq!(legacy.crf, Some(23));
        assert!(resolve_profile_by_id("camera-balanced").is_some());
        assert!(resolve_profile_by_id("balanced").is_some());
        assert!(resolve_profile_by_id("nope").is_none());
    }

    #[test]
    fn validate_accepts_camera_source_with_tier() {
        for profile in [
            "camera-low",
            "camera-balanced",
            "camera-high",
            "camera-ultra",
        ] {
            assert!(
                camera_config(profile).validate().is_ok(),
                "{profile} must validate"
            );
        }
        // Mic/system audio still allowed in camera mode.
        let mut config = camera_config("camera-balanced");
        config.capture_microphone = true;
        config.microphone_device_id = Some("mic-1".into());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn validate_camera_source_rejects_screen_and_legacy_profiles() {
        for profile in ["balanced", "ultra-4k", "camera-only", "bogus"] {
            let err = validate_error(&camera_config(profile));
            assert!(err.contains("camera quality profile"), "{profile}: {err}");
        }
    }

    #[test]
    fn validate_camera_source_rejects_screen_features() {
        let mut config = camera_config("camera-balanced");
        config.capture_webcam = true;
        config.webcam_device_id = Some("cam".into());
        assert!(validate_error(&config).contains("webcam"));

        let mut config = camera_config("camera-balanced");
        config.smart_zoom_enabled = true;
        assert!(validate_error(&config).contains("smart zoom"));

        let mut config = camera_config("camera-balanced");
        config.capture_keystrokes = true;
        assert!(validate_error(&config).contains("keystroke"));
    }

    #[test]
    fn validate_camera_source_hardens_device_id() {
        let mut config = camera_config("camera-balanced");
        config.source.id = "  ".into();
        assert!(validate_error(&config).contains("identity"));

        let mut config = camera_config("camera-balanced");
        config.source.id = "a".repeat(513);
        assert!(validate_error(&config).contains("device id"));

        let mut config = camera_config("camera-balanced");
        config.source.id = "cam\n-evil".into();
        assert!(validate_error(&config).contains("device id"));
    }

    /// The TypeScript `cameraTiers` and the Rust `camera_profiles()` must
    /// describe the same tiers; the shared JSON fixture is the source of
    /// truth asserted from BOTH languages (same convention as the
    /// `camera-crops` fixture in `exports/camera.rs`).
    #[test]
    fn camera_tiers_fixture_matches_typescript_and_rust() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureTier {
            id: String,
            label: String,
            width: i32,
            height: i32,
            fps: i32,
            bpp: f64,
            min_kbps: u32,
            max_kbps: u32,
            crf: u8,
            nominal_kbps: i32,
        }

        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tooling/fixtures/camera-tiers.json");
        let json = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let fixture: Vec<FixtureTier> = serde_json::from_str(&json).expect("parse tiers fixture");
        assert_eq!(fixture.len(), 4);

        let profiles = camera_profiles();
        assert_eq!(profiles.len(), fixture.len());
        for (profile, tier) in profiles.iter().zip(fixture.iter()) {
            assert_eq!(profile.id, tier.id);
            assert_eq!(profile.label, tier.label);
            assert_eq!(profile.width, tier.width);
            assert_eq!(profile.height, tier.height);
            assert_eq!(profile.fps, tier.fps);
            assert_eq!(profile.crf, Some(tier.crf as i32), "{} crf", tier.id);
            assert_eq!(
                profile.video_bitrate_kbps,
                Some(tier.nominal_kbps),
                "{} nominal bitrate",
                tier.id
            );
            let spec = camera_tier_spec(&tier.id).expect("tier spec");
            assert_eq!(spec.bpp, tier.bpp);
            assert_eq!(spec.min_kbps, tier.min_kbps);
            assert_eq!(spec.max_kbps, tier.max_kbps);
            assert_eq!(spec.crf, tier.crf);
        }
    }

    #[test]
    fn is_valid_camera_device_id_accepts_only_usable_specifiers() {
        assert!(is_valid_camera_device_id("Integrated Camera"));
        assert!(is_valid_camera_device_id(&"x".repeat(512)));
        assert!(!is_valid_camera_device_id(""));
        assert!(!is_valid_camera_device_id("   "));
        assert!(!is_valid_camera_device_id(&"x".repeat(513)));
        assert!(!is_valid_camera_device_id("cam\0evil"));
    }

    #[test]
    fn validate_screen_source_rejects_camera_tiers() {
        for kind in ["display", "window", "region"] {
            let mut config = screen_config("camera-balanced");
            config.source.kind = kind.into();
            let err = validate_error(&config);
            assert!(err.contains("camera source"), "{kind} + camera tier: {err}");
        }
    }

    #[test]
    fn validate_screen_source_still_accepts_legacy_camera_only() {
        let mut config = screen_config("camera-only");
        assert!(config.validate().is_ok());

        // Screen sources keep their normal feature checks too.
        config.capture_keystrokes = true;
        config.smart_zoom_enabled = true;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn validate_still_rejects_unknown_profiles() {
        let err = validate_error(&screen_config("not-a-profile"));
        assert!(err.contains("unknown profile"));
    }

    fn bounds(width: i32, height: i32) -> Bounds {
        Bounds {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    #[test]
    fn matching_aspect_keeps_the_profile_geometry() {
        let balanced = resolve_profile_by_id("balanced").expect("balanced");
        assert_eq!(balanced.for_source_bounds(bounds(1920, 1080)).width, 1920);
        assert_eq!(balanced.for_source_bounds(bounds(1920, 1080)).height, 1080);
        // Same 16:9 at another size: unchanged, because the fit filter upscales
        // small sources today and that behaviour must not change.
        let from_720 = balanced.for_source_bounds(bounds(1280, 720));
        assert_eq!((from_720.width, from_720.height), (1920, 1080));
        // 4K profile onto a 1080p display still delivers 4K.
        let ultra = resolve_profile_by_id("ultra-4k").expect("ultra-4k");
        let from_hd = ultra.for_source_bounds(bounds(1920, 1080));
        assert_eq!((from_hd.width, from_hd.height), (3840, 2160));
    }

    #[test]
    fn mismatched_aspect_fills_the_budget_without_bars() {
        let balanced = resolve_profile_by_id("balanced").expect("balanced");
        // 4:3 window into a 1080p budget: height-limited, no side bars.
        let four_three = balanced.for_source_bounds(bounds(1024, 768));
        assert_eq!((four_three.width, four_three.height), (1440, 1080));
        // 16:10 display.
        let sixteen_ten = balanced.for_source_bounds(bounds(1920, 1200));
        assert_eq!((sixteen_ten.width, sixteen_ten.height), (1728, 1080));
        // 21:9 window: width-limited.
        let ultrawide = balanced.for_source_bounds(bounds(2560, 1080));
        assert_eq!((ultrawide.width, ultrawide.height), (1920, 810));
        // Portrait region.
        let portrait = balanced.for_source_bounds(bounds(600, 900));
        assert_eq!((portrait.width, portrait.height), (720, 1080));
    }

    #[test]
    fn derived_geometry_is_always_even_and_never_degenerate() {
        let balanced = resolve_profile_by_id("balanced").expect("balanced");
        for (width, height) in [(1367, 769), (3, 5), (1, 1), (16383, 4096)] {
            let fitted = balanced.for_source_bounds(bounds(width, height));
            assert_eq!(fitted.width % 2, 0, "{width}x{height} → {fitted:?}");
            assert_eq!(fitted.height % 2, 0, "{width}x{height} → {fitted:?}");
            assert!(fitted.width >= 2 && fitted.height >= 2, "{fitted:?}");
            // The budget is respected: no dimension exceeds the profile box.
            assert!(fitted.width <= balanced.width, "{fitted:?}");
            assert!(fitted.height <= balanced.height, "{fitted:?}");
        }
    }

    #[test]
    fn camera_profiles_keep_their_device_budget() {
        let camera = resolve_profile_by_id("camera-balanced").expect("camera-balanced");
        // A 4:3 source must not shrink a camera tier's plan budget.
        let fitted = camera.for_source_bounds(bounds(640, 480));
        assert_eq!((fitted.width, fitted.height), (camera.width, camera.height));
        // Legacy `camera-only` is a SCREEN profile, so it does adapt.
        let legacy = resolve_profile_by_id("camera-only").expect("camera-only");
        let adapted = legacy.for_source_bounds(bounds(1024, 768));
        assert_eq!((adapted.width, adapted.height), (1440, 1080));
    }

    #[test]
    fn resolve_profile_for_source_adapts_screen_configs() {
        let mut config = screen_config("balanced");
        config.source.kind = "window".into();
        config.source.bounds = bounds(800, 600);
        let resolved = config
            .resolve_profile_for_source()
            .expect("profile resolves");
        assert_eq!((resolved.width, resolved.height), (1440, 1080));
        // The untagged resolver stays the raw profile for UI/benchmark use.
        assert_eq!(config.resolve_profile().expect("raw").width, 1920);
    }
}
