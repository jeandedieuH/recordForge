//! Reproductions for P0 Blocker Bugs (P0.1, P0.6, P0.7, P0.8, P0.9)
//!
//! These tests establish baseline reproductions for critical P0 bugs before fixing them.

use recordforge_desktop_lib::capture::manifest::{RecorderState, RecordingManifest};
use recordforge_desktop_lib::capture::recovery::{delete_recovery_session, scan_recovery};
use recordforge_desktop_lib::capture::source::{Bounds, CaptureSource};
use recordforge_desktop_lib::database::library::{
    delete_recording, insert_recording, list_recordings,
};

#[test]
fn test_p0_1_first_segment_crash_unrecoverable() {
    let temp_dir = tempfile_dir("p0_1_test");
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

    // Create a manifest in Recording state (process crashed mid-recording without calling pause/stop)
    let manifest = RecordingManifest::new(
        session_id.clone(),
        work_dir.to_string_lossy(),
        source,
        "balanced",
    );
    manifest.write().unwrap();

    // Simulate FFmpeg writing 500KB to seg_000.mp4 before the process was killed
    let seg_path = work_dir.join("seg_000.mp4");
    std::fs::write(&seg_path, vec![0u8; 500 * 1024]).unwrap();

    // Scan for recovery
    let results = scan_recovery(&temp_dir).unwrap();
    assert_eq!(results.len(), 1);
    let result = &results[0];

    // P0.1 Fix Verification: Direct file scanning recovers unfinalized segments after force-quit/crash
    assert!(
        result.is_recoverable,
        "P0.1 FIX CONFIRMED: Segment file detected and marked recoverable!"
    );

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn test_p0_7_path_traversal_in_delete_recovery_session() {
    let temp_dir = tempfile_dir("p0_7_test");
    let secret_dir = temp_dir.join("secret_data");
    std::fs::create_dir_all(&secret_dir).unwrap();
    std::fs::write(secret_dir.join("file.txt"), "important").unwrap();

    let sessions_dir = temp_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();

    // Traversal payload targeting secret_dir outside sessions_dir
    let traversal_id = "../secret_data";

    // P0.7 Fix Verification: delete_recovery_session MUST return an error on path traversal
    let res = delete_recovery_session(traversal_id, &sessions_dir);
    assert!(
        res.is_err(),
        "delete_recovery_session correctly rejected path traversal attempt"
    );

    // Verify secret_dir WAS NOT DELETED
    assert!(
        secret_dir.exists(),
        "P0.7 FIX CONFIRMED: Path traversal prevented! Secret directory remains intact."
    );

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn test_p0_8_delete_recording_non_atomic() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();

    // Init v2 schema
    conn.execute(
        "CREATE TABLE recordings (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            fps INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL,
            profile_name TEXT NOT NULL,
            output_path TEXT,
            webcam_path TEXT,
            work_dir TEXT NOT NULL,
            thumbnail_path TEXT,
            markers TEXT NOT NULL DEFAULT '[]'
        )",
        [],
    )
    .unwrap();

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

    let session_id = uuid::Uuid::new_v4().to_string();
    let mut manifest = RecordingManifest::new(session_id, "C:/tmp/work", source, "balanced");
    manifest.set_output_path("C:/nonexistent/file/that/cannot/be/deleted.mp4");

    let rec = insert_recording(&mut conn, &manifest, 100).unwrap();
    let retry = insert_recording(&mut conn, &manifest, 100).unwrap();
    assert_eq!(
        retry.id, rec.id,
        "session retries must not duplicate library rows"
    );
    assert_eq!(list_recordings(&conn).unwrap().len(), 1);

    // Delete recording row. Pass an existing app data dir for path containment
    // validation; the recording's file paths are nonexistent, so deletion still
    // proceeds to the database row.
    let delete_res = delete_recording(&conn, &rec.id, &std::env::temp_dir());
    assert!(delete_res.is_ok());

    // P0.8 Bug Reproduction: The database row is removed even though the file removal was attempted afterward and ignored.
    let remaining = list_recordings(&conn).unwrap();
    assert_eq!(
        remaining.len(),
        0,
        "P0.8: DB row deleted regardless of file deletion outcome"
    );
}

#[test]
fn test_p0_9_migrate_v2_destroys_recordings() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();

    // Create v1-style app_meta and recordings table with data
    conn.execute(
        "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO app_meta VALUES ('schema_version', '1')", [])
        .unwrap();
    conn.execute(
        "CREATE TABLE recordings (id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, fps INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'completed', tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '{}', profile_name TEXT NOT NULL DEFAULT 'balanced', output_path TEXT, work_dir TEXT NOT NULL DEFAULT '', thumbnail_path TEXT, markers TEXT NOT NULL DEFAULT '[]')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO recordings (id, name) VALUES ('rec-1', 'Important Recording')",
        [],
    )
    .unwrap();

    // Verify row exists
    let count_before: i64 = conn
        .query_row("SELECT count(*) FROM recordings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count_before, 1);

    // Run new transactional forward-only migrations
    recordforge_desktop_lib::database::migrations::run_migrations(&mut conn).unwrap();

    // P0.9 Fix Verification: Non-destructive migrations MUST preserve existing recording data!
    let count_after: i64 = conn
        .query_row("SELECT count(*) FROM recordings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        count_after, 1,
        "P0.9 FIX CONFIRMED: Transactional migrations preserved user recording data!"
    );
}

#[test]
fn test_manifest_rewrite_is_atomic_and_durable() {
    let temp_dir = tempfile_dir("manifest_rewrite");
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

    let mut manifest =
        RecordingManifest::new(session_id, work_dir.to_string_lossy(), source, "balanced");
    manifest.write().unwrap();
    manifest.set_state(RecorderState::Paused);
    manifest.write().unwrap();

    let restored = RecordingManifest::read(work_dir.join("session.json")).unwrap();
    assert_eq!(restored.state, RecorderState::Paused);
    assert!(!work_dir.join("session.json.tmp").exists());
    std::fs::remove_dir_all(&temp_dir).unwrap();
}

#[test]
fn test_recovery_repairs_unfinalized_audio_wav_header() {
    let temp_dir = tempfile_dir("wav_repair");
    let wav_path = temp_dir.join("mic_000.wav");

    // Construct a standard 44-byte WAV header with 0 data length as happens before finalize_wav()
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
    header[40..44].copy_from_slice(&0u32.to_le_bytes()); // unfinalized 0 size

    let mut file = std::fs::File::create(&wav_path).unwrap();
    std::io::Write::write_all(&mut file, &header).unwrap();
    // Simulate 48,000 bytes of audio PCM written before crash
    std::io::Write::write_all(&mut file, &vec![0x12u8; 48000]).unwrap();
    drop(file);

    let repaired_len = recordforge_desktop_lib::capture::audio::repair_wav_header_if_needed(&wav_path).unwrap();
    assert_eq!(repaired_len, 48044);

    let read_back = std::fs::read(&wav_path).unwrap();
    let data_len = u32::from_le_bytes([read_back[40], read_back[41], read_back[42], read_back[43]]);
    let riff_len = u32::from_le_bytes([read_back[4], read_back[5], read_back[6], read_back[7]]);
    assert_eq!(data_len, 48000);
    assert_eq!(riff_len, 48036);

    std::fs::remove_dir_all(&temp_dir).unwrap();
}

fn tempfile_dir(prefix: &str) -> std::path::PathBuf {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = std::env::temp_dir().join(format!("recordforge_test_{prefix}_{id}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
