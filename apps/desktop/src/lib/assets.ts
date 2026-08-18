import {
  assetDerivativeJobRequestSchema,
  assetImportRequestSchema,
  assetImportResultSchema,
  assetProbeRequestSchema,
  assetRelinkRequestSchema,
  mediaJobSchema,
  mediaMetadataSchema,
  projectAssetPathMapSchema,
  projectAssetSchema,
  type AssetDerivativeJobRequest,
  type AssetImportRequest,
  type AssetImportResult,
  type AssetProbeRequest,
  type AssetRelinkRequest,
  type ProjectAssetPathMap,
  type ProjectAsset,
  type MediaJob,
  type MediaMetadata,
} from "@recordforge/contracts"
import { convertFileSrc } from "@tauri-apps/api/core"
import { invokeValidated } from "./ipc"
import { isTauri } from "./settings"

/**
 * Normalizes Windows and POSIX paths by converting backslashes to forward slashes
 * and stripping Windows extended-length verbatim prefixes (`\\?\` and `\\?\UNC\`).
 */
export function normalizePath(path: string | null | undefined): string | null {
  if (!path) return null
  let normalized = path.replace(/\\/g, "/")
  if (normalized.startsWith("//?/UNC/")) {
    normalized = "//" + normalized.slice(8)
  } else if (normalized.startsWith("//?/")) {
    normalized = normalized.slice(4)
  }
  return normalized
}

/** Check if a string is already a valid web/blob/data/asset URL. */
export function isWebUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return /^(?:https?|blob|data|asset):/i.test(url)
}

/** Check if a path is an absolute filesystem path (POSIX, UNC, or Windows drive letter). */
export function isAbsolutePath(path: string | null | undefined): boolean {
  if (!path) return false
  const clean = normalizePath(path)
  if (!clean) return false
  return /^(?:[a-zA-Z]:[/\\]|\/|\\\\)/.test(clean)
}

/**
 * Resolves a project asset path to an absolute path.
 * If the path is already absolute or a web URL, it is returned directly.
 * If the path is project-relative and a work directory is provided, it resolves against workDir.
 */
export function resolveAssetPath(
  path: string | null | undefined,
  workDir?: string | null,
): string | null {
  if (!path) return null
  if (isWebUrl(path)) return path

  const clean = normalizePath(path)
  if (!clean) return null
  if (isAbsolutePath(clean)) return clean

  if (workDir) {
    const cleanWorkDir = normalizePath(workDir)?.replace(/\/+$/, "")
    const cleanPath = clean.replace(/^\/+/, "")
    return cleanWorkDir ? `${cleanWorkDir}/${cleanPath}` : cleanPath
  }
  return null
}

/**
 * Converts a filesystem path or URL to an asset URL safe for use in Tauri or the browser.
 * Never passes unresolved relative paths to convertFileSrc to prevent Tauri protocol errors.
 */
export function toAssetUrl(
  path: string | null | undefined,
  workDir?: string | null,
): string | null {
  if (!path) return null
  if (isWebUrl(path)) return path

  const resolved = resolveAssetPath(path, workDir)
  if (!resolved) {
    return isTauri() ? null : path
  }

  return isTauri() ? convertFileSrc(resolved) : resolved
}

export function importAssets(request: AssetImportRequest): Promise<AssetImportResult> {
  return invokeValidated(
    "import_assets",
    { request: assetImportRequestSchema.parse(request) },
    assetImportResultSchema,
  )
}

export function deleteAsset(request: {
  recordingId: string
  assetId: string
  deleteSource?: boolean
}): Promise<void> {
  return invokeValidated<void>("delete_asset", {
    request: {
      recordingId: request.recordingId,
      assetId: request.assetId,
      deleteSource: request.deleteSource ?? false,
    },
  })
}

export function relinkAsset(request: AssetRelinkRequest): Promise<ProjectAsset> {
  return invokeValidated(
    "relink_asset",
    { request: assetRelinkRequestSchema.parse(request) },
    projectAssetSchema,
  )
}

export function probeAsset(request: AssetProbeRequest): Promise<MediaMetadata> {
  return invokeValidated(
    "probe_asset",
    { request: assetProbeRequestSchema.parse(request) },
    mediaMetadataSchema,
  )
}

export function startAssetDerivativeJob(request: AssetDerivativeJobRequest): Promise<MediaJob> {
  return invokeValidated(
    "start_derivative_job",
    { request: assetDerivativeJobRequestSchema.parse(request) },
    mediaJobSchema,
  )
}

export function getProjectAssetPaths(recordingId: string): Promise<ProjectAssetPathMap> {
  return invokeValidated("get_project_asset_paths", { recordingId }, projectAssetPathMapSchema)
}
