# @recordforge/web

recordForge web app — TanStack Start + Convex.

## Development

```bash
cd apps/web
bun run convex:once      # provision local Convex, generate types, write .env.local
bun run dev             # start Vite dev server
```

Open <http://localhost:3000>. The home page is empty until you seed sample tasks —
click the **Seed sample tasks** button, or run:

```bash
bun run convex:seed
```

## Build

```bash
bun run build
```

## Project structure

- `src/routes/` — file-based TanStack Start routes
- `src/router.tsx` — router factory with Convex + React Query wiring
- `src/styles/index.css` — Tailwind v4 + Forge UI tokens
- `convex/` — Convex backend schema and functions
- `convex/_generated/` — generated Convex types (commit these)
