//! Storage Profiles and Upload Jobs Database Layer

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::errors::{InternalError, Result};
use crate::storage::drive::GoogleDriveConfig;
use crate::storage::local::LocalFolderConfig;
use crate::storage::s3::S3Config;
use crate::storage::vault;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageProfile {
    pub id: String,
    pub name: String,
    pub kind: String, // "s3" | "gdrive" | "local"
    pub is_default: bool,
    pub s3_config: Option<S3Config>,
    pub drive_config: Option<GoogleDriveConfig>,
    pub local_config: Option<LocalFolderConfig>,
    pub has_credentials: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadJob {
    pub id: String,
    pub provider_profile_id: String,
    pub provider_profile_name: Option<String>,
    pub provider_kind: String,
    pub recording_id: Option<String>,
    pub export_id: Option<String>,
    pub local_path: String,
    pub remote_path: String,
    pub state: String, // "pending" | "uploading" | "paused" | "completed" | "failed" | "cancelled"
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub remote_url: Option<String>,
    pub retry_count: u32,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

pub fn list_storage_profiles(conn: &Connection) -> Result<Vec<StorageProfile>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, is_default, s3_config_json, drive_config_json, local_config_json, created_at, updated_at
             FROM storage_profiles ORDER BY is_default DESC, created_at ASC",
        )
        .map_err(|e| InternalError::Storage(format!("failed to prepare query: {e}")))?;

    let profile_iter = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let kind: String = row.get(2)?;
            let is_default: bool = row.get(3)?;
            let s3_json: Option<String> = row.get(4)?;
            let drive_json: Option<String> = row.get(5)?;
            let local_json: Option<String> = row.get(6)?;
            let created_at: String = row.get(7)?;
            let updated_at: String = row.get(8)?;

            let s3_config: Option<S3Config> = s3_json.and_then(|s| serde_json::from_str(&s).ok());
            let drive_config: Option<GoogleDriveConfig> =
                drive_json.and_then(|s| serde_json::from_str(&s).ok());
            let local_config: Option<LocalFolderConfig> =
                local_json.and_then(|s| serde_json::from_str(&s).ok());

            let has_credentials = match kind.as_str() {
                "s3" => vault::get_secret(&format!("{}:secret_key", id))
                    .ok()
                    .flatten()
                    .is_some(),
                "gdrive" => vault::get_secret(&format!("{}:refresh_token", id))
                    .ok()
                    .flatten()
                    .is_some(),
                _ => true,
            };

            Ok(StorageProfile {
                id,
                name,
                kind,
                is_default,
                s3_config,
                drive_config,
                local_config,
                has_credentials,
                created_at,
                updated_at,
            })
        })
        .map_err(|e| InternalError::Storage(format!("failed to query profiles: {e}")))?;

    let mut profiles = Vec::new();
    for p in profile_iter {
        profiles.push(p.map_err(|e| InternalError::Storage(format!("row parse error: {e}")))?);
    }

    Ok(profiles)
}

pub fn get_profile_by_id(conn: &Connection, id: &str) -> Result<Option<StorageProfile>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, is_default, s3_config_json, drive_config_json, local_config_json, created_at, updated_at
             FROM storage_profiles WHERE id = ?1",
        )
        .map_err(|e| InternalError::Storage(format!("failed to prepare query: {e}")))?;

    let profile = stmt
        .query_row(params![id], |row| {
            let profile_id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let kind: String = row.get(2)?;
            let is_default: bool = row.get(3)?;
            let s3_json: Option<String> = row.get(4)?;
            let drive_json: Option<String> = row.get(5)?;
            let local_json: Option<String> = row.get(6)?;
            let created_at: String = row.get(7)?;
            let updated_at: String = row.get(8)?;

            let s3_config: Option<S3Config> = s3_json.and_then(|s| serde_json::from_str(&s).ok());
            let drive_config: Option<GoogleDriveConfig> =
                drive_json.and_then(|s| serde_json::from_str(&s).ok());
            let local_config: Option<LocalFolderConfig> =
                local_json.and_then(|s| serde_json::from_str(&s).ok());

            let has_credentials = match kind.as_str() {
                "s3" => vault::get_secret(&format!("{}:secret_key", profile_id))
                    .ok()
                    .flatten()
                    .is_some(),
                "gdrive" => vault::get_secret(&format!("{}:refresh_token", profile_id))
                    .ok()
                    .flatten()
                    .is_some(),
                _ => true,
            };

            Ok(StorageProfile {
                id: profile_id,
                name,
                kind,
                is_default,
                s3_config,
                drive_config,
                local_config,
                has_credentials,
                created_at,
                updated_at,
            })
        })
        .optional()
        .map_err(|e| InternalError::Storage(format!("get profile query error: {e}")))?;

    Ok(profile)
}

