# Editor Minimum Supported Window Sizes

> **Status:** Phase 0 baseline
> **Scope:** Supported editor window dimensions and reference-capture protocol
> **Related:** `docs/specs/editor-capability-matrix.md`, `docs/benchmarks/editor-phase-0-baseline.md`

## 1. Minimum Supported Size

| Size        | Width | Height | Usage                              |
| ----------- | ----- | ------ | ---------------------------------- |
| Minimum     | 1024  | 768    | Degraded editor; collapsed sidebar, compact inspector, scrollable toolbar |
| Comfortable | 1280  | 800    | Full two-column inspector, visible timeline thumbnails, readable transport |
| Recommended | 1440  | 900    | Default target for Windows 11 baseline machine |
| High-DPI    | 1920  | 1080   | Full feature visibility, large preview, expanded track lanes |
| Large       | 2560  | 1440   | Simultaneous preview, timeline, and contextual inspector |

### Rationale

- **1024 x 768** is the smallest size where the editor remains operable. The main navigation sidebar can be collapsed, the inspector switches to a drawer, and the timeline toolbar wraps or becomes horizontally scrollable. Below this size the user is warned that the editor requires a larger window.
- **1280 x 800** is the lowest size the team validates for release. It matches a common low-end laptop panel and leaves enough room for the timeline, a 480 px preview, and the track lane list.
- **1440 x 900** is the Windows 11 baseline reference machine resolution and the default target for performance and accessibility testing.
- **1920 x 1080** is the standard 100% DPI target for the primary test fixture set.
- **2560 x 1440** is the high-resolution target used for high-DPI and multi-monitor validation.

## 2. Breakpoints and Layout Behavior

| Breakpoint | Width trigger | Layout change |
| ---------- | ------------- | ------------- |
| `sm`       | 640 px        | Inspector becomes a bottom sheet; transport controls stack vertically. |
| `md`       | 768 px        | Sidebar can be collapsed to icon-only; timeline track headers remain fixed. |
| `lg`       | 1024 px       | Two-column inspector is usable; preview and timeline share the main area. |
| `xl`       | 1280 px       | Full inspector, expanded timeline, and side-by-side preview are visible. |
| `2xl`      | 1536 px       | Large preview, persistent task rail, and multi-track expanded lanes. |

- The breakpoints are derived from the Tailwind defaults used in `apps/desktop/src/styles/index.css` and the responsive classes in `apps/desktop/src/features/editor/**`.
- Minimum supported logical resolution is **1024 x 768**. The editor window can be smaller for other parts of the app (library, settings), but the project workspace warns below this size.

## 3. Reference Screenshots

Reference screenshots must be captured at the supported sizes so later UI changes can be compared for regression. They are stored in `docs/design/editor-screenshots/` and regenerated before each Phase 3/4/9 sign-off.

### Required screenshot set

| Filename                        | Window size | Content                                                       |
| ------------------------------- | ----------- | ------------------------------------------------------------- |
| `editor-1024x768-minimum.png`   | 1024 x 768  | Open editor fixture with collapsed sidebar and compact inspector. |
| `editor-1280x800-default.png`   | 1280 x 800  | Open editor fixture with full timeline and two-column inspector. |
| `editor-1440x900-baseline.png`  | 1440 x 900  | Default baseline layout with expanded track lanes.            |
| `editor-1920x1080-standard.png` | 1920 x 1080 | Full preview, timeline, inspector, and transport.             |
| `editor-2560x1440-large.png`    | 2560 x 1440 | Large workspace with all panels visible.                      |
| `editor-cursor-panel.png`       | 1440 x 900  | Cursor inspector open with a click effect visible in preview. |
| `editor-export-panel.png`       | 1440 x 900  | Export drawer open while editor project remains loaded.       |

### Capture protocol

1. Run `bun run tauri:dev` on the Windows 11 baseline machine.
2. Close all other windows and set the OS display scaling to 100%.
3. Load the editor fixture from `tooling/fixtures/editor-fixtures/project.json` via the generator.
4. For each target size:
   - Resize the main window to the exact dimensions using the Tauri window API or `WM_SIZE`.
   - Wait for the React render to settle (at least 1 second after resize ends).
   - Capture the client area of the window without window chrome.
   - Save the PNG with the filename above.
5. Keep raw screenshots in a temporary directory; commit only the redacted, version-named files to `docs/design/editor-screenshots/`.
6. Record the commit hash, capture date, and display scaling in `docs/benchmarks/editor-phase-0-baseline.md`.

### Windows capture helpers

A PowerShell helper is provided at `tooling/scripts/capture-editor-screenshots.ps1`. It resizes the active recordForge window and captures the client area using `ffmpeg -f gdigrab` once the app is running. The script is manual; it must be started while the editor is open.

```powershell
# Requires ffmpeg in PATH and the app window to be active/focused.
# Set $env:RECORDFORGE_WINDOW_TITLE to match the main window title (default "recordForge").
.\tooling\scripts\capture-editor-screenshots.ps1
```

### Phase 0 note

The screenshots are a Phase 0 deliverable, but the actual PNGs require a running app on the Windows 11 baseline machine. The checklist and protocol above are frozen; capture is tracked in `docs/benchmarks/editor-phase-0-baseline.md`. Phase 0 stores the size definitions and the empty screenshot manifest; Phase 3 performs the manual capture and checks them into `docs/design/editor-screenshots/`.
