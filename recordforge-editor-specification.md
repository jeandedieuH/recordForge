# RecordForge Editor Specification

## Document status

- **Product area:** recordForge desktop editor
- **Document type:** Functional and technical specification
- **Primary audience:** Product owner, coding agents, UI engineers, Rust/Tauri engineers, media-pipeline engineers, QA
- **Scope:** Editor experience for recorded screen content, local-first workflows, and practical video polishing
- **Out of scope:** Full nonlinear-editor parity with DaVinci Resolve or Premiere Pro

## Overview

recordForge Editor is a modern, task-oriented screen-video editor designed for tutorials, demos, bug reports, onboarding videos, educational content, and internal communication. The editor is optimized for the work users actually want to do after recording: remove mistakes, improve clarity, guide attention, style the frame, improve audio, add captions, redact sensitive information, and export quickly.

The editor must feel significantly more capable than basic trim-only tools, while remaining much simpler than a general-purpose nonlinear editor. The intended product category is closer to the practical editing model seen in Screen Studio and Camtasia, where cursor effects, zoom, pan, captions, backgrounds, masking, and quick export matter more than deep cinematic post-production workflows.

## Goals

### Primary goals

- Provide a fast, responsive editing workflow for recorded screen content.
- Make common edits easy without requiring professional video-editing knowledge.
- Support modern screen-recording polish features such as smart zoom, cursor effects, webcam layout, captions, masking, and export presets.
- Preserve a local-first architecture where recordings, projects, proxies, renders, and exports work offline.
- Keep the editor performant on low-end Windows machines through proxy media and background render jobs.

### Non-goals

- Unlimited arbitrary track compositing.
- Full VFX, color-grading, or node-based compositing.
- Pro-audio mixing and buses.
- Motion-graphics authoring comparable to After Effects.
- Collaborative multi-user editing.
- A plugin ecosystem in the initial product versions.

## Product positioning

recordForge Editor should be positioned as a **screen-story editor** rather than a generic NLE. The product should help users transform raw screen recordings into clear, polished, professional communication artifacts with minimal friction.

### Editor value proposition

| User need | Editor response |
|---|---|
| Remove mistakes quickly | Trim, split, delete, ripple delete, markers |
| Make tiny UI readable | Smart zoom, spotlight, cursor scaling, click emphasis |
| Make recordings look professional | Backgrounds, padding, rounded corners, webcam layouts, shadows |
| Improve comprehension | Captions, chapter markers, annotations |
| Protect sensitive data | Blur and redact masks |
| Improve narration quality | Volume, fades, normalization, voice emphasis |
| Export for different destinations | Presets, aspect-ratio reframing, upload-ready outputs |

## Design principles

### 1. Task-oriented over tool-oriented

The editor should present controls in terms of user intent: **Trim**, **Focus**, **Cursor**, **Captions**, **Layout**, **Audio**, **Mask**, **Export**. It should avoid the feel of a dense technical workstation filled with unlabeled tool panels.

### 2. Powerful defaults with optional refinement

The editor should provide a strong auto-polish path, then allow manual refinement. Camtasia SmartFocus and Screen Studio-style auto zoom are useful references here: the system can generate focus edits from cursor and click behavior, then allow users to tweak them.

### 3. Non-destructive by default

All edits must be stored as project metadata, not burned into originals. This applies to zoom, cursor effects, captions, masks, layout, and audio adjustments.

### 4. Local-first and export-driven

Preview uses proxies and lightweight overlays; final output is rendered from original media and project metadata. The preview and export paths must remain conceptually aligned.

### 5. Fast enough for everyday work

The editor should prioritize responsiveness over maximal feature breadth. A 60-minute screen recording should remain practically editable through virtualization, proxy playback, background jobs, and constrained effect complexity.

## User profiles

