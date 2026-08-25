# recordForge Desktop — Agent Guide

## Scope

The desktop app contains the React UI and the Tauri Rust backend. Work here for UI features, Tauri commands, window/tray behavior, and native integrations.

## Commands

```bash
# Development
cd apps/desktop
bun run tauri:dev

# Frontend only
bun run dev

# Build frontend
bun run build

# Build full desktop release
bun run tauri:build

# Official signed release builds are run by .github/workflows/release-desktop.yml.
# They prepare src-tauri/tauri.release.generated.conf.json before invoking Tauri.

# Type check
bun run typecheck

# Run Rust checks
cd src-tauri
cargo fmt --check
cargo clippy
```

## Directory Layout

- `src/app/` — App-level shell and providers
- `src/components/` — Reusable and feature-organized React components
- `src/features/` — Recorder, library, editor, export, storage, settings
- `src/hooks/` — Custom React hooks
- `src/lib/` — Utilities, Tauri command wrappers, validation
- `src/stores/` — Zustand stores
- `src/styles/` — Tailwind base styles and themes
- `src-tauri/src/` — Rust modules
- `src-tauri/capabilities/` — Tauri capability files

## Tauri Commands

- Keep commands small and focused.
- Validate all inputs with Zod on the TypeScript side and strongly typed structs on the Rust side.
- Return `Result<T>` from Rust using the shared `AppError` format.
- Never return raw frames, audio buffers, or credentials.

## UI Conventions

- Functional components with TypeScript interfaces.
- Use `@recordforge/ui` primitives.
- Place components in `components/{feature}/` or `features/{feature}/`.
- Keep feature files small; split by concern.
- Use Tailwind CSS with the design tokens in `src/styles/index.css`.

## Tauri JS Plugins

- `@tauri-apps/plugin-global-shortcut` and `@tauri-apps/plugin-dialog` are used for global hotkeys and save dialogs.
- `@tauri-apps/plugin-updater` is enabled only in official packaged builds using the release config overlay and a public GitHub Releases endpoint.
- The floating toolbar is rendered when the webview URL contains `?floating=1` (see `src/App.tsx`).

## Security Notes

- Do not add shell or filesystem permissions without review.
- Keep all native code in Rust.
- Do not log secrets or media contents.
- The updater public key may be embedded in official release configuration; the private signing key must remain in GitHub Actions secrets and never enter the frontend bundle.
