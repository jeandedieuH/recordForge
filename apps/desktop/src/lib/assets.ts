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
import { invokeValidated } from "./ipc"

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
