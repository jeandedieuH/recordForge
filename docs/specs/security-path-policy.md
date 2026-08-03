# Security and Path Policy Specification

> **Status:** Draft — Phase 0  
> **Scope:** Path authorization, UUID validation, containment rules, symlink defense, command validation  
> **Owner:** Rust `path_policy`, `validation` modules

---

## 1. Threat Model

recordForge is a desktop app that receives untrusted input from:
1. **React UI via Tauri IPC** — user-influenced parameters (source IDs, device IDs, recording IDs, file paths, render plans)
2. **External media files** — FFmpeg/FFprobe output, media containers
3. **External credentials** — S3 keys, OAuth tokens (user-provided)
4. **User-selected file destinations** — export/save paths via OS file dialogs

### Attack surfaces

| Surface | Risk | Example |
|---------|------|---------|
| IPC string → filesystem path | Path traversal, arbitrary file deletion | `delete_recovery_session("../../important")` |
| IPC string → SQL | Injection (mitigated by parameterized queries) | — |
| Render plan paths | Read arbitrary files during export | `inputPath: "C:\\Windows\\system32\\config\\SAM"` |
| Log/diagnostic output | Credential/PII leakage | OAuth token in debug log |
| Capability scope | Over-privileged windows | Floating controls with `dialog:allow-save` |

---

## 2. Path Authorization Policy

### 2.1 Allowed scopes

| Scope | Path | Operations |
|-------|------|-----------|
| App data | `{app_data_dir}/` | Read, write, delete (sessions, DB, settings) |
| Sessions | `{app_data_dir}/sessions/` | Read, write, delete (recording data) |
| User export | One-time OS dialog selection | Write (export destination) |
| User import | One-time OS dialog selection | Read (import source) |

### 2.2 Containment rules

Every path used in a filesystem operation MUST pass through the path policy module:

```rust
pub struct PathPolicy {
    app_data_dir: PathBuf,
    sessions_dir: PathBuf,
}

impl PathPolicy {
    /// Validate that a path is contained within the allowed scope.
    /// Returns the canonicalized path or an error.
    pub fn validate_session_path(&self, session_id: &str) -> Result<PathBuf> {
        // 1. Validate session_id is a valid UUID
        uuid::Uuid::parse_str(session_id)
            .map_err(|_| SecurityError::InvalidSessionId(session_id.into()))?;

        // 2. Construct the expected path
        let path = self.sessions_dir.join(session_id);

        // 3. Canonicalize to resolve symlinks/traversal
        let canonical = path.canonicalize()
            .map_err(|_| SecurityError::PathResolution(path.display().to_string()))?;

        // 4. Verify containment
        if !canonical.starts_with(&self.sessions_dir) {
            return Err(SecurityError::PathTraversal {
                requested: session_id.into(),
                resolved: canonical.display().to_string(),
            });
        }

        Ok(canonical)
    }

    /// Validate a user-selected export destination.
    pub fn validate_export_destination(&self, path: &Path) -> Result<PathBuf> {
        let canonical = path.canonicalize()
            .or_else(|_| {
                // File may not exist yet; canonicalize parent
                path.parent()
                    .ok_or(SecurityError::InvalidPath(path.display().to_string()))
                    .and_then(|p| p.canonicalize()
                        .map_err(|_| SecurityError::PathResolution(p.display().to_string())))
                    .map(|p| p.join(path.file_name().unwrap_or_default()))
            })?;

        // Block writes to system directories
        let blocked = [r"C:\Windows", r"C:\Program Files", r"C:\Program Files (x86)"];
        for blocked_dir in &blocked {
            if canonical.starts_with(blocked_dir) {
                return Err(SecurityError::BlockedDestination(canonical.display().to_string()));
            }
        }

        Ok(canonical)
    }
}
```

### 2.3 Symlink and reparse point defense

On Windows, paths may contain:
- NTFS symlinks (`mklink`)
- Junction points (`mklink /j`)
- Reparse points

The path policy MUST canonicalize before containment checks to resolve these.

---

## 3. UUID Validation

Every entity ID received via IPC must be validated as a proper UUID before use:

| Entity | Format | Validation |
|--------|--------|-----------|
| Session ID | UUIDv4 | `uuid::Uuid::parse_str()` |
| Recording ID | UUIDv4 | `uuid::Uuid::parse_str()` |
| Job ID | UUIDv4 | `uuid::Uuid::parse_str()` |
| Project ID | UUIDv4 | `uuid::Uuid::parse_str()` |
| Asset ID | UUIDv4 | `uuid::Uuid::parse_str()` |

---

