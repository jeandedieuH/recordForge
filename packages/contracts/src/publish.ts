import { z } from "zod"

// YouTube Data API v3 publishing — direct-to-YouTube upload from an exported
// MP4. OAuth uses the same loopback+PKCE flow as Google Drive; the refresh
// token lives in the OS credential vault and never crosses to the frontend.

export const youtubePrivacySchema = z.enum(["private", "unlisted", "public"])
export type YouTubePrivacy = z.infer<typeof youtubePrivacySchema>

export const youtubePublishRequestSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1).max(100),
  description: z.string().max(5000).default(""),
  privacy: youtubePrivacySchema.default("unlisted"),
  // YouTube category 28 = Science & Technology; fits software demos.
  categoryId: z.string().default("28"),
  tags: z.array(z.string()).default([]),
  // Optional SRT sidecar written by the export (captionMode "sidecar").
  captionsPath: z.string().optional(),
  captionsLanguage: z.string().default("en"),
})
export type YouTubePublishRequest = z.infer<typeof youtubePublishRequestSchema>

export const youtubePublishResultSchema = z.object({
  videoId: z.string(),
  url: z.string(),
  captionsAttached: z.boolean(),
})
export type YouTubePublishResult = z.infer<typeof youtubePublishResultSchema>

export const youtubeConnectionSchema = z.object({
  connected: z.boolean(),
  accountLabel: z.string().nullable(),
})
export type YouTubeConnection = z.infer<typeof youtubeConnectionSchema>

export const youtubePublishProgressSchema = z.object({
  stage: z.enum(["uploading", "attaching-captions", "done", "failed"]),
  uploadedBytes: z.number(),
  totalBytes: z.number(),
})
export type YouTubePublishProgress = z.infer<typeof youtubePublishProgressSchema>
