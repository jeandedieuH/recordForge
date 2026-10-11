import { listen } from "@tauri-apps/api/event"
import {
  AI_CAPTIONS_PROGRESS_EVENT,
  AI_CAPTIONS_SETUP_EVENT,
  aiCaptionsProgressSchema,
  aiCaptionsSetupProgressSchema,
  aiCaptionsStatusSchema,
  transcriptSchema,
  type AiCaptionsProgress,
  type AiCaptionsSetupProgress,
  type AiCaptionsStatus,
  type TranscribeRequest,
  type Transcript,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

// AI Captions (Pro) — on-device whisper.cpp transcription; the engine is
// downloaded on demand and nothing leaves the device.
export function getAiCaptionsStatus(): Promise<AiCaptionsStatus> {
  return invokeValidated("get_ai_captions_status", {}, aiCaptionsStatusSchema)
}

export function downloadAiCaptionsEngine(model: string): Promise<void> {
  return invokeValidated("download_ai_captions_engine", { model })
}

export function deleteAiCaptionsModel(model: string): Promise<void> {
  return invokeValidated("delete_ai_captions_model", { model })
}

// Word-level transcription — the newer engine path; times are in the
// recording asset's container timeline so segmentation can map them onto
// AudioClip ranges directly.
export function transcribeAudio(request: TranscribeRequest): Promise<Transcript> {
  return invokeValidated("transcribe_audio", { request }, transcriptSchema)
}

export function cancelTranscription(jobId: string): Promise<void> {
  return invokeValidated("cancel_transcription", { jobId })
}

export function onAiCaptionsProgress(
  callback: (progress: AiCaptionsProgress) => void,
): Promise<() => void> {
  return listen<unknown>(AI_CAPTIONS_PROGRESS_EVENT, (event) => {
    const parsed = aiCaptionsProgressSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}

export function onAiCaptionsSetupProgress(
  callback: (progress: AiCaptionsSetupProgress) => void,
): Promise<() => void> {
  return listen<unknown>(AI_CAPTIONS_SETUP_EVENT, (event) => {
    const parsed = aiCaptionsSetupProgressSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}
