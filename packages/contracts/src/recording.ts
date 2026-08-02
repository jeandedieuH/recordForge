import { z } from "zod"

// Recording source options for screen capture.
export const captureSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("display"),
    id: z.string(),
    name: z.string(),
    bounds: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  }),
  z.object({
    kind: z.literal("window"),
    id: z.string(),
    name: z.string(),
    bounds: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  }),
  z.object({
    kind: z.literal("region"),
    id: z.string(),
    bounds: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  }),
])

export type CaptureSource = z.infer<typeof captureSourceSchema>

export const recordingConfigSchema = z.object({
  source: captureSourceSchema,
  profile: z.enum(["low-impact", "balanced", "smooth-demo", "high-quality", "camera-only"]),
  captureMicrophone: z.boolean(),
  captureSystemAudio: z.boolean(),
  captureWebcam: z.boolean(),
  webcamDeviceId: z.string().optional(),
  microphoneDeviceId: z.string().optional(),
})

export type RecordingConfig = z.infer<typeof recordingConfigSchema>

export const recorderStateSchema = z.enum([
  "idle",
  "selecting-source",
  "configuring",
  "countdown",
  "recording",
  "paused",
  "finalizing",
  "completed",
  "failed",
  "recovering",
  "recovery-required",
])

export type RecorderState = z.infer<typeof recorderStateSchema>
