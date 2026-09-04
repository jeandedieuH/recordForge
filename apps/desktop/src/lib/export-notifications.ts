import type { MediaJob } from "@recordforge/contracts"
import { invoke } from "@tauri-apps/api/core"
import { getSetting, isTauri } from "./settings"

// Lengthy export threshold: exports taking 5 seconds or longer warrant
// background completion alerts when the user is away.
export const LENGTHY_EXPORT_THRESHOLD_MS = 5000

/**
 * Returns true if the application window is minimized, hidden behind other
 * windows, or currently not focused.
 */
export function isWindowInBackground(): boolean {
  if (typeof document === "undefined") return false
  return Boolean(document.hidden || !document.hasFocus())
}

/**
 * Checks whether an export job took longer than the configured lengthy threshold.
 */
export function isLengthyExport(
  job: Pick<MediaJob, "startedAt" | "completedAt">,
  thresholdMs = LENGTHY_EXPORT_THRESHOLD_MS,
): boolean {
  if (!job.startedAt) return false
  const start = new Date(job.startedAt).getTime()
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return false
  return end - start >= thresholdMs
}

/**
 * Requests OS notification permissions gracefully if supported.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "denied"
  }
  if (Notification.permission === "default") {
    try {
      return await Notification.requestPermission()
    } catch {
      return "denied"
    }
  }
  return Notification.permission
}

/**
 * Synthesizes an elegant, crystal-clear completion chime using the standard Web Audio API.
 * Uses a soft harmonic triad chord (E5, G#5, B5, E6) with smooth exponential decay.
 * Requires zero external audio files, operates fully offline, and has zero latency.
 */
export function playExportChime(): void {
  if (typeof window === "undefined") return

  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return

  try {
    const ctx = new AudioContextClass()
    if (ctx.state === "suspended") {
      void ctx.resume()
    }

    const now = ctx.currentTime
    // Chime chord notes: E5 (659.25 Hz), G#5 (830.61 Hz), B5 (987.77 Hz), E6 (1318.51 Hz)
    const notes = [
      { freq: 659.25, timeOffset: 0.0, duration: 0.7, gain: 0.15 },
      { freq: 830.61, timeOffset: 0.08, duration: 0.65, gain: 0.18 },
      { freq: 987.77, timeOffset: 0.16, duration: 0.6, gain: 0.16 },
      { freq: 1318.51, timeOffset: 0.24, duration: 0.8, gain: 0.2 },
    ]

    const masterGain = ctx.createGain()
    masterGain.gain.setValueAtTime(0.7, now)
    masterGain.connect(ctx.destination)

    notes.forEach(({ freq, timeOffset, duration, gain }) => {
      const osc = ctx.createOscillator()
      const noteGain = ctx.createGain()

      // Sine wave with soft harmonic tone
      osc.type = "sine"
      osc.frequency.setValueAtTime(freq, now + timeOffset)

      // Envelope: gentle 15ms attack, smooth exponential decay
      const startTime = now + timeOffset
      const attackEnd = startTime + 0.015
      const stopTime = startTime + duration

      noteGain.gain.setValueAtTime(0.0001, startTime)
      noteGain.gain.linearRampToValueAtTime(gain, attackEnd)
      noteGain.gain.exponentialRampToValueAtTime(0.0001, stopTime)

      osc.connect(noteGain)
      noteGain.connect(masterGain)

      osc.start(startTime)
      osc.stop(stopTime)
    })

    // Clean up audio context after completion
    window.setTimeout(() => {
      void ctx.close().catch(() => {})
    }, 1500)
  } catch (error) {
    console.warn("Failed to play export chime:", error)
  }
}

/**
 * Handles post-export notification and audio chime dispatching.
 * Triggers when a lengthy export finishes while the application is in the background.
 */
export async function notifyExportFinished(
  job: MediaJob,
  projectName = "Recording",
): Promise<void> {
  const inBackground = isWindowInBackground()
  const lengthy = isLengthyExport(job)

  // Only trigger background notifications and chimes when the user was away
  // or minimized during a lengthy export.
  if (!inBackground || !lengthy) {
    return
  }

  let notifyEnabled = true
  let soundEnabled = true

  if (isTauri()) {
    try {
      const [notifySetting, soundSetting] = await Promise.all([
        getSetting("notifyOnExportComplete"),
        getSetting("soundOnExportComplete"),
      ])
      if (notifySetting !== null) notifyEnabled = notifySetting === "true"
      if (soundSetting !== null) soundEnabled = soundSetting === "true"
    } catch {
      // Keep defaults on failure
    }
  }

  // 1. Play audio chime if enabled
  if (soundEnabled) {
    playExportChime()
  }

  // 2. Request taskbar attention in Tauri
  if (isTauri()) {
    void invoke("request_export_attention").catch(() => {})
  }

  // 3. Send OS system notification if enabled and supported
  if (notifyEnabled && typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "default") {
      await requestNotificationPermission()
    }

    if (Notification.permission === "granted") {
      try {
        const title = "Export Complete"
        const body = `${projectName} has been successfully exported and is ready.`
        const notification = new Notification(title, {
          body,
          icon: "/icons/128x128.png",
          tag: `export-${job.id}`,
        })

        notification.onclick = () => {
          window.focus()
          if (isTauri()) {
            void invoke("show_main_window").catch(() => {})
          }
        }
      } catch (error) {
        console.warn("Failed to trigger system notification:", error)
      }
    }
  }
}
