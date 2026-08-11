import type { TimelineClip, TimelineState } from "@recordforge/domain"
import { findClip } from "@recordforge/domain"
import {
  findNextTimelineClip,
  findTimelineClipAt,
  sourceToClipTime,
  timelineToSource,
} from "./time-mapping"

/**
 * Preview quality mode. Quality drives frame-accurate seeking, performance
 * allows a small drift budget, and power saving coalesces updates.
 */
export type PreviewQualityMode = "quality" | "performance" | "power"

export interface PlaybackClockOptions {
  /** Preview quality mode. */
  mode?: PreviewQualityMode
  /** Frames per second used for frame-boundary rounding. */
  fps?: number
  /** Maximum acceptable drift before a corrective seek in quality mode. */
  maxDriftMs?: number
  /** Number of drift samples kept in the rolling metrics window. */
  driftWindowSize?: number
}

export interface PlaybackPosition {
  clipId: string
  clip: TimelineClip
  sourceMs: number
  timelineMs: number
  /** Effective playback rate combining user rate and clip speed. */
  playbackRate: number
  /** True when the position falls in a gap with no active screen clip. */
  isGap: boolean
}

export interface PlaybackBoundary {
  timelineMs: number
  sourceMs: number
  clipId: string | null
  kind: "clip-start" | "clip-end" | "end"
}

export interface DriftMetrics {
  sampleCount: number
  maxDriftMs: number
  averageDriftMs: number
  lastDriftMs: number
}

export interface PlaybackClock {
  /** Active preview quality mode. */
  mode: PreviewQualityMode
  /** Duration of one output frame in milliseconds. */
  frameMs: number
  /** Maximum drift the current mode tolerates before a corrective seek. */
  maxDriftMs: number
  /** Map a timeline position to the authoritative screen source position. */
  mapTimelineToSource(timelineMs: number, playbackRate?: number): PlaybackPosition | null
  /** Map a source time back to a timeline position. */
  mapSourceToTimeline(
    sourceMs: number,
    options?: { preferClipId?: string },
  ): { timelineMs: number; clipId: string; unambiguous: boolean } | null
  /** Find the next significant boundary (clip end, next clip start, or timeline end). */
  nextBoundary(timelineMs: number): PlaybackBoundary | null
  /** Round a time to the nearest output frame boundary. */
  roundToFrame(ms: number): number
  /** Advance playhead by a wall-clock interval, honoring gaps and clip speed. */
  advanceFrame(timelineMs: number, elapsedMs: number, playbackRate?: number): number
  /** Record a drift sample for metrics. */
  reportDrift(expectedTimelineMs: number, actualTimelineMs: number): void
  /** Current drift metrics. */
  drift(): DriftMetrics
  /** Reset drift metrics. */
  resetDrift(): void
}

interface DriftSample {
  /** Expected timeline position. */
  expectedMs: number
  /** Actual observed timeline position. */
  actualMs: number
}

function defaultFps(state: TimelineState): number {
  return Math.max(1, state.canvas.fps)
}

function screenTrack(state: TimelineState) {
  return state.tracks.find((track) => track.kind === "screen")
}

function firstScreenAssetId(state: TimelineState): string | null {
  return screenTrack(state)?.clips[0]?.assetId ?? null
}

function findScreenClip(
  state: TimelineState,
  clipId: string,
): { clip: TimelineClip; index: number } | null {
  const found = findClip(state, clipId)
  if (!found || found.track.kind !== "screen") return null
  return { clip: found.clip, index: found.clipIndex }
}

function effectivePlaybackRate(userRate: number, clipSpeed: number): number {
  return Math.max(0.25, Math.min(4, userRate * clipSpeed))
}

function modeMaxDriftMs(mode: PreviewQualityMode, frameMs: number, option?: number): number {
  if (option !== undefined && option > 0) return option
  if (mode === "quality") return frameMs * 0.5
  if (mode === "performance") return frameMs * 1.5
  return frameMs * 3
}

/**
 * Create a deterministic playback clock for one timeline.
 *
 * The clock owns the source/timeline/output mapping that both the preview and
 * the export plan share. It is a pure module with no DOM or React dependencies
 * so it can be unit tested against deterministic fixtures.
 */
