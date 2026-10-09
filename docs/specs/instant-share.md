# Instant Share — Phase 2 Design

> **Status:** Design — needs approval before implementation
> **Related:** ADR 015 (open core), ADR 016 (license tokens), `docs/specs/storage-contract.md`, plan §6.1

## Goal

One click after finishing an export (or right after stopping a recording):
the app uploads the video, copies a link to the clipboard, and the link page
plays it — with upload progress visible on the page while the file is still
in flight. Two delivery modes:

- **Hosted** — RecordForge serves `https://share.<domain>/v/<shareId>` backed
  by Cloudflare R2 + Convex metadata. Pro Lifetime includes a small quota.
- **Bring-your-own bucket (BYO)** — the MP4 plus a self-contained player page
  are uploaded to the user's own S3-compatible bucket (and later Drive),
  reusing the existing multipart uploader. Unlimited.

Both are **Pro features**. Free keeps the existing raw S3/Drive upload
(unchanged) — Instant Share is about the _link_, not the bytes.

## Architecture

```
Desktop (Rust)                      recordforge-cloud (Convex + R2)
─────────────                       ─────────────────────────────────
export_timeline finishes            POST /v1/share/create   {token, meta}
  → if share requested:             → verify token, quota check
    POST /v1/share/create           → {shareId, upload: presigned multipart}
    → multipart upload to R2        POST /v1/share/complete {shareId, checksum}
    → POST /v1/share/complete       → marks live; schedules expiry
    → copy https://share./v/<id>    GET  /v/<shareId> (share domain)
      to clipboard                    → HTML shell + OG meta (SEO-safe)
                                    GET  /v1/share/<id>/manifest
                                      → {title, playbackUrl, captionsUrl,
                                         chapters, flags, status}
```

### Why presigned URLs, not a proxy

Uploads go straight from the desktop to R2 (S3-compatible, no egress fees).
The server never sees video bytes — only metadata — so the recurring cost is
storage + a tiny amount of Convex compute, and the client needs no lasting
cloud credential: each presigned URL is scoped to one object and expires.

### Token auth for the share API

Share requests carry the same signed offline token the desktop already holds.
The server verifies the signature with the public key (it has the private
half), extracts `licenseId` + `deviceHash`, and maps the key to its stored
license row for the quota check. No new auth handshake is needed.

## Data model (Convex)

```
shares: {
  shareId,                    // 128-bit random, URL segment — unguessable
  licenseKeyHash,             // sha256(key) — quota attribution
  deviceHash,
  title, durationMs, bytes, width, height, fps,
  playbackUrl,                // R2 object public URL (or proxy path)
  captionsUrl?,               // sidecar .vtt object
  chapters: [{t, label}],     // from timeline markers
  flags: {download, embed},   // viewer affordances
  status: "uploading" | "live" | "expired" | "revoked",
  createdAtMs, expiresAtMs,   // 30-day window, renewable
  views: number,              // cheap counter (Pro Cloud adds real analytics)
}
  .index("byLicense", ["licenseKeyHash", "status"])
  .index("byExpiry", ["status", "expiresAtMs"])
```

## Hosted quota (Pro Lifetime)

- **10 active links** at a time; each video ≤10 minutes at ≤1080p.
- Links live **30 days**, renewable (a `POST /v1/share/renew` call extends the
  window — also re-validates the license).
- Creating an 11th link while at quota returns `409 {error:"quota_exceeded",
oldestShareId}` so the UI can offer "expire the oldest and retry".
- Expiry is a Convex cron (`*/15m`): marks `expired`, deletes the R2 object.

## The viewer page

`GET https://share.<domain>/v/<shareId>` is served by a Convex HTTP action
that injects per-share Open Graph/Twitter meta (title, thumbnail, duration,
`og:video`) — link previews work in Slack/Discord. The HTML itself is a
single static bundle that calls `/v1/share/<id>/manifest`:

- `uploading` → progress bar reading `shares.uploadProgress` (Convex
  subscription — the page live-updates as chunks land, no refresh).
- `live` → `<video>` + `<track>` captions + chapter rail + download/embed
  affordances per `flags`.
- `expired`/`revoked` → friendly "this link expired" page (no player).

Embed code: `<iframe src="…/v/<id>?embed=1">` — a stripped chrome variant.

## BYO bucket path

- The app ships `share-player.html` (bundled asset): a self-contained player
  that reads `?v=<mp4-url>&t=<title>&cc=<vtt-url>&ch=<b64-json-chapters>`.
- On share, Rust uploads `video.mp4` + `captions.vtt` + `player.html` into
  the user's bucket at `<prefix>/share/<slug>/` using the existing storage
  provider, then copies the player's public URL.
- Works for any bucket that can serve public objects; Drive gets its own
  small adapter later (share links to `drive.google.com` preview are a poor
  player — defer).
- No server round-trip is required for BYO — but the license token still
  gates the feature client-side (Rust checks entitlement before starting).

## Rust/UI flow

1. `export_timeline` already returns a job; when it lands `completed` with
   `share: true` in settings, `jobs/mod.rs` runs the share step as a second
   stage of the same job (progress events continue on the same job channel).
2. Entitlement: `license.requires("instant-share")` — a new ProFeatureKey —
   enforced at job admission like the other five.
3. Failure leaves the local export intact; the toast says "export done —
   share failed: <reason>" with a retry action.

## Security & privacy notes

- `shareId` is 128-bit random — links are _capability URLs_ (anyone with the
  link can view; that is the product). Password/expiry/custom-domain links
  are Pro Cloud add-ons, later.
- The server sees metadata only — no media paths, no transcripts, no content.
- Presigned upload URLs are single-object, short-lived (15 min parts).
- `data.key`/`deviceHash` handling matches ADR 016 — nothing raw is stored.

## Cost sketch

10-min 1080p ≈ 100–300 MB. Quota worst case: 10 links × 300 MB ≈ 3 GB per
license — R2 storage is pennies/user/month; zero egress. Convex compute is
HTTP actions + one cron — well inside the free tier at launch scale.

## Decisions (approved 2026-10-05)

1. **Domain** — `share.recordforge.prestigetech.dev` subdomain.
2. **Upload progress** — per-part granularity (parts are 8 MB).
3. **Feature key** — `instant-share` is its own Pro feature key.
4. **GIF/WebP** — MP4-only shares for v1; animations later.

## Implementation status (2026-10-05 — built, pending deploy)

1. ✅ `recordforge-cloud`: `shares` schema, `create|progress|complete|renew|
list|revoke|manifest` actions, R2 presigned multipart helper, expiry cron.
2. ✅ Desktop Rust: `share_export` (hosted) + `share_to_profile` (BYO) +
   `list_shares`/`renew_share`/`revoke_share` commands, `instant-share`
   entitlement, SRT→VTT sidecar conversion.
3. ✅ Viewer: self-contained HTML player (`convex/viewer.ts`) — video + chapter
   rail + `<track>` captions + download/embed + live upload progress.
4. ✅ Desktop UI: Instant Share toggle + hosted/BYO destination selector on
   the export view, clipboard link + toasts, `SharedLinksCard` in Storage
   (copy/renew/revoke).
5. ✅ BYO: bundled `share-player.html` template + `S3Client::upload_file_typed`
   for multi-file upload (video + index.html + captions.vtt).

Deployment (Phase 0, manual): Convex project + Polar org + R2 bucket +
`share.recordforge.prestigetech.dev` DNS → then `bun run deploy` in recordforge-cloud and
set `RECORD_FORGE_LICENSE_SERVER_URL` in release CI.