| User type | Typical task | Editing expectations |
|---|---|---|
| Developer | Bug report or feature walkthrough | Trim mistakes, zoom to UI, blur secrets, export fast |
| Educator | Tutorial lesson | Cursor polish, captions, chapters, webcam PiP, good audio |
| Product manager | Feature explanation | Quick cuts, markers, captions, branding |
| Support engineer | Troubleshooting guide | Zoom, highlight actions, redact data, concise export |
| Content creator | Product demo or lesson | Professional framing, cursor polish, polished export presets |

## Supported project types

The editor must support these common recordForge projects:

- Full-screen recording with optional webcam and microphone.
- Window recording with optional webcam and microphone.
- Region recording.
- Imported screen recordings from external tools, with reduced feature depth when cursor metadata is unavailable.
- Short-form vertical and square reformats of recorded screen content.

## Core workflow

### Recommended editing flow

1. Open a completed recording or project.
2. Load proxy media, waveform data, thumbnails, and metadata.
3. Review timeline and remove mistakes.
4. Apply or review smart zoom suggestions.
5. Adjust cursor effects.
6. Position webcam and canvas layout.
7. Add captions and chapter markers.
8. Mask sensitive information if needed.
9. Review audio and export preset.
10. Render final output locally.
11. Optionally upload the finished export to a configured destination.

This workflow is consistent with modern screen-recording editors that combine core cutting with cursor, zoom, layout, masking, captions, and export polish.

## Feature tiers

### Tier 1 — Editor MVP

These features define the first version of the practical editor.

| Area | Required MVP capability |
|---|---|
| Timeline | Trim, split, delete, ripple delete, move clips, undo/redo |
| Playback | Proxy playback, play/pause, seek, timeline zoom, snapping |
| Screen clip | Basic crop and transform |
| Webcam | PiP layout, resize, reposition, show/hide |
| Cursor | Size scaling, click highlight, basic spotlight |
| Zoom | Manual zoom segments |
| Audio | Separate mic/system gain, mute, fades |
| Captions | Import SRT/VTT, basic styling |
| Layout | Background color, padding, corner radius, shadow |
| Masking | Static blur/redaction rectangles |
| Export | MP4 export with presets |

### Tier 2 — Modern Editor

These features define the product’s modern differentiation.

| Area | Required modern capability |
|---|---|
| Zoom | Smart zoom generation from cursor/click behavior |
| Cursor | Smoothing, spotlight, preset system, stronger click effects |
| Captions | Better styling, transcript-linked navigation, later generation hooks |
| Layout | Aspect-ratio reframing and preset scenes |
| Audio | Voice emphasis, normalization, ducking presets |
| Masking | Better per-segment masks and sensitive-area workflow |
| Export | Vertical/social presets, selection export, caption burn-in |
| Workflow | Regeneration, lockable auto effects, reusable presets |

### Tier 3 — Delight and intelligence

These features are valuable after the editing foundation is stable.

- Silence suggestions
- Smart chapter suggestions
- Cursor motion blur
- Kinetic cursor
- Lens/magnify effects
- Smart follow-cursor mode
- Keyboard shortcut overlay track
- Reusable branded scene presets
- Freeze frame with annotation
- Guided cleanup suggestions

## Information architecture

### Editor layout

```text
┌──────────────────────────────────────────────────────────────┐
│ Top bar: project, undo/redo, save state, export, upload     │
├───────────────┬───────────────────────────────┬──────────────┤
│ Left sidebar  │ Preview canvas                │ Right panel  │
│ Media         │ Proxy video + overlays        │ Inspector    │
│ Captions      │                               │ Contextual   │
│ Effects       │                               │ settings     │
│ Layouts       │                               │              │
│ Exports       │                               │              │
├───────────────┴───────────────────────────────┴──────────────┤
│ Timeline: markers / zoom / screen / webcam / audio / caps   │
└──────────────────────────────────────────────────────────────┘
```

### Top bar

Required controls:

- Project name
- Save state indicator
- Undo / redo
- Quick export
- Upload destination shortcut
- Playback status shortcut actions
- Diagnostics / recovery warning indicator when relevant

### Left sidebar

Task-oriented tabs:

