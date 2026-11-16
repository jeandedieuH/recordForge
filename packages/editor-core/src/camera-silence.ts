// Hide-camera-during-silence (#4d).
//
// Smart Cut already resolves dead-air ranges from the recording's waveform
// envelopes. This pure builder turns those ranges into `source: "silence"`
// camera-layout segments: every existing silence-generated segment is replaced,
// manual segments always win, and each edit stays a single undoable command.
//
// Pure and waveform-free so the command layer owns the transition and the UI
// owns the analysis.

import type { CameraLayoutSegment } from "@recordforge/contracts"
import { snapRangeEdgeToFrame } from "./smart-cut"

export interface SilenceRangeMs {
  startMs: number
  endMs: number
}

export interface CameraSilenceLayoutOptions {
  /** Ignore ranges shorter than this before padding. */
  minSilenceMs: number
  /** Speech kept visible at each boundary, in ms. */
  padMs: number
  /** Cross-fade in/out for each generated hidden segment, in ms. */
  transitionMs: number
  /** Canvas frame rate for frame-snapped edges. */
  fps?: number
  /** Timeline end; generated segments never run past it. */
  durationMs: number
}

export const CAMERA_SILENCE_DEFAULTS = {
  minSilenceMs: 2500,
  padMs: 150,
  transitionMs: 400,
} as const

function segmentEnd(segment: CameraLayoutSegment): number {
  return segment.startMs + segment.durationMs
}

function subtractManual(range: SilenceRangeMs, manual: CameraLayoutSegment[]): SilenceRangeMs[] {
  let pieces: SilenceRangeMs[] = [range]
  for (const segment of manual) {
    const next: SilenceRangeMs[] = []
    const segmentStart = segment.startMs
    const segmentEndMs = segmentEnd(segment)
    for (const piece of pieces) {
      if (segmentEndMs <= piece.startMs || segmentStart >= piece.endMs) {
        next.push(piece)
        continue
      }
      if (segmentStart > piece.startMs) {
        next.push({ startMs: piece.startMs, endMs: segmentStart })
      }
      if (segmentEndMs < piece.endMs) {
        next.push({ startMs: segmentEndMs, endMs: piece.endMs })
      }
    }
    pieces = next
  }
  return pieces
}

/** True when a camera-layout segment came from silence generation. */
export function isSilenceLayoutSegment(segment: CameraLayoutSegment): boolean {
  return segment.source === "silence"
}

/**
 * Build the replacement silence segments. Callers pass the *current* lane so
 * manual/derived segments and ids round-trip deterministically.
 */
export function buildCameraSilenceLayouts(
  existing: CameraLayoutSegment[],
  ranges: SilenceRangeMs[],
  options: CameraSilenceLayoutOptions,
  makeId: () => string,
): CameraLayoutSegment[] {
  const manual = existing.filter((segment) => !isSilenceLayoutSegment(segment))
  const generated: CameraLayoutSegment[] = []
  const minSilence = Math.max(1, Math.round(options.minSilenceMs))
  const pad = Math.max(0, Math.round(options.padMs))
  const transition = Math.max(0, Math.round(options.transitionMs))
  const duration = Math.max(0, Math.round(options.durationMs))

  for (const range of ranges) {
    const rawStart = Math.max(0, Math.min(range.startMs, range.endMs))
    const rawEnd = Math.min(duration, Math.max(range.startMs, range.endMs))
    if (rawEnd - rawStart < minSilence) continue
    const start = snapRangeEdgeToFrame(rawStart + pad, options.fps)
    const end = snapRangeEdgeToFrame(rawEnd - pad, options.fps)
    if (end - start < Math.max(500, minSilence - pad * 2)) continue
    for (const piece of subtractManual({ startMs: start, endMs: end }, manual)) {
      if (piece.endMs - piece.startMs < 500) continue
      generated.push({
        id: makeId(),
        startMs: Math.round(piece.startMs),
        durationMs: Math.round(piece.endMs - piece.startMs),
        layout: "hidden",
        transitionInMs: transition,
        transitionOutMs: transition,
        easing: "smooth",
        source: "silence",
        enabled: true,
        locked: false,
        label: "Hidden during silence",
      })
    }
  }

  // Keep the lane ordered; the renderer resolves windows in array order but a
  // sorted lane makes the timeline UI predictable.
  return [...manual, ...generated].sort((left, right) => left.startMs - right.startMs)
}
