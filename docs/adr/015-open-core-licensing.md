# ADR 015: Open-Core Licensing Model

> **Status:** Accepted
> **Date:** 2026-10-05
> **Related:** `LICENSING.md`, `TRADEMARKS.md`, `CLA.md`, `PRO-LICENSE-TERMS.md`, ADR 016 (entitlement enforcement)

## Context

RecordForge needs a sustainable revenue model that does not compromise its
local-first values: no mandatory accounts, no hosted-media requirement, and
a genuinely useful free tier. The chosen product shape is a generous Free
tier plus a low-cost Pro Lifetime license (launch: $39, $29 founder price).

That decision forces a licensing question: the desktop app is GPL-3.0, the
features being gated are already shipped in the GPL codebase, and a pure-GPL
project has no standard way to sell "unlocks" inside itself.

## Decision

Adopt **open core**:

1. **The desktop app stays GPL-3.0-or-later in this repository** — including
   the rendering engines for the five gated features, the entitlement
   checks, and the license client. No relicensing of existing code.
2. **A private repository (`recordforge-cloud`)** holds the proprietary
   parts: the license server (Convex), the payment/activation integration
   (Polar, acting as merchant of record), and the Instant Share backend and
   viewer when it ships.
3. **A CLA** (`CLA.md` + CLA Assistant on pull requests) lets the project
   accept community contributions and ship them inside dual-licensed
   official builds.
4. **Trademark policy** (`TRADEMARKS.md`): the RecordForge name/logo and the
   official updater channel are reserved; forks must rebrand.
5. **Pro License Terms** (`PRO-LICENSE-TERMS.md`) govern the *key purchase*
   only — 3 personal devices, lifetime updates, 14-day refunds — without
   adding restrictions to the GPL software.

## Alternatives considered

- **Fully closed source**: rejected — violates the project's existing GPL
  commitments, breaks community trust, and makes prior releases a fork
  magnet.
- **Donations only**: rejected — insufficient and unpredictable revenue.
- **Subscription-only Pro**: rejected — the product's privacy positioning and
  the user's explicit requirement are lifetime pricing; recurring fees are
  reserved for cost-bearing hosted services (Pro Cloud add-on, Phase 2+).
- **Closed-source plugin for gated features**: deferred — the gated features
  are already GPL and shared between preview and export; a closed-module
  build seam is only added when the first truly new closed client module
  ships (Phase 2+).

## Consequences

- The five gated features stay editable in the editor for everyone
  ("try in editor"), with entitlement enforced at export time in Rust.
- Anyone may legally build a gate-free version from source; this is accepted
  openly (`LICENSING.md` documents it). What the license protects is
  convenience, official signed builds/updates, the trademark, and a fair
  price — not an unbreakable lock.
- Official builds embed the license-server URL at compile time
  (`RECORD_FORGE_LICENSE_SERVER_URL`), following the same pattern as the
  Google Drive client secret; the URL is public-by-design (it is an API
  endpoint, not a secret).
- Contributions now require CLA sign-off; `CONTRIBUTING.md` documents it.
- `AGENTS.md` non-goals are updated: hosted share links and billing move
  from "non-goal" to "owned by the private cloud repository".
