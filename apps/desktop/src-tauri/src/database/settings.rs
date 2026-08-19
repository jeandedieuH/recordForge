use rusqlite::{params, Connection, OptionalExtension};

use crate::errors::{InternalError, Result};

/// Keys accepted over IPC. An allowlist keeps the settings surface narrow:
/// the frontend cannot write arbitrary rows into the database.
const ALLOWED_KEYS: &[&str] = &[
    "theme",
    "windowTransparency",
    "countdownSeconds",
    "startMinimized",
    "minimizeToTray",
    "defaultOutputFolder",
    "sidebarCollapsed",
    "hardwareCheckDone",
    "cursorPresets",
    "defaultCursorSettings",
    "editorAnnotationPresets",
    "editorAnnotationPresetFavorites",
    "editorTextPresets",
    "editorTextPresetFavorites",
    "recordingPreferences",
];

pub fn validate_key(key: &str) -> Result<()> {
    if ALLOWED_KEYS.contains(&key) {
        return Ok(());
    }
    Err(InternalError::Unknown(format!("unknown setting key: {key}")).into())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|e| InternalError::Storage(format!("read setting: {e}")).into())
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params![key, value, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| InternalError::Storage(format!("write setting: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allowed_keys_includes_recording_preferences() {
        assert!(validate_key("recordingPreferences").is_ok());
        assert!(validate_key("theme").is_ok());
        assert!(validate_key("minimizeToTray").is_ok());
        assert!(validate_key("defaultOutputFolder").is_ok());
        assert!(validate_key("invalidKey").is_err());
    }

    #[test]
    fn test_settings_round_trip() {
        let conn = Connection::open_in_memory().expect("open in memory db");
        conn.execute_batch(
            "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .expect("create table");

        assert_eq!(get_setting(&conn, "recordingPreferences").unwrap(), None);

        set_setting(
            &conn,
            "recordingPreferences",
            r#"{"sourceType":"screen","profile":"balanced"}"#,
        )
        .unwrap();

        assert_eq!(
            get_setting(&conn, "recordingPreferences").unwrap(),
            Some(r#"{"sourceType":"screen","profile":"balanced"}"#.into())
        );
    }
}
