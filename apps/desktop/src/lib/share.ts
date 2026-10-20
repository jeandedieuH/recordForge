import { z } from "zod"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  SHARE_PROGRESS_EVENT,
  shareListSchema,
  shareProgressSchema,
  shareRenewSchema,
  shareResultSchema,
  shareAnalyticsSchema,
  type ShareAnalytics,
  type ShareInfo,
  type ShareProgress,
  type ShareResult,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

/**
 * Args for `share_export` — the Rust command validates again; this schema
 * keeps the caller honest about the export's metadata.
 */
export const shareExportArgsSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  durationMs: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  chapters: z.array(z.object({ t: z.number(), label: z.string() })).default([]),
  allowDownload: z.boolean().default(true),
  allowEmbed: z.boolean().default(true),
  captionsPath: z.string().min(1).optional(),
  // Pro Cloud extras — empty/omitted password = public link.
  password: z.string().max(128).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})
export type ShareExportArgs = z.infer<typeof shareExportArgsSchema>

/** Upload a finished MP4 export to the hosted share viewer. Pro-gated. */
export async function shareExport(args: ShareExportArgs): Promise<ShareResult> {
  const parsed = shareExportArgsSchema.parse(args)
  return invokeValidated("share_export", { args: parsed }, shareResultSchema)
}

/** Upload progress while the multipart PUTs stream — mirrors the viewer bar. */
export function onShareProgress(callback: (progress: ShareProgress) => void): Promise<() => void> {
  return listen<unknown>(SHARE_PROGRESS_EVENT, (event) => {
    const parsed = shareProgressSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}

/**
 * BYO-bucket share — uploads the MP4 plus a generated player page into the
 * user's configured S3 profile. Returns the player's public URL.
 */
export async function shareToProfile(
  profileId: string,
  args: ShareExportArgs,
): Promise<ShareResult> {
  const parsed = shareExportArgsSchema.parse(args)
  return invokeValidated("share_to_profile", { profileId, args: parsed }, shareResultSchema)
}

/** The owner's hosted links for the management card. Empty list on Free. */
export async function listShares(): Promise<ShareInfo[]> {
  const result = await invokeValidated("list_shares", undefined, shareListSchema)
  return result.shares
}

/** Owner analytics for one hosted link — views, uniques, watch time, comments. */
export async function shareAnalytics(shareId: string): Promise<ShareAnalytics> {
  return invokeValidated("share_analytics", { shareId }, shareAnalyticsSchema)
}

/** Extend a live link's 30-day window. */
export async function renewShare(shareId: string): Promise<number> {
  const result = await invokeValidated("renew_share", { shareId }, shareRenewSchema)
  return result.expiresAtMs
}

/** Permanently remove a share link — deletes the hosted object. */
export async function revokeShare(shareId: string): Promise<void> {
  await invoke("revoke_share", { shareId })
}
