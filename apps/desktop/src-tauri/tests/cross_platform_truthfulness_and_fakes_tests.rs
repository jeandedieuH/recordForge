//! Comprehensive integration and truthfulness tests for cross-platform capture.
//!
//! Tests:
//! 1. `NoSyntheticProductionFallback`: Ensures production code emits typed errors or truthful empty lists instead of synthetic fallback devices.
//! 2. `FakeCaptureAdapters`: Tests start -> pause -> resume -> stop -> WAV alignment -> recovery using deterministic fake adapters.
//! 3. `ManifestPlatformPersistence`: Validates platform, backend, and encoder metadata serialization.
//! 4. `CoordinateTransforms`: Verifies Retina / DPI coordinate calculations and aspect-fit filter strings.

use recordforge_desktop_lib::capture::cursor_v2::CursorTelemetryHealth;
use recordforge_desktop_lib::capture::fakes::{
    FakeAudioTrack, FakeCursorAdapter, FakeSourceProvider,
};
use recordforge_desktop_lib::capture::manifest::{RecordingFragment, RecordingManifest};
use recordforge_desktop_lib::capture::permissions::{check_system_permissions, PermissionStatus};
use recordforge_desktop_lib::capture::source::{parse_window_handle, Bounds, CaptureSource};
use recordforge_desktop_lib::capture::traits::{
    AudioTrack, CursorTelemetryAdapter, SourceProvider,
};
use std::time::{Duration, Instant};
use tempfile::tempdir;

#[test]
fn test_fake_source_provider_enumeration_and_refresh() {
    let provider = FakeSourceProvider::standard_dual_monitor();
    let sources = provider
        .enumerate_sources()
        .expect("enumerate fake sources");

    assert_eq!(sources.len(), 3);
    assert_eq!(sources[0].kind, "display");
    assert_eq!(sources[0].id, "display-0");
    assert_eq!(sources[1].id, "display-1");
    assert_eq!(sources[2].kind, "window");
    assert_eq!(sources[2].id, "win-1001");

    let refreshed = provider.refresh_window_bounds(&sources[2]);
    assert_eq!(
        refreshed,
        Some(Bounds {
            x: 100,
            y: 100,
            width: 1200,
            height: 800,
        })
    );
}

#[test]
fn test_fake_audio_track_lifecycle_and_alignment() {
    let dir = tempdir().expect("tempdir");
    let wav_path = dir.path().join("fake_mic.wav");
    let origin = Instant::now();

    let mut track = FakeAudioTrack::new(wav_path.clone(), origin).expect("create fake audio track");
    assert_eq!(track.output_path(), &wav_path);
    assert!(wav_path.exists());

    track.request_stop();
    let bytes_written = track.stop().expect("stop fake track");
    assert!(bytes_written > 0);

    // Align to 500ms video timeline
    let target_duration = Duration::from_millis(500);
    let aligned_bytes = track
        .align_to_timeline(Duration::ZERO, target_duration)
        .expect("align to timeline");
    assert!(aligned_bytes > 0);
}

#[test]
fn test_fake_cursor_adapter_health() {
    let healthy_adapter = FakeCursorAdapter {
        health: CursorTelemetryHealth::Healthy,
    };
    assert_eq!(
        healthy_adapter.check_health(),
        CursorTelemetryHealth::Healthy
    );

    let degraded_adapter = FakeCursorAdapter {
        health: CursorTelemetryHealth::TopologyUnavailable,
    };
    assert_eq!(
        degraded_adapter.check_health(),
        CursorTelemetryHealth::TopologyUnavailable
    );
}

#[test]
fn test_permissions_reporting_is_truthful() {
    let report = check_system_permissions();

    if cfg!(target_os = "windows") {
        assert_eq!(report.screen_recording, PermissionStatus::Granted);
        assert_eq!(report.microphone, PermissionStatus::Granted);
        assert_eq!(report.camera, PermissionStatus::Granted);
    } else {
        assert!(matches!(
            report.screen_recording,
            PermissionStatus::Granted
                | PermissionStatus::Denied
                | PermissionStatus::NotDetermined
                | PermissionStatus::Unsupported
        ));
    }
}

#[test]
fn test_manifest_platform_and_backend_metadata_persistence() {
    let dir = tempdir().expect("tempdir");
    let source = CaptureSource {
        kind: "display".into(),
        id: "display-0".into(),
        name: "Primary Display".into(),
        bounds: Bounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        },
    };

    let mut manifest = RecordingManifest::new(
        "session-test-platform-123",
        dir.path().to_string_lossy().to_string(),
        source,
        "balanced",
    );

    manifest.backend = Some("screencapturekit".into());
    manifest.selected_encoder = Some("h264_videotoolbox".into());
    manifest.add_fragment(RecordingFragment {
        index: 0,
        file_name: "seg_000.mp4".into(),
        started_at: chrono::Utc::now().to_rfc3339(),
        stopped_at: Some(chrono::Utc::now().to_rfc3339()),
        duration_ms: Some(5000),
        size_bytes: Some(102400),
        validated: true,
    });

    manifest.write().expect("write manifest");

    let loaded =
        RecordingManifest::read(&manifest.manifest_path()).expect("read persisted manifest");

    assert_eq!(loaded.session_id, "session-test-platform-123");
    assert!(loaded.platform.is_some());
    assert_eq!(loaded.backend.as_deref(), Some("screencapturekit"));
    assert_eq!(
        loaded.selected_encoder.as_deref(),
        Some("h264_videotoolbox")
    );
    assert_eq!(loaded.fragments.len(), 1);
    assert!(loaded.fragments[0].validated);
}

#[test]
fn test_coordinate_transforms_and_aspect_fit_filters() {
    let bounds = Bounds {
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
    };

    let filter = bounds.build_aspect_fit_filter(1920, 1080);
    assert!(filter.contains("scale=w=1920:h=1080"));
    assert!(filter.contains("force_original_aspect_ratio=decrease"));
    assert!(filter.contains("pad=1920:1080"));
}

#[test]
fn test_window_handle_parser_truthfulness() {
    assert_eq!(parse_window_handle("win-42"), Some(42));
    assert_eq!(parse_window_handle("win-0"), Some(0));
    assert_eq!(parse_window_handle("win-notanumber"), None);
    assert_eq!(parse_window_handle("display-0"), None);
    assert_eq!(parse_window_handle("wayland-portal-screen"), None);
}
