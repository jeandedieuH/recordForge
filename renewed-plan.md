# recordForge — Renewed Master Plan

> **Status:** Active. Supersedes `dev-plan.md` as the working roadmap (the product vision in `project-plan.md` remains the source of truth for scope).
> **Purpose:** Take recordForge from a functional-but-plain prototype to a modern, sleek, professional desktop studio — without throwing away the solid Rust capture, recovery, media-pipeline, and editor-core work already built.
> **Locked design decisions (2026-08-03):** Dark-first studio theme · Forge-ember accent · Custom frameless window with Mica backdrop · Icon sidebar rail navigation.

---

## 1. Where We Are — Honest Audit

### 1.1 What is already built (keep and build on)

| Area | State | Evidence |
|---|---|---|
| Monorepo, contracts, ADRs, CI scripts | Done | `packages/contracts`, `docs/adr/001–007`, root `package.json` |
| Native capture (FFmpeg-based), device enumeration, encoder detection, benchmark | Working | `src-tauri/src/capture/*` |
| Segmented recording + crash recovery | Working | `capture/session.rs`, `capture/manifest.rs`, `capture/recovery.rs` |
| Media preparation jobs (probe, proxy, thumbnail sprites, waveform PNG, disk estimates, cleanup) | Working | `src-tauri/src/media/*`, `src-tauri/src/jobs/mod.rs` |
| Library persistence + tags | Working | `src-tauri/src/database/library.rs` |
| Editor domain engine (commands, undo/redo, render plans) | Working, unit-tested | `packages/editor-core`, `packages/media-core` |
| Tray, global shortcuts, floating controls window | Working | `src-tauri/src/tray.rs`, `shortcuts.rs`, `?floating=1` branch in `App.tsx` |
| All core screens exist (recorder, library, editor, settings) | Functional, plain | `apps/desktop/src/features/*` |

### 1.2 Why the app does not feel modern (diagnosis)

1. **No design system.** Five colors total; the primary `#396cd8` is the stock Tauri template blue. No elevation, radius, spacing, or typography scale. Dark mode is a 3-color `prefers-color-scheme` afterthought.
2. **Emoji as iconography.** 🖥️ 🪟 🎬 appear in the source picker and library cards. No icon library exists in the dependency tree.
3. **No media richness.** Library cards show a 🎬 placeholder instead of the thumbnails the backend already generates. Source picker has no display previews or window icons.
4. **Web-form layout.** A centered `max-w-5xl` column with text tabs ("recorder / library / editor / settings") in the header — a settings page, not a studio.
5. **Cluttered cards.** Each library card crams in a stats grid, tag editor, marker list, and **six** text buttons (Reveal / Trim / Export / Prepare / Editor / Delete).
6. **Native everything.** Native title bar, native `<select>`s, plain inputs. No custom chrome, no glass, no depth.
7. **No motion or feedback layer.** No toasts (background jobs complete silently), no skeletons ("Loading timeline..." text), no empty states, no transitions beyond `transition-opacity`.
8. **Thin settings & missing flows.** Settings exposes only diagnostics. No onboarding, no recovery UI polish, no export presets UI, no storage destinations.

### 1.3 Real gaps vs. the product plan (beyond visuals)

- Region capture is numeric x/y/w/h entry — no drag-select overlay.
- No audio-level metering events from Rust (floating bar needs a live meter).
- Studio effects (cursor highlight, click ring, canvas background, padding/radius/shadow, webcam styling) not implemented in render plans.
- Export presets UI absent; export is a raw save-dialog flow.
- `packages/storage-core` is contracts-only; there is no `src-tauri/src/storage/` — S3/Drive are unimplemented.
- No first-run onboarding, no settings persistence layer, no auto-updater, no screenshot capture.
- `docs/specs/`, `docs/test-plans/`, `docs/benchmarks/` directories do not exist yet.

### 1.4 What does **not** change

- Architecture boundaries (Rust owns media/native; React owns UI; no frames over IPC).
- Capture, session, manifest, recovery, encoder, and media-job code (additive changes only).
- `packages/contracts` schemas (additive evolution only), `editor-core` engine API.
- Performance budgets and security rules from `AGENTS.md` / `project-plan.md`.

---

## 2. Design Vision

**North star:** recordForge should feel like a *creator's studio console* — dark, calm, precise — closer to Screen Studio, Cap, and CleanShot X than to a settings dialog. Chrome and panels get out of the way; the user's recordings and the canvas carry the color.

