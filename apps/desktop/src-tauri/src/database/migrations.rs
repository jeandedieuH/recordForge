use rusqlite::{Connection, Transaction};
use tracing::info;

/// Run versioned, transactional, forward-only migrations.
pub fn run_migrations(conn: &mut Connection) -> Result<(), rusqlite::Error> {
    // 1. Create app_meta table for tracking schema version if it does not exist.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
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

    info!(current_version, "running database migrations");

    // Execute migrations inside a transaction
    let tx = conn.transaction()?;

    if current_version < 1 {
        migrate_v1(&tx)?;
    }
    if current_version < 2 {
        migrate_v2_safe(&tx)?;
    }
    if current_version < 3 {
        migrate_v3(&tx)?;
    }
    if current_version < 4 {
        migrate_v4(&tx)?;
    }
    if current_version < 5 {
        migrate_v5(&tx)?;
    }
    if current_version < 6 {
        migrate_v6(&tx)?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '6')",
        [],
    )?;

    tx.commit()?;
    Ok(())
}

fn migrate_v1(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_json TEXT NOT NULL
        )",
        [],
    )?;

    tx.execute(
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

    Ok(())
}

/// Non-destructive migration to v2 schema (fixing P0.9).
fn migrate_v2_safe(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    // Instead of DROP TABLE IF EXISTS, create recordings if not exists, or add missing columns.
    tx.execute(
        "CREATE TABLE IF NOT EXISTS recordings (
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
            status TEXT NOT NULL DEFAULT 'completed',
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

    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status)",
        [],
    )?;
    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at DESC)",
        [],
    )?;

    Ok(())
}

fn migrate_v3(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute(
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

    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_jobs_recording ON media_jobs(recording_id)",
        [],
    )?;
    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status)",
        [],
    )?;

    tx.execute(
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

    tx.execute(
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

    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_derivatives_recording ON derivatives(recording_id)",
        [],
    )?;

    Ok(())
}

fn migrate_v4(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    Ok(())
}

/// v5: durable project index with recording reference and full project json.
fn migrate_v5(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    // A partially initialized v1 database may not have created the project
    // index yet. Create the legacy shape before rebuilding it so migration is
    // safe for both complete and interrupted first-run databases.
    tx.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_json TEXT NOT NULL
        )",
        [],
    )?;

    // The v1 projects table did not include a recording_id column or FK.
    // Rebuild it non-destructively so existing rows keep their project_json.
    tx.execute(
        "CREATE TABLE IF NOT EXISTS projects_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            recording_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_json TEXT NOT NULL,
            FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Attempt to backfill recording_id from the JSON payload when available.
    // If json_extract is unavailable, existing rows get an empty recording_id
    // and will be repaired the next time they are saved through the project API.
    let fill_sql = "INSERT OR REPLACE INTO projects_new
        SELECT
            id,
            name,
            COALESCE(json_extract(project_json, '$.recordingId'), '') AS recording_id,
            created_at,
            updated_at,
            project_json
        FROM projects";

    if tx.execute(fill_sql, []).is_err() {
        // Fallback: copy without recording_id backfill. Existing rows with an
        // empty recording_id will be overwritten on their next save.
        tx.execute(
            "INSERT OR REPLACE INTO projects_new
                SELECT id, name, '', created_at, updated_at, project_json FROM projects",
            [],
        )?;
    }

    tx.execute("DROP TABLE IF EXISTS projects", [])?;
    tx.execute("ALTER TABLE projects_new RENAME TO projects", [])?;
    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_projects_recording ON projects(recording_id)",
        [],
    )?;
    Ok(())
}

/// v6: persist the full export request so one durable job identity can be
/// retried or resumed after an application restart.
fn migrate_v6(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute(
        "ALTER TABLE media_jobs ADD COLUMN options TEXT NOT NULL DEFAULT '{}'",
        [],
    )?;
    tx.execute(
        "ALTER TABLE media_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_non_destructive_v2_migration() {
        let mut conn = Connection::open_in_memory().unwrap();

        // Create old table with data
        conn.execute(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO app_meta VALUES ('schema_version', '1')", [])
            .unwrap();
        conn.execute("CREATE TABLE recordings (id TEXT PRIMARY KEY, session_id TEXT, name TEXT, created_at TEXT, updated_at TEXT, duration_ms INTEGER, size_bytes INTEGER, width INTEGER, height INTEGER, fps INTEGER, status TEXT, tags TEXT, source TEXT, profile_name TEXT, output_path TEXT, work_dir TEXT, thumbnail_path TEXT, markers TEXT)", []).unwrap();
        conn.execute("INSERT INTO recordings (id, session_id, name, created_at, updated_at, source, profile_name, work_dir) VALUES ('rec-1', 's-1', 'My Rec', '2026', '2026', '{}', 'balanced', '/tmp')", []).unwrap();

        // Run migrations
        run_migrations(&mut conn).unwrap();

        // Verify data was PRESERVED
        let count: i64 = conn
            .query_row("SELECT count(*) FROM recordings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "Migration must preserve existing recordings");

        let version: String = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, "6");
    }
}
