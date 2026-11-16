import type { TimelineClip } from "@recordforge/domain"

/**
 * Whether a clip's timeline geometry is bounded by the length of a source file.
 *
 * Screen, camera and audio clips reference recorded media: their `sourceOutMs`
 * can never pass the end of that media, so an end trim stops at the source end.
 *
 * Every other kind is a free overlay — titles, annotations, graphics, b-roll
 * layers and masks are not cut from a running clock. They may be stretched to
 * any length, and content past the last screen frame is exported over the
 * freeze-frame tail.
 *
 * The gesture HUD clamp and the committed `trim-clip` command must agree on
 * this rule. When they disagree the drag shows a longer clip and the release
 * clamps it back, which reads to the user as the edit being undone.
 */
export function clipUsesSourceTrimLimits(clip: Pick<TimelineClip, "kind">): boolean {
  return clip.kind === "screen" || clip.kind === "camera" || clip.kind === "audio"
}
