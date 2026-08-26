//! End-to-end integration tests for macOS and Apple Silicon hardware architecture.
//!
//! Validates:
//! 1. Native Apple Silicon architecture & environment contract (aarch64 / ARM64).
//! 2. ScreenCaptureKit discovery, source mapping, and live capture lifecycle with audio sync.
//! 3. CoreAudio microphone and system audio capture, WAV framing, timeline alignment, and repair.
//! 4. Apple VideoToolbox (H.264 / HEVC) hardware accelerated encoder detection and CLI configuration.
//! 5. End-to-end recording session lifecycle with SQLite persistence and manifest durability.
//! 6. Crash recovery resilience for interrupted macOS capture sessions and unfinalized WAV headers.

use recordforge_desktop_lib::capture::audio::coreaudio::{
    enumerate_coreaudio_devices, AudioCaptureOptions, CoreAudioCaptureSession,
};
use recordforge_desktop_lib::capture::audio::wav::{
    align_wav_to_duration, repair_wav_header_if_needed, AudioSampleFormat, DEFAULT_CHANNELS,
    DEFAULT_SAMPLE_RATE, WAV_HEADER_SIZE,
};
use recordforge_desktop_lib::capture::encoder::detect_encoders;
use recordforge_desktop_lib::capture::manifest::{RecorderState, RecordingManifest};
use recordforge_desktop_lib::capture::recovery::scan_recovery;
use recordforge_desktop_lib::capture::screencapturekit::{
    get_shareable_content, is_screencapturekit_available, sck_content_to_capture_sources,
    SckCaptureSession, SckContentFilter, SckDisplay, SckPixelFormat, SckStreamConfig, SckWindow,
};
use recordforge_desktop_lib::capture::source::{Bounds, CaptureSource};
use recordforge_desktop_lib::database::library::{
    delete_recording, insert_recording, list_recordings,
};
use recordforge_desktop_lib::database::migrations::run_migrations;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn temp_test_dir(prefix: &str) -> PathBuf {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = std::env::temp_dir().join(format!("recordforge_macos_e2e_{prefix}_{id}"));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn test_apple_silicon_hardware_environment() {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    tracing::info!(os = %os, arch = %arch, "Running on host environment");

    // If running on an actual macOS Apple Silicon runner (macOS 14+ M-series in CI)
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        assert_eq!(os, "macos", "Target OS must be macOS");
        assert_eq!(
            arch, "aarch64",
            "Target architecture must be Apple Silicon aarch64"
        );
        assert!(
            is_screencapturekit_available(),
            "ScreenCaptureKit must be available on macOS 14+ Apple Silicon"
        );
    }
}

#[test]
fn test_screencapturekit_shareable_content_and_source_mapping() {
    // Probe shareable content
    let content = get_shareable_content().expect("query shareable content");
    assert!(
        !content.displays.is_empty(),
        "Must discover at least one display"
    );

    let sources = sck_content_to_capture_sources(&content);
    assert!(
        !sources.is_empty(),
        "Must map shareable content to capture sources"
    );

    let primary_display = &sources[0];
    assert_eq!(primary_display.kind, "display");
    assert!(primary_display.bounds.width > 0);
    assert!(primary_display.bounds.height > 0);

    // Verify window filtering logic with custom simulated content
    let simulated_content =
        recordforge_desktop_lib::capture::screencapturekit::SckShareableContent {
            displays: vec![SckDisplay {
                display_id: 1,
                width: 2560,
                height: 1440,
                point_width: 2560.0,
                point_height: 1440.0,
                scale_factor: 2.0,
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 2560,
                    height: 1440,
                },
            }],
            windows: vec![
                SckWindow {
                    window_id: 101,
                    title: "Code — recordForge".into(),
                    owning_app_name: "Code".into(),
                    owning_app_bundle_id: Some("com.microsoft.VSCode".into()),
                    owning_app_pid: 2024,
                    bounds: Bounds {
                        x: 50,
                        y: 50,
                        width: 1400,
                        height: 900,
                    },
                    window_layer: 0,
                    is_on_screen: true,
                    is_active: true,
                },
                SckWindow {
                    window_id: 999,
                    title: "Hidden Offscreen".into(),
                    owning_app_name: "Helper".into(),
                    owning_app_bundle_id: None,
                    owning_app_pid: 5050,
                    bounds: Bounds {
                        x: -2000,
                        y: -2000,
                        width: 10,
                        height: 10,
                    },
                    window_layer: 0,
                    is_on_screen: false,
                    is_active: false,
                },
            ],
            applications: Vec::new(),
        };

    let mapped = sck_content_to_capture_sources(&simulated_content);
    assert_eq!(
        mapped.len(),
        2,
        "Expected 1 display + 1 visible on-screen window"
    );
    assert_eq!(mapped[0].id, "display-0");
    assert_eq!(mapped[1].id, "win-101");
    assert_eq!(mapped[1].name, "Code — Code — recordForge");
}

