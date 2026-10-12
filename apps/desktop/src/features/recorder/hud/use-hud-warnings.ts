import { useCallback, useEffect, useRef, useState } from "react"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { useAudioLevelStore } from "./audio-level-store"
import {
  CAPTURE_HEALTH_INITIAL,
  CAPTURE_HEALTH_MESSAGE,
  MIC_SILENCE_INITIAL,
  MIC_SILENCE_MESSAGE,
  dismissCaptureHealth,
  dismissMicSilence,
  evaluateCaptureHealth,
  evaluateMicSilence,
  type CaptureHealthState,
  type MicSilenceState,
} from "./hud-eval"

export type HudWarningKind = "mic-silence" | "capture-health"

export interface HudWarning {
  kind: HudWarningKind
  message: string
}

// Combines the two client-side HUD warnings — mic-silence (audio-level
// events) and capture-health (status polls) — behind one state machine so
// row-1 shows the highest-priority message. Backend `status.error` is NOT
// handled here: it already has its own surface in the toolbar.
export function useHudWarnings(): { warning: HudWarning | null; dismiss: () => void } {
  const micState = useRef<MicSilenceState>(MIC_SILENCE_INITIAL)
  const healthState = useRef<CaptureHealthState>(CAPTURE_HEALTH_INITIAL)
  const sessionId = useRecorderStore((s) => s.status?.sessionId)
  const [warning, setWarning] = useState<HudWarning | null>(null)

  const refresh = useCallback(() => {
    const mic = micState.current
    const health = healthState.current
    setWarning(
      mic.alarming
        ? { kind: "mic-silence", message: MIC_SILENCE_MESSAGE }
        : health.degraded && !health.dismissed
          ? { kind: "capture-health", message: CAPTURE_HEALTH_MESSAGE }
          : null,
    )
  }, [])

  // Reset both evaluators when a new session starts.
  useEffect(() => {
    micState.current = MIC_SILENCE_INITIAL
    healthState.current = CAPTURE_HEALTH_INITIAL
    refresh()
  }, [sessionId, refresh])

  // Mic-silence: feed every audio-level event (12 Hz) into the evaluator.
  useEffect(() => {
    const unsubscribe = useAudioLevelStore.subscribe((levels) => {
      const status = useRecorderStore.getState().status
      micState.current = evaluateMicSilence(micState.current, {
        listening: Boolean(status?.microphoneActive) && status?.state === "recording",
        peak: levels.microphone,
        at: levels.updatedAt,
      })
      refresh()
    })
    return unsubscribe
  }, [refresh])

  // Capture-health: feed every status poll into the evaluator.
  useEffect(() => {
    const unsubscribe = useRecorderStore.subscribe((store) => {
      const status = store.status
      healthState.current = evaluateCaptureHealth(healthState.current, {
        at: Date.now(),
        recording: status?.state === "recording",
        recordingAgeMs: status?.recordedMs ?? null,
        diagnostics: status?.cameraDiagnostics ?? status?.screenDiagnostics ?? null,
      })
      refresh()
    })
    return unsubscribe
  }, [refresh])

  const dismiss = useCallback(() => {
    if (micState.current.alarming) {
      micState.current = dismissMicSilence(micState.current)
    }
    if (healthState.current.degraded) {
      healthState.current = dismissCaptureHealth(healthState.current)
    }
    refresh()
  }, [refresh])

  return { warning, dismiss }
}
