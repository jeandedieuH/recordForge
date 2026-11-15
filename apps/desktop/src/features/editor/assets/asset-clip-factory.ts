import type { ImageClip, ProjectAsset, TimelineCanvas, VideoClip } from "@recordforge/contracts"

export function createImageClipForAsset(
  asset: ProjectAsset,
  startMs: number,
  canvas: TimelineCanvas,
): ImageClip {
  const sourceWidth = Math.max(1, asset.width ?? 400)
  const sourceHeight = Math.max(1, asset.height ?? 300)
  const maxWidth = canvas.width * 0.36
  const maxHeight = canvas.height * 0.36
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1)
  const width = Math.max(40, Math.round(sourceWidth * scale))
  const height = Math.max(40, Math.round(sourceHeight * scale))
  const durationMs = Math.max(1, asset.durationMs || 4_000)

  return {
    id: crypto.randomUUID(),
    kind: "image",
    assetId: asset.id,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    x: Math.max(0, Math.round((canvas.width - width) / 2)),
    y: Math.max(0, Math.round((canvas.height - height) / 2)),
    width,
    height,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    zIndex: 0,
    opacity: 1,
    borderRadius: 8,
    borderWidth: 0,
    borderColor: "white",
    shadowEnabled: true,
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowBlur: 12,
    fit: "contain",
    animationIn: "fade",
    animationOut: "fade",
    overlayAnimation: {
      inType: "fade",
      outType: "fade",
      inDurationMs: 350,
      outDurationMs: 350,
      easing: "expo-out",
    },
    enabled: true,
    locked: false,
  }
}

export function assetDurationMs(asset: ProjectAsset, fallbackMs: number): number {
  return Math.max(1, asset.durationMs || fallbackMs)
}

/**
 * B-roll clip (#13) for an imported video asset. Sizes the layer to two thirds
 * of the canvas at most, so it reads as an overlay rather than a second screen;
 * the inspector can switch it to fullscreen.
 */
export function createVideoClipForAsset(
  asset: ProjectAsset,
  startMs: number,
  canvas: TimelineCanvas,
): VideoClip {
  const sourceWidth = Math.max(1, asset.width ?? 1280)
  const sourceHeight = Math.max(1, asset.height ?? 720)
  const maxWidth = canvas.width * 0.66
  const maxHeight = canvas.height * 0.66
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1)
  const width = Math.max(40, Math.round(sourceWidth * scale))
  const height = Math.max(40, Math.round(sourceHeight * scale))
  const durationMs = assetDurationMs(asset, 5_000)

  return {
    id: crypto.randomUUID(),
    kind: "video",
    assetId: asset.id,
    startMs: Math.max(0, Math.round(startMs)),
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    x: Math.max(0, Math.round((canvas.width - width) / 2)),
    y: Math.max(0, Math.round((canvas.height - height) / 2)),
    width,
    height,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    zIndex: 0,
    opacity: 1,
    borderRadius: 8,
    borderWidth: 0,
    borderColor: "white",
    shadowEnabled: true,
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowBlur: 12,
    fit: "contain",
    layoutMode: "overlay",
    animationIn: "fade",
    animationOut: "fade",
    animationMs: 400,
    volume: 1,
    audioMuted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    enabled: true,
    locked: false,
  }
}