**Reference points:**

| Product | What we take |
|---|---|
| Screen Studio | Dark minimal chrome, export presets as visual cards, floating recorder pill |
| Cap | Local-first honesty, compact recorder, big-thumbnail library |
| CleanShot X | Tray-centric speed, overlay-based region selection, instant HUD feedback |
| Loom | One-shortcut workflow, zero-config start |
| Linear / Raycast | Window chrome craft: sidebar rail, kbd hints everywhere, command-first, subtle borders, 150–250 ms motion |
| OBS / ShareX | **Anti-reference:** power without clarity |

**Design principles:**

1. **Recorder-first speed.** Any path to "recording" is ≤ 2 clicks or 1 shortcut from anywhere.
2. **Dark-first.** OLED-friendly dark is the default; light theme is a first-class citizen, not an afterthought.
3. **One accent, reserved meanings.** Ember = brand/primary action. Red = recording/destructive only. Track colors belong to the timeline.
4. **Density with air.** Compact desktop density (13–14 px body, 32–36 px controls) with consistent 4 px spacing rhythm.
5. **Motion with meaning.** 120–280 ms ease-out transitions that explain state changes; nothing decorative; `prefers-reduced-motion` respected.
6. **Keyboard-first.** Every primary action shows its shortcut via `<kbd>` hints; full keyboard navigability.
7. **Honest status.** The app always shows what it's doing — jobs, disk, device health — never silently.

---

## 3. Forge UI — Design System

### 3.1 Color tokens (Tailwind v4 `@theme`)

Dark theme is `:root` default; light overrides via `[data-theme="light"]`. Values are starting points to be tuned during R0 visual review.

```css
@theme {
  /* Surfaces (dark) */
  --color-background: #0a0a0b;      /* app canvas, near-OLED */
  --color-surface: #131316;         /* cards, panels */
  --color-elevated: #1a1a1f;        /* popovers, drawers */
  --color-overlay: #222228;         /* tooltips, hover fills */
  /* Borders */
  --color-border: #ffffff14;        /* white/8 */
  --color-border-strong: #ffffff24; /* white/14 */
  /* Text */
  --color-foreground: #fafafa;
  --color-muted-foreground: #a1a1aa;
  --color-subtle-foreground: #71717a;
  /* Brand + semantics */
  --color-accent: #f59e0b;          /* forge ember */
  --color-accent-foreground: #1a1207;
  --color-accent-soft: #f59e0b1f;   /* ember tint fills */
  --color-recording: #ef4444;       /* REC red — recording + destructive only */
  --color-success: #10b981;
  --color-warning: #eab308;
  --color-info: #38bdf8;
  /* Timeline track accents */
  --color-track-screen: #38bdf8;    /* sky */
  --color-track-webcam: #a78bfa;    /* violet */
  --color-track-mic: #34d399;       /* emerald */
  --color-track-system: #f472b6;    /* pink */
  --color-track-captions: #facc15;  /* yellow */
}

[data-theme="light"] {
  --color-background: #fafafa;
  --color-surface: #ffffff;
  --color-elevated: #ffffff;
  --color-overlay: #f4f4f5;
  --color-border: #18181b14;        /* black/8 */
  --color-border-strong: #18181b24;
  --color-foreground: #18181b;
  --color-muted-foreground: #52525b;
  --color-subtle-foreground: #a1a1aa;
  --color-accent: #d97706;          /* darker ember for AA on white */
  --color-accent-foreground: #ffffff;
}
```

### 3.2 Typography

- **Family:** Inter Variable, **vendored locally** (`@fontsource-variable/inter` or manual woff2 in `src/assets/fonts`) — the app must render identically offline. System stack as fallback.
- **Scale:** 12 / 13 / 14 (base) / 16 / 18 / 24 / 32. Line-height 1.5 body, 1.2 headings.
- **Numeric:** `font-feature-settings: "tnum"` for timers, timecode, sizes. Timecode format `HH:MM:SS.mmm`.
- **Mono:** system mono stack for session IDs, paths, logs only — no extra font download.
- **Titles:** sidebar/section headers 12 px medium, uppercase-tracking labels for group headers.

### 3.3 Spacing, radius, elevation

