import { useEffect, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Folder,
  HardDrive,
  Loader2,
  Plus,
  Server,
  Star,
  Trash2,
  Wrench,
} from "lucide-react"
import { Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label } from "@recordforge/ui"
import type {
  SaveGoogleDriveProfileInput,
  SaveS3ProfileInput,
  StorageProfile,
  StorageProviderKind,
} from "@recordforge/contracts"
import { useStorageStore } from "../storage-store"
import {
  saveGoogleDriveProfile,
  saveLocalProfile,
  saveS3Profile,
  testStorageProfile,
} from "../storage-api"
import { S3ConfigForm } from "./s3-config-form"
import { GDriveConfigForm } from "./gdrive-config-form"

export function StorageProfilesManager() {
  const { profiles, isLoadingProfiles, fetchProfiles, deleteProfile } = useStorageStore()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedKind, setSelectedKind] = useState<StorageProviderKind>("s3")
  const [editingProfile, setEditingProfile] = useState<StorageProfile | null>(null)

  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({})

  // Local folder form state
  const [localName, setLocalName] = useState("Local Exports Folder")
  const [localPath, setLocalPath] = useState("C:\\Videos\\recordForge")
  const [savingLocal, setSavingLocal] = useState(false)

  useEffect(() => {
    fetchProfiles()
  }, [fetchProfiles])

  async function handleTestProfile(id: string) {
    setTestingId(id)
    try {
      const res = await testStorageProfile(id)
      setTestResults((prev) => ({ ...prev, [id]: res }))
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          message: err instanceof Error ? err.message : "Test failed",
        },
      }))
    } finally {
      setTestingId(null)
    }
  }

  async function handleSaveS3(input: SaveS3ProfileInput) {
    await saveS3Profile(input)
    await fetchProfiles()
    setDialogOpen(false)
    setEditingProfile(null)
  }

  async function handleSaveGDrive(input: SaveGoogleDriveProfileInput) {
    await saveGoogleDriveProfile(input)
    await fetchProfiles()
    setDialogOpen(false)
    setEditingProfile(null)
  }

  async function handleSaveLocal(e: React.FormEvent) {
    e.preventDefault()
    setSavingLocal(true)
    try {
      await saveLocalProfile({
        id: editingProfile?.id,
        name: localName,
        config: { destinationPath: localPath },
        isDefault: editingProfile?.isDefault ?? false,
      })
      await fetchProfiles()
      setDialogOpen(false)
      setEditingProfile(null)
    } finally {
      setSavingLocal(false)
    }
  }

  function handleOpenAdd(kind: StorageProviderKind) {
    setEditingProfile(null)
    setSelectedKind(kind)
    setDialogOpen(true)
  }

  function handleOpenEdit(profile: StorageProfile) {
    setEditingProfile(profile)
    setSelectedKind(profile.kind)
    if (profile.kind === "local" && profile.localConfig) {
      setLocalName(profile.name)
      setLocalPath(profile.localConfig.destinationPath)
    }
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      {/* Header & Quick Add Cards */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">Cloud Storage & Export Destinations</h3>
          <p className="text-xs text-muted-foreground">
            Connect S3 buckets, Google Drive, or local storage for automatic or 1-click video uploads.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => handleOpenAdd("s3")} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" />
            Add S3 Bucket
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleOpenAdd("gdrive")} className="gap-1.5 text-xs">
            <Cloud className="h-3.5 w-3.5 text-primary" />
            Connect Google Drive
          </Button>
        </div>
      </div>

      {/* Provider Quick Picker */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card
          className="p-4 cursor-pointer hover:border-primary/50 transition-all bg-surface border-border hover:bg-surface-dim"
          onClick={() => handleOpenAdd("s3")}
        >
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-xs text-foreground">S3-Compatible Storage</div>
              <div className="text-[11px] text-subtle-foreground">AWS S3, Cloudflare R2, MinIO, Wasabi</div>
            </div>
          </div>
        </Card>

        <Card
          className="p-4 cursor-pointer hover:border-primary/50 transition-all bg-surface border-border hover:bg-surface-dim"
          onClick={() => handleOpenAdd("gdrive")}
        >
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              <Cloud className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-xs text-foreground">Google Drive</div>
              <div className="text-[11px] text-subtle-foreground">OAuth 2.0 PKCE Resumable Uploads</div>
            </div>
          </div>
        </Card>

        <Card
          className="p-4 cursor-pointer hover:border-primary/50 transition-all bg-surface border-border hover:bg-surface-dim"
          onClick={() => handleOpenAdd("local")}
        >
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              <HardDrive className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-xs text-foreground">Local / NAS Folder</div>
              <div className="text-[11px] text-subtle-foreground">Custom local path or network drive</div>
            </div>
          </div>
        </Card>
      </div>

      {/* Saved Profiles List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Configured Destinations ({profiles.length})
          </h4>
        </div>

        {isLoadingProfiles ? (
          <div className="flex items-center justify-center p-8 text-muted-foreground text-xs gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading destinations...
          </div>
        ) : profiles.length === 0 ? (
          <Card className="p-8 border-dashed flex flex-col items-center justify-center text-center space-y-2 bg-muted/10">
            <HardDrive className="h-8 w-8 text-muted-foreground/50" />
            <div className="font-medium text-xs">No Cloud Storage Configured</div>
            <p className="text-[11px] text-muted-foreground max-w-sm">
              All recordings are currently saved to your local library. Add an S3 bucket or Google Drive to enable cloud uploads and sharing.
            </p>
          </Card>
        ) : (
          <div className="grid gap-3">
            {profiles.map((profile) => {
              const test = testResults[profile.id]
              const isTesting = testingId === profile.id

              return (
                <Card
                  key={profile.id}
                  className={`p-4 transition-all ${
                    profile.isDefault ? "border-primary/40 bg-primary/2" : ""
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded bg-muted/60 flex items-center justify-center shrink-0 mt-0.5 text-foreground">
                        {profile.kind === "s3" ? (
                          <Server className="h-4 w-4 text-primary" />
                        ) : profile.kind === "gdrive" ? (
                          <Cloud className="h-4 w-4 text-primary" />
                        ) : (
                          <Folder className="h-4 w-4 text-primary" />
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-foreground">{profile.name}</span>
                          <Badge variant="outline" className="text-[10px] uppercase py-0 px-1.5">
                            {profile.kind === "s3"
                              ? "S3 Bucket"
                              : profile.kind === "gdrive"
                              ? "Google Drive"
                              : "Local Folder"}
                          </Badge>
                          {profile.isDefault ? (
                            <Badge className="text-[10px] py-0 px-1.5 gap-1 bg-primary/10 text-primary hover:bg-primary/20 border-primary/20">
                              <Star className="h-2.5 w-2.5 fill-primary" />
                              Default
                            </Badge>
                          ) : null}
                        </div>

                        <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                          {profile.kind === "s3" && profile.s3Config ? (
                            <>
                              <span>Bucket: <code>{profile.s3Config.bucket}</code></span>
                              <span>Region: {profile.s3Config.region}</span>
                              {profile.s3Config.prefix ? <span>Prefix: /{profile.s3Config.prefix}</span> : null}
                            </>
                          ) : profile.kind === "gdrive" && profile.driveConfig ? (
                            <>
                              <span>Account: {profile.driveConfig.accountEmail ?? "Connected"}</span>
                              <span>Folder: {profile.driveConfig.folderName}</span>
                            </>
                          ) : profile.kind === "local" && profile.localConfig ? (
                            <span>Path: <code>{profile.localConfig.destinationPath}</code></span>
                          ) : null}
                        </div>

                        {test ? (
                          <div
                            className={`flex items-center gap-1.5 text-[11px] font-medium pt-1 ${
                              test.ok ? "text-green-500" : "text-destructive"
                            }`}
                          >
                            {test.ok ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <AlertCircle className="h-3.5 w-3.5" />
                            )}
                            <span>{test.message}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-center">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-xs"
                        disabled={isTesting}
                        onClick={() => handleTestProfile(profile.id)}
                      >
                        {isTesting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          "Test"
                        )}
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-xs"
                        onClick={() => handleOpenEdit(profile)}
                      >
                        <Wrench className="h-3.5 w-3.5 mr-1" />
                        Edit
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => deleteProfile(profile.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Add / Edit Destination Modal */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editingProfile ? `Edit ${editingProfile.name}` : "Configure Storage Destination"}
            </DialogTitle>
            <DialogDescription>
              {selectedKind === "s3"
                ? "Configure AWS S3 or compatible cloud storage provider."
                : selectedKind === "gdrive"
                ? "Connect your Google Drive account with secure OAuth 2.0 PKCE."
                : "Specify an external folder or NAS path for video exports."}
            </DialogDescription>
          </DialogHeader>

          {selectedKind === "s3" ? (
            <S3ConfigForm
              initialProfile={editingProfile}
              onSave={handleSaveS3}
              onCancel={() => setDialogOpen(false)}
            />
          ) : selectedKind === "gdrive" ? (
            <GDriveConfigForm
              initialProfile={editingProfile}
              onSave={handleSaveGDrive}
              onCancel={() => setDialogOpen(false)}
            />
          ) : (
            <form onSubmit={handleSaveLocal} className="space-y-4">
              <div className="space-y-3 text-xs">
                <div>
                  <Label className="mb-1 block font-medium">Profile Name</Label>
                  <Input
                    value={localName}
                    onChange={(e) => setLocalName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label className="mb-1 block font-medium">Destination Folder Path</Label>
                  <Input
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder="C:\Exports or \\NAS\Recordings"
                    required
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="ghost" size="sm" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={savingLocal}>
                  {savingLocal ? "Saving..." : "Save Local Destination"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