- **Media** — project assets, imports, generated derivatives
- **Captions** — captions track, transcript, import, style presets
- **Effects** — cursor presets, zoom generation, masks, annotations
- **Layouts** — aspect ratio, background, webcam scenes, templates
- **Exports** — export presets, queue, recent renders

### Center preview

The preview area must support:

- Proxy-based video playback
- Canvas framing
- Zoom preview
- Cursor overlay preview
- Webcam overlay preview
- Caption preview
- Mask preview
- Selection and direct manipulation for zoom targets, webcam frame, and masks

### Right inspector

Contextual controls only. The inspector must change based on selection.

| Selection | Inspector controls |
|---|---|
| Screen clip | Trim, crop, transform, speed, visibility |
| Webcam clip | Resize, crop, shape, border, shadow, audio link |
| Zoom segment | Scale, timing, easing, target region, mode |
| Cursor effect | Style, size, smoothing, click effects, spotlight |
| Caption clip | Text styling, placement, timing |
| Mask | Shape, blur/pixelation, timing, position |
| Canvas | Background, padding, radius, shadow, aspect ratio |
| Audio clip | Gain, mute, fade, presets |

## Timeline specification

### Track model

recordForge should use a constrained but feature-rich track model.

| Track | Purpose |
|---|---|
| Markers | Chapters, notes, click-derived suggestions |
| Zoom | Auto/manual zoom segments |
| Cursor | Cursor effect ranges and presets |
| Screen | Main screen-recording clips |
| Webcam | Camera clips and layouts |
| Microphone | Narration track |
| System audio | App/system audio |
| Music | Optional background music |
| Captions | Subtitle and text ranges |
| Masks | Redaction and blur regions |
| Annotations | Callouts, arrows, shapes, text |

### Timeline capabilities

- Horizontal zoom
- Virtualized rendering for clips and markers
- Snapping to clip edges, playhead, markers, click events, caption boundaries
- Track mute/lock for applicable tracks
- Collapsible tracks
- Track height presets
- Keyboard shortcuts for common edit operations
- Context menu actions per clip/segment

### Timeline performance requirements

- Timeline must remain usable with at least a 60-minute recording.
- Virtualization is required for thumbnails, caption segments, markers, and clip rendering.
- Waveform and thumbnail data must be precomputed.
- Dragging and resizing interactions must avoid unnecessary React rerenders.

## Core editing features

### 1. Core cut editing

The foundation of the editor must support:

- Trim clip start and end
- Split clip at playhead
- Delete clip
- Delete selected range
- Ripple delete range
- Move clip in timeline
- Duplicate clip where appropriate
- Multi-select clips
- Undo/redo all timeline actions

These workflows align with the practical screen-recording editing model seen in Camtasia, where splitting, ripple delete, zoom placement, and track edits are common but still approachable.

### 2. Smart zoom

Smart zoom is one of recordForge’s most important differentiation features.

#### Objectives

- Improve readability of small UI elements.
- Direct viewer attention to clicks, fields, menus, and interaction hotspots.
- Save users from manually keyframing every zoom.
- Keep zoom editable and non-destructive.

#### Capabilities

- Automatic zoom generation from cursor and click metadata
- Manual zoom segments
- Follow-cursor mode for selected segments
- Dwell-based zoom suggestions
- Lockable auto-generated zooms
- Regeneration without overwriting locked/manual segments
- Zoom presets: subtle, product demo, cinematic, manual only
- Safe-edge clamping and aspect-ratio-aware targeting

Screen Studio-style auto zoom and Camtasia SmartFocus demonstrate the usefulness of automatic zoom generation based on user activity, with manual edits layered on top.

#### Zoom segment model

```ts
type ZoomSegment = {
  id: string;
  startMs: number;
  endMs: number;
  scale: number;
  mode: "auto" | "manual" | "follow-cursor";
  easing: "smooth" | "cinematic" | "snappy" | "linear";
  locked: boolean;
  source: "click" | "dwell" | "manual" | "follow";
  target: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};
```

