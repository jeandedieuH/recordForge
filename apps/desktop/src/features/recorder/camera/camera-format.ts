import type { CameraCapturePlan } from "@recordforge/contracts"

// PCM16 stereo @ 48 kHz ≈ 1536 kbps. Used ONLY for remaining-disk estimates
// when the mic is enabled — never shown as the recording's quality.
export const AUDIO_PCM_KBPS_ESTIMATE = 1536

export function resolutionLabel(width: number, height: number): string {
  if (height === 720) return "720p"
  if (height === 1080) return "1080p"
  if (height === 1440) return "1440p"
  if (height >= 2160) return "4K"
  return `${width}x${height}`
}

export function formatMbps(kbps: number): string {
  return `≈ ${(kbps / 1000).toFixed(1)} Mbps`
}

// kbps * 60 s / 8 bits-per-byte → MB/min (decimal MB, matches formatBytes).
export function estimateMbPerMinute(kbps: number): number {
  return (kbps * 7.5) / 1000
}

export function estimateRecordingMinutes(freeBytes: number, totalKbps: number): number {
  if (totalKbps <= 0) return Number.POSITIVE_INFINITY
  const bytesPerMinute = totalKbps * 7_500
  return Math.floor(freeBytes / bytesPerMinute)
}

export function formatDurationHuman(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes >= 24 * 60) return "24 h+"
  if (minutes < 1) return "0 min"
  const whole = Math.floor(minutes)
  if (whole < 60) return `${whole} min`
  const hours = Math.floor(whole / 60)
  const rest = whole % 60
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"] as const
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${Number.parseFloat(value.toFixed(1))} ${units[index]}`
}

export type CameraImpact = "light" | "moderate" | "heavy"

// Rough CPU/GPU load estimate driven by output pixel rate (Mpx/s). The
// thresholds assume a typical low-end 4-core PC: hardware encoders offload
// the expensive part so only software encoding can reach "heavy".
export function estimateImpact(plan: CameraCapturePlan, hasHardwareEncoder: boolean): CameraImpact {
  const mpxPerSecond = (plan.outputWidth * plan.outputHeight * plan.outputFps) / 1_000_000
  if (hasHardwareEncoder) {
    return mpxPerSecond <= 70 ? "light" : "moderate"
  }
  let impact: CameraImpact =
    mpxPerSecond <= 30 ? "light" : mpxPerSecond <= 70 ? "moderate" : "heavy"
  // camera-high keeps 1080p but nearly doubles the bitrate — software x264
  // spends measurably more on it, so bump one level.
  if (plan.profileId === "camera-high" && impact !== "heavy") {
    impact = impact === "light" ? "moderate" : "heavy"
  }
  return impact
}

export function planSummary(plan: CameraCapturePlan | null | undefined): string {
  if (!plan) return "Auto"
  return `${plan.outputWidth}×${plan.outputHeight} · ${Math.round(plan.outputFps)} fps`
}
