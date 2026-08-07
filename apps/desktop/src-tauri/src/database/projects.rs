use rusqlite::{params, Connection, Row};
use tracing::instrument;

use crate::errors::{InternalError, Result};

/// Persisted project index row.
#[derive(Debug, Clone)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub recording_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub project_json: String,
}

/// Insert or replace a project in the SQLite index.
#[instrument]
pub fn upsert_project(conn: &Connection, project: &ProjectRecord) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO projects (
            id, name, recording_id, created_at, updated_at, project_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            project.id,
            project.name,
            project.recording_id,
            project.created_at,
            project.updated_at,
            project.project_json,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("upsert project index: {e}")))?;
    Ok(())
}

fn row_to_project(row: &Row<'_>) -> std::result::Result<ProjectRecord, rusqlite::Error> {
    Ok(ProjectRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        recording_id: row.get("recording_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        project_json: row.get("project_json")?,
    })
}

/// Get a project index row by id.
#[instrument]
pub fn get_project(conn: &Connection, id: &str) -> Result<Option<ProjectRecord>> {
    let result = conn.query_row(
        "SELECT * FROM projects WHERE id = ?1",
        params![id],
        row_to_project,
    );

    match result {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(InternalError::Storage(format!("get project index: {e}")).into()),
    }
}

/// List projects, optionally filtered by recording id.
#[instrument]
pub fn list_projects(conn: &Connection, recording_id: Option<&str>) -> Result<Vec<ProjectRecord>> {
    let mut stmt = if let Some(_rec_id) = recording_id {
        conn.prepare("SELECT * FROM projects WHERE recording_id = ?1 ORDER BY updated_at DESC")
            .map_err(|e| InternalError::Storage(format!("prepare list projects: {e}")))?
    } else {
        conn.prepare("SELECT * FROM projects ORDER BY updated_at DESC")
            .map_err(|e| InternalError::Storage(format!("prepare list projects: {e}")))?
    };

    let rows = if let Some(rec_id) = recording_id {
        stmt.query_map(params![rec_id], row_to_project)
    } else {
        stmt.query_map([], row_to_project)
    }
    .map_err(|e| InternalError::Storage(format!("query projects: {e}")))?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| InternalError::Storage(format!("map project: {e}")))?);
    }
    Ok(projects)
}

/// Delete a project index row.
#[instrument]
pub fn delete_project(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| InternalError::Storage(format!("delete project index: {e}")))?;
    Ok(())
}
