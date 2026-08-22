import type { StorageProfile, StorageProviderKind, UploadJobState } from "@recordforge/contracts"

export interface UploadProgress {
  bytesUploaded: number
  totalBytes: number
  percentage: number
  speedBps?: number
  etaSeconds?: number
}

export interface UploadOptions {
  localPath: string
  destinationName: string
  onProgress?: (progress: UploadProgress) => void
  abortSignal?: AbortSignal
}

export interface UploadResult {
  ok: boolean
  url?: string
  error?: string
}

export interface StorageProvider {
  readonly kind: StorageProviderKind
  readonly name: string
  upload(options: UploadOptions): Promise<UploadResult>
  testConnection?(): Promise<{ ok: boolean; message: string }>
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind: StorageProviderKind = "local"
  readonly name = "Local Disk"

  async upload(options: UploadOptions): Promise<UploadResult> {
    options.onProgress?.({
      bytesUploaded: 100,
      totalBytes: 100,
      percentage: 100,
      speedBps: 0,
      etaSeconds: 0,
    })
    return { ok: true, url: options.localPath }
  }
}

/** Formats bytes into human-readable string (KB, MB, GB) */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes <= 0) return "0 B"
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

/** Formats transfer speed (bytes per second) to human-readable string */
export function formatSpeed(speedBps: number): string {
  if (speedBps <= 0) return "0 KB/s"
  return `${formatBytes(speedBps)}/s`
}

/** Formats ETA seconds into human-readable minutes/seconds */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--"
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = Math.ceil(seconds % 60)
  return `${minutes}m ${remainingSecs}s`
}

/** Computes upload progress metrics */
export function calculateProgress(
  bytesUploaded: number,
  totalBytes: number,
  speedBps?: number | null,
): UploadProgress {
  const currentSpeed = speedBps ?? 0
  const percentage = totalBytes > 0 ? Math.min(100, (bytesUploaded / totalBytes) * 100) : 0
  const remainingBytes = Math.max(0, totalBytes - bytesUploaded)
  const etaSeconds = currentSpeed > 0 ? remainingBytes / currentSpeed : 0

  return {
    bytesUploaded,
    totalBytes,
    percentage: Math.round(percentage * 10) / 10,
    speedBps: currentSpeed,
    etaSeconds: Math.ceil(etaSeconds),
  }
}

/** Checks if a job state is active (in-flight) */
export function isUploadActive(state: UploadJobState): boolean {
  return state === "pending" || state === "uploading"
}

/** Checks if a job state is final (completed, failed, or cancelled) */
export function isUploadTerminal(state: UploadJobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled"
}

/** Validates if a profile has sufficient config to perform an upload */
export function isProfileReadyForUpload(profile: StorageProfile): boolean {
  if (profile.kind === "local") return !!profile.localConfig?.destinationPath
  if (profile.kind === "s3") {
    return (
      profile.hasCredentials &&
      !!profile.s3Config?.endpoint &&
      !!profile.s3Config?.bucket &&
      !!profile.s3Config?.region
    )
  }
  if (profile.kind === "gdrive") {
    return profile.hasCredentials && !!profile.driveConfig?.folderId
  }
  return false
}
