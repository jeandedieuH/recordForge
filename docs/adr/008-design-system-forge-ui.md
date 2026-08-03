# ADR 008: Forge UI — Dark-First Design System on the shadcn Model

## Status

Accepted

## Context

The prototype UI had no design system: five colors total, the stock Tauri template blue as primary, emoji as iconography, native form controls, and no motion or feedback layer. The renewed plan (`renewed-plan.md` §2–3) calls for a dark-first "creator's studio console" aesthetic with a single forge-ember accent.

## Decision

- **Dark-first theme** with light as a first-class citizen. Tokens are defined once in `packages/ui/src/styles/theme.css` as a Tailwind v4 `@theme` block (dark in `:root`, light overrides under `[data-theme="light"]`) and imported by the app — a single source of truth (spec-010).
- **shadcn/ui model** for `packages/ui`: Radix primitives + Tailwind + CVA variants, owned source, named exports, small files in subfolders per concern. No monolithic UI library.
- **lucide-react** is the only icon set. Zero emoji in product UI.
- **Inter Variable** is vendored via `@fontsource-variable/inter` so the app renders identically offline.
- **Motion:** 120/180/280 ms durations, `cubic-bezier(.16,1,.3,1)` easing, transform/opacity only, `prefers-reduced-motion` honored. The recording-dot pulse is the only ambient animation.
- **wavesurfer.js and Drizzle are dropped** from the stack list: the Rust-generated waveform PNG and the existing Rust SQLite layer already cover those needs.

## Consequences

- Every visual change flows through the token layer; raw hex/px literals are banned outside `theme.css`.
- Call sites migrate feature-by-feature per roadmap phase; the legacy native select survives as `NativeSelect` until R1.
- New dependencies are pinned and tree-shaken per component (Radix is per-primitive).

## Alternatives Considered

- Off-the-shelf component library (Mantine/MUI): rejected — bundle weight, theming friction, and not the repo's owned-source preference.
- CSS-in-JS: rejected — Tailwind v4 tokens give compile-time utilities and runtime theme switching for free.
