import {
  cameraFrameSchema,
  type CameraClip,
  type CameraFrame,
  type CameraFrameFraming,
  type CameraFramePlacement,
  type CameraFrameStyle,
  type CameraPlacementPreset,
  type ClipTransform,
} from "@recordforge/contracts"
import type { TimelineCanvas, TimelineState } from "@recordforge/domain"
import {
  autoCameraFrame,
  autoPresetForAspectRatio,
  cameraFrameFromLegacyTransform,
  legacyTransformFromFrame,
  type CameraFrameCanvas,
  type CameraSourceSize,
} from "./camera-frame"

/**
 * Camera frame persistence (ADR 023 phase 4): `CameraClip.frame` is the source
 * of truth. Every command keeps the legacy pixel `transform` mirrored via
 * `legacyTransformFromFrame` so older app versions still render the camera;
 * `frame` wins on read.
 */

/** Deep-partial `CameraFrame` — the payload of `update-camera-frame`. */
export interface CameraFramePatch {
  placement?: {
    mode?: CameraFramePlacement["mode"]
    align?: Partial<CameraFramePlacement["align"]>
    size?: CameraFramePlacement["size"]
    margin?: CameraFramePlacement["margin"]
    anchorTo?: CameraFramePlacement["anchorTo"]
    split?: Partial<CameraFramePlacement["split"]>
    origin?: CameraFramePlacement["origin"]
  }
  shape?: CameraFrame["shape"]
  aspect?: CameraFrame["aspect"]
  cornerRadius?: CameraFrame["cornerRadius"]
  style?: Partial<CameraFrameStyle>
  framing?: Partial<CameraFrameFraming>
  visible?: CameraFrame["visible"]
  preset?: CameraPlacementPreset
}

function frameCanvas(canvas: TimelineCanvas): CameraFrameCanvas {
  return {
    width: canvas.width,
    height: canvas.height,
    padding: canvas.padding,
    aspectRatio: canvas.aspectRatio,
  }
}

function mirrorTransform(
  frame: CameraFrame,
  previous: ClipTransform,
  canvas: CameraFrameCanvas,
  source?: CameraSourceSize,
): ClipTransform {
  const mirrored = legacyTransformFromFrame(frame, canvas, source)
  return {
    ...mirrored,
    // Without a source size the resolver cannot express the crop; keep the
    // stored one rather than regressing to a cover crop.
    crop: mirrored.crop ?? previous.crop,
    // Auto frames inherit the preset's lock (e.g. side-by-side); pinned frames
    // keep the user's own lock flag.
    locked:
      frame.placement.origin === "auto"
        ? (mirrored.locked ?? previous.locked)
        : (previous.locked ?? mirrored.locked),
  }
}

/**
 * Mirror a clip's `frame` back into its legacy `transform` at `canvas`.
 * Returns the input clip unchanged when it carries no frame.
 */
export function syncCameraTransform(
  clip: CameraClip,
  canvas: TimelineCanvas | CameraFrameCanvas,
  source?: CameraSourceSize,
): CameraClip {
  if (!clip.frame) return clip
  const transform = mirrorTransform(clip.frame, clip.transform, canvas, source)
  return { ...clip, transform }
}

function normalizeCameraClip(
  clip: CameraClip,
  canvas: CameraFrameCanvas,
  source?: CameraSourceSize,
): CameraClip {
  const frame = clip.frame ?? cameraFrameFromLegacyTransform(clip.transform, canvas, source)
  const transform = mirrorTransform(frame, clip.transform, canvas, source)
  return { ...clip, frame, transform }
}

/**
 * Give every camera clip a `frame` (migrated from its legacy transform) and a
 * freshly mirrored `transform`. Idempotent: clips that already carry a frame
 * are left alone and the state object is returned unchanged when nothing
 * needed migrating.
 */
