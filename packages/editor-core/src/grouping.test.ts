import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState, type TimelineTrack } from "@recordforge/domain"
import {
  clipsInTimelineOrder,
  createDuplicateClipCommand,
  createDuplicateClipsCommand,
  createEngine,
  createGroupClipsCommand,
  createMoveClipCommand,
  createSplitClipCommand,
  createUngroupClipsCommand,
  executeCommand,
  expandClipIdsThroughGroups,
  findClip,
  getClipGroupId,
  getGroupMemberIds,
  undoCommand,
} from "./index"

function makeTrack(id: string, kind: TimelineTrack["kind"], clipIds: string[]): TimelineTrack {
  return {
    id,
    kind,
    name: id,
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: clipIds.map((id, index) => ({
      id,
      kind: "screen" as const,
      assetId: "rec-1",
      startMs: index * 10_000,
      durationMs: 4_000,
      sourceInMs: 0,
      sourceOutMs: 4_000,
      speed: 1,
    })),
  }
}

// Track layout:
//   screen  [a1 0-4s] [a2 10-14s]        (a1+a2 share group "g1" later)
//   audio   [b1 0-4s] [b2 10-14s]        (b1 grouped with a1 via "g1", b2 loose)
//   titles  [t1 5-9s]
function makeState(): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Grouping test",
    recordingId: "rec-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
      makeTrack("screen", "screen", ["a1", "a2"]),
      makeTrack("audio", "audio", ["b1", "b2"]),
      makeTrack("titles", "titles", ["t1"]),
    ],
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function withGroup(state: TimelineState, groupId: string, clipIds: string[]): TimelineState {
  return {
    ...state,
    tracks: state.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => (clipIds.includes(clip.id) ? { ...clip, groupId } : clip)),
    })),
  }
}

describe("clip grouping helpers", () => {
  it("lists group members in timeline order", () => {
    const state = withGroup(makeState(), "g1", ["a2", "b2"])
    expect(getGroupMemberIds(state, "g1")).toEqual(["a2", "b2"])
  })

  it("expands clip ids to complete groups", () => {
    const state = withGroup(makeState(), "g1", ["a1", "b1"])
    // Selecting one member pulls in its siblings across tracks.
    expect(expandClipIdsThroughGroups(state, ["a1"])).toEqual(["a1", "b1"])
    expect(expandClipIdsThroughGroups(state, ["b1", "b2"])).toEqual(["a1", "b1", "b2"])
    // Ungrouped clips pass through untouched.
    expect(expandClipIdsThroughGroups(state, ["t1"])).toEqual(["t1"])
    // Unknown ids are dropped, not kept.
    expect(expandClipIdsThroughGroups(state, ["missing"])).toEqual([])
  })

  it("exposes clip membership and flat ordering", () => {
    const state = withGroup(makeState(), "g1", ["a1", "b1"])
    expect(getClipGroupId(findClip(state, "a1")?.clip)).toBe("g1")
    expect(getClipGroupId(findClip(state, "b2")?.clip)).toBeUndefined()
    expect(clipsInTimelineOrder(state).map(({ clip }) => clip.id)).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
      "t1",
    ])
  })
})

describe("group / ungroup commands", () => {
  it("assigns one groupId to every listed clip", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(engine, createGroupClipsCommand(["a1", "b1"], { groupId: "g1" }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    expect(getClipGroupId(findClip(state, "a1")?.clip)).toBe("g1")
    expect(getClipGroupId(findClip(state, "b1")?.clip)).toBe("g1")
    expect(getClipGroupId(findClip(state, "a2")?.clip)).toBeUndefined()
  })

  it("rejects grouping a single clip or a locked track", () => {
    const engine = createEngine(makeState())
    expect(executeCommand(engine, createGroupClipsCommand(["a1"])).ok).toBe(false)

    const locked = makeState()
    locked.tracks[1].locked = true
    const lockedEngine = createEngine(locked)
    const result = executeCommand(lockedEngine, createGroupClipsCommand(["a1", "b1"]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("track_locked")
  })

  it("ungroups only the listed clips and undoes cleanly", () => {
    const engine = createEngine(withGroup(makeState(), "g1", ["a1", "b1", "a2"]))
    const result = executeCommand(engine, createUngroupClipsCommand(["b1"]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    expect(getClipGroupId(findClip(state, "b1")?.clip)).toBeUndefined()
    // Siblings keep their membership.
    expect(getClipGroupId(findClip(state, "a1")?.clip)).toBe("g1")

    const undone = undoCommand(result.value)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(getClipGroupId(findClip(undone.value.history.present, "b1")?.clip)).toBe("g1")
  })

  it("rejects ungrouping clips that are not grouped", () => {
    const engine = createEngine(makeState())
    expect(executeCommand(engine, createUngroupClipsCommand(["a1"])).ok).toBe(false)
  })

  it("regrouping migrates a member to the new group", () => {
    const engine = createEngine(withGroup(makeState(), "g1", ["a1", "b1"]))
    const result = executeCommand(engine, createGroupClipsCommand(["a1", "b2"], { groupId: "g2" }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    expect(getClipGroupId(findClip(state, "a1")?.clip)).toBe("g2")
    expect(getClipGroupId(findClip(state, "b2")?.clip)).toBe("g2")
    // b1 stays behind in the original group.
    expect(getClipGroupId(findClip(state, "b1")?.clip)).toBe("g1")
  })
})

describe("group semantics in other commands", () => {
  it("keeps groupId on both halves of a split clip", () => {
    const engine = createEngine(withGroup(makeState(), "g1", ["a1", "b1"]))
    const result = executeCommand(
      engine,
      createSplitClipCommand("a1", 2_000, {
        leftClipId: "a1-left",
        rightClipId: "a1-right",
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    expect(getClipGroupId(findClip(state, "a1-left")?.clip)).toBe("g1")
    expect(getClipGroupId(findClip(state, "a1-right")?.clip)).toBe("g1")
  })

  it("remaps duplicated group members to a fresh shared groupId", () => {
    const engine = createEngine(withGroup(makeState(), "g1", ["a1", "b1"]))
    const result = executeCommand(engine, createDuplicateClipsCommand(["a1", "b1"]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    const dupA = state.tracks[0].clips.find((clip) => clip.id.startsWith("a1:dup"))
    const dupB = state.tracks[1].clips.find((clip) => clip.id.startsWith("b1:dup"))
    expect(dupA && dupB).toBeTruthy()
    const mapped = getClipGroupId(dupA!)
    expect(mapped).toBeDefined()
    expect(mapped).not.toBe("g1")
    expect(getClipGroupId(dupB!)).toBe(mapped)
    // Originals are untouched.
    expect(getClipGroupId(findClip(state, "a1")?.clip)).toBe("g1")
  })

  it("strips groupId from a lone duplicate", () => {
    const engine = createEngine(withGroup(makeState(), "g1", ["a1", "b1"]))
    const result = executeCommand(engine, createDuplicateClipCommand("a1"))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    const dup = state.tracks[0].clips.find((clip) => clip.id.startsWith("a1:dup"))
    expect(dup).toBeTruthy()
    expect(getClipGroupId(dup)).toBeUndefined()
  })

  it("moves a single clip independently despite its group", () => {
    const engine = createEngine(withGroup(makeState(), "g1", ["a1", "b1"]))
    const result = executeCommand(engine, createMoveClipCommand("a1", 20_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    expect(findClip(state, "a1")?.clip.startMs).toBe(20_000)
    expect(findClip(state, "b1")?.clip.startMs).toBe(0)
  })
})
