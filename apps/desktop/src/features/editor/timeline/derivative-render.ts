// Pure layout and sampling math for timeline media derivatives.
// Kept DOM-free so the canvas renderers and unit tests share one source of truth.

export interface ClipTiming {
  startMs: number
  durationMs: number
  sourceInMs: number
  speed: number
}

export interface ClipWindow {
  startMs: number
  endMs: number
}

// The slice of a clip that intersects the visible timeline window.
// Derivative canvases only ever cover this region, which keeps their pixel
// footprint bounded by the viewport instead of growing with zoom level.
export function visibleClipWindow(
  clip: ClipTiming,
  visibleStartMs: number,
  visibleEndMs: number,
): ClipWindow | null {
  const startMs = Math.max(clip.startMs, visibleStartMs)
  const endMs = Math.min(clip.startMs + clip.durationMs, visibleEndMs)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null
  return { startMs, endMs }
}

// Map a timeline timestamp to source-media time for a clip (trim + speed aware).
export function clipSourceTimeMs(clip: ClipTiming, timelineMs: number): number {
  return clip.sourceInMs + (timelineMs - clip.startMs) * clip.speed
}

// --- Filmstrip -----------------------------------------------------------

const MIN_TILE_PX = 20
const MAX_TILE_PX = 240

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Filmstrip tiles keep a constant on-screen pitch matched to the clip height,
// so zooming changes WHICH frame each tile samples rather than stretching
// frames (the failure mode of the old time-anchored layout).
export function filmstripTileWidth(heightPx: number, thumbAspect: number): number {
  const aspect = Number.isFinite(thumbAspect) && thumbAspect > 0 ? thumbAspect : 16 / 9
  const height = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 24
  return clamp(Math.round(height * aspect), MIN_TILE_PX, MAX_TILE_PX)
}

// Sprite frame covering a source timestamp. Frame i owns the interval
// [i * intervalMs, (i + 1) * intervalMs), so floor (not round) — a tile must
// never sample a frame from the future.
export function filmstripFrameIndex(sourceMs: number, intervalMs: number, count: number): number {
  if (count <= 0) return -1
  if (!Number.isFinite(sourceMs) || intervalMs <= 0) return 0
  return clamp(Math.floor(sourceMs / intervalMs), 0, count - 1)
}

// --- Waveform ------------------------------------------------------------

export interface WaveformLike {
  sampleRate: number
  samplesPerPeak: number
  peaks: number[]
  mins?: number[]
}

export interface WaveformEnvelope {
  top: number
  bottom: number
}

// Milliseconds of source audio covered by one peak pair.
export function waveformWindowMs(data: WaveformLike): number {
  if (data.sampleRate <= 0) return 100
  return (data.samplesPerPeak / data.sampleRate) * 1000
}

// Envelope for the fractional peak range [fromIndex, toIndex) covered by one
// canvas column. When a column spans whole windows we aggregate with true
// min/max (preserves transients); when zoomed past window resolution we
// interpolate so the silhouette stays smooth instead of stepping.
export function sampleWaveformEnvelope(
  data: WaveformLike,
  fromIndex: number,
  toIndex: number,
): WaveformEnvelope {
  const count = data.peaks.length
  if (count === 0) return { top: 0, bottom: 0 }
  const mins = data.mins && data.mins.length === count ? data.mins : undefined

  if (toIndex - fromIndex >= 1) {
    const i0 = clamp(Math.floor(fromIndex), 0, count - 1)
    const i1 = clamp(Math.ceil(toIndex) - 1, 0, count - 1)
    let top = 0
    let bottom = 0
    for (let i = i0; i <= i1; i++) {
      const peak = data.peaks[i]
      if (peak > top) top = peak
      const min = mins ? mins[i] : -peak
      if (min < bottom) bottom = min
    }
    return { top, bottom }
  }

  const f = clamp((fromIndex + toIndex) / 2, 0, count - 1)
  const i = Math.floor(f)
  const frac = f - i
  const j = Math.min(i + 1, count - 1)
  const top = data.peaks[i] + (data.peaks[j] - data.peaks[i]) * frac
  const min0 = mins ? mins[i] : -data.peaks[i]
  const min1 = mins ? mins[j] : -data.peaks[j]
  return { top, bottom: min0 + (min1 - min0) * frac }
}

// Global peak amplitude used to normalize the silhouette so quiet and loud
// clips render at consistent visual weight.
export function waveformNormalization(data: WaveformLike): number {
  let max = 0
  for (const peak of data.peaks) if (peak > max) max = peak
  if (data.mins) {
    for (const min of data.mins) {
      const value = Math.abs(min)
      if (value > max) max = value
    }
  }
  return max
}

// Normalized amplitude → display scale. A gentle perceptual curve keeps quiet
// passages readable without faking loudness structure.
export function displayAmplitude(value: number, normalization: number): number {
  if (normalization <= 0) return 0
  const normalized = clamp(Math.abs(value) / normalization, 0, 1)
  return Math.pow(normalized, 0.72)
}