export function normalizeCameraFrames(state: TimelineState): TimelineState {
  if (!state.tracks.some((track) => track.clips.some((clip) => clip.kind === "camera"))) {
    return state
  }
  const canvas = frameCanvas(state.canvas)
  let changed = false
  const tracks = state.tracks.map((track) => {
    if (!track.clips.some((clip) => clip.kind === "camera" && !clip.frame)) return track
    const clips = track.clips.map((clip) => {
      if (clip.kind !== "camera" || clip.frame) return clip
      changed = true
      return normalizeCameraClip(clip, canvas)
    })
    return { ...track, clips }
  })
  return changed ? { ...state, tracks } : state
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  // undefined-valued keys compare equal to absent keys — mirrors/patches only
  // differ in whether optional fields are spelled out.
  const aKeys = Object.keys(a as Record<string, unknown>).filter(
    (key) => (a as Record<string, unknown>)[key] !== undefined,
  )
  const bKeys = Object.keys(b as Record<string, unknown>).filter(
    (key) => (b as Record<string, unknown>)[key] !== undefined,
  )
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

function reconcileCameraClip(
  clip: CameraClip,
  canvas: CameraFrameCanvas,
  ratioChanged: boolean,
  previousAspectRatio: TimelineCanvas["aspectRatio"],
): CameraClip {
  const frame = clip.frame ?? cameraFrameFromLegacyTransform(clip.transform, canvas)
  let nextFrame = frame
  if (ratioChanged && frame.placement.origin === "auto") {
    const previousDefault = autoCameraFrame({
      preset: frame.preset ?? autoPresetForAspectRatio(previousAspectRatio),
      aspectRatio: previousAspectRatio,
    })
    const next = autoCameraFrame({
      preset: autoPresetForAspectRatio(canvas.aspectRatio),
      aspectRatio: canvas.aspectRatio,
    })
    nextFrame = cameraFrameSchema.parse({
      ...frame,
      placement: next.placement,
      shape: next.shape,
      aspect: next.aspect,
      cornerRadius: next.cornerRadius,
      // A style the user customised survives the rebuild; a style that still
      // equals the old preset's default tracks the new preset's default.
      style: deepEqual(frame.style, previousDefault.style) ? next.style : frame.style,
      preset: next.preset,
      framing: frame.framing,
      visible: frame.visible,
    })
  }
  const transform = mirrorTransform(nextFrame, clip.transform, canvas)
  if (nextFrame === frame && deepEqual(transform, clip.transform) && clip.frame) return clip
  return { ...clip, frame: nextFrame, transform }
}

/**
 * Re-resolve every camera clip after a canvas change. `origin: "auto"` frames
 * are rebuilt from the new ratio's default preset (keeping framing, visible,
 * and a customised style); pinned frames only re-mirror their transform, which
 * is what keeps pixel geometry correct across resolution-tier changes.
 * `previousCanvas` is the canvas the state was resolved against.
 */
export function reconcileCameraFramesForCanvas(
  state: TimelineState,
  previousCanvas: TimelineCanvas,
): TimelineState {
  const ratioChanged = state.canvas.aspectRatio !== previousCanvas.aspectRatio
  const canvas = frameCanvas(state.canvas)
  let changed = false
  const tracks = state.tracks.map((track) => {
    if (!track.clips.some((clip) => clip.kind === "camera")) return track
    const clips = track.clips.map((clip) => {
      if (clip.kind !== "camera") return clip
      const next = reconcileCameraClip(clip, canvas, ratioChanged, previousCanvas.aspectRatio)
      if (next !== clip) changed = true
      return next
    })
    return { ...track, clips }
  })
  return changed ? { ...state, tracks } : state
}

/**
 * Merge a `CameraFramePatch` into a frame and re-validate it. Touching
 * placement/shape/aspect marks the frame `pinned` and drops its preset label —
 * the user owns the placement now — unless the patch sets `origin` itself.
 */
export function mergeCameraFramePatch(frame: CameraFrame, patch: CameraFramePatch): CameraFrame {
  const pinsPlacement =
    patch.placement !== undefined || patch.shape !== undefined || patch.aspect !== undefined
  const explicitOrigin = patch.placement?.origin !== undefined
  return cameraFrameSchema.parse({
    ...frame,
    placement: {
      ...frame.placement,
      ...patch.placement,
      align: { ...frame.placement.align, ...patch.placement?.align },
      split: { ...frame.placement.split, ...patch.placement?.split },
      ...(pinsPlacement && !explicitOrigin ? { origin: "pinned" as const } : {}),
    },
    shape: patch.shape ?? frame.shape,
    aspect: patch.aspect ?? frame.aspect,
    cornerRadius: patch.cornerRadius ?? frame.cornerRadius,
    style: { ...frame.style, ...patch.style },
    framing: { ...frame.framing, ...patch.framing },
    visible: patch.visible ?? frame.visible,
    preset: pinsPlacement && !explicitOrigin ? undefined : (patch.preset ?? frame.preset),
  })
}

/**
 * Apply a named placement preset: the frame is rebuilt from `autoCameraFrame`
 * (new placement, shape, aspect, radius, default style, `origin: "auto"`),
 * keeping the user's framing and visibility.
 */
export function applyCameraPresetFrame(
  frame: CameraFrame | undefined,
  clip: CameraClip,
  preset: CameraPlacementPreset,
  canvas: TimelineCanvas | CameraFrameCanvas,
): CameraFrame {
  const current = frame ?? cameraFrameFromLegacyTransform(clip.transform, canvas)
  const next = autoCameraFrame({ preset, aspectRatio: canvas.aspectRatio })
  return cameraFrameSchema.parse({
    ...next,
    framing: current.framing,
    visible: current.visible,
  })
}

/**
 * Route a legacy pixel `transform` write through the frame model: migrate it
 * to a frame (preset-matched -> auto, otherwise pinned), keep the existing
 * frame's framing when the transform carries no crop and its cornerRadius
 * (a legacy transform cannot express either), then mirror back.
 */
export function updateCameraClipTransform(
  clip: CameraClip,
  transform: ClipTransform,
  canvas: TimelineCanvas | CameraFrameCanvas,
  source?: CameraSourceSize,
): CameraClip {
  const migrated = cameraFrameFromLegacyTransform(transform, canvas, source)
  const frame = cameraFrameSchema.parse({
    ...migrated,
    framing: transform.crop ? migrated.framing : (clip.frame?.framing ?? migrated.framing),
    cornerRadius: clip.frame?.cornerRadius ?? migrated.cornerRadius,
  })
  return {
    ...clip,
    frame,
    transform: mirrorTransform(frame, transform, canvas, source),
  }
}