### 3. Cursor effects

Cursor polish must be a first-class editing feature rather than a minor recording setting.

#### Capabilities

- Replace native cursor with custom cursor during preview/export
- Cursor scale control
- Cursor smoothing
- Left/right click rings
- Spotlight/highlight
- Magnify cursor preset later
- Idle fade/hide behavior
- Per-range or per-clip cursor presets
- Export-time cursor composition from cursor metadata

Cursor smoothing, highlight, spotlight, magnify, and click effects are proven needs in screen-recording editing workflows.

#### Cursor effect model

```ts
type CursorEffect = {
  enabled: boolean;
  presetId: string;
  sizePx: number;
  opacity: number;
  smoothing: {
    enabled: boolean;
    preset: "natural" | "smooth" | "fluid" | "precise";
  };
  highlight: {
    enabled: boolean;
    color: string;
    radiusPx: number;
    opacity: number;
  };
  clicks: {
    enabled: boolean;
    leftColor: string;
    rightColor: string;
    durationMs: number;
    radiusPx: number;
  };
};
```

### 4. Captions and transcript tools

Captions should be treated as a core communication feature.

#### MVP capabilities

- Import SRT and VTT
- Captions track
- Edit caption text and timing
- Style presets
- Basic position and safe-area handling
- Burn-in captions on export or export sidecar captions

#### Later capabilities

- Generated captions
- Transcript panel with search and playhead sync
- Word-level timing when available
- Phrase grouping presets
- Chapter suggestion from transcript or markers

Screen Studio includes caption workflows as part of its editing experience, reinforcing that captions belong inside the core editor rather than as a separate tool.

### 5. Webcam layout and composition

#### Required capabilities

- Webcam as separate media asset and track
- PiP presets: corner box, circle, portrait card, side panel
- Resize, reposition, crop, mirror, mute, hide/show range
- Border, background plate, corner rounding, shadow
- Full-camera emphasis segments later

Camtasia-style webcam resizing and composition support a practical tutorial workflow without requiring a full compositing system.

### 6. Canvas styling and reframing

#### Required capabilities

- Background color, gradient, or blurred plate
- Padding around captured content
- Rounded corners
- Shadow around capture frame
- Output aspect-ratio presets: 16:9, 1:1, 9:16
- Reframe screen and webcam content inside target canvas
- Branded scene/layout presets later

Screen Studio’s emphasis on background and layout adjustments shows that canvas styling is a core differentiator in polished screen-video output.

### 7. Audio tools

recordForge should not become a DAW, but it must provide practical narration and screen-audio control.

#### Required capabilities

- Separate microphone and system-audio tracks
- Gain/volume control
- Mute/solo
- Fade in/out
- Normalization preset
- Voice emphasis preset later
- Optional background music track
- Ducking preset later

Camtasia includes voice-oriented audio effects such as fades, compression/emphasis, and music balancing, which align with recordForge’s practical use cases.

### 8. Sensitive-information masking

#### Required capabilities

- Rectangle blur mask
- Rectangle pixelation/redaction mask
- Per-range timing
- Drag and resize in preview
- Presets for common sensitive areas later

Screen Studio includes masking sensitive details in the editor workflow, underscoring the importance of this capability for demos and internal recordings.

### 9. Annotations and emphasis

Annotations should remain lightweight and instructional rather than motion-graphics heavy.

#### Required capabilities

- Text callouts
- Arrows
- Outline/box highlight
- Spotlight region
- Numbered steps
- Freeze frame with annotation later
- Keystroke overlay later

### 10. Export workflow

The editor must be tightly integrated with export.

#### Required capabilities

- Export entire project
- Export selected range
- MP4 presets: fast share, balanced, high quality
- Vertical/social presets
- GIF snippet later
- Burn captions or export sidecar files
- Queue multiple exports later
- Open file location after completion
- Upload after export to configured storage destination

## Feature matrix

