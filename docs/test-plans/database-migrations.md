# Database Migration Test Plan

> **Status:** Draft — Phase 0  
> **Scope:** Migration correctness, version upgrade paths, data preservation, rollback safety

---

## 1. Current Migration Issues (P0.9)

### 1.1 Destructive `migrate_v2`

The current `migrate_v2` drops and recreates the `recordings` table:

```rust
conn.execute("DROP TABLE IF EXISTS recordings", [])?;
conn.execute("CREATE TABLE recordings (...)", [])?;
```

This destroys all existing recording data on upgrade. While acceptable in pre-release, this pattern MUST NOT be carried forward.

### 1.2 Non-atomic migrations

Migrations run as individual `conn.execute()` calls without a transaction. If a migration fails midway, the database is left in an inconsistent state.

### 1.3 Missing constraints

- No foreign keys between `recordings` and `media_jobs`/`derivatives`
- No unique constraints on `session_id` in recordings
- No `created_at`/`updated_at` on `upload_jobs`
- No indexes on frequently queried columns

---

## 2. Migration Test Cases (Rust)

### 2.1 Fresh database

| Test | Input | Expected |
|------|-------|----------|
| `test_fresh_db_creates_all_tables` | New empty database | All tables exist: `app_meta`, `recordings`, `projects`, `upload_jobs`, `media_jobs`, `media_metadata`, `derivatives`, `settings` |
| `test_fresh_db_sets_version` | New empty database | `app_meta.schema_version = 6` (export options/attempts persisted) |
| `test_fresh_db_wal_mode` | New empty database | `PRAGMA journal_mode` returns "wal" |
| `test_fresh_db_foreign_keys` | New empty database | `PRAGMA foreign_keys` returns 1 |

### 2.2 Version upgrades

| Test | From | To | Expected |
|------|------|----|----------|
| `test_migrate_v0_to_v6` | Empty DB (version 0) | 6 | All tables created, media job options/attempts available, version = 6 |
| `test_migrate_v2_to_v4` | Version 2 | 4 | v3 + v4 migrations applied |
| `test_migrate_v3_to_v4` | Version 3 | 4 | v4 migration applied |
| `test_migrate_v4_noop` | Version 4 | 4 | No changes |

### 2.3 Data preservation

| Test | Setup | Expected |
|------|-------|----------|
| `test_v2_drops_recordings` | Insert recording at v1, then migrate | **DOCUMENTS BUG P0.9**: recording is lost |
| `test_v3_preserves_recordings` | Insert recording at v2, migrate to v3 | Recording preserved |
| `test_v4_preserves_all` | Insert data at v3, migrate to v4 | All data preserved |

### 2.4 Transactional safety

| Test | Setup | Expected |
|------|-------|----------|
| `test_migration_rollback_on_error` | Inject failure mid-migration | Database unchanged (when transactional migrations are implemented) |
| `test_backup_before_migrate` | Database with data, run migration | Backup file exists (when implemented) |

---

## 3. Schema Correctness Tests

### 3.1 Constraint verification

| Test | Expected |
|------|----------|
| `test_recording_id_unique` | Duplicate ID insert fails |
| `test_session_id_not_null` | NULL session_id insert fails |
| `test_media_job_recording_fk` | Insert job for nonexistent recording fails (when FK implemented) |
| `test_derivative_recording_fk` | Insert derivative for nonexistent recording fails (when FK implemented) |

### 3.2 Index verification

| Test | Expected |
|------|----------|
| `test_idx_media_jobs_recording` | Index exists |
| `test_idx_media_jobs_status` | Index exists |
| `test_idx_derivatives_recording` | Index exists |
| `test_idx_recordings_created_at` | Index exists (when added) |
| `test_idx_recordings_status` | Index exists (when added) |

---

## 4. Integrity Tests

### 4.1 Busy timeout

| Test | Expected |
|------|----------|
| `test_busy_timeout_set` | `PRAGMA busy_timeout` returns value > 0 (when implemented) |
| `test_concurrent_access` | Two threads can read simultaneously without error |

### 4.2 Integrity check

| Test | Expected |
|------|----------|
| `test_integrity_check_passes` | `PRAGMA integrity_check` returns "ok" |
| `test_foreign_key_check_passes` | `PRAGMA foreign_key_check` returns no violations |

---

## 5. Deletion Atomicity Tests (P0.8)

### 5.1 Current behavior

```rust
// CURRENT: Deletes DB row first, then tries to delete file
conn.execute("DELETE FROM recordings WHERE id = ?1", ...)?;
let _ = std::fs::remove_file(output);  // Failure is silently ignored
```

### 5.2 Required tests

| Test | Setup | Expected |
|------|-------|----------|
| `test_delete_removes_row_and_file` | Recording with existing output | Both row and file deleted |
| `test_delete_file_failure_preserves_row` | Recording with locked/missing file | **BUG P0.8**: Currently row deleted, file remains |
| `test_delete_cleans_derivatives` | Recording with proxy/thumbnails | All derivative files and rows cleaned |
| `test_delete_checks_project_refs` | Recording referenced by a project | Error: "recording is used by project X" |
| `test_trash_before_delete` | Delete recording | Recording status → "trashed", not removed |
| `test_restore_from_trash` | Trashed recording | Status → "completed", row and file intact |
| `test_empty_trash` | Multiple trashed recordings | All removed permanently |

---

## 6. Startup Reconciliation Tests

| Test | Setup | Expected |
|------|-------|----------|
| `test_orphan_db_rows` | DB row exists but file missing | Marked as "missing" or cleaned up |
| `test_orphan_files` | File exists but no DB row | Logged for manual review |
| `test_orphan_derivatives` | Derivative exists but recording deleted | Derivative cleaned up |
| `test_orphan_jobs` | Job exists but recording deleted | Job cancelled and cleaned up |
