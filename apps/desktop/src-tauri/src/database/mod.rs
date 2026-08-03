pub mod library;
pub mod media;
pub mod settings;

use rusqlite::Connection;
use std::fmt::Debug;
use std::path::Path;
use tracing::{info, instrument};

/// Initialize the local SQLite database and run pending migrations.
#[instrument]
pub fn initialize(db_path: impl AsRef<Path> + Debug) -> Result<Connection, rusqlite::Error> {
    let path = db_path.as_ref();
    info!(db_path = %path.display(), "initializing SQLite database");

    let conn = Connection::open(path)?;

    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    run_migrations(&conn)?;

    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Phase 0 baseline schema.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_json TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS upload_jobs (
            id TEXT PRIMARY KEY,
            provider_profile_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            export_id TEXT NOT NULL,
            local_path TEXT NOT NULL,
            remote_path TEXT NOT NULL,
            state TEXT NOT NULL,
            bytes_uploaded INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        )",
        [],
    )?;

    let current_version: i32 = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default()
        .parse()
        .unwrap_or(0);

    if current_version < 2 {
        migrate_v2(conn)?;
    }

    if current_version < 3 {
        migrate_v3(conn)?;
    }

    if current_version < 4 {
        migrate_v4(conn)?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '4')",
        [],
    )?;

    Ok(())
}

fn migrate_v2(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Pre-release migration: drop the old v1 recordings table and recreate it
    // to match the LibraryRecording contract.
    conn.execute("DROP TABLE IF EXISTS recordings", [])?;
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
            work_dir TEXT NOT NULL,
            thumbnail_path TEXT,
            markers TEXT NOT NULL DEFAULT '[]'
        )",
        [],
    )?;
    Ok(())
}

fn migrate_v4(conn: &Connection) -> Result<(), rusqlite::Error> {
    // R0 settings persistence: theme, window transparency, recorder defaults.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    Ok(())
}

fn migrate_v3(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Phase 3 media preparation tables.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_jobs (
            id TEXT PRIMARY KEY,
            recording_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            stage TEXT NOT NULL,
            message TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            outputs TEXT NOT NULL DEFAULT '{}'
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_jobs_recording ON media_jobs(recording_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status)",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_metadata (
            recording_id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            width INTEGER,
            height INTEGER,
            fps REAL,
            has_audio INTEGER NOT NULL DEFAULT 0,
            video_codec TEXT,
            audio_codec TEXT,
            bitrate_kbps REAL,
            streams TEXT NOT NULL DEFAULT '[]',
            format TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS derivatives (
            id TEXT PRIMARY KEY,
            recording_id TEXT NOT NULL,
            job_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            path TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_derivatives_recording ON derivatives(recording_id)",
        [],
    )?;

    Ok(())
}
