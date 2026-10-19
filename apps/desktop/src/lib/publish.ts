import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  PUBLICATION_JOB_EVENT,
  publicationJobSchema,
  youtubeOAuthCompletedSchema,
  youtubePublishRequestSchema,
  type OAuthFlowStartResult,
  type PublicationJob,
  type YouTubeConnection,
  type YouTubeOAuthCompleted,
  type YouTubePublishRequest,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export function startYouTubeOAuth(): Promise<OAuthFlowStartResult> {
  return invoke("start_youtube_oauth")
}

export function youtubeConnectionStatus(): Promise<YouTubeConnection> {
  return invoke("youtube_connection_status")
}

export function disconnectYouTube(): Promise<void> {
  return invoke("disconnect_youtube")
}

/** Publish a finished export to YouTube — returns the admitted publication
 * job; progress arrives via `publication-job-update` / the store. */
export async function publishToYouTube(request: YouTubePublishRequest): Promise<PublicationJob> {
  const parsed = youtubePublishRequestSchema.parse(request)
  return invokeValidated("publish_to_youtube", { request: parsed }, publicationJobSchema)
}

/** Cancellation goes through the shared publication surface. */
export { cancelPublicationJob as cancelPublication } from "./share"

/** OAuth completion — correlated by the flow's `state` so a stale emit from
 * an earlier flow can never mark this attempt connected. */
export function onYouTubeOAuthCompleted(
  handler: (event: YouTubeOAuthCompleted) => void,
): Promise<() => void> {
  return listen<unknown>("youtube-oauth-completed", (event) => {
    const parsed = youtubeOAuthCompletedSchema.safeParse(event.payload)
    if (parsed.success) handler(parsed.data)
  })
}

/** Every publication job state change — the store fans this out. */
export function onPublicationJobUpdate(
  handler: (job: PublicationJob) => void,
): Promise<() => void> {
  return listen<unknown>(PUBLICATION_JOB_EVENT, (event) => {
    const parsed = publicationJobSchema.safeParse(event.payload)
    if (parsed.success) handler(parsed.data)
  })
}