- **Spacing:** 4 px base grid; common gaps 8/12/16/24.
- **Radius:** `sm 6` · `md 8` (controls) · `lg 12` (cards) · `xl 16` (dialogs) · `full` (pills, floating bar).
- **Elevation (dark-first, borders do the work; shadows for layering):**
  - `e1` cards: `0 1px 2px rgb(0 0 0 / .35)`
  - `e2` popovers/menus: `0 8px 24px rgb(0 0 0 / .45)`
  - `e3` dialogs/overlays: `0 16px 48px rgb(0 0 0 / .55)`
- **Glass:** floating pill + overlays use `backdrop-blur` over translucent surface (`color-mix(surface, transparent 20%)`) — never on the main window body (Mica already provides it).

### 3.4 Motion

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 120 ms | hovers, presses, toggles |
| `--duration-base` | 180 ms | menus, popovers, tab switches |
| `--duration-slow` | 280 ms | dialogs, drawers, view transitions |
| Easing | `cubic-bezier(.16, 1, .3, 1)` | ease-out "springy settle" |

- Animate `transform` + `opacity` only (no width/height/layout thrash).
- Recording dot pulse: 1.6 s ease-in-out infinite — the only ambient animation.
- Respect `prefers-reduced-motion`: disable pulse and reduce durations to 0–1 ms.

### 3.5 Iconography

- **lucide-react**, one set, 16 px default / 20 px sidebar / 14 px dense, 1.5 px stroke — **zero emoji in product UI** (current 🖥️🪟🎬 all removed).
- Icon-only buttons always get `aria-label` + tooltip.

### 3.6 Component inventory — rebuild `packages/ui`

Adopt the **shadcn/ui model** (Radix primitives + Tailwind + CVA variants, owned source) inside `packages/ui`, keeping repo conventions: functional components, TypeScript interfaces, **named exports**, small files, subfolders per concern.

| Component | Notes |
|---|---|
| Button | variants: `primary` (ember), `secondary`, `ghost`, `outline`, `destructive`; sizes `sm/md/lg/icon`; loading state |
| IconButton | tooltip + aria-label built in |
| Input / Textarea | focus ring accent, error variant, leading-icon slot |
| Select | custom Radix listbox (replaces native `<select>` everywhere) |
| Slider | zoom, gain, padding, radius controls |
| Switch | settings toggles |
| Tabs / ToggleGroup | segmented controls (source kind, grid/list) |
| Dialog / AlertDialog | export, recovery, confirmations |
| Popover / DropdownMenu / ContextMenu | card overflow menus, right-click menus |
| Tooltip | kbd hints included in content |
| Toast (`useToast` + viewport) | job completion, errors w/ action buttons, queued, bottom-right |
| Badge / Chip | status pills (Ready · Preparing · Recovery · Exported) |
| Card / Surface | standard section container |
| Progress + StageProgress | determinate bar with stage label + ETA |
| Skeleton | library cards, editor preview, timeline |
| EmptyState | icon + headline + body + CTA pattern |
| Kbd | shortcut hint element |
| ScrollArea / Separator | chrome consistency |
| AudioLevelMeter | segmented live meter (floating pill, recorder home, devices test) |
| Thumbnail | 16:9 media thumb with duration badge + fallback icon |

### 3.7 Branding

- **Icon:** ember flame/forge mark in a rounded squircle; ember gradient (`#f59e0b → #ea580c`) on dark ground. Master SVG in `branding/`, generated PNG/ICO via a `tooling/scripts` step (replaces stock Tauri icons).
- **Wordmark:** "recordForge" — Inter semibold, "Forge" in ember.
- **Tray icon:** monochrome template-style icon with state variants: idle (gray), recording (red), paused (amber).
- Titlebar shows wordmark + view name; window title stays "RecordForge".

---

## 4. App Architecture & Information Architecture

### 4.1 Windows (3)

| Window | Chrome | Purpose |
|---|---|---|
| **Main studio** (existing `main`) | Frameless + custom titlebar + Mica | Recorder home, library, editor, settings |
| **Floating pill** (existing floating window, redesigned) | Frameless, transparent, always-on-top, glass | Live recording HUD |
| **Region-select overlay** (new) | Frameless, transparent, fullscreen, always-on-top | Drag-select capture region |

### 4.2 Main window chrome

- `decorations: false`; **custom titlebar**: drag region (`data-tauri-drag-region`), left = wordmark + current view breadcrumb, center = optional project name (editor), right = minimize / maximize / close (`@tauri-apps/api/window`).
- **Mica backdrop** applied at startup via Tauri v2 window-effects API; user toggle in Settings → General ("Window transparency effect"), auto-disabled when preflight flags a low-end GPU.
- Default size 1280×800, min 960×600.

