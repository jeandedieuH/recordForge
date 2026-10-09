# ADR 016: License Entitlements — Token, Device Binding, and Enforcement

> **Status:** Accepted
> **Date:** 2026-10-05
> **Related:** ADR 015 (open-core model), `src-tauri/src/licensing/`, `src-tauri/src/jobs/mod.rs`, `packages/contracts/src/license.ts`

## Context

The Free/Pro split requires a license mechanism that is (a) offline-capable
— a lifetime license must not stop working when a server is down or the user
is on a plane; (b) privacy-preserving — no raw device identifiers or usage
data leave the machine; (c) enforced in Rust — UI-only gating can be bypassed
by calling `export_timeline` directly with a crafted render plan.

## Decision

### 1. Signed offline tokens

- The license server returns a token: `base64url(payload).base64url(Ed25519
  signature)` over the payload segment bytes.
- Payload: `{v, kid, licenseId, plan, addons, deviceHash, iat}`.
- The app verifies the signature offline against embedded public keys, keyed
  by `kid` so the server can rotate signing keys.
- Features derive from `plan` inside the app, so future Pro features unlock
  automatically for lifetime owners.

### 2. Device binding

- `deviceHash = sha256(machine-uid + "recordforge-license-device-v1")`.
  The raw machine UID never leaves the OS API boundary; the hash cannot be
  correlated across apps or machines.
- `deviceLabel` (hostname only) is sent at activation so users can recognize
  devices on the license server's device list.

### 3. Storage

- The signed token is stored as a small JSON file in the app data dir — it
  is not a secret (it only works on the bound device).
- The raw license **key** goes in the OS credential vault
  (`storage/vault.rs`, account `pro-license-key`) — never in files, never in
  SQLite.
- Token persistence is write-then-rename; a corrupt file fails closed
  (Free) rather than crashing.

### 4. Server contact — exactly three flows

| Flow | When | Notes |
|---|---|---|
| `POST /v1/license/activate` | User enters key | Online once per device |
| `POST /v1/license/deactivate` | User deactivates | Best-effort; local state always clears |
| `POST /v1/license/refresh` | Background, ≤ every 30 days, and manual | Network failure never removes Pro; only explicit "revoked" does |

- The server URL is compiled in via `RECORD_FORGE_LICENSE_SERVER_URL`
  (`option_env!`), mirroring the Google Drive secret pattern. Debug builds
  may override via env and also accept `dev:`-prefixed tokens signed by a
  dev key (`RECORD_FORGE_DEV_LICENSE_PUBLIC_KEY` + `tooling/scripts/
  license-keys.mjs`), so the whole flow is testable before the server
  exists.
- No usage data, media paths, or screen content is ever sent; requests carry
  a 15s timeout and keys are redacted from logs.

#### Owner (admin) tokens

- The owner holds a dedicated Ed25519 keypair whose **public** half is
  embedded in `ADMIN_KEYS` (`licensing/token.rs`, kid `admin-1`); the private
  half lives only on the owner's machine (`license-admin-key.json`,
  gitignored) — not in the repo, not on the license server.
- `token --prefix admin` mints a device-bound token; entering it as
  `admin:<token>` in the license-key field installs it in **any** build —
  the same `install_token` signature/device verification gates it.
- Admin licenses are marked `server_managed = false` (detected by `kid`
  membership in `ADMIN_KEYS`, not by the prefix): `refresh`, `refresh_due`,
  and `deactivate` never contact the server, so a future production server
  can neither rotate nor revoke an admin license, and the admin keeps Pro
  forever-offline.
- `admin:` accepts any token whose signature verifies — the prefix only
  chooses the raw-token install path; it grants nothing by itself.

### 5. Enforcement points (Rust)

`JobManager` holds an `Arc<LicenseManager>` and calls
`licensing::entitlements::enforce_export_entitlements` at **every** export
entry point — `start_export`, `retry_export`, and `resume_pending_jobs` —
right next to `validate_export_settings`. Violations return a structured
`pro_feature_required` error (category `licensing`) carrying the feature
keys so the UI can route to the upgrade dialog.

Detection inspects **both** the canonical `overlay_render_plan` items and
the legacy `annotations`/`texts` fields:

| Feature key | Trigger |
|---|---|
| `high-res-export` | `ultra-4k` / `ultra-4k-60` presets |
| `custom-aspect-ratio` | canvas aspect ≠ 16:9 beyond ±0.5%, or `vertical`/`square` presets |
| `chapters` | chapter mode ≠ `none` with chapters present |
| `premium-titles` | any enabled text whose `titleDesign.template` ≠ `clean-text` (missing design = legacy preset = Pro) |
| `annotations` | any enabled annotation item |

Disabled items do not flag — stripping a feature in the editor genuinely
removes the requirement.

### 6. Free output cap — a pipeline value, not a check

A >1080p canvas is **not** rejected (the fallback is a downscale, per the
product rules). Instead, `JobManager::spawn_export` resolves
`Entitlements::output_cap()` at spawn time and passes `Option<ExportOutputCap>`
into `run_render_plan`. The cap is applied at the composition's final filter
node (`scale=…:flags=lanczos` before `format=`), which means:

- every chunked `.ts` intermediate is already capped → concat still
  stream-copies;
- GIF/WebP standalone passes get the cap in the same node;
- uncapped (Pro) exports emit **byte-identical** filter graphs to before —
  the scale filter is only appended when the resolved dims differ;
- `validate_export_output` receives the resolved dims so capped outputs
  pass validation.

The export-harness spec accepts `outputCap`, so the cap is testable
end-to-end without a license.

### 7. No new Tauri capability

Checkout opens through the already-permitted `opener` plugin; the four new
commands (`get_license_status`, `activate_license`, `deactivate_license`,
`refresh_license`) are ordinary commands under `core:default`. Security
review: the only new outbound surface is the license endpoint documented
above; it takes a fixed JSON body, has timeouts, and cannot reach the
filesystem.

## Consequences

- `JobManager::new` gained a `license` parameter; `AppState` exposes
  `license` for the commands.
- `ErrorCategory` gained `licensing` (contract enum updated in
  `packages/contracts/src/errors.ts`).
- `run_render_plan` and the composition functions carry an `output_cap`
  parameter; the dev harness spec has an optional `outputCap` field.
- A Pro export persisted while licensed cannot survive deactivation:
  resume and retry re-check entitlements before spawning.
- `machine-uid` and `ed25519-dalek` are new pinned dependencies (both
  well-established releases >7 days old at add time).
- The verification core (`verify_token_with_keys`) is keyring-injectable so
  unit tests exercise the real path without env or build-time constants.
- `license-keys.mjs token` gained `--prefix dev|admin` (admin defaults to
  kid `admin-1`, plan `pro_admin`); `ActiveLicense` gained a `server_managed`
  flag derived from the verified `kid` — no schema or contract changes.
