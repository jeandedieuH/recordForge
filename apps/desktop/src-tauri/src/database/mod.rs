pub mod library;

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

    conn.execute(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '2')",
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