### 4.3 Sidebar rail IA

```
┌────────────────────────────────────────────┐
│ Titlebar (drag)          — ☐ ×             │
├────────┬───────────────────────────────────┤
│ ⬢ Forge│  Content                          │
│        │                                   │
│ ● Record                                   │
│ ▦ Library                                  │
│ ✂ Editor (contextual — badge when open)    │
│        │                                   │
│ ──────                                     │
│ ⚙ Settings                                 │
│        │                                   │
│ ▶ jobs 2 ● 12.4 GB free                    │
└────────┴───────────────────────────────────┘
```

- 200 px icon+label column (icons 20 px, labels 13 px); collapses to a 56 px icon rail via a toggle in the footer.
- Footer: **jobs indicator** (active count, opens Jobs Drawer) + **disk-free meter**.
- Editor is contextual: opens when a recording is opened; shows a close affordance returning to Library.
- Navigation state stays in React (no router needed — single-window Tauri app); deep states: `record`, `library`, `editor/:id`, `settings/:section`.

### 4.4 Global systems

- **Toast system:** bottom-right, 4 s auto-dismiss, action buttons (Reveal / Open editor / Undo delete), max 3 stacked.
- **Keyboard map:** global recording shortcuts stay in Rust (existing); in-app shortcuts (editor + navigation) in a `useAppShortcuts` hook; full map visible in Settings → Shortcuts.
- **Theme store:** `zustand` + persisted setting (SQLite settings table or `settings.json` via Rust — decide in R0); `data-theme` attribute on `<html>`; system-follow default.
- **State pattern for every async surface:** skeleton → content | empty | error(+retry). No raw text loaders anywhere.
- **Command palette (Ctrl+K)** — stretch goal in R5: start recording, jump views, search recordings, recent exports.

---

## 5. Feature-by-Feature UX Specs

### 5.1 Recorder Home (Record view)

**Layout:** two-column at ≥1100 px (config left, summary right), single column below.

1. **Source section** — segmented control `Display | Window | Region`:
   - *Display:* cards with **real display thumbnails** (new Rust command `get_source_thumbnails` — reuse FFmpeg screenshot path; fallback: monitor icon + resolution + "Primary" badge).
   - *Window:* searchable list with **app icons** extracted in Rust (fallback: app-window icon), title, dimensions.
   - *Region:* "Select region" button → fullscreen overlay (5.2); chosen region shown as thumbnail with dimensions + "Reselect" / fine-tune popover (the existing numeric fields move here as *advanced*).