#[test]
fn test_screencapturekit_capture_session_live_stream_and_wav_sync() {
    let temp_dir = temp_test_dir("sck_stream");
    let video_path = temp_dir.join("segment_000.mp4");
    let audio_path = temp_dir.join("sys_000.wav");

    let config = SckStreamConfig {
        width: 1920,
        height: 1080,
        fps: 60,
        pixel_format: SckPixelFormat::Bgra8888,
        shows_cursor: false,
        captures_audio: true,
        sample_rate: DEFAULT_SAMPLE_RATE,
        channel_count: DEFAULT_CHANNELS,
        excludes_current_process_audio: true,
    };

    let filter = SckContentFilter::Display {
        display: SckDisplay {
            display_id: 1,
            width: 1920,
            height: 1080,
            point_width: 1920.0,
            point_height: 1080.0,
            scale_factor: 2.0,
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        },
        excluded_windows: Vec::new(),
    };

    // Simulate timeline origin slightly in the past (20 ms) to exercise leading silence padding
    let timeline_origin = Instant::now() - Duration::from_millis(20);

    let mut session = SckCaptureSession::start(
        config,
        filter,
        video_path.clone(),
        Some(audio_path.clone()),
        timeline_origin,
    )
    .expect("start ScreenCaptureKit session");

    assert_eq!(session.output_video_path(), video_path.as_path());
    assert_eq!(session.output_audio_path(), Some(audio_path.as_path()));

    // Record for 80 ms
    std::thread::sleep(Duration::from_millis(80));

    let result = session.stop().expect("stop ScreenCaptureKit session");
    assert!(result.frames_captured > 0, "Frames must be captured");
    assert!(
        result.audio_bytes_written > 0,
        "Audio bytes must be written"
    );

    // Validate generated WAV container
    assert!(audio_path.is_file(), "Audio WAV file must exist on disk");
    let wav_bytes = std::fs::read(&audio_path).expect("read generated WAV");
    assert!(
        wav_bytes.len() >= WAV_HEADER_SIZE as usize,
        "WAV file must contain at least standard 44-byte header"
    );
    assert_eq!(&wav_bytes[0..4], b"RIFF");
    assert_eq!(&wav_bytes[8..12], b"WAVE");
    assert_eq!(&wav_bytes[12..16], b"fmt ");
    assert_eq!(&wav_bytes[36..40], b"data");

    // Verify finalized data size matches file length - 44
    let data_len = u32::from_le_bytes([wav_bytes[40], wav_bytes[41], wav_bytes[42], wav_bytes[43]]);
    assert_eq!(
        data_len as usize,
        wav_bytes.len() - WAV_HEADER_SIZE as usize
    );

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn test_coreaudio_multitrack_recording_and_duration_alignment() {
    let temp_dir = temp_test_dir("coreaudio_multitrack");
    let mic_path = temp_dir.join("mic_000.wav");
    let sys_path = temp_dir.join("sys_000.wav");

    // Enumerate CoreAudio devices
    let devices = enumerate_coreaudio_devices().expect("enumerate CoreAudio endpoints");
    assert!(!devices.is_empty(), "Must discover CoreAudio endpoints");
    assert!(
        devices.iter().any(|d| !d.is_loopback),
        "Must discover microphone endpoint"
    );
    assert!(
        devices.iter().any(|d| d.is_loopback),
        "Must discover system loopback endpoint"
    );

    let timeline_origin = Instant::now();

    // Start microphone capture session
    let mic_options = AudioCaptureOptions::microphone(None, mic_path.clone())
        .with_timeline_origin(timeline_origin);
    let mut mic_session =
        CoreAudioCaptureSession::start(mic_options).expect("start CoreAudio mic session");

    // Start system audio loopback capture session
    let sys_options = AudioCaptureOptions::system_loopback(None, sys_path.clone())
        .with_timeline_origin(timeline_origin);
    let mut sys_session =
        CoreAudioCaptureSession::start(sys_options).expect("start CoreAudio sys session");

    // Record for 60 ms
    std::thread::sleep(Duration::from_millis(60));

    let mic_bytes = mic_session.stop().expect("stop mic session");
    let sys_bytes = sys_session.stop().expect("stop sys session");

    assert!(mic_bytes > WAV_HEADER_SIZE);
    assert!(sys_bytes > WAV_HEADER_SIZE);

    // Test timeline duration alignment (trim head and pad/clamp to exact 100ms)
    let aligned_len = align_wav_to_duration(
        &mic_path,
        DEFAULT_SAMPLE_RATE,
        DEFAULT_CHANNELS,
        AudioSampleFormat::Pcm16,
        Duration::from_millis(10),
        Duration::from_millis(100),
    )
    .expect("align mic wav to duration");

    // 100ms * 48000 samples/sec * 4 bytes/frame = 19,200 bytes + 44 header = 19,244 bytes
    assert_eq!(aligned_len, 19244);
    let aligned_file_len = std::fs::metadata(&mic_path).unwrap().len();
    assert_eq!(aligned_file_len, 19244);

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn test_apple_videotoolbox_hardware_encoder_detection_and_export_args() {
    // Verify that VideoToolbox hardware encoders are part of the probed candidates
    let ffmpeg_stub = "ffmpeg";
    // detect_encoders is cached; probe or clear cache to verify candidate registrations
    recordforge_desktop_lib::capture::encoder::clear_encoder_cache();
    let encoders = detect_encoders(ffmpeg_stub).unwrap_or_default();

    assert!(
        encoders
            .iter()
            .any(|e| e.id == "h264_videotoolbox" && e.vendor.as_deref() == Some("apple")),
        "h264_videotoolbox must be registered as an Apple hardware encoder"
    );
    assert!(
        encoders
            .iter()
            .any(|e| e.id == "hevc_videotoolbox" && e.vendor.as_deref() == Some("apple")),
        "hevc_videotoolbox must be registered as an Apple hardware encoder"
    );
}

#[test]
fn test_e2e_macos_recording_session_sqlite_and_manifest_persistence() {
    let temp_dir = temp_test_dir("session_sqlite_e2e");
    let session_id = uuid::Uuid::new_v4().to_string();
    let work_dir = temp_dir.join(&session_id);
    std::fs::create_dir_all(&work_dir).unwrap();

    let source = CaptureSource {
        kind: "display".into(),
        id: "display-0".into(),
        name: "Retina Display 1".into(),
        bounds: Bounds {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        },
    };

    // Create and save manifest
    let mut manifest = RecordingManifest::new(
        session_id.clone(),
        work_dir.to_string_lossy(),
        source,
        "high-quality",
    );
    manifest.set_output_path(work_dir.join("final_recording.mp4").to_string_lossy());
    manifest.set_state(RecorderState::Completed);
    manifest.write().expect("write manifest");

    // Initialize SQLite in-memory database with migrations
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    run_migrations(&mut conn).expect("run database migrations");

    // Insert recording into library
    let rec = insert_recording(&mut conn, &manifest, 15000).expect("insert recording");
    assert_eq!(rec.session_id, session_id);
    assert_eq!(rec.profile_name, "high-quality");

    let recordings = list_recordings(&conn).expect("list recordings");
    assert_eq!(recordings.len(), 1);
    assert_eq!(recordings[0].id, rec.id);

    // Delete recording atomically
    let del_res = delete_recording(&conn, &rec.id, &temp_dir);
    assert!(del_res.is_ok());
    assert_eq!(list_recordings(&conn).unwrap().len(), 0);

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn test_macos_crash_recovery_repairs_unfinalized_session_and_wav_headers() {
    let temp_dir = temp_test_dir("macos_crash_recovery");
    let session_id = uuid::Uuid::new_v4().to_string();
    let work_dir = temp_dir.join(&session_id);
    std::fs::create_dir_all(&work_dir).unwrap();

    let source = CaptureSource {
        kind: "display".into(),
        id: "display-0".into(),
        name: "Display 1".into(),
        bounds: Bounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        },
    };

    // Create manifest in unfinalized Recording state (process killed unexpectedly)
    let manifest = RecordingManifest::new(
        session_id.clone(),
        work_dir.to_string_lossy(),
        source,
        "balanced",
    );
    manifest.write().unwrap();

    // Create unfinalized video segment
    let seg_path = work_dir.join("segment_000.mp4");
    std::fs::write(&seg_path, vec![0xABu8; 250 * 1024]).unwrap();

    // Create unfinalized audio WAV track with 0-byte header length field
    let wav_path = work_dir.join("mic_000.wav");
    let mut header = vec![0u8; 44];
    header[0..4].copy_from_slice(b"RIFF");
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    header[22..24].copy_from_slice(&2u16.to_le_bytes()); // 2 channels
    header[24..28].copy_from_slice(&48000u32.to_le_bytes());
    header[28..32].copy_from_slice(&192000u32.to_le_bytes());
    header[32..34].copy_from_slice(&4u16.to_le_bytes());
    header[34..36].copy_from_slice(&16u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&0u32.to_le_bytes()); // Unfinalized 0-size field

    let mut wav_file = std::fs::File::create(&wav_path).unwrap();
    std::io::Write::write_all(&mut wav_file, &header).unwrap();
    // Simulate 38,400 bytes (200ms) of PCM samples written before crash
    std::io::Write::write_all(&mut wav_file, &vec![0x42u8; 38400]).unwrap();
    drop(wav_file);

    // Scan for recoverable sessions
    let scan_results = scan_recovery(&temp_dir).expect("scan recovery");
    assert_eq!(scan_results.len(), 1);
    assert!(
        scan_results[0].is_recoverable,
        "Interrupted macOS recording session must be detected as recoverable"
    );

    // Run header repair
    let repaired_size =
        repair_wav_header_if_needed(&wav_path).expect("repair unfinalized WAV header");
    assert_eq!(repaired_size, 38444);

    let repaired_bytes = std::fs::read(&wav_path).unwrap();
    let data_len = u32::from_le_bytes([
        repaired_bytes[40],
        repaired_bytes[41],
        repaired_bytes[42],
        repaired_bytes[43],
    ]);
    let riff_len = u32::from_le_bytes([
        repaired_bytes[4],
        repaired_bytes[5],
        repaired_bytes[6],
        repaired_bytes[7],
    ]);
    assert_eq!(data_len, 38400);
    assert_eq!(riff_len, 38436);

    std::fs::remove_dir_all(&temp_dir).ok();
}
