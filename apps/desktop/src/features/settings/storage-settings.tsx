import { Separator } from "@recordforge/ui"
import { StorageProfilesManager, UploadJobsPanel } from "../storage"

export function StorageSettings() {
  return (
    <div className="space-y-8">
      <StorageProfilesManager />
      <Separator />
      <UploadJobsPanel />
    </div>
  )
}
