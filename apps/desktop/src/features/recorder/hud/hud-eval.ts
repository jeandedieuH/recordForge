import type { CaptureDiagnostics, RecordingStatus } from "@recordforge/contracts"

// ---------------------------------------------------------------------------
// Row-1 label
// ---------------------------------------------------------------------------

export interface HudSourceLabel {
  // "Recording" / "Paused" / … — the transport state word.
  state: string
  // Device/source display name; empty when nothing is known.
  name: string
  // Camera recordings prefix the name with a small video glyph.
  glyph: "video" | null
}

export function hudSourceLabel(
  status: Pick<RecordingStatus, "state" | "sourceKind" | "sourceName"> | null | undefined,
): HudSourceLabel {
  const state =
    status?.state === "recording"
      ? "Recording"
      : status?.state === "paused"
        ? "Paused"
        : status?.state === "finalizing"
          ? "Saving"
          : status?.state === "countdown"
            ? "Starting"
            : "Ready"
  if (status?.sourceKind === "camera") {
    return { state, name: status.sourceName || "Camera", glyph: "video" }
  }
  return { state, name: status?.sourceName || "Screen capture", glyph: null }
}

// ---------------------------------------------------------------------------
// Mic-silence detection
// ---------------------------------------------------------------------------

export const MIC_SILENT_PEAK = 0.001 // below -60 dBFS counts as silence
export const MIC_SIGNAL_PEAK = 0.003 // hysteresis: >= this clears the alarm
export const MIC_SILENT_AFTER_MS = 8_000

export const MIC_SILENCE_MESSAGE = "No microphone signal — check that your mic isn't muted."

export interface MicSilenceState {
  // Timestamp when the continuous silent stretch started (null = not silent).
  silentSince: number | null
  // True while the condition has crossed the threshold.
  alarming: boolean
  // User dismissed the alarm; re-arms only when real signal returns.
  dismissed: boolean
}

export const MIC_SILENCE_INITIAL: MicSilenceState = {
  silentSince: null,
  alarming: false,
  dismissed: false,
}

export interface MicSilenceInput {
  // status.microphoneActive && status.state === "recording"
  listening: boolean
  // Raw mic peak from the latest audio-level event (null = no samples yet).
  peak: number | null
  // Event timestamp in ms — durations are derived from real time, not ticks.
  at: number
}

export function evaluateMicSilence(prev: MicSilenceState, input: MicSilenceInput): MicSilenceState {
  if (!input.listening) {
    // Paused/stopped/mic-off resets the timer; a dismissal stays armed until
    // actual signal returns (per the "don't nag" contract).
    return { silentSince: null, alarming: false, dismissed: prev.dismissed }
  }

  const peak = input.peak
  if (peak != null && peak >= MIC_SIGNAL_PEAK) {
    return { silentSince: null, alarming: false, dismissed: false }
  }

  if (peak != null && peak < MIC_SILENT_PEAK) {
    const silentSince = prev.silentSince ?? input.at
    const alarming = !prev.dismissed && input.at - silentSince >= MIC_SILENT_AFTER_MS
    return { silentSince, alarming, dismissed: prev.dismissed }
  }

  // Hysteresis band (0.001..0.003): keep the current verdict — neither fresh
  // silence nor a clear signal.
  return prev
}

export function dismissMicSilence(prev: MicSilenceState): MicSilenceState {
  return { ...prev, alarming: false, dismissed: true }
}

// ---------------------------------------------------------------------------
// Capture-health degradation (from the 1 Hz status poll)
// ---------------------------------------------------------------------------

export const HEALTH_BAD_POLLS = 3
export const HEALTH_RECOVER_POLLS = 3
export const HEALTH_GRACE_MS = 3_000
export const HEALTH_MIN_SPEED = 0.9
export const HEALTH_MIN_FPS_RATIO = 0.85

export const CAPTURE_HEALTH_MESSAGE =
  "Recording can't keep up at this quality. Try a lower quality next time."

export interface CaptureHealthState {
  consecutiveBad: number
  consecutiveGood: number
  degraded: boolean
  dismissed: boolean
}

export const CAPTURE_HEALTH_INITIAL: CaptureHealthState = {
  consecutiveBad: 0,
  consecutiveGood: 0,
  degraded: false,
  dismissed: false,
}

export interface CaptureHealthInput {
  // Status poll timestamp in ms.
  at: number
  // status.state — anything but "recording" resets the counters.
  recording: boolean
  // Milliseconds since the session entered Recording (grace period input).
  recordingAgeMs: number | null
  // status.cameraDiagnostics ?? status.screenDiagnostics — null when the
  // primary capture hasn't reported yet.
  diagnostics: CaptureDiagnostics | null | undefined
}

export function evaluateCaptureHealth(
  prev: CaptureHealthState,
  input: CaptureHealthInput,
): CaptureHealthState {
  if (!input.recording) {
    return { ...prev, consecutiveBad: 0, consecutiveGood: 0 }
  }
  // Grace period right after start — startup speed/FPS are always low.
  if (input.recordingAgeMs != null && input.recordingAgeMs < HEALTH_GRACE_MS) {
    return { ...prev, consecutiveBad: 0, consecutiveGood: 0 }
  }

  const progress = input.diagnostics?.progress
  const requestedFps = input.diagnostics?.requestedFps
  const speed = progress?.speed
  const outputFps = progress?.outputFps

  let bad: boolean | null = null
  if (speed != null || outputFps != null) {
    const slow = speed != null && speed < HEALTH_MIN_SPEED
    const starved =
      outputFps != null && requestedFps != null && outputFps < HEALTH_MIN_FPS_RATIO * requestedFps
    bad = slow || starved
  }

  if (bad === null) {
    // Missing counters: not evidence either way — don't move the counters.
    return prev
  }

  if (bad) {
    const consecutiveBad = prev.consecutiveBad + 1
    return {
      ...prev,
      consecutiveBad,
      consecutiveGood: 0,
      degraded: consecutiveBad >= HEALTH_BAD_POLLS || prev.degraded,
    }
  }

  const consecutiveGood = prev.consecutiveGood + 1
  const recovered = prev.degraded && consecutiveGood >= HEALTH_RECOVER_POLLS
  return {
    ...prev,
    consecutiveBad: 0,
    consecutiveGood,
    // Recovery clears both the alarm and any dismissal.
    degraded: recovered ? false : prev.degraded,
    dismissed: recovered ? false : prev.dismissed,
  }
}

export function dismissCaptureHealth(prev: CaptureHealthState): CaptureHealthState {
  return { ...prev, dismissed: true }
}
