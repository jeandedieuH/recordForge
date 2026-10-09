import { listen } from "@tauri-apps/api/event"
import {
  VIRTUAL_BACKGROUND_DOWNLOAD_EVENT,
  virtualBackgroundDownloadProgressSchema,
  virtualBackgroundStatusSchema,
  type VirtualBackgroundDownloadProgress,
  type VirtualBackgroundStatus,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

// Virtual background (Pro) — on-device MediaPipe segmentation; the ~450 KB
// model is downloaded on demand and nothing leaves the device.
export function getVirtualBackgroundStatus(): Promise<VirtualBackgroundStatus> {
  return invokeValidated("get_virtual_background_status", {}, virtualBackgroundStatusSchema)
}

export function downloadVirtualBackgroundModel(): Promise<void> {
  return invokeValidated("download_virtual_background_model", {})
}

export function deleteVirtualBackgroundModel(): Promise<void> {
  return invokeValidated("delete_virtual_background_model", {})
}

export function onVirtualBackgroundDownloadProgress(
  callback: (progress: VirtualBackgroundDownloadProgress) => void,
): Promise<() => void> {
  return listen<unknown>(VIRTUAL_BACKGROUND_DOWNLOAD_EVENT, (event) => {
    const parsed = virtualBackgroundDownloadProgressSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}
