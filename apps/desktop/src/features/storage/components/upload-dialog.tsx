import { useEffect, useState } from "react"
import { AlertCircle, Cloud, HardDrive, Loader2, Server, UploadCloud } from "lucide-react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SimpleSelect,
} from "@recordforge/ui"
import { toErrorMessage } from "../../../lib/errors"
import { useStorageStore } from "../storage-store"

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  localPath: string
  recordingId?: string
  exportId?: string
  defaultName?: string
  onUploaded?: () => void
}

export function loadProfilesForUploadDialog(
  open: boolean,
  fetchProfiles: () => Promise<void>,
): void {
  if (open) void fetchProfiles()
}

export function UploadDialog({
  open,
  onOpenChange,
  localPath,
  recordingId,
  exportId,
  defaultName,
  onUploaded,
}: UploadDialogProps) {
  const {
    profiles,
    isLoadingProfiles,
    error: profileError,
    fetchProfiles,
    startUpload,
  } = useStorageStore()
  const [hasRequestedProfiles, setHasRequestedProfiles] = useState(false)

  useEffect(() => {
    if (!open) {
      setHasRequestedProfiles(false)
      return
    }

    setHasRequestedProfiles(true)
    loadProfilesForUploadDialog(open, fetchProfiles)
  }, [open, fetchProfiles])

  const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0]
  const [selectedProfileId, setSelectedProfileId] = useState<string>(defaultProfile?.id ?? "")
  const [customName, setCustomName] = useState(defaultName ?? "")
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isLoadingProfileList = open && (!hasRequestedProfiles || isLoadingProfiles)

  async function handleStart() {
    const profileId = selectedProfileId || defaultProfile?.id
    if (!profileId) {
      setError("Please select a cloud storage destination.")
      return
    }

    setIsStarting(true)
    setError(null)

    try {
      await startUpload({
        profileId,
        localPath,
        recordingId,
        exportId,
        customDestinationName: customName.trim() || undefined,
      })
      onOpenChange(false)
      onUploaded?.()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setIsStarting(false)
    }
  }

  const activeProfile = profiles.find((p) => p.id === (selectedProfileId || defaultProfile?.id))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <UploadCloud className="h-4 w-4 text-primary" />
            Upload Video to Cloud
          </DialogTitle>
          <DialogDescription className="text-xs">
            Send your exported video or recording directly to S3 or Google Drive.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {isLoadingProfileList ? (
          <div className="flex items-center justify-center gap-2 rounded-md border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading cloud destinations...
          </div>
        ) : profileError && profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-center text-xs">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <div className="font-semibold">Could not load cloud storage</div>
            <p className="text-muted-foreground text-[11px]">{profileError}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchProfiles()}>
              Retry
            </Button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="p-4 text-center space-y-2 bg-muted/20 rounded-md border text-xs">
            <Cloud className="h-6 w-6 text-muted-foreground mx-auto" />
            <div className="font-semibold">No Cloud Storage Connected</div>
            <p className="text-muted-foreground text-[11px]">
              Configure an S3 bucket or Google Drive in Settings before uploading.
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div>
              <Label className="mb-1 block font-medium">Destination Profile</Label>
              <SimpleSelect
                value={selectedProfileId || defaultProfile?.id}
                onValueChange={(val) => setSelectedProfileId(val)}
                options={profiles.map((p) => ({
                  value: p.id,
                  label: `${p.name} (${p.kind.toUpperCase()})${p.isDefault ? " ★ Default" : ""}`,
                }))}
              />
            </div>

            {activeProfile ? (
              <div className="p-2.5 bg-muted/30 rounded border text-[11px] text-muted-foreground flex items-center gap-2">
                {activeProfile.kind === "s3" ? (
                  <Server className="h-3.5 w-3.5 text-primary" />
                ) : activeProfile.kind === "gdrive" ? (
                  <Cloud className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <HardDrive className="h-3.5 w-3.5 text-primary" />
                )}
                <span>
                  {activeProfile.kind === "s3"
                    ? `Bucket: ${activeProfile.s3Config?.bucket} (${activeProfile.s3Config?.region})`
                    : activeProfile.kind === "gdrive"
                      ? `Folder: ${activeProfile.driveConfig?.folderName}`
                      : `Path: ${activeProfile.localConfig?.destinationPath}`}
                </span>
              </div>
            ) : null}

            <div>
              <Label className="mb-1 block font-medium">Destination File Name (Optional)</Label>
              <Input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="my-video.mp4"
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 pt-2 border-t">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {profiles.length > 0 ? (
            <Button size="sm" disabled={isStarting} onClick={handleStart}>
              {isStarting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Starting...
                </>
              ) : (
                "Start Upload"
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