| Feature | MVP | Modern | Later |
|---|---|---|---|
| Trim / split / ripple delete | Yes | Yes | Yes |
| Undo / redo | Yes | Yes | Yes |
| Manual zoom | Yes | Yes | Yes |
| Smart zoom | No | Yes | Yes |
| Cursor scale / click rings | Yes | Yes | Yes |
| Cursor smoothing / presets | No | Yes | Yes |
| Webcam PiP | Yes | Yes | Yes |
| Captions import | Yes | Yes | Yes |
| Generated captions | No | No | Yes |
| Blur / redact masks | Yes | Yes | Yes |
| Background / padding / radius | Yes | Yes | Yes |
| Voice emphasis presets | No | Yes | Yes |
| Brand templates | No | No | Yes |
| Keystroke overlays | No | No | Yes |
| Smart chapter suggestions | No | No | Yes |

## Data model

### Project model

```ts
type recordForgeProject = {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  canvas: CanvasSettings;
  assets: MediaAsset[];
  tracks: TimelineTrack[];
  markers: Marker[];
  exportSettings: ExportSettings;
  effects: {
    zoom: ZoomSettings;
    cursor: CursorSettings;
  };
};
```

### Track model

```ts
type TimelineTrack = {
  id: string;
  kind:
    | "markers"
    | "zoom"
    | "cursor"
    | "screen"
    | "camera"
    | "mic"
    | "system-audio"
    | "music"
    | "captions"
    | "masks"
    | "annotations";
  name: string;
  muted: boolean;
  locked: boolean;
  clips: TimelineClip[];
};
```

### Clip model

```ts
type TimelineClip = {
  id: string;
  assetId?: string;
  startMs: number;
  durationMs: number;
  sourceInMs?: number;
  sourceOutMs?: number;
  speed?: number;
  transform?: ClipTransform;
  effects?: ClipEffect[];
  metadata?: Record<string, unknown>;
};
```

## Command model

All editing actions must be represented through explicit commands so they are testable, undoable, and suitable for agent implementation.

```ts
type TimelineCommand =
  | { type: "clip.trim"; clipId: string; edge: "start" | "end"; timeMs: number }
  | { type: "clip.split"; clipId: string; timeMs: number }
  | { type: "clip.move"; clipId: string; trackId: string; startMs: number }
  | { type: "range.delete"; startMs: number; endMs: number; ripple: boolean }
  | { type: "clip.volume"; clipId: string; gainDb: number }
  | { type: "marker.add"; timeMs: number; label: string }
  | { type: "zoom.add"; segment: ZoomSegment }
  | { type: "zoom.update"; segmentId: string; patch: Partial<ZoomSegment> }
  | { type: "zoom.delete"; segmentId: string }
  | { type: "cursor.applyPreset"; rangeId: string; presetId: string }
  | { type: "caption.update"; clipId: string; text: string }
  | { type: "mask.add"; mask: MaskSegment }
  | { type: "canvas.update"; settings: Partial<CanvasSettings> };
```

## Interaction patterns

### Direct manipulation

The preview must allow direct manipulation for:

- Zoom target rectangle
- Webcam frame position and size
- Mask position and size
- Caption placement within safe areas

### Keyboard shortcuts

Required editing shortcuts:

| Action | Shortcut |
|---|---|
| Play/pause | Space |
| Split at playhead | S |
| Delete selection | Delete / Backspace |
| Ripple delete | Shift + Delete |
| Undo | Ctrl + Z |
| Redo | Ctrl + Shift + Z |
| Zoom timeline in/out | `+` / `-` |
| Add marker | M |
| Next/previous frame step | Arrow keys |
| J/K/L playback | J / K / L |

### Selection model

- Single select by click
- Multi-select by modifier key
- Drag range selection in timeline
- Inspector always reflects primary selection
- Hover states should expose affordances without cluttering the interface

## Rendering model

### Preview path

- Use proxy video for playback.
- Render cursor, zoom, captions, masks, and overlays on top of proxy media.
- Use imperative rendering for high-frequency overlays when needed.
- Keep preview effect fidelity close enough to export to preserve user trust.