2. **Audio & camera** — device dropdowns with icons (mic, speaker, camera), per-device **test meter** (mic check with live level), actionable empty hints (keep current copy — it's good).
3. **Quality** — profile cards (Low-impact 720p30 · Balanced 1080p30 · Smooth 1080p60 · High 1440p30) with encoder chip ("NVENC", "QSV", "x264") instead of a raw dropdown; preflight-recommended badge.
4. **Record button** — large ember CTA with `Ctrl+Shift+R` kbd hint; countdown toggle (3 s default, configurable in Settings).
5. **While recording** (main window visible): status card becomes live HUD — pulsing red dot, big tabular timer, **live mic level meter**, marker feed, pause/resume/stop; "Minimize to tray — recording continues" hint.

### 5.2 Region-Select Overlay (new window)

- Fullscreen dimmed backdrop (`black/60`), crosshair cursor, drag to select; live `W×H` readout badge follows the selection.
- Esc cancels, Enter confirms, arrows nudge 1 px (Shift = 10 px), magnifier loupe (stretch).
- Confirm emits bounds → recorder store; window closes. Rust: `open_region_overlay` / region result event.
- Must handle multi-monitor (one overlay per display or a single spanning window — decide in R1 spike), DPI scaling, and never intercept the global shortcuts.

### 5.3 Countdown

- Full-window dim + centered 96 px tabular numerals scaling down each second (200 ms ease-out), ring progress around the numeral, "Press Esc to cancel". Replace the current plain number.

### 5.4 Floating Recorder Pill (redesign of existing window)

- **Glass pill** (`backdrop-blur`, translucent surface, `radius-full`, 320×56 px), draggable anywhere, always-on-top, remembers position.
- Contents: REC dot (pulsing) · tabular timer · **live segmented audio meter** (new Rust `audio-level` event at ~10 Hz, compact — allowed by comms rules) · pause/resume · marker · stop (with 300 ms press-and-hold or confirm-click to avoid accidental stops — decide in R1).
- Collapses to a 48 px dot when idle >5 s (hover expands) — stretch.
- States mirror the recorder state machine with color (recording red / paused amber / finalizing ember).

### 5.5 Library

- **Cards (grid):** 16:9 **real thumbnail** (poster frame from the existing thumbnail-sprite job; skeleton shimmer until ready, icon fallback), duration badge bottom-right on the thumb, status chip top-left (Ready / Preparing / Recovery), name + date + size row. **Hover:** quick actions fade in — Open in editor (primary), Export, More (⋯). **Right-click:** context menu (Open editor, Export, Prepare media, Rename, Tags…, Reveal in Explorer, Duplicate, Delete).
- **Tags/markers/stats** move to a detail popover or right-side inspector on selection — off the card face.
- **List view:** slim rows (thumb 96 px, name, duration, size, status, date, actions on hover).
- **Filter bar:** search (icon + Esc clear), sort select, tag filter (chip multiselect), grid/list toggle — one compact row.
- **Recovery items:** amber-accented card variant with "Recover" CTA first.
- **Empty state:** icon + "No recordings yet" + "Press Ctrl+Shift+R to start your first recording" + secondary "Learn the basics" (opens onboarding).
- **Jobs Drawer:** bottom sheet (40 % height) listing active/queued/finished jobs with stage progress, cancel, and error details; opened from sidebar footer; global **toast** on job completion ("Proxy ready — Open editor").
- **Disk meter:** sidebar footer, tooltip with breakdown (originals / proxies / exports), turns amber <10 GB, red <5 GB (ties into existing disk estimates).

### 5.6 Editor Studio

**Three-zone layout (fills viewport, no page scroll):**

```
┌──────────────────────────────────────────────┐
│ Titlebar: ← Library · Project name · Export  │
├─────────────────────────────┬────────────────┤
│ Preview canvas (16:9)       │ Inspector      │
│ - proxy playback            │ (contextual:   │
│ - draggable webcam PiP      │  clip/canvas/  │
│ - canvas bg preview         │  webcam/audio) │
├─────────────────────────────┴────────────────┤
│ Timeline dock                                │
│ toolbar │ ruler │ tracks │ playhead          │
└──────────────────────────────────────────────┘
```

1. **Preview canvas:** dark checkerboard/letterbox background; click toggles play; **webcam PiP is dragged/resized directly on the canvas** with snap-to-edge guides (replaces pure numeric controls — `pip-controls.tsx` stays as precise fallback in inspector); canvas background (color/gradient/wallpaper — R5) rendered behind video.
2. **Timeline dock:**
   - **Toolbar:** undo/redo · split · delete · marker · caption · zoom slider + fit · time readout (`current / total`).
   - **Ruler:** adaptive ticks (1 s → 1 min by zoom), click/drag to scrub.
   - **Tracks:** colored clip blocks per track accent (3.1), **filmstrip thumbnails** on screen clips (from sprite), **waveform image** inside audio clips (existing PNG — keep; *wavesurfer.js dropped*: static peaks are cheaper on low-end), marker flags row, mute/lock toggles per track header.
   - **Playhead:** ember line + handle; `Ctrl+wheel` zoom at cursor; drag to scrub.
   - **Virtualization:** `@tanstack/react-virtual` for long timelines (60-min budget); clip drag via `dnd-kit` (as originally planned).
3. **Inspector (right, 280 px):** contextual — clip (trim numeric, speed, gain, fades) · canvas (background, padding, corner radius, shadow) · webcam (position/size/shape/border) · captions (text, timing). Uses sliders + inputs with live preview where cheap.
4. **Keyboard:** `Space` play/pause · `S` split · `Del` delete · `Ctrl+Z/Y` undo/redo · `←/→` ±1 frame (`Shift` ±1 s) · `M` marker · `Ctrl+E` export. Hints in tooltips + Settings → Shortcuts.
5. **States:** skeleton preview + timeline while loading; "Recording not prepared" empty state gets a **"Prepare media" button** that runs the job inline (with progress) instead of dead text.

### 5.7 Export

- **Export dialog** (replaces bare save dialog): **preset cards** — Fast share 1080p30 · Balanced · Smooth demo 1080p60 · High quality 1440p30 · Archive · GIF snippet · Vertical 1080×1920 (cards show codec/fps/**estimated file size**); destination picker; advanced accordion (bitrate, encoder override, low-impact render mode).
- **Progress state:** stage label (Preparing → Rendering → Validating → Moving), determinate bar, elapsed + ETA, encoder chip, cancel.
- **Done state:** success panel with thumbnail, file size, and actions: **Reveal · Open · Upload to…** (R4) · Done. Failure state with human-readable error + retry.

### 5.8 Storage Destinations (feature build, R4)

- Settings → Storage: provider cards (Local folder, S3-compatible, Google Drive) with connect/test flows; S3 form (endpoint, region, bucket, prefix, path-style) storing secrets **only in OS vault** (existing rule); Google OAuth in system browser.
- Upload center: queue list (per upload: progress bar, pause/resume/retry/cancel, remote path, provider link), persisted across restarts; upload status chip on library cards.

### 5.9 Settings (real IA)

Left sub-nav sections: **General** (theme: dark/light/system · Mica toggle · launch on login · updates) · **Recording** (default sources, profile, countdown seconds, output folder, disk-space warning threshold) · **Shortcuts** (remappable grid with kbd-capture control, conflict detection, reset) · **Storage** (5.8) · **Diagnostics** (existing panel, restyled: preflight results, benchmark, redacted diagnostics export) · **About** (version, check for updates, licenses/FFmpeg attribution).

### 5.10 Onboarding (first run)

Four-step modal wizard, skippable, re-openable from Settings → General:
1. **Welcome** — what recordForge does, local-first promise.
2. **Devices check** — mic / webcam / system-audio status rows with live test and fix hints (reuse device-empty copy).
3. **Performance preflight** — auto-selected profile with one-line "why" (GPU, encoders found), override link.
4. **Shortcuts tour** — the 6 global shortcuts as kbd cards → "Record your first video" CTA.

### 5.11 Recovery UX

- Startup scan (existing) → **banner** in Library: "1 interrupted recording can be recovered" → dialog listing sessions (date, size, recorded duration) with **Recover / Export recovered file / Delete** (destructive = AlertDialog typed confirm). Never silently delete (existing rule).

### 5.12 Tray & Shortcuts

- Tray menu restated: status line (state + timer) · Start/Stop · Pause/Resume · Show RecordForge · Quit; **state-aware tray icon** (3.7). Shortcut conflicts surfaced in Settings → Shortcuts.

---

## 6. Technical Implementation Plan

### 6.1 New dependencies (pin versions ≥ 7 days old at install time; add to the workspace that uses them)

| Package | Where | Why |
|---|---|---|
| `lucide-react` | `packages/ui` | icon system |
| `@radix-ui/react-{dialog,alert-dialog,dropdown-menu,context-menu,popover,select,slider,switch,tabs,tooltip,toggle-group,scroll-area,separator,label}` | `packages/ui` | accessible primitives (shadcn model) |
| `class-variance-authority`, `clsx`, `tailwind-merge` | `packages/ui` | variant + class composition |
| `tw-animate-css` | `apps/desktop` | Tailwind v4 animation utilities |
| `@fontsource-variable/inter` | `apps/desktop` | offline-safe vendored font |
| `@tanstack/react-virtual` | `apps/desktop` | library + timeline virtualization (original stack) |
| `dnd-kit` (`@dnd-kit/core` + `sortable`) | `apps/desktop` | timeline clip drag (original stack) |

**Explicitly dropped from the old stack list:** `wavesurfer.js` (static waveform PNG already generated by Rust is cheaper and sufficient), Drizzle (Rust SQLite layer already exists). Update `AGENTS.md` stack table accordingly.

### 6.2 `packages/ui` rebuild

- Convert to the shadcn-style component set in 3.6; **named exports** (fixes current default-export drift from repo conventions); keep existing `Button/Input/Select/Progress` API-compatible where practical, then migrate call sites feature by feature (each roadmap phase migrates its feature).
- Tokens live in `packages/ui` (or `packages/config`) as a shared Tailwind v4 `@theme` CSS module imported by the app — single source of truth.

### 6.3 Tauri / Rust changes (additive, capability-safe)

1. `tauri.conf.json`: `decorations: false` on `main`; floating window recreated with `transparent: true`, `alwaysOnTop`, `skipTaskbar`; new region-overlay window created at runtime (no new fs/shell permissions required).
2. Rust setup: apply Mica via window-effects API at startup (respecting user setting + low-end preflight).
3. New commands: `get_source_thumbnails` (display/window previews; cache to app data dir), `get_window_app_icons`, `get/set_setting` (settings persistence in SQLite), `open_region_overlay` (+ region-result event), `audio-level` event emitter (~10 Hz compact f32 — within comms rules), `set_tray_state` variants. Each is small, validated, returns DTOs only — no frame streaming.
4. Tray icon state variants; shortcut rebinding plumbing (persist → re-register).

### 6.4 Assets & docs

- `branding/` master SVG + icon generation script → `src-tauri/icons/*`.
- New docs: `docs/specs/010-design-system.md` (tokens + component rules), `docs/specs/011-ux-flows.md` (this plan's section 5 distilled), ADR-008 (dark-first design system + shadcn-model decision), ADR-009 (window chrome: frameless + Mica + fallback policy). Update `AGENTS.md` (UI conventions: named exports already required; add "no emoji icons", "states pattern", "design tokens only — no raw hex").

---

## 7. Roadmap (R0–R6)

Each phase: goal → tasks → acceptance criteria → verification. Phases are sequential; UI migration happens feature-by-feature so the app stays shippable.

### R0 — Design Foundation (1–2 wks)

**Goal:** tokens, kit, chrome, shell — the base everything else uses.
**Tasks:** install deps · write `@theme` tokens (dark + light) · vendor Inter · build core kit (Button, IconButton, Input, Select, Slider, Switch, Dialog, Tooltip, Toast, Badge, Card, Skeleton, Kbd, EmptyState) · custom titlebar + Mica + theme store · sidebar rail shell (nav, jobs footer, disk meter placeholder) · app icon v1 · ADR-008/009 + spec-010.
**Acceptance:** app runs dark-first with custom chrome; old views render inside new shell without breakage; `bun run check` green; visual review of tokens signed off.
**Verification:** `bun run check`, `cargo clippy`, launch app, toggle theme + Mica, resize to min 960×600.

### R1 — Recorder Experience (2–3 wks)

**Goal:** the 10-second "wow" path — source → record → floating HUD.
**Tasks:** Recorder Home rebuild (5.1) · `get_source_thumbnails` + window icons · profile cards · countdown redesign · floating pill rebuild + `audio-level` event · region overlay spike (multi-monitor + DPI) → full region flow · tray state icons · recorder empty/error/skeleton states.
**Acceptance:** full flow (display/window/region) ≤ 2 clicks to countdown; pill shows live meter + controls reliably; region overlay works on 2-monitor setup; recording start < 2 s (budget preserved); no emoji left in recorder.
**Verification:** `bun run check` + capture smoke matrix (start/pause/resume/stop × display/window/region) + manual on baseline machine.

### R2 — Library (2 wks)

**Goal:** recordings look and feel valuable.
**Tasks:** card rebuild with real thumbnails + status chips + hover actions + context menu · list view · filter bar · detail popover (tags/markers) · recovery card variant + dialog (5.11) · jobs drawer + toasts · disk meter wiring · virtualization for large libraries · skeleton/empty/error states.
**Acceptance:** 500-item library scrolls smoothly; every item state covered (ready/preparing/recovery/error); all actions ≤ 2 clicks; zero-text-loader rule holds.
**Verification:** `bun run check`, RTL tests for card actions, manual soak with large library.

### R3 — Editor Studio (3–4 wks)

**Goal:** a timeline people enjoy using.
**Tasks:** three-zone layout · preview canvas + draggable PiP · timeline dock rebuild (toolbar, ruler, filmstrip + waveform clips, marker flags, zoom/scroll) · inspector rebuild · keyboard map · inline "Prepare media" empty state · `@tanstack/react-virtual` + `dnd-kit` integration · export dialog (5.7, local presets first).
**Acceptance:** 60-min recording edits smoothly (budget); all V1 edit actions from `project-plan.md` §6.7 operable via mouse + keyboard; export dialog produces validated MP4; undo/redo intact (engine untouched).
**Verification:** `bun run check`, `editor-core` + `media-core` tests, manual 60-min project test, export-vs-timeline correctness check.

### R4 — Settings, Onboarding & Storage (3–4 wks)

**Goal:** the app feels finished and self-serve; cloud destinations land.
**Tasks:** settings IA + persistence (5.9) incl. shortcut rebinding · onboarding wizard (5.10) · storage feature build: `src-tauri/src/storage/` (provider trait, local folder, S3 multipart w/ vault, Google OAuth + resumable) + upload center UI + library upload chips · command palette (stretch).
**Acceptance:** new user goes install → first recording without docs; S3 1 GB upload survives interruption + app restart (exit criteria from dev-plan P6); Drive resumable upload works; secrets only in vault.
**Verification:** storage test matrix (dev-plan §8), fresh-profile onboarding run, security checklist (no secrets logged, capabilities unchanged except reviewed additions).

### R5 — Studio Polish (3–4 wks; folds in old Phase 5)

**Goal:** professional-looking output + distribution readiness.
**Tasks:** cursor highlight + click ring + size (render-plan extension) · canvas background/padding/radius/shadow + webcam shapes/borders (inspector → render plan → FFmpeg) · export preset completion (GIF, vertical reframe) · recording templates (tutorial/demo/bug report/lesson) · screenshot capture + annotation · auto-updater + installer UX + signing prep · diagnostics export polish.
**Acceptance:** exports look professionally framed without manual tweaking (canvas + PiP styling); updater installs cleanly on a fresh Windows 11 VM.
**Verification:** media-export test plan, clean-machine install test, benchmark re-run.

### R6 — Hardening & Release (2 wks)

**Goal:** quality bar + release.
**Tasks:** a11y pass (focus order, ARIA, contrast AA on both themes) · perf audit vs budgets (idle <200 MB, UI CPU <5 %) · motion/reduced-motion audit · docs sync (specs, test-plans, AGENTS.md) · V1 release checklist (dev-plan §Release).
**Verification:** full `bun run check` + cargo gates + manual QA matrix + 14-day green CI.

### Traceability (old dev-plan → renewed)

| dev-plan | Renewed |
|---|---|
| P0 Foundation | Done (audited) |
| P1 Capture spike | Done (audited); region overlay completes in R1 |
| P2 Recorder MVP | Exists functionally → UX rebuilt in R1 |
| P3 Media prep | Done → surfaced in R2 (jobs drawer, thumbnails) |
| P4 Editor MVP | Engine done → studio UX + virtualization in R3 |
| P5 Studio polish | R5 |
| P6 Storage | R4 (with settings + onboarding) |
| Release checklist | R6 |

---

## 8. UX Quality Bar (applies to every feature, every PR)

1. **Four states:** loading (skeleton), empty (EmptyState + CTA), error (message + retry), success — no exceptions.
2. **Keyboard:** reachable + operable without a mouse; shortcuts shown via Kbd tooltips.
3. **Icons:** lucide only, no emoji; icon-only buttons have aria-label + tooltip.
4. **Tokens only:** no raw hex/px literals outside the token layer; dark + light both reviewed.
5. **Motion:** 120–280 ms, transform/opacity only, reduced-motion honored.
6. **Feedback:** every background job ends in a toast (or drawer entry) — never silent.
7. **Contrast:** WCAG AA (4.5:1 body, 3:1 large) on both themes.
8. **Perf:** no layout thrash; lists >50 items virtualized; budgets in `project-plan.md` §8 hold.
9. **Copy:** errors are human-readable and actionable (keep the current device-hint standard).

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Mica/transparency hurts low-end GPUs | Setting + auto-disable from preflight; opaque fallback path tested in R0 |
| Region overlay complexity (multi-monitor, DPI, input) | Timeboxed R1 spike with numeric-fields fallback retained |
| Source thumbnails slow on weak hardware | Cached, generated lazily on picker open, icon fallback |
| Scope creep (design rabbit holes) | Tokens signed off at R0; per-phase acceptance gates; visual changes only via spec-010 |
| Breaking working capture while re-skinning | UI-only file scope per phase; capture/recovery untouched; smoke matrix per phase gate |
| Editor perf regressions from richer timeline | Filmstrips from pre-generated sprites, virtualization, rAF playhead (existing rules) |
| New deps bloat | Radix packages tree-shaken per component; no monolithic UI lib; audit bundle at R3 |

## 10. Governance

- Specs/ADRs added per §6.4; `AGENTS.md` updated at R0 (stack table, UI conventions) and whenever stack changes.
- Workflow per `project-plan.md` §11: spec → approval → bounded task → checks → completion report (files changed, acceptance met, validation evidence, limitations, follow-ups).
- This plan is updated as phases complete (mark `[x]` + date); deviations recorded as ADRs.
