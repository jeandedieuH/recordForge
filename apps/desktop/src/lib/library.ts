import { z } from "zod"
import {
  exportOptionsSchema,
  libraryRecordingSchema,
  trimOptionsSchema,
  type ExportOptions,
  type LibraryRecording,
  type TrimOptions,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function listRecordings(): Promise<LibraryRecording[]> {
  return invokeValidated("list_recordings", undefined, z.array(libraryRecordingSchema))
}

export async function deleteRecording(recordingId: string): Promise<void> {
  return invokeValidated<void>("delete_recording", { recordingId })
}

export async function revealRecording(recordingId: string): Promise<void> {
  return invokeValidated<void>("reveal_recording", { recordingId })
}

export async function addRecordingTag(recordingId: string, tag: string): Promise<void> {
  return invokeValidated<void>("add_recording_tag", { recordingId, tag })
}

export async function removeRecordingTag(recordingId: string, tag: string): Promise<void> {
  return invokeValidated<void>("remove_recording_tag", { recordingId, tag })
}

export async function trimRecording(options: TrimOptions): Promise<LibraryRecording> {
  return invokeValidated(
    "trim_recording",
    { options: trimOptionsSchema.parse(options) },
    libraryRecordingSchema,
  )
}

export async function exportRecording(options: ExportOptions): Promise<void> {
  return invokeValidated<void>("export_recording", {
    options: exportOptionsSchema.parse(options),
  })
}

export async function trashRecording(recordingId: string): Promise<void> {
  return invokeValidated<void>("trash_recording", { recordingId })
}

export async function restoreRecording(recordingId: string): Promise<void> {
  return invokeValidated<void>("restore_recording", { recordingId })
}

export async function emptyTrash(): Promise<void> {
  return invokeValidated<void>("empty_trash")
}
