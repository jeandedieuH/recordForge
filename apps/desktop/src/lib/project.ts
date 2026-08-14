import { z } from "zod"
import {
  projectSchema,
  projectSummarySchema,
  type ProjectSummary,
  type recordForgeProject,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export type SaveStatus = "idle" | "saving" | "saved" | "error"

export interface ProjectLoadResult {
  project: recordForgeProject
  missingAssets: string[]
}

const projectLoadResultSchema = z.object({
  project: projectSchema,
  missingAssets: z.array(z.string()),
})

export async function listProjects(): Promise<ProjectSummary[]> {
  return invokeValidated("list_projects", undefined, z.array(projectSummarySchema))
}

export async function loadProject(recordingId: string): Promise<ProjectLoadResult | null> {
  return invokeValidated(
    "load_project_for_recording",
    { recordingId },
    projectLoadResultSchema.nullable(),
  )
}

export async function saveProject(project: recordForgeProject): Promise<recordForgeProject> {
  return invokeValidated("save_project", { project }, projectSchema)
}

export async function createProject(project: recordForgeProject): Promise<recordForgeProject> {
  return invokeValidated("create_project", { project }, projectSchema)
}

export async function renameProject(
  recordingId: string,
  newName: string,
): Promise<recordForgeProject> {
  return invokeValidated("rename_project", { recordingId, newName }, projectSchema)
}

export async function duplicateProject(
  recordingId: string,
  newName?: string,
): Promise<recordForgeProject> {
  return invokeValidated("duplicate_project", { recordingId, newName }, projectSchema)
}

export async function deleteProject(recordingId: string): Promise<void> {
  return invokeValidated<void>("delete_project", { recordingId })
}

export async function relinkProjectAsset(
  recordingId: string,
  assetId: string,
  newPath: string,
): Promise<recordForgeProject> {
  return invokeValidated("relink_project_asset", { recordingId, assetId, newPath }, projectSchema)
}

export async function snapshotProject(recordingId: string): Promise<string> {
  return invokeValidated<string>("snapshot_project", { recordingId })
}
