import { useEffect, useState } from "react"
import { matchDeviceLabel } from "./device-match"

// Map a raw peak amplitude to a perceptual 0..1 meter level: -60 dBFS reads
// as silence, 0 dBFS as full scale.
export function peakToLevel(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 0
  const db = 20 * Math.log10(Math.min(peak, 1))
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

// Meter ballistics: instant attack so speech spikes register immediately,
// exponential release so the meter decays smoothly instead of flickering.
export function smoothMeterLevel(previous: number, next: number, release = 0.85): number {
  return next > previous ? next : previous * release
}

export interface UseMicLevelOptions {
  deviceName: string
  enabled: boolean
}

const EMIT_INTERVAL_MS = 50 // ~20 fps meter updates

// Live mic level for the SETUP meter (replaces the old fake random meter) —
// it opens its own getUserMedia stream matched by label, falling back to
// the default input when the stored name no longer matches anything.
export function useMicLevel({ deviceName, enabled }: UseMicLevelOptions): number {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.getUserMedia) {
      setLevel(0)
      return
    }

    // StrictMode-safe: this effect run owns its tracks/context/raf; a stale
    // async start stops its own stream instead of leaking it.
    let cancelled = false
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let rafId = 0
    const smoothedRef = { value: 0 }

    async function start() {
      try {
        let audio: MediaTrackConstraints | boolean = true
        const requested = deviceName.trim()
        if (requested) {
          let devices = await navigator.mediaDevices.enumerateDevices()
          let matched = devices
            .filter((d) => d.kind === "audioinput")
            .find((d) => d.label && matchDeviceLabel(d.label, requested))
          if (!matched) {
            // Labels hidden until a grant — same bootstrap as the camera.
            const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
            permissionStream.getTracks().forEach((track) => track.stop())
            devices = await navigator.mediaDevices.enumerateDevices()
            matched = devices
              .filter((d) => d.kind === "audioinput")
              .find((d) => d.label && matchDeviceLabel(d.label, requested))
          }
          // No match → quietly use the default input rather than fail.
          if (matched) audio = { deviceId: { exact: matched.deviceId } }
        }

        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        context = new AudioContext()
        await context.resume()
        const source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        const buffer = new Float32Array(analyser.fftSize)
        let lastEmit = 0

        const tick = (now: number) => {
          if (cancelled) return
          analyser.getFloatTimeDomainData(buffer)
          let peak = 0
          for (const sample of buffer) {
            const abs = Math.abs(sample)
            if (abs > peak) peak = abs
          }
          smoothedRef.value = smoothMeterLevel(smoothedRef.value, peakToLevel(peak))
          if (now - lastEmit >= EMIT_INTERVAL_MS) {
            lastEmit = now
            setLevel(smoothedRef.value)
          }
          rafId = requestAnimationFrame(tick)
        }
        rafId = requestAnimationFrame(tick)
      } catch {
        // No mic / no permission: the meter silently stays at zero — the
        // cards already surface "No microphone found" separately.
      }
    }
    void start()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
      smoothedRef.value = 0
      setLevel(0)
    }
  }, [deviceName, enabled])

  return level
}
