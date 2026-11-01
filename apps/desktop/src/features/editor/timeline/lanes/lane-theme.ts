import type { CSSProperties } from "react"
import type { TimelineClip, TimelineTrack } from "@recordforge/contracts"
import {
  AudioLines,
  Captions,
  FileImage,
  Monitor,
  MousePointer2,
  Music,
  Shapes,
  ShieldAlert,
  Type,
  Video,
  Volume2,
  ZoomIn,
  type LucideIcon,
} from "lucide-react"

export interface LaneTheme {
  // CSS variable name ("--color-track-screen", ...) resolved through the
  // --color-lane indirection set by laneStyle().
  colorVar: string
  icon: LucideIcon
  // "run" lanes merge back-to-back clips into one strip with a single sticky
  // label; "clip" lanes keep an individual card + label per clip.
  labelMode: "run" | "clip"
}

/**
 * Single source for lane accent color, icon, and labelling behavior —
 * replaces the per-component color switches that previously lived in the clip
 * item, track header, and minimap.
 */
export function getTrackLaneTheme(track: TimelineTrack): LaneTheme {
  switch (track.kind) {
    case "screen":
      return { colorVar: "--color-track-screen", icon: Monitor, labelMode: "run" }
    case "camera":
      return { colorVar: "--color-track-webcam", icon: Video, labelMode: "run" }
    case "audio": {
      const name = track.name.toLowerCase()
      const roles = track.clips.map((clip) => (clip.kind === "audio" ? clip.role : undefined))
      if (name.includes("music") || roles.includes("music")) {
        return { colorVar: "--color-track-music", icon: Music, labelMode: "run" }
      }
      if (name.includes("system") || roles.includes("system_audio")) {
        return { colorVar: "--color-track-system", icon: AudioLines, labelMode: "run" }
      }
      return { colorVar: "--color-track-mic", icon: AudioLines, labelMode: "run" }
    }
    case "captions":
      return { colorVar: "--color-track-captions", icon: Captions, labelMode: "clip" }
    case "cursor":
      return { colorVar: "--color-track-cursor", icon: MousePointer2, labelMode: "run" }
    case "effects":
      return { colorVar: "--color-track-effects", icon: ShieldAlert, labelMode: "clip" }
    case "zoom":
      return { colorVar: "--color-track-zoom", icon: ZoomIn, labelMode: "clip" }
    case "annotations":
      return { colorVar: "--color-track-annotation", icon: Shapes, labelMode: "clip" }
    case "titles":
      return { colorVar: "--color-track-title", icon: Type, labelMode: "clip" }
    case "graphics":
      return { colorVar: "--color-track-graphic", icon: FileImage, labelMode: "clip" }
    case "overlay":
      return { colorVar: "--color-track-overlay", icon: FileImage, labelMode: "clip" }
  }
}

/**
 * Per-clip accent override. Clip-kind beats the track color so e.g. a music
 * clip on a mic track still reads as music; labelMode stays track-owned.
 */
export function getClipLaneTheme(clip: TimelineClip, track: TimelineTrack): LaneTheme {
  const trackTheme = getTrackLaneTheme(track)
  if (clip.kind === "annotation") return { ...trackTheme, colorVar: "--color-track-annotation" }
  if (clip.kind === "text") return { ...trackTheme, colorVar: "--color-track-title" }
  if (clip.kind === "image") return { ...trackTheme, colorVar: "--color-track-graphic" }
  if (clip.kind === "mask") return { ...trackTheme, colorVar: "--color-track-effects" }
  if (clip.kind === "caption") return { ...trackTheme, colorVar: "--color-track-captions" }
  if (clip.kind === "audio" && clip.role === "music") {
    return { ...trackTheme, colorVar: "--color-track-music" }
  }
  return trackTheme
}

/** Per-clip icon — mirrors the previous getClipIcon kind map. */
export function getClipIcon(clip: TimelineClip, track: TimelineTrack): LucideIcon {
  if (clip.kind === "screen") return Monitor
  if (clip.kind === "camera") return Video
  if (clip.kind === "cursor-effect") return MousePointer2
  if (clip.kind === "caption") return Captions
  if (clip.kind === "mask") return ShieldAlert
  if (clip.kind === "annotation") return Shapes
  if (clip.kind === "text") return Type
  if (clip.kind === "image") return FileImage
  if (clip.kind === "audio" && clip.role === "music") return Music
  if (track.kind === "audio") return Volume2
  return AudioLines
}

/**
 * Points the generic --color-lane token at a concrete track accent so lane
 * utilities (bg-lane/20, ring-lane/40, text-lane, …) resolve per lane.
 */
export function laneStyle(colorVar: string): CSSProperties {
  return { "--color-lane": `var(${colorVar})` } as CSSProperties
}
