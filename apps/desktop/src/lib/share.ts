import { z } from "zod"
import { invoke } from "@tauri-apps/api/core"
import {
  exportArtifactInfoSchema,
  publicationJobSchema,
  shareAnalyticsSchema,
  shareExportArgsSchema,
  shareInfoSchema,
  type ExportArtifactInfo,
  type PublicationJob,
  type ShareAnalytics,
  type ShareExportArgs,
  type ShareInfo,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

/**
 * Publish a finished export's MP4 to the hosted share viewer. The request
 * names the export JOB — the path, captions, title, and measurements are
 * resolved natively from the job's frozen artifact. Returns the admitted
 * publication job; results arrive on `publication-job-update`.
 */
export async function shareExport(args: ShareExportArgs): Promise<PublicationJob> {
  const parsed = shareExportArgsSchema.parse(args)
  return invokeValidated("share_export", { args: parsed }, publicationJobSchema)
}

/**
 * BYO-bucket share — uploads the export's MP4 plus a generated player page
 * into the user's configured S3 profile (which must carry a `publicBaseUrl`).
 */
export async function shareToProfile(
  profileId: string,
  args: ShareExportArgs,
): Promise<PublicationJob> {
  const parsed = shareExportArgsSchema.parse(args)
  return invokeValidated("share_to_profile", { profileId, args: parsed }, publicationJobSchema)
}

/** The frozen artifact manifest for a finished export — the delivery card's
 * read model; null when the job has none (legacy/unpublished). */
export async function getExportArtifact(exportJobId: string): Promise<ExportArtifactInfo> {
  return invokeValidated("get_export_artifact", { exportJobId }, exportArtifactInfoSchema)
}

/** One publication job's current state. */
export async function getPublicationJob(jobId: string): Promise<PublicationJob> {
  return invokeValidated("get_publication_job", { jobId }, publicationJobSchema)
}

/** Recent publication jobs — terminal ones are capped at 100 natively. */
export async function listPublicationJobs(): Promise<PublicationJob[]> {
  return invokeValidated("list_publication_jobs", undefined, z.array(publicationJobSchema))
}

/** Request cancellation — the job moves to `cancelling` until its worker
 * unwinds; a confirmed result is never fabricated into a cancel. */
export async function cancelPublicationJob(jobId: string): Promise<PublicationJob> {
  return invokeValidated("cancel_publication_job", { jobId }, publicationJobSchema)
}

/** The owner's hosted links for the management card. Empty list on Free. */
export async function listShares(): Promise<ShareInfo[]> {
  // The command returns a bare array, not a `{shares}` envelope.
  return invokeValidated("list_shares", undefined, z.array(shareInfoSchema))
}

/** Owner analytics for one hosted link — views, uniques, watch time, comments. */
export async function shareAnalytics(shareId: string): Promise<ShareAnalytics> {
  return invokeValidated("share_analytics", { shareId }, shareAnalyticsSchema)
}

/** Extend a live link's 30-day window. */
export async function renewShare(shareId: string): Promise<number> {
  // The command returns the bare epoch-ms i64, not an `{expiresAtMs}` object.
  return invokeValidated("renew_share", { shareId }, z.number().int())
}

/** Permanently remove a share link — deletes the hosted object. */
export async function revokeShare(shareId: string): Promise<void> {
  await invoke("revoke_share", { shareId })
}

/**
 * Set, change, or clear a hosted link's viewer password. `password` sets a
 * new one (the server stores a salted hash); `clear` removes the gate. The
 * two are exclusive — clearing wins if both are passed.
 */
export async function updateSharePassword(
  shareId: string,
  options: { password?: string; clear?: boolean },
): Promise<void> {
  await invoke("update_share_password", {
    shareId,
    password: options.password?.trim() || null,
    clearPassword: options.clear === true,
  })
}
