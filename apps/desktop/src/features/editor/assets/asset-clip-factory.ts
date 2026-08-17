import type { ImageClip, ProjectAsset, TimelineCanvas } from "@recordforge/contracts"

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
