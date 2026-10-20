import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type {
  YouTubeConnection,
  YouTubePublishProgress,
  YouTubePublishRequest,
  YouTubePublishResult,
} from "@recordforge/contracts"

interface OAuthFlowStartResult {
  authUrl: string
  state: string
  port: number
}

export function startYouTubeOAuth(): Promise<OAuthFlowStartResult> {
  return invoke("start_youtube_oauth")
}

export function youtubeConnectionStatus(): Promise<YouTubeConnection> {
  return invoke("youtube_connection_status")
}

export function disconnectYouTube(): Promise<void> {
  return invoke("disconnect_youtube")
}

export function publishToYouTube(request: YouTubePublishRequest): Promise<YouTubePublishResult> {
  return invoke("publish_to_youtube", { request })
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