pub fn upsert_storage_profile(conn: &Connection, profile: &StorageProfile) -> Result<()> {
    if profile.is_default {
        // Clear previous default
        conn.execute("UPDATE storage_profiles SET is_default = 0", [])
            .map_err(|e| InternalError::Storage(format!("failed to clear default profile: {e}")))?;
    }

    let s3_json = profile
        .s3_config
        .as_ref()
        .map(|c| serde_json::to_string(c).unwrap_or_default());
    let drive_json = profile
        .drive_config
        .as_ref()
        .map(|c| serde_json::to_string(c).unwrap_or_default());
    let local_json = profile
        .local_config
        .as_ref()
        .map(|c| serde_json::to_string(c).unwrap_or_default());

    conn.execute(
        "INSERT INTO storage_profiles (
            id, name, kind, is_default, s3_config_json, drive_config_json, local_config_json, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            kind = excluded.kind,
            is_default = excluded.is_default,
            s3_config_json = excluded.s3_config_json,
            drive_config_json = excluded.drive_config_json,
            local_config_json = excluded.local_config_json,
            updated_at = excluded.updated_at",
        params![
            profile.id,
            profile.name,
            profile.kind,
            if profile.is_default { 1 } else { 0 },
            s3_json,
            drive_json,
            local_json,
            profile.created_at,
            profile.updated_at,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("failed to upsert profile: {e}")))?;

    Ok(())
}

pub fn delete_storage_profile(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM storage_profiles WHERE id = ?1", params![id])
        .map_err(|e| InternalError::Storage(format!("failed to delete profile: {e}")))?;

    // Clean up secrets
    let _ = vault::delete_secret(&format!("{}:access_key", id));
    let _ = vault::delete_secret(&format!("{}:secret_key", id));
    let _ = vault::delete_secret(&format!("{}:refresh_token", id));

    Ok(())
}

pub fn list_upload_jobs(conn: &Connection) -> Result<Vec<UploadJob>> {
    let mut stmt = conn
        .prepare(
            "SELECT u.id, u.provider_profile_id, p.name, u.provider_kind, u.recording_id, u.export_id,
                    u.local_path, u.remote_path, u.state, u.bytes_uploaded, u.total_bytes, u.speed_bps,
                    u.remote_url, u.retry_count, u.last_error, u.created_at, u.updated_at, u.completed_at
             FROM upload_jobs u
             LEFT JOIN storage_profiles p ON u.provider_profile_id = p.id
             ORDER BY u.created_at DESC",
        )
        .map_err(|e| InternalError::Storage(format!("failed to prepare jobs query: {e}")))?;

    let job_iter = stmt
        .query_map([], |row| {
            Ok(UploadJob {
                id: row.get(0)?,
                provider_profile_id: row.get(1)?,
                provider_profile_name: row.get(2)?,
                provider_kind: row.get(3)?,
                recording_id: row.get(4)?,
                export_id: row.get(5)?,
                local_path: row.get(6)?,
                remote_path: row.get(7)?,
                state: row.get(8)?,
                bytes_uploaded: row.get::<_, i64>(9)? as u64,
                total_bytes: row.get::<_, i64>(10)? as u64,
                speed_bps: row.get::<_, i64>(11)? as u64,
                remote_url: row.get(12)?,
                retry_count: row.get::<_, i32>(13)? as u32,
                last_error: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
                completed_at: row.get(17)?,
            })
        })
        .map_err(|e| InternalError::Storage(format!("failed to query jobs: {e}")))?;

    let mut jobs = Vec::new();
    for j in job_iter {
        jobs.push(j.map_err(|e| InternalError::Storage(format!("job row error: {e}")))?);
    }

    Ok(jobs)
}

