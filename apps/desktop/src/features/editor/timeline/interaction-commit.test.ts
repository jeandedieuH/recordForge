import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type recordForgeProject,
  type TextClip,
  type TimelineState,
  defaultCursorSettings,
  textClipSchema,
} from "@recordforge/contracts"
import {
  createEngine,
  createMoveClipCommand,
  createTrimClipCommand,
  findClip,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"

// Timeline gestures run in two steps: a draft state that renders while the
// pointer moves, and exactly one committed command when it is released. A
// commit that silently does nothing leaves the edit in `draftTimeline` only —
// the clip *looks* moved until the next command drops the draft, and then it
// snaps back to its pre-gesture geometry. These tests pin the contract: after a
// release the engine owns the edit, no draft is left behind, and a later
// command cannot undo it.

function canvas(): TimelineState["canvas"] {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#000000",
    padding: 0,
    borderRadius: 0,
    shadow: false,
    cursorSettings: defaultCursorSettings,
  }
}

function titleClip(): TextClip {
  return textClipSchema.parse({
    id: "title-1",
    kind: "text",
    assetId: "title-asset",
    startMs: 1_000,
    durationMs: 4_000,
    sourceInMs: 0,
    sourceOutMs: 4_000,
    x: 100,
    y: 100,
    width: 640,
    height: 220,
    primaryText: "Hello",
  })
}

function timeline(): TimelineState {
  return {
    version: 1,
    id: "timeline",
    name: "Timeline",
    recordingId: "rec-1",
    canvas: canvas(),
    tracks: [
      {
        id: "titles",
        kind: "titles",
        name: "Titles",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [titleClip()],
      },
    ],
    markers: [],
    zoomSegments: [],
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
  }
}

function project(state: TimelineState): recordForgeProject {
  return {
    format: "recordforge.project",
    version: 1,
    id: "project-1",
    name: "Demo",
    recordingId: "rec-1",
    canvas: state.canvas,
    assets: [],
    tracks: state.tracks,
    markers: [],
    zoomSegments: [],
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
    checksum: "",
  } as unknown as recordForgeProject
}

function open(state: TimelineState) {
  useTimelineStore.setState({
    engine: createEngine(state),
    project: project(state),
    draftTimeline: null,
    draftError: null,
    error: null,
    projectRevision: 0,
    autosaveTimeout: null,
  })
}

function expectCommitted(startMs: number, durationMs: number) {
  const state = useTimelineStore.getState()
  const found = findClip(state.engine!.history.present, "title-1")
  expect(found?.clip.startMs).toBe(startMs)
  expect(found?.clip.durationMs).toBe(durationMs)
  // A committed gesture must not leave its preview behind: a lingering draft
  // masks the engine and is discarded by the next command.
  expect(state.draftTimeline).toBeNull()
}

describe("timeline gesture commit", () => {
  beforeEach(() => open(timeline()))

  afterEach(() => {
    // `execute` schedules a 2s autosave; keep it from firing into IPC mocks.
    const { autosaveTimeout } = useTimelineStore.getState()
    if (autosaveTimeout) clearTimeout(autosaveTimeout)
    useTimelineStore.setState({ autosaveTimeout: null })
  })

  it("keeps a moved title after a later selection", () => {
    expect(useTimelineStore.getState().execute(createMoveClipCommand("title-1", 8_000))).toBe(true)
    expectCommitted(8_000, 4_000)

    // The user's next click must not resurrect the old geometry.
    useTimelineStore.getState().setSelection({
      kind: "clip",
      primaryClipId: "title-1",
      clipIds: ["title-1"],
      trackId: "titles",
    })
    expectCommitted(8_000, 4_000)
  })

  it("keeps an extended title when it is moved afterwards", () => {
    expect(useTimelineStore.getState().execute(createTrimClipCommand("title-1", 0, 9_000))).toBe(
      true,
    )
    expectCommitted(1_000, 9_000)

    expect(useTimelineStore.getState().execute(createMoveClipCommand("title-1", 2_000))).toBe(true)
    expectCommitted(2_000, 9_000)
  })

  it("reports a rejected command instead of keeping a phantom edit", () => {
    const locked = timeline()
    locked.tracks[0]!.locked = true
    open(locked)

    expect(useTimelineStore.getState().execute(createMoveClipCommand("title-1", 8_000))).toBe(false)
    expect(useTimelineStore.getState().error).toBeTruthy()

    useTimelineStore.getState().setSelection(null)
    expectCommitted(1_000, 4_000)
  })
})
