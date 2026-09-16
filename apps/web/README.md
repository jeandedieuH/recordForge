# @recordforge/web

RecordForge web app — TanStack Start + Convex.

Hosts the public marketing site: a landing page (`/`) with feature demos and a
download page (`/download`) that serves the latest GitHub Release assets and
records every download in Convex.

## Development

```bash
cd apps/web
bun run convex:once      # provision local Convex, generate types, write .env.local
bun run dev             # start Vite dev server
```

Open <http://localhost:3000>.

## Build

```bash
bun run build
```

## Download tracking

- `convex/schema.ts` — `downloads` (one row per download event: platform, asset,
  version, timestamp) and `downloadCounters` (running totals keyed by
  `total`/`windows`/`macos`/`linux`/`other` for O(1) reads).
- `convex/downloads.ts` — `record` mutation (inserts the event row and bumps the
  counters transactionally) and `stats` query (powers the live counter).
- `src/lib/releases.ts` — server-side fetch of the `latest.json` updater
  manifest from GitHub Releases, resolved into per-platform asset URLs.

## Project structure

- `src/routes/` — file-based TanStack Start routes (`_marketing` layout group)
- `src/components/` — `marketing/` and `download/` component folders
- `src/lib/` — release metadata + download tracking helpers
- `src/router.tsx` — router factory with Convex + React Query wiring
- `src/styles/index.css` — Tailwind v4 + Forge UI tokens
- `convex/` — Convex backend schema and functions
- `convex/_generated/` — generated Convex types (commit these)
