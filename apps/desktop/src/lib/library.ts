import { invoke } from "@tauri-apps/api/core"
import type { ExportOptions, LibraryRecording, TrimOptions } from "@recordforge/contracts"

export async function listRecordings(): Promise<LibraryRecording[]> {
  return invoke("list_recordings")
}

export async function deleteRecording(recordingId: string): Promise<void> {
  return invoke("delete_recording", { recordingId })
}

export async function revealRecording(recordingId: string): Promise<void> {
  return invoke("reveal_recording", { recordingId })
}

export async function addRecordingTag(recordingId: string, tag: string): Promise<void> {
  return invoke("add_recording_tag", { recordingId, tag })
}

export async function removeRecordingTag(recordingId: string, tag: string): Promise<void> {
  return invoke("remove_recording_tag", { recordingId, tag })
}

export async function trimRecording(options: TrimOptions): Promise<LibraryRecording> {
  return invoke("trim_recording", { options })
}

export async function exportRecording(options: ExportOptions): Promise<void> {
  return invoke("export_recording", { options })
}
