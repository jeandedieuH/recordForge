# RecordForge Licensing Model (Open Core)

RecordForge uses an **open-core** model: the desktop application in this
repository is free software, and the company sells a **Pro license key** that
unlocks additional features in official builds, plus hosted services that are
developed in a private repository.

This document explains what is open, what is closed, and how the two halves
interact. It is a summary, not a legal instrument — see `LICENSE` for the
source license and `PRO-LICENSE-TERMS.md` for the terms of the paid license
key.

## What is open source (GPL-3.0-or-later)

Everything in this repository, including:

- The Tauri/Rust desktop app — capture, editor, export pipeline, FFmpeg glue.
- The rendering engines behind the gated features (annotations, titles,
  chapters, non-16:9 canvases, high-resolution export). They ship in preview
  and export alike and are published here under the GPL.
- The entitlement checks and the license client (`src-tauri/src/licensing/`),
  so the mechanism that locks Pro features is itself auditable.

Nothing about the GPL license changed for existing code, and every release up
to and including v1.6.4 stays GPL with all features unlocked, forever.

## What is closed

- **`recordforge-cloud`** (private repository): the license server, the
  payment/activation plumbing (Polar), and the upcoming Instant Share
  hosted-delivery backend.
- The **RecordForge name and logo**: see `TRADEMARKS.md`. Forks must rebrand.
- **Pro license keys**: purchasing a key is governed by
  `PRO-LICENSE-TERMS.md`. The terms cover the *key* only — they do not add
  restrictions to the GPL-licensed software itself.
- Future closed components (announced in `docs/adr/` when they land): premium
  content packs and closed client modules delivered through a build seam.

## How Pro unlocking works

1. Buy a key at the checkout link on the pricing page (payments by Polar).
2. Enter it in Settings → License. The app calls the license server once to
   bind the key to your device, then stores a signed offline token locally.
3. From then on everything works offline. Entitlement is an Ed25519-signed
   token verified inside the app; no account, no background phoning home —
   the server is contacted only for activation, deactivation, and an
   occasional (≤ every 30 days) refresh that detects refunds/revocations.
4. `deviceHash = sha256(machine-uid + app salt)` — no raw hardware identifiers
   are stored or transmitted.

Free exports stay fully functional: no watermark, no time limit, commercial
use allowed under the GPL. Output is capped at 1920×1080 and the five Pro
feature groups are gated (see `docs/adr/016-license-entitlements.md`).

## Honest limits

Because the GPL covers the whole desktop app, anyone can build RecordForge
from source with the gates removed or patched out — that is their right under
the license, and this model accepts it. What the Pro key actually buys is:

- **Convenience**: signed official builds and automatic updates.
- **Support for development**: lifetime revenue that keeps the project alive.
- **Honesty**: you pay for the product, not for a lock that pretends to be
  unbreakable. This is the same trade-off products like Ardour and Cap make.

## Contributing

All community contributions land in the GPL codebase. So that the project can
also ship your work inside dual-licensed official builds, contributions are
accepted under the Contributor License Agreement in `CLA.md` (signed
automatically on your first PR via CLA Assistant).
