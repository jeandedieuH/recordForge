import { listen } from "@tauri-apps/api/event"
import {
  AI_CAPTIONS_SETUP_EVENT,
  aiCaptionsSetupProgressSchema,
  aiCaptionsStatusSchema,
  captionCueSchema,
  type AiCaptionsSetupProgress,
  type AiCaptionsStatus,
  type CaptionCue,
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

export function transcribeCaptions(recordingId: string, model: string): Promise<CaptionCue[]> {
  return invokeValidated("transcribe_captions", { recordingId, model }, captionCueSchema.array())
}

export function onAiCaptionsSetupProgress(
  callback: (progress: AiCaptionsSetupProgress) => void,
): Promise<() => void> {
  return listen<unknown>(AI_CAPTIONS_SETUP_EVENT, (event) => {
    const parsed = aiCaptionsSetupProgressSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}