### Export path

- Render from original media and project metadata.
- Zoom is applied by crop/scale/pad operations.
- Cursor is composited from cursor metadata and effect settings.
- Webcam, captions, masks, and canvas effects are applied in the final render graph.
- Output is validated before the export is marked successful.

## Performance specification

### Baseline expectations

- The editor should open a 60-minute project without freezing the UI.
- Proxy playback should remain smooth at normal speed on the baseline low-end target machine.
- Timeline interactions must remain responsive with virtualization enabled.
- Export jobs must run in the background and be cancellable.

### Performance strategies

- Proxy-based preview
- Precomputed waveform peaks
- Precomputed thumbnails
- Virtualized timeline rendering
- Off-main-thread or imperative overlay rendering where needed
- Deferred heavy analysis jobs
- Controlled effect complexity in preview mode

## Error handling and recovery

### Required behaviors

- Missing derivative media should be regeneratable.
- Missing originals should produce actionable errors.
- Incompatible imported media should degrade gracefully.
- Failed export should preserve render logs and partial diagnostics.
- Recovery state should never silently discard project edits.

## Accessibility specification

The editor must support:

- Keyboard-accessible transport and editing controls
- Visible focus states
- Sufficient color contrast
- Readable caption presets
- High-contrast cursor preset later
- Screen-reader-friendly control labeling for major UI functions

## Test plan

### Unit tests

- Timeline command reducers
- Undo/redo behavior
- Snap logic
- Ripple delete rules
- Zoom segment generation and clamping
- Cursor effect serialization
- Caption timing edits
- Canvas transform calculations
- Export plan generation

### Integration tests

- Trim and export match
- Smart zoom preview/export parity
- Cursor effect preview/export parity
- Webcam layout persistence
- Caption burn-in correctness
- Mask placement correctness
- Aspect-ratio reframing correctness
- Audio gain/fade correctness

### Manual QA scenarios

- 5-minute project with core edits
- 30-minute tutorial with webcam and captions
- 60-minute project with many markers and zoom segments
- Vertical export for social media
- Project containing blur masks over sensitive UI
- Import of an external MP4 without cursor metadata

## Agent implementation guidance

The editor should be implemented through bounded, testable milestones.

### Suggested milestone order

1. Editor shell layout and project loading
2. Timeline engine and undo/redo
3. Proxy playback and waveform/thumbnails
4. Core trim/split/delete/ripple editing
5. Webcam PiP and canvas layout
6. Manual zoom segments
7. Cursor effect preview and export path
8. Captions import and editing
9. Mask/redaction workflow
10. Smart zoom generation
11. Audio polish presets
12. Export integration and upload handoff

### Engineering boundaries

- `editor-core` owns timeline commands and undo/redo.
- `zoom-core` owns auto/manual zoom logic.
- `cursor-core` owns cursor metadata interpretation and visual behavior.
- `render-core` owns export plan generation.
- React owns presentation and interaction.
- Rust/Tauri owns media jobs, filesystem access, and final render orchestration.

## Definition of done

The editor specification is satisfied for the first modern release when a user can:

1. Open a screen recording project quickly.
2. Trim, split, delete, and ripple-delete mistakes.
3. Review and edit zoom behavior.
4. Apply cursor enhancements that improve clarity.
5. Position and style a webcam overlay.
6. Add or import captions.
7. Add masks to hide sensitive information.
8. Style the canvas with backgrounds, padding, radius, and shadows.
9. Adjust audio to produce a clearer narration.
10. Export a final local video in common preset formats.

## Product standard

recordForge Editor must remain intentionally narrower than DaVinci Resolve or Premiere Pro, but it should feel modern, complete, and highly capable for its domain. The success benchmark is not whether it can edit every kind of video; it is whether a user making tutorials, demos, bug reports, and screen-based lessons can finish polished work faster than they could in a general-purpose editor.
