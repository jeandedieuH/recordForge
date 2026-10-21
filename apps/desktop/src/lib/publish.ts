import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  youtubeConnectionSchema,
  youtubePublishRequestSchema,
  youtubePublishResultSchema,
  type YouTubeConnection,
  type YouTubePublishProgress,
  type YouTubePublishRequest,
  type YouTubePublishResult,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

interface OAuthFlowStartResult {
  authUrl: string
  state: string
  port: number
}

export function startYouTubeOAuth(): Promise<OAuthFlowStartResult> {
  return invoke("start_youtube_oauth")
}

export function youtubeConnectionStatus(): Promise<YouTubeConnection> {
  return invokeValidated("youtube_connection_status", undefined, youtubeConnectionSchema)
}

export function disconnectYouTube(): Promise<void> {
  return invoke("disconnect_youtube")
}

export function publishToYouTube(request: YouTubePublishRequest): Promise<YouTubePublishResult> {
  // Validated before IPC so a stale/malformed request fails locally with a
  // readable zod error instead of a Rust-side deserialization rejection.
  const parsed = youtubePublishRequestSchema.parse(request)
  return invokeValidated("publish_to_youtube", { request: parsed }, youtubePublishResultSchema)
}

export function cancelYouTubePublish(): Promise<void> {
  return invoke("cancel_youtube_publish")
}

export interface YouTubeOAuthCompleted {
  success: boolean
  accountLabel?: string
  error?: string
}

export function onYouTubeOAuthCompleted(
  handler: (event: YouTubeOAuthCompleted) => void,
): Promise<UnlistenFn> {
  return listen<YouTubeOAuthCompleted>("youtube-oauth-completed", (event) => {
    handler(event.payload)
  })
}

export function onYouTubePublishProgress(
  handler: (progress: YouTubePublishProgress) => void,
): Promise<UnlistenFn> {
  return listen<YouTubePublishProgress>("youtube-publish-progress", (event) => {
    handler(event.payload)
  })
}