## 4. Current Vulnerabilities (P0)

### P0.7 — Path traversal in `delete_recovery_session`

**File:** [recovery.rs](file:///d:/1-Projects/Personal-projects/app-development/recordForge/apps/desktop/src-tauri/src/capture/recovery.rs#L158-L166)

```rust
// CURRENT (UNSAFE):
pub fn delete_recovery_session(session_id: &str, sessions_dir: &Path) -> Result<()> {
    let work_dir = sessions_dir.join(session_id);  // No validation!
    if work_dir.exists() {
        std::fs::remove_dir_all(&work_dir);         // Deletes arbitrary directory
    }
    Ok(())
}
```

A malicious or buggy IPC call with `session_id = "../../"` would delete the parent directory.

**Required fix:**
```rust
pub fn delete_recovery_session(session_id: &str, sessions_dir: &Path) -> Result<()> {
    // 1. Validate UUID format
    uuid::Uuid::parse_str(session_id)
        .map_err(|_| InternalError::Security("invalid session ID format".into()))?;

    // 2. Construct and canonicalize
    let work_dir = sessions_dir.join(session_id);
    let canonical = work_dir.canonicalize()
        .map_err(|_| InternalError::Storage("session directory not found".into()))?;

    // 3. Containment check
    if !canonical.starts_with(sessions_dir) {
        return Err(InternalError::Security("path traversal detected".into()).into());
    }

    std::fs::remove_dir_all(&canonical)
        .map_err(|e| InternalError::Storage(format!("delete session: {e}")))?;
    Ok(())
}
```

---

## 5. IPC Command Validation

### 5.1 Validation layers

```
React UI → Zod validation (TypeScript) → Tauri IPC → Serde deserialization (Rust) → Business validation (Rust)
```

### 5.2 Required: `invokeValidated` wrapper

Add a TypeScript wrapper that validates IPC arguments with Zod before sending:

```typescript
async function invokeValidated<T>(
  command: string,
  args: Record<string, unknown>,
  schema?: z.ZodType<T>
): Promise<T> {
  const result = await invoke(command, args);
  if (schema) {
    return schema.parse(result);
  }
  return result as T;
}
```

### 5.3 Golden fixtures

Cross-language JSON fixtures that are parsed by both TypeScript and Rust tests to detect DTO drift:

```
tooling/golden-fixtures/
    recording-config.json
    recording-status.json
    render-plan.json
    media-job.json
    library-recording.json
```

---

## 6. Capability Split

### Current state (P0.5, P2.5)

One capability file grants all permissions to both `main` and `floating` windows:

```json
{
  "windows": ["main", "floating"],
  "permissions": [
    "core:default",
    "opener:default",
    "global-shortcut:*",
    "dialog:*",
    "core:window:*",
    "core:webview:*"
  ]
}
```

### Required split

| Window | Needed Permissions |
|--------|-------------------|
| `main` | `core:default`, `core:event:default`, `dialog:allow-save`, `dialog:allow-open`, `dialog:allow-ask`, `core:window:allow-*` (window management) |
| `floating` | `core:default`, `core:event:default`, `core:window:allow-show`, `core:window:allow-hide`, `core:window:allow-close` |
| `recorder` (future) | `core:default`, `core:event:default` |

Remove from floating: `opener:default`, `global-shortcut:*`, `dialog:*`, `core:webview:*`

---

## 7. Log Redaction

### Fields that MUST be redacted in logs

| Field | Example | Redaction |
|-------|---------|-----------|
| Window titles | `"Secret Project - Firefox"` | `"[window title]"` |
| Device names | `"John's Microphone"` | `"[audio device]"` |
| Full file paths | `"C:\Users\john\Documents\..."` | `"{sessions}/abc.../output.mp4"` |
| OAuth tokens | `"ya29.a0..."` | `"[bearer token]"` |
| S3 keys | `"AKIAIOSFODNN7EXAMPLE"` | `"[access key]"` |
| Session URIs | `"https://www.googleapis.com/upload/..."` | `"[session uri]"` |

### Implementation

Replace `#[instrument]` on commands that log sensitive arguments with custom `#[instrument(skip(config))]` or field-level redaction.

---

## 8. Destructive Operation Safeguards

| Operation | Safeguard |
|-----------|-----------|
| Delete recording | Move to trash first; empty trash is separate action |
| Delete recovery session | UUID validation + containment check |
| Overwrite export | Explicit confirmation dialog |
| Delete project | Check for linked recordings; confirm with undo |
| Empty trash | Final confirmation; retention period (30 days) |
| Database migration | Backup before migrate; fail-safe rollback |
