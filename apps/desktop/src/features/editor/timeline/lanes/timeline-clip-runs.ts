import type { TimelineClip } from "@recordforge/contracts"

export type RunPosition = "single" | "first" | "middle" | "last"

export interface ClipRunLayout {
  // Id of the run this clip belongs to (the run's first clip id).
  runId: string
  position: RunPosition
  // Immediate neighbors' edges in time order regardless of run membership —
  // used to clamp trims so an edge can never be dragged over a neighbor.
  prevEndMs: number | null
  nextStartMs: number | null
}

export interface ClipRun {
  id: string
  startMs: number
  endMs: number
  clipIds: string[]
}

export interface ClipRuns {
  byClip: Map<string, ClipRunLayout>
  runs: ClipRun[]
}

/**
 * Groups back-to-back clips into seamless runs. A clip continues the previous
 * clip's run when the gap is invisible: <= 1ms, or below 1.5px at the current
 * zoom — sub-pixel gaps would otherwise paint rounded-corner seams every few
 * pixels at fit zoom, while a real gap (visible at high zoom) breaks the run.
 */
export function computeClipRuns(clips: TimelineClip[], pixelsPerMs: number): ClipRuns {
  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs)
  const byClip = new Map<string, ClipRunLayout>()
  const runs: ClipRun[] = []

  let current: ClipRun | null = null
  for (let i = 0; i < sorted.length; i++) {
    const clip = sorted[i]
    const clipEndMs = clip.startMs + clip.durationMs
    const prevEndMs = i > 0 ? sorted[i - 1].startMs + sorted[i - 1].durationMs : null
    const nextStartMs = i < sorted.length - 1 ? sorted[i + 1].startMs : null

    const gapMs = prevEndMs === null ? Number.POSITIVE_INFINITY : clip.startMs - prevEndMs
    if (!current || !(gapMs <= 1 || gapMs * pixelsPerMs < 1.5)) {
      current = { id: clip.id, startMs: clip.startMs, endMs: clipEndMs, clipIds: [clip.id] }
      runs.push(current)
    } else {
      current.endMs = Math.max(current.endMs, clipEndMs)
      current.clipIds.push(clip.id)
    }

    byClip.set(clip.id, { runId: current.id, position: "single", prevEndMs, nextStartMs })
  }

  // Positions are known only once the run is complete — second pass.
  for (const run of runs) {
    run.clipIds.forEach((clipId, index) => {
      const layout = byClip.get(clipId)
      if (!layout) return
      layout.position =
        run.clipIds.length === 1
          ? "single"
          : index === 0
            ? "first"
            : index === run.clipIds.length - 1
              ? "last"
              : "middle"
    })
  }

  return { byClip, runs }
}

export interface ClipSublane {
  index: number
  count: number
}

/**
 * Greedily assigns overlapping clips to sub-lanes per connected cluster
 * so simultaneous overlay items (e.g. multiple titles/annotations) do not visually occlude
 * one another, while non-overlapping clips remain at full height.
 */
export function computeClipSublanes(clips: TimelineClip[]): Map<string, ClipSublane> {
  const result = new Map<string, ClipSublane>()
  if (clips.length <= 1) {
    for (const clip of clips) {
      result.set(clip.id, { index: 0, count: 1 })
    }
    return result
  }

  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs)
  const clusters: TimelineClip[][] = []
  let currentCluster: TimelineClip[] = []
  let currentClusterEnd = -1

  for (const clip of sorted) {
    const clipEnd = clip.startMs + clip.durationMs
    if (currentCluster.length === 0) {
      currentCluster.push(clip)
      currentClusterEnd = clipEnd
    } else if (clip.startMs < currentClusterEnd) {
      currentCluster.push(clip)
      currentClusterEnd = Math.max(currentClusterEnd, clipEnd)
    } else {
      clusters.push(currentCluster)
      currentCluster = [clip]
      currentClusterEnd = clipEnd
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster)
  }

  for (const cluster of clusters) {
    if (cluster.length <= 1) {
      for (const clip of cluster) {
        result.set(clip.id, { index: 0, count: 1 })
      }
      continue
    }

    const laneEndTimes: number[] = []
    const clusterAssignments = new Map<string, number>()
    for (const clip of cluster) {
      let placedLane = -1
      for (let i = 0; i < laneEndTimes.length; i++) {
        if (clip.startMs >= laneEndTimes[i]) {
          placedLane = i
          laneEndTimes[i] = clip.startMs + clip.durationMs
          break
        }
      }
      if (placedLane === -1) {
        placedLane = laneEndTimes.length
        laneEndTimes.push(clip.startMs + clip.durationMs)
      }
      clusterAssignments.set(clip.id, placedLane)
    }

    const clusterMaxLanes = Math.min(3, Math.max(1, laneEndTimes.length))
    for (const clip of cluster) {
      const lane = clusterAssignments.get(clip.id) ?? 0
      result.set(clip.id, {
        index: Math.min(lane, clusterMaxLanes - 1),
        count: clusterMaxLanes,
      })
    }
  }

  return result
}