pub fn get_upload_job(conn: &Connection, id: &str) -> Result<Option<UploadJob>> {
    let mut stmt = conn
        .prepare(
            "SELECT u.id, u.provider_profile_id, p.name, u.provider_kind, u.recording_id, u.export_id,
                    u.local_path, u.remote_path, u.state, u.bytes_uploaded, u.total_bytes, u.speed_bps,
                    u.remote_url, u.retry_count, u.last_error, u.created_at, u.updated_at, u.completed_at
             FROM upload_jobs u
             LEFT JOIN storage_profiles p ON u.provider_profile_id = p.id
             WHERE u.id = ?1",
        )
        .map_err(|e| InternalError::Storage(format!("failed to prepare get job query: {e}")))?;

    let job = stmt
        .query_row(params![id], |row| {
            Ok(UploadJob {
                id: row.get(0)?,
                provider_profile_id: row.get(1)?,
                provider_profile_name: row.get(2)?,
                provider_kind: row.get(3)?,
                recording_id: row.get(4)?,
                export_id: row.get(5)?,
                local_path: row.get(6)?,
                remote_path: row.get(7)?,
                state: row.get(8)?,
                bytes_uploaded: row.get::<_, i64>(9)? as u64,
                total_bytes: row.get::<_, i64>(10)? as u64,
                speed_bps: row.get::<_, i64>(11)? as u64,
                remote_url: row.get(12)?,
                retry_count: row.get::<_, i32>(13)? as u32,
                last_error: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
                completed_at: row.get(17)?,
            })
        })
        .optional()
        .map_err(|e| InternalError::Storage(format!("get job query error: {e}")))?;

    Ok(job)
}

pub fn insert_upload_job(conn: &Connection, job: &UploadJob) -> Result<()> {
    conn.execute(
        "INSERT INTO upload_jobs (
            id, provider_profile_id, provider_kind, recording_id, export_id, local_path, remote_path,
            state, bytes_uploaded, total_bytes, speed_bps, remote_url, retry_count, last_error, created_at, updated_at, completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            job.id,
            job.provider_profile_id,
            job.provider_kind,
            job.recording_id,
            job.export_id,
            job.local_path,
            job.remote_path,
            job.state,
            job.bytes_uploaded as i64,
            job.total_bytes as i64,
            job.speed_bps as i64,
            job.remote_url,
            job.retry_count as i32,
            job.last_error,
            job.created_at,
            job.updated_at,
            job.completed_at,
        ],
    )
    .map_err(|e| InternalError::Storage(format!("failed to insert upload job: {e}")))?;

    Ok(())
}

pub fn update_upload_job_progress(
    conn: &Connection,
    id: &str,
    bytes_uploaded: u64,
    total_bytes: u64,
    speed_bps: u64,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE upload_jobs SET bytes_uploaded = ?1, total_bytes = ?2, speed_bps = ?3, updated_at = ?4 WHERE id = ?5",
        params![bytes_uploaded as i64, total_bytes as i64, speed_bps as i64, now, id],
    )
    .map_err(|e| InternalError::Storage(format!("failed to update job progress: {e}")))?;

    Ok(())
}

pub fn update_upload_job_status(
    conn: &Connection,
    id: &str,
    state: &str,
    remote_url: Option<&str>,
    last_error: Option<&str>,
    completed_at: Option<&str>,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE upload_jobs SET state = ?1, remote_url = COALESCE(?2, remote_url), last_error = ?3, completed_at = ?4, updated_at = ?5 WHERE id = ?6",
        params![state, remote_url, last_error, completed_at, now, id],
    )
    .map_err(|e| InternalError::Storage(format!("failed to update job status: {e}")))?;

    Ok(())
}

pub fn delete_upload_job(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM upload_jobs WHERE id = ?1", params![id])
        .map_err(|e| InternalError::Storage(format!("failed to delete upload job: {e}")))?;

    Ok(())
}
