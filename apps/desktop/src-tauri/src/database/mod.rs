pub mod library;
pub mod media;
pub mod migrations;
pub mod projects;
pub mod settings;
pub mod storage;

use rusqlite::Connection;
use std::fmt::Debug;
use std::path::Path;
use tracing::{info, instrument};

/// Initialize the local SQLite database and run pending migrations.
#[instrument]
pub fn initialize(db_path: impl AsRef<Path> + Debug) -> Result<Connection, rusqlite::Error> {
    let path = db_path.as_ref();
    info!(db_path = %path.display(), "initializing SQLite database");

    let mut conn = Connection::open(path)?;

    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", "5000")?;

    migrations::run_migrations(&mut conn)?;

    Ok(conn)
}
