import type { CameraClip, CameraFrame } from "@recordforge/contracts"
import type { CameraFrameCanvas, CameraFramePatch } from "@recordforge/editor-core"

export interface CameraSectionProps {
  clip: CameraClip
  /** The clip's effective frame (`frame` wins, legacy transform migrates). */
  frame: CameraFrame
  canvas: CameraFrameCanvas
  onUpdate: (patch: CameraFramePatch) => void
}
