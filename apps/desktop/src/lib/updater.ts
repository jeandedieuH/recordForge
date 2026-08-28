import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater"
import {
  updateDownloadEventSchema,
  updateMetadataSchema,
  updateReadinessSchema,
  type UpdateDownloadEvent,
  type UpdateMetadata,
  type UpdateReadiness,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"
import { isTauri } from "./settings"

const UPDATE_CHECK_TIMEOUT_MS = 30_000
const UPDATE_DOWNLOAD_TIMEOUT_MS = 1_800_000

let pendingUpdate: Update | null = null
let isDownloaded = false

function ensureProductionTauri(): void {
  if (!isTauri() || import.meta.env.DEV) {
    throw new Error("desktop updates are only available in a packaged application")
  }
}

async function closePendingUpdate(): Promise<void> {
  const update = pendingUpdate
  pendingUpdate = null
  isDownloaded = false
  await update?.close().catch(() => undefined)
}

export async function checkForUpdate(): Promise<UpdateMetadata | null> {
  if (!isTauri() || import.meta.env.DEV) return null
  await closePendingUpdate()

  const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS })
  if (!update) return null

  pendingUpdate = update
  return updateMetadataSchema.parse({
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body ?? null,
    pubDate: update.date ?? null,
  })
}

export async function getUpdateReadiness(): Promise<UpdateReadiness> {
  ensureProductionTauri()
  return invokeValidated("get_update_readiness", undefined, updateReadinessSchema)
}

export async function beginUpdateInstall(): Promise<UpdateReadiness> {
  ensureProductionTauri()
  return invokeValidated("begin_update_install", undefined, updateReadinessSchema)
}

export async function cancelUpdateInstall(): Promise<void> {
  if (!isTauri()) return
  await invokeValidated<void>("cancel_update_install")
}

export async function downloadUpdate(onEvent: (event: UpdateDownloadEvent) => void): Promise<void> {
  ensureProductionTauri()
  if (!pendingUpdate) throw new Error("no update is available to download")

  await pendingUpdate.download(
    (event: DownloadEvent) => onEvent(updateDownloadEventSchema.parse(event)),
    { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS },
  )
  isDownloaded = true
}

export async function installDownloadedUpdate(): Promise<void> {
  ensureProductionTauri()
  if (!pendingUpdate || !isDownloaded) {
    throw new Error("the update has not finished downloading")
  }

  const update = pendingUpdate
  await update.install()
  pendingUpdate = null
  isDownloaded = false
  await update.close().catch(() => undefined)
}

export function hasDownloadedUpdate(): boolean {
  return isDownloaded
}
