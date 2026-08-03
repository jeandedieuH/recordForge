# Spec 010: Forge UI Design System

> Token and component rules for recordForge. Source of truth: `packages/ui/src/styles/theme.css` (tokens) and `packages/ui/src/components/**` (kit). Decisions: ADR-008 (system), ADR-009 (chrome).

## 1. Color Tokens

Dark theme is `:root` default; light overrides via `[data-theme="light"]`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-background` | `#0a0a0b` | `#fafafa` | app canvas, near-OLED |
| `--color-surface` | `#131316` | `#ffffff` | cards, panels |
| `--color-elevated` | `#1a1a1f` | `#ffffff` | popovers, drawers |
| `--color-overlay` | `#222228` | `#f4f4f5` | tooltips, hover fills |
| `--color-border` | white/8 | black/8 | default borders |
| `--color-border-strong` | white/14 | black/14 | emphasis borders |
| `--color-foreground` | `#fafafa` | `#18181b` | body text |
| `--color-muted-foreground` | `#a1a1aa` | `#52525b` | secondary text |
| `--color-subtle-foreground` | `#71717a` | `#a1a1aa` | placeholders, hints |
| `--color-accent` | `#f59e0b` | `#d97706` | forge ember — brand/primary only |
| `--color-accent-foreground` | `#1a1207` | `#ffffff` | text on accent |
| `--color-accent-soft` | ember/12 | ember/12 | ember tint fills |
| `--color-recording` | `#ef4444` | same | recording + destructive **only** |
| `--color-success` | `#10b981` | same | success states, meter green |
| `--color-warning` | `#eab308` | same | warnings, meter amber |
| `--color-info` | `#38bdf8` | same | info states |
| `--color-track-*` | screen sky / webcam violet / mic emerald / system pink / captions yellow | same | timeline track accents |

**Reserved meanings:** ember = brand/primary action; red = recording/destructive; track colors belong to the timeline. Nothing else may use them.

## 2. Typography

- **Family:** Inter Variable (vendored via `@fontsource-variable/inter`); system stack fallback.
- **Scale:** 12 / 13 / 14 (base) / 16 / 18 / 24 / 32. App sets `html { font-size: 14px }` (compact desktop density).
- **Numeric:** `.tnum` (`font-feature-settings: "tnum"`) for timers, timecode, sizes.
- **Mono:** system mono stack for session IDs, paths, logs.
- **Group headers:** 12 px medium, uppercase tracking.

## 3. Spacing, Radius, Elevation

- 4 px base grid; common gaps 8/12/16/24.
- Radius: `sm 6` · `md 8` (controls) · `lg 12` (cards) · `xl 16` (dialogs) · `full` (pills, floating bar).
- Elevation: `shadow-e1` cards · `shadow-e2` popovers/menus · `shadow-e3` dialogs/overlays. Borders do the work on dark; shadows only layer.
- Glass surfaces (floating pill, overlays): `backdrop-blur` over translucent surface.

## 4. Motion

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 120 ms | hovers, presses, toggles |
| `--duration-base` | 180 ms | menus, popovers, tab switches |
| `--duration-slow` | 280 ms | dialogs, drawers, view transitions |
| `--ease-forge` | `cubic-bezier(.16, 1, .3, 1)` | default ease-out |

- Animate `transform` + `opacity` only.
- Recording-dot pulse (`animate-rec-pulse`, 1.6 s) is the only ambient animation.
- `prefers-reduced-motion`: durations collapse to 1 ms globally (in `theme.css`).

## 5. Iconography

- **lucide-react** only; 16 px default, 20 px sidebar, 14 px dense.
- Zero emoji in product UI.
- Icon-only buttons: always `IconButton` (built-in `aria-label` + tooltip).

## 6. Component Kit (`@recordforge/ui`)

shadcn model: Radix primitives + Tailwind + CVA, owned source, named exports, subfolders per concern (`actions/`, `forms/`, `nav/`, `overlay/`, `feedback/`, `display/`, `layout/`).

Available: Button, IconButton, ToggleGroup · Input, Textarea, Label, Select (Radix), NativeSelect (legacy), Slider, Switch · Tabs · Dialog, AlertDialog, Popover, DropdownMenu, ContextMenu, Tooltip · Toast (`useToast` + `ToastViewport`), Badge, Progress, StageProgress, Skeleton, EmptyState · Card, Kbd, Separator, Thumbnail, AudioLevelMeter · ScrollArea · `cn`.

## 7. Quality Bar (every surface)

1. **Four states:** loading (Skeleton), empty (EmptyState + CTA), error (message + retry), success. No raw text loaders.
2. **Keyboard:** reachable + operable; shortcuts shown via Kbd in tooltips.
3. **Icons:** lucide only, no emoji.
4. **Tokens only:** no raw hex/px outside `theme.css`; both themes reviewed.
5. **Motion:** 120–280 ms, transform/opacity, reduced-motion honored.
6. **Feedback:** every background job ends in a toast or drawer entry — never silent.
7. **Contrast:** WCAG AA (4.5:1 body, 3:1 large) on both themes.
8. **Perf:** no layout thrash; lists > 50 items virtualized.