export function createPlaybackClock(
  state: TimelineState,
  options: PlaybackClockOptions = {},
): PlaybackClock {
  const mode = options.mode ?? "quality"
  const fps = Math.max(1, options.fps ?? defaultFps(state))
  const frameMs = 1000 / fps
  const maxDriftMs = modeMaxDriftMs(mode, frameMs, options.maxDriftMs)
  const driftWindowSize = Math.max(2, options.driftWindowSize ?? 60)
  const driftSamples: DriftSample[] = []

  function roundToFrame(ms: number): number {
    const frameIndex = Math.round(ms / frameMs)
    return Math.max(0, Math.round(frameIndex * frameMs))
  }

  function mapTimelineToSource(timelineMs: number, userPlaybackRate = 1): PlaybackPosition | null {
    const clip = findTimelineClipAt(state, "screen", timelineMs)
    if (!clip) {
      return null
    }
    const sourceMs = timelineToSource(clip, timelineMs)
    if (sourceMs === null) return null
    return {
      clipId: clip.id,
      clip,
      sourceMs,
      timelineMs,
      playbackRate: effectivePlaybackRate(userPlaybackRate, clip.speed),
      isGap: false,
    }
  }

  function mapSourceToTimeline(
    sourceMs: number,
    mapOptions: { preferClipId?: string } = {},
  ): { timelineMs: number; clipId: string; unambiguous: boolean } | null {
    const assetId =
      (mapOptions.preferClipId
        ? findScreenClip(state, mapOptions.preferClipId)?.clip.assetId
        : null) ?? firstScreenAssetId(state)
    if (!assetId) return null

    const track = screenTrack(state)
    if (!track) return null

    const candidates = track.clips
      .filter((clip) => {
        if (clip.assetId !== assetId) return false
        if (mapOptions.preferClipId && clip.id !== mapOptions.preferClipId) return false
        return sourceMs >= clip.sourceInMs && sourceMs <= clip.sourceOutMs
      })
      .sort((a, b) => a.startMs - b.startMs)

    if (candidates.length === 0) return null
    const first = candidates[0]!
    const timelineMs = sourceToClipTime(first, sourceMs)
    if (timelineMs === null) return null
    return {
      clipId: first.id,
      timelineMs,
      unambiguous: candidates.length === 1,
    }
  }

  function nextBoundary(timelineMs: number): PlaybackBoundary | null {
    const track = screenTrack(state)
    if (!track || track.clips.length === 0) {
      return { timelineMs: stateDuration(), sourceMs: 0, clipId: null, kind: "end" }
    }

    const active = findTimelineClipAt(state, "screen", timelineMs)
    if (active) {
      const endMs = active.startMs + active.durationMs
      const next = findNextTimelineClip(state, "screen", endMs)
      return {
        timelineMs: endMs,
        sourceMs: active.sourceOutMs,
        clipId: active.id,
        kind: next ? "clip-end" : "end",
      }
    }

    const next = findNextTimelineClip(state, "screen", timelineMs)
    if (next) {
      return {
        timelineMs: next.startMs,
        sourceMs: next.sourceInMs,
        clipId: next.id,
        kind: "clip-start",
      }
    }

    const last = track.clips[track.clips.length - 1]
    if (last) {
      return {
        timelineMs: last.startMs + last.durationMs,
        sourceMs: last.sourceOutMs,
        clipId: last.id,
        kind: "end",
      }
    }

    return null
  }

  function stateDuration(): number {
    const track = screenTrack(state)
    if (!track) return 0
    return track.clips.reduce(
      (duration, clip) => Math.max(duration, clip.startMs + clip.durationMs),
      0,
    )
  }

  function advanceFrame(timelineMs: number, elapsedMs: number, userPlaybackRate = 1): number {
    let t = Math.max(0, timelineMs)
    let e = Math.max(0, elapsedMs)
    const rate = Math.max(0.25, userPlaybackRate)

    while (e > 0) {
      const active = findTimelineClipAt(state, "screen", t)
      if (!active) {
        const boundary = nextBoundary(t)
        if (!boundary || boundary.kind === "end") {
          return roundToFrame(Math.min(stateDuration(), t + e * rate))
        }
        const gapMs = boundary.timelineMs - t
        const wallClockToNext = gapMs / rate
        if (e <= wallClockToNext) {
          return roundToFrame(t + e * rate)
        }
        e -= wallClockToNext
        t = boundary.timelineMs
        continue
      }

      const clipEndMs = active.startMs + active.durationMs
      const remainingMs = (clipEndMs - t) / rate
      if (e <= remainingMs) {
        return roundToFrame(t + e * rate)
      }
      e -= remainingMs
      t = clipEndMs
    }

    return roundToFrame(t)
  }

  function reportDrift(expectedTimelineMs: number, actualTimelineMs: number): void {
    const driftMs = Math.abs(actualTimelineMs - expectedTimelineMs)
    if (!Number.isFinite(driftMs)) return
    driftSamples.push({ expectedMs: expectedTimelineMs, actualMs: actualTimelineMs })
    if (driftSamples.length > driftWindowSize) {
      driftSamples.shift()
    }
  }

  function drift(): DriftMetrics {
    if (driftSamples.length === 0) {
      return { sampleCount: 0, maxDriftMs: 0, averageDriftMs: 0, lastDriftMs: 0 }
    }
    let maxDriftMs = 0
    let totalDriftMs = 0
    for (const sample of driftSamples) {
      const driftMs = Math.abs(sample.actualMs - sample.expectedMs)
      maxDriftMs = Math.max(maxDriftMs, driftMs)
      totalDriftMs += driftMs
    }
    const last = driftSamples[driftSamples.length - 1]!
    return {
      sampleCount: driftSamples.length,
      maxDriftMs,
      averageDriftMs: totalDriftMs / driftSamples.length,
      lastDriftMs: Math.abs(last.actualMs - last.expectedMs),
    }
  }

  function resetDrift(): void {
    driftSamples.length = 0
  }

  return {
    mode,
    frameMs,
    maxDriftMs,
    mapTimelineToSource,
    mapSourceToTimeline,
    nextBoundary,
    roundToFrame,
    advanceFrame,
    reportDrift,
    drift,
    resetDrift,
  }
}

/** True when the clock should correct the playhead for the current drift. */
export function shouldCorrectDrift(
  clock: PlaybackClock,
  expectedMs: number,
  actualMs: number,
): boolean {
  const driftMs = Math.abs(actualMs - expectedMs)
  return driftMs > clock.maxDriftMs
}
