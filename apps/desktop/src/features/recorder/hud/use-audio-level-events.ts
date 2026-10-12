import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import { z } from "zod"
import { isTauri } from "../../../lib/settings"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { useAudioLevelStore } from "./audio-level-store"

const audioLevelPayloadSchema = z.object({
  microphone: z.number().nullable().default(null),
  systemAudio: z.number().nullable().default(null),
})

// Feeds the HUD's audio-level store from the Rust `recorder-audio-level`
// event (~12 Hz while Recording). Mount ONLY in the floating-controls
// window — the main window has no meter and doesn't need the stream.
export function useAudioLevelEvents() {
  const recorderState = useRecorderStore((state) => state.status?.state)
  const reset = useAudioLevelStore((state) => state.reset)

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let running = true

    listen("recorder-audio-level", (event) => {
      const parsed = audioLevelPayloadSchema.safeParse(event.payload)
      if (!parsed.success) return
      useAudioLevelStore.getState().update(parsed.data)
    }).then((fn) => {
      if (running) unlisten = fn
      else fn()
    })

    return () => {
      running = false
      unlisten?.()
    }
  }, [])

  // The emitter only streams while Recording — pause/stop/zero session zero
  // the meter immediately instead of freezing at the last peak.
  useEffect(() => {
    if (recorderState !== "recording") reset()
  }, [recorderState, reset])
}
