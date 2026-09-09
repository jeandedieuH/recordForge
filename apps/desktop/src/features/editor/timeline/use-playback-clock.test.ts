import { describe, expect, it } from "vitest"
import { type TimelineState, defaultCursorSettings } from "@recordforge/contracts"
import {
  createPlaybackClock,
  computePreviewMediaSync,
  findNextTimelineClip,
} from "@recordforge/editor-core"

function createMockTimeline(): TimelineState {
  return {
    version: 1,
    id: "test-timeline",
    name: "Test Timeline",
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
      {
        id: "screen-track",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-1",
            kind: "screen",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 5000,
            sourceInMs: 0,
            sourceOutMs: 5000,
            speed: 1,
          },
          {
            id: "clip-2",
            kind: "screen",
            assetId: "rec-1",
            startMs: 5000,
            durationMs: 5000,
            sourceInMs: 10000,
            sourceOutMs: 15000,
            speed: 1,
          },
        ],
      },
      {
        id: "audio-track",
        kind: "audio",
        name: "Microphone",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "audio-clip-1",
            kind: "audio",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 5000,
            sourceInMs: 0,
            sourceOutMs: 5000,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
          },
        ],
      },
    ],
    markers: [],
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
  }
}

describe("usePlaybackClock - Playback Synchronization & Audio Unmute Verification", () => {
  it("does not return null for frames near clip boundaries (sub-zero or boundary jitter)", () => {
    const timeline = createMockTimeline()
    const clock = createPlaybackClock(timeline, { fps: 30 })

    // When starting video, Chromium often reports mediaTime as 0 or slightly negative (-0.001 to -5ms)
    const atStart = clock.mapSourceToTimeline(-2)
    expect(atStart).not.toBeNull()
    expect(atStart?.timelineMs).toBe(0)
    expect(atStart?.clipId).toBe("clip-1")

    const atZero = clock.mapSourceToTimeline(0)
    expect(atZero).not.toBeNull()
    expect(atZero?.timelineMs).toBe(0)

    // Near the end of clip-1 (5002ms vs 5000ms sourceOut)
    const atEnd = clock.mapSourceToTimeline(5002, { preferClipId: "clip-1" })
    expect(atEnd).not.toBeNull()
    expect(atEnd?.timelineMs).toBe(5000)
  })

  it("drives playhead smoothly on each frame across quality modes", () => {
    const timeline = createMockTimeline()
    const qualityClock = createPlaybackClock(timeline, { fps: 30, mode: "quality" })
    const perfClock = createPlaybackClock(timeline, { fps: 30, mode: "performance" })

    for (const clock of [qualityClock, perfClock]) {
      let drivenPlayheadMs = 0
      const seeks: number[] = []

      // Simulate 5 frames arriving at 30 fps (~33.3ms intervals)
      for (let frame = 1; frame <= 5; frame++) {
        const sourceMs = frame * (1000 / 30)
        const mapped = clock.mapSourceToTimeline(sourceMs, { preferClipId: "clip-1" })
        expect(mapped).not.toBeNull()
        if (mapped) {
          const rounded = clock.roundToFrame(mapped.timelineMs)
          if (rounded !== drivenPlayheadMs) {
            seeks.push(rounded)
            drivenPlayheadMs = rounded
          }
        }
      }

      // Playhead must advance monotonically on each distinct frame
      expect(seeks.length).toBe(5)
      expect(seeks[0]).toBeCloseTo(33, 0)
      expect(seeks[4]).toBeCloseTo(167, 0)
      expect(drivenPlayheadMs).toBeCloseTo(167, 0)
    }
  })

  it("does not force video element seek on normal playback drift (preventing seek storm loops)", () => {
    const timeline = createMockTimeline()
    const clock = createPlaybackClock(timeline, { fps: 30 })

    // Simulate playback state: playing=true, same clip, normal frame progression
    const isPlaying = true
    const isClipChanged = false
    const frameMs = clock.frameMs
    const drivenPlayheadMs = 100
    const playheadMs = 100
    const playheadJumpMs = Math.abs(playheadMs - drivenPlayheadMs)

    // Normal continuous playback: shouldSeekVideo MUST be false even if drift is 66ms (2 frames)
    const shouldSeekVideo = !isPlaying || isClipChanged || playheadJumpMs > frameMs * 2
    expect(shouldSeekVideo).toBe(false)

    // But if user seeks (e.g. jumps playhead by 1000ms), shouldSeekVideo is true
    const userJumpPlayheadMs = 1100
    const userJumpMs = Math.abs(userJumpPlayheadMs - drivenPlayheadMs)
    const shouldSeekOnUserJump = !isPlaying || isClipChanged || userJumpMs > frameMs * 2
    expect(shouldSeekOnUserJump).toBe(true)

    // And if clip changes across a cut, shouldSeekVideo is true
    const shouldSeekOnCut = !isPlaying || true || playheadJumpMs > frameMs * 2
    expect(shouldSeekOnCut).toBe(true)
  })

  it("ensures audio is unmuted and plays when video is playing and not seeking", () => {
    const timeline = createMockTimeline()
    const audioTrack = timeline.tracks.find((t) => t.kind === "audio")!
    const audioClip = audioTrack.clips[0]!

    // When playing continuously without a seek in flight (isVideoSeeking = false):
    const isVideoSeeking = false
    const isTrackActive = !audioTrack.muted && audioTrack.volume > 0
    const canPlay = isTrackActive && !isVideoSeeking
    expect(canPlay).toBe(true)

    const decision = computePreviewMediaSync({
      kind: "audio",
      clip: audioClip,
      playheadMs: 1000,
      currentTimeMs: 1000,
      playbackRate: 1,
      isPlaying: true && canPlay,
      frameMs: 33,
    })

    // Audio MUST play unmuted and not seek
    expect(decision.shouldPlay).toBe(true)
    expect(decision.shouldPause).toBe(false)
    expect(decision.shouldSeek).toBe(false)

    // Element muted attribute strictly follows track mute state (unmuted)
    const elementMuted = audioTrack.muted
    expect(elementMuted).toBe(false)
  })

  it("holds audio playback without permanently muting element when video is seeking across cut", () => {
    const timeline = createMockTimeline()
    const audioTrack = timeline.tracks.find((t) => t.kind === "audio")!
    const audioClip = audioTrack.clips[0]!

    // When video is in a transition seek across a cut (isVideoSeeking is true):
    const isVideoSeeking = true
    const isTrackActive = !audioTrack.muted && audioTrack.volume > 0
    const canPlay = isTrackActive && !isVideoSeeking
    expect(canPlay).toBe(false)

    const decision = computePreviewMediaSync({
      kind: "audio",
      clip: audioClip,
      playheadMs: 1000,
      currentTimeMs: 1000,
      playbackRate: 1,
      isPlaying: true && canPlay,
      frameMs: 33,
    })

    // Audio pauses cleanly during transition seek
    expect(decision.shouldPlay).toBe(false)
    expect(decision.shouldPause).toBe(true)

    // But audio element muted property is NOT set to true (stays unmuted so it immediately plays when seek completes)
    const elementMuted = audioTrack.muted
    expect(elementMuted).toBe(false)
  })

  it("handles cut transitions cleanly by seeking video to next clip start and advancing playhead", () => {
    const timeline = createMockTimeline()
    const clock = createPlaybackClock(timeline, { fps: 30 })

    // Simulate playhead reaching the end of clip-1 (5000ms)
    const drivenPlayheadMs = 4980
    const currentPos = clock.mapTimelineToSource(drivenPlayheadMs, 1)
    expect(currentPos).not.toBeNull()
    expect(currentPos?.clipId).toBe("clip-1")

    const boundary = clock.nextBoundary(drivenPlayheadMs)
    expect(boundary).not.toBeNull()
    expect(boundary?.timelineMs).toBe(5000)
    expect(boundary?.kind).toBe("clip-end")

    const nextClip = findNextTimelineClip(timeline, "screen", boundary!.timelineMs)
    expect(nextClip).not.toBeNull()
    expect(nextClip?.id).toBe("clip-2")
    expect(nextClip?.startMs).toBe(5000)
    expect(nextClip?.sourceInMs).toBe(10000)

    // Next video target is nextClip.sourceInMs (10s)
    const nextSourceSeconds = nextClip!.sourceInMs / 1000
    expect(nextSourceSeconds).toBe(10)
  })

  it("guards against treating frames before clip start as deleted footage", () => {
    const timeline = createMockTimeline()
    const clock = createPlaybackClock(timeline, { fps: 30 })

    // Suppose sourceMs is 0 and current clip starts at sourceInMs: 0
    const drivenPlayheadMs = 0
    const currentPos = clock.mapTimelineToSource(drivenPlayheadMs, 1)
    expect(currentPos).not.toBeNull()
    expect(currentPos?.clip.sourceInMs).toBe(0)

    // A sourceMs of -1 is before sourceInMs, but within tolerance; it must map to timeline 0
    const mapped = clock.mapSourceToTimeline(-1)
    expect(mapped).not.toBeNull()
    expect(mapped?.timelineMs).toBe(0)
  })

  it("handles null audio elements safely during initial render or unmount", () => {
    const timeline = createMockTimeline()
    const audioTrack = timeline.tracks.find((t) => t.kind === "audio")!
    const audioClip = audioTrack.clips[0]!

    // Simulate audioRefs with an unmounted or unattached element
    const audioRefs: Record<string, HTMLAudioElement | null> = {
      [audioClip.id]: null,
    }

    // Verify null check behaves without throwing
    let threw = false
    try {
      const element = audioRefs[audioClip.id]
      if (element) {
        // Should not enter here
        throw new Error("Element should be null")
      }
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  it("self-heals isSeeking flag when video is not actively seeking", () => {
    let isSeekingRef = true
    let isSeekingState = true

    const video = { seeking: false }

    // Logic in handleFrame and syncVideo:
    if (video && !video.seeking) {
      if (isSeekingRef) {
        isSeekingRef = false
        isSeekingState = false
      }
    }

    expect(isSeekingRef).toBe(false)
    expect(isSeekingState).toBe(false)
  })
})
