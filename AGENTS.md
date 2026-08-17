# recordForge — Agent Operating Guide

## Project Summary

recordForge is a **local-first, low-end-friendly desktop screen recorder** with a lightweight editor. The initial target is Windows 11. The product is intentionally recorder-first: capture, A/V sync, recovery, editing, and exports come before cloud-sharing features.

## Approved Stack

| Area | Decision |
|---|---|
| Desktop framework | Tauri v2 |
| Native language | Rust |
| UI | React + TypeScript |
| Bundler | Vite |
| Styling | Tailwind CSS |
| Package manager | Bun |
| Monorepo | Turborepo + Bun workspaces |
| Local database | SQLite |
| Video processing | FFmpeg + FFprobe |
| Windows audio capture | Native WASAPI via `wasapi` |
| Cursor SVG rasterization | `resvg` + `tiny-skia` in export |
| State management | Zustand |
| Validation | Zod |
| UI kit | `@recordforge/ui` (shadcn model: Radix + Tailwind v4 + CVA, spec-010) |
| Icons | lucide-react (no emoji in product UI) |
| Font | Inter Variable for the shell; overlay bundle uses Inter, Source Serif 4, JetBrains Mono, and Outfit under OFL-1.1 |

## Repository Layout

- `apps/desktop/` — Tauri desktop app (React frontend + Rust backend)
- `packages/contracts/` — Zod schemas and DTOs
- `packages/cursor-core/` — Pure cursor telemetry normalization, mapping, and parity algorithms
- `packages/overlay-core/` — TypeScript/WASM overlay engine adapter
- `packages/overlay-engine/` — Canonical Rust overlay evaluation engine
- `packages/domain/` — Domain models
- `packages/editor-core/` — Pure timeline command engine
- `packages/media-core/` — FFmpeg job specifications
- `packages/storage-core/` — Storage provider contracts
- `packages/ui/` — Shared UI primitives
- `packages/config/` — Shared TS, lint, Tailwind config
- `docs/` — ADRs, specs, test plans, benchmarks

## V1 Scope

- Screen, window, and region recording on Windows 11
- Microphone, system audio, and optional webcam
- Global shortcuts, tray, floating controls
- Local library and recovery
- Proxy-based timeline editor with trim, split, move, delete, undo/redo
- Local MP4 export
- Optional S3-compatible and Google Drive uploads

## V1 Non-Goals

- recordForge-hosted share links
- Public web video pages
- User accounts and workspaces
- Cloud collaboration
- macOS / Linux production support
- Full professional editor features

## Architecture Boundaries

- **Rust owns:** native capture, audio, filesystem, encoding, credentials, media jobs, security-sensitive operations.
- **React owns:** user interface and interaction only.
- **Never pass raw video frames or audio buffers through React state, Tauri commands, or events.**
- Use Tauri commands for start/stop operations and queries.
- Use Tauri events/channels only for compact status and progress updates.

## Commands

Install dependencies:

```bash
bun install
```

Build the overlay engine WASM artifact:

```bash
bun run build:wasm:overlay
```

Download FFmpeg/FFprobe sidecar binaries (required after fresh clone):

```bash
bun run setup:ffmpeg
```

Run development mode:

```bash
cd apps/desktop
bun run tauri:dev
```

Build desktop release:

```bash
cd apps/desktop
bun run tauri:build
```

Run all checks from root:

```bash
bun run check
```

Type check:

```bash
bun run typecheck
```

Run tests:

```bash
bun run test
```

## Security Rules

- Never store cloud credentials in code, project files, or SQLite.
- Store S3 and Google tokens only in the OS credential vault.
- Use narrow Tauri capability files.
- Do not expose arbitrary command execution to React.
- Require ADR approval for new Tauri capabilities.
- Redact secrets, tokens, and media paths from logs and diagnostics.
- Do not log screen content, audio transcripts, or user media.

## Rules for Adding Dependencies

- Prefer well-known, stable libraries.
- Avoid dependencies published less than 7 days ago.
- Do not use floating versions (`latest`, `*`, unbounded `>=`).
- Add to the correct workspace package, not the root unless shared by all.
- Update `AGENTS.md` if the dependency changes the stack or build commands.

## Rules for Changing Tauri Capabilities

- Capabilities must be narrowly scoped.
- Any change requires a security review.
- Update the relevant ADR and spec.
- Do not add filesystem access without explicit allowed paths.

## Code Conventions

- TypeScript: strict mode, interfaces over types, no enums, functional components, named exports.
- Rust: `cargo fmt` and `clippy` must pass.
- React: minimize `use client`, `useEffect`, and `setState`; prefer server components where applicable.
- Tailwind: use design tokens, mobile-first.
- **Design tokens only** — no raw hex/px literals outside `packages/ui/src/styles/theme.css` (spec-010).
- **No emoji icons** — lucide-react only; icon-only buttons use `IconButton` (aria-label + tooltip built in).
- **Four-states pattern** — every async surface renders skeleton → content | empty | error(+retry); no raw text loaders.
- **Feedback** — every background job ends in a toast (or jobs-drawer entry), never silently.
- Error handling: guard clauses, early returns, user-friendly messages.
- Add comments on non-obvious implementation decisions only.

## Tooling

Download FFmpeg/FFprobe sidecar binaries (pinned to v9.0):

```bash
bun run setup:ffmpeg
```

Regenerate app icons from the branding master SVG (`branding/icon.svg`):

```bash
bun run --cwd tooling/scripts icons
```

## Completion-Report Format

When finishing a task, report:

1. Files changed.
2. Acceptance criteria met.
3. Validation evidence (commands run, test results).
4. Known limitations.
5. Follow-up work.

## Verification Notes

- `bun run lint` currently stops before linting because the installed `typescript-eslint` release does not support the repository's TypeScript 7.0 toolchain; use typecheck, format checks, and tests until the toolchain compatibility is resolved.
- On Windows, run Rust tests with `cargo test -j 1` when parallel linking intermittently reports `LNK1104` for test executables.
