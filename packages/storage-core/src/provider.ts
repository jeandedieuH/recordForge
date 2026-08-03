export interface UploadProgress {
  bytesUploaded: number
  totalBytes: number
  percentage: number
}

export interface UploadOptions {
  localPath: string
  destinationName: string
  onProgress?: (progress: UploadProgress) => void
}

export interface UploadResult {
  ok: boolean
  url?: string
  error?: string
}

export interface StorageProvider {
  id: string
  name: string
  upload(options: UploadOptions): Promise<UploadResult>
}

export class LocalStorageProvider implements StorageProvider {
  readonly id = "local"
  readonly name = "Local Disk"

  async upload(options: UploadOptions): Promise<UploadResult> {
    options.onProgress?.({
      bytesUploaded: 100,
      totalBytes: 100,
      percentage: 100,
    })
    return { ok: true, url: options.localPath }
  }
}
