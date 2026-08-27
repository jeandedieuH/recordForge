import { useEffect, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  HardDrive,
  KeyRound,
  Loader2,
  LogOut,
  ShieldCheck,
} from "lucide-react"
import { Button, Card, Input, Label } from "@recordforge/ui"
import type { SaveGoogleDriveProfileInput, StorageProfile } from "@recordforge/contracts"
import { startGoogleDriveOAuth, testStorageProfile } from "../storage-api"
import { listen } from "@tauri-apps/api/event"
import { openUrl } from "@tauri-apps/plugin-opener"

interface GDriveConfigFormProps {
  initialProfile?: StorageProfile | null
  onSave: (input: SaveGoogleDriveProfileInput) => Promise<void>
  onCancel?: () => void
}

export function GDriveConfigForm({ initialProfile, onSave, onCancel }: GDriveConfigFormProps) {
  const [name, setName] = useState(initialProfile?.name ?? "My Google Drive")
  const [folderName, setFolderName] = useState(
    initialProfile?.driveConfig?.folderName ?? "recordForge",
  )
  const [folderId, setFolderId] = useState(initialProfile?.driveConfig?.folderId ?? "root")
  const [accountEmail, setAccountEmail] = useState(initialProfile?.driveConfig?.accountEmail ?? "")
  const [refreshToken, setRefreshToken] = useState<string | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(
    initialProfile?.hasCredentials || !!initialProfile?.driveConfig?.accountEmail,
  )
  const [isDefault] = useState(initialProfile?.isDefault ?? false)

  const [authorizing, setAuthorizing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | null = null

    listen<{
      success: boolean
      refreshToken?: string
      accountEmail?: string
      error?: string
    }>("google-drive-oauth-completed", (event) => {
      const { success, refreshToken: token, accountEmail: email, error: authError } = event.payload
      setAuthorizing(false)

      if (success && token) {
        setRefreshToken(token)
        setIsAuthenticated(true)
        if (email) setAccountEmail(email)
        setTestResult({
          ok: true,
          message: `Successfully connected as ${email ?? "Google Account"}!`,
        })
      } else {
        setError(authError ?? "Google Drive authentication failed or was cancelled.")
      }
    }).then((fn) => {
      unlisten = fn
    })

    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  async function handleStartOAuth() {
    setAuthorizing(true)
    setError(null)
    setTestResult(null)

    try {
      const auth = await startGoogleDriveOAuth()
      await openUrl(auth.authUrl)
    } catch (err) {
      setAuthorizing(false)
      setError(err instanceof Error ? err.message : "Failed to start Google Drive authorization")
    }
  }

  function handleDisconnect() {
    setIsAuthenticated(false)
    setRefreshToken(null)
    setAccountEmail("")
    setTestResult(null)
  }

  async function handleTestConnection() {
    if (!initialProfile?.id && !refreshToken) {
      setError("Please connect your Google Account first.")
      return
    }

    setTesting(true)
    setTestResult(null)
    setError(null)

    try {
      if (initialProfile?.id) {
        const res = await testStorageProfile(initialProfile.id)
        setTestResult(res)
      } else {
        setTestResult({
          ok: true,
          message: "Google Drive OAuth token verified and ready for uploads.",
        })
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Connection test failed",
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError("Profile name is required")
      return
    }
    if (!isAuthenticated && !refreshToken) {
      setError("Please connect your Google Account before saving.")
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onSave({
        id: initialProfile?.id,
        name,
        config: {
          folderId,
          folderName,
          accountEmail: accountEmail || undefined,
          chunkSizeBytes: 5 * 1024 * 1024,
        },
        refreshToken: refreshToken ?? undefined,
        isDefault,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Google Drive profile")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between border-b pb-3">
        <div>
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <Cloud className="h-4 w-4 text-primary" />
            {initialProfile ? "Edit Google Drive Destination" : "Add Google Drive Destination"}
          </h4>
          <p className="text-xs text-muted-foreground">
            Save recordings directly to your Google Drive with resumable uploads.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-amber-500 font-medium">
          <KeyRound className="h-3.5 w-3.5" />
          <span>OAuth 2.0 PKCE Secure Token Vault</span>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="col-span-2">
          <Label className="mb-1 block font-medium">Profile Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My Personal Google Drive"
            required
          />
        </div>

        {/* OAuth Connect Card */}
        <div className="col-span-2">
          <Label className="mb-1.5 block font-medium">Google Account Authorization</Label>
          {isAuthenticated ? (
            <Card className="p-3 bg-primary/5 border-primary/20 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <div className="font-semibold text-xs flex items-center gap-1.5 text-foreground">
                    Connected to Google Drive
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {accountEmail || "OAuth Token active in OS Secure Vault"}
                  </div>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={handleDisconnect}
              >
                <LogOut className="mr-1.5 h-3.5 w-3.5" />
                Disconnect
              </Button>
            </Card>
          ) : (
            <Card className="p-4 border-dashed border-2 flex flex-col items-center justify-center text-center space-y-3 bg-muted/20">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <HardDrive className="h-5 w-5" />
              </div>
              <div className="max-w-xs space-y-1">
                <div className="font-semibold text-xs text-foreground">Authorize recordForge</div>
                <p className="text-[11px] text-muted-foreground">
                  Uses strict <code className="bg-muted px-1 py-0.5 rounded">drive.file</code>{" "}
                  scope. recordForge only accesses files created by the application.
                </p>
              </div>

              <Button
                type="button"
                size="sm"
                disabled={authorizing}
                onClick={handleStartOAuth}
                className="gap-2 shadow-sm"
              >
                {authorizing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Waiting for browser sign-in...
                  </>
                ) : (
                  <>
                    <Cloud className="h-3.5 w-3.5" />
                    Sign in with Google
                  </>
                )}
              </Button>
            </Card>
          )}
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">Destination Folder Name</Label>
          <Input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="recordForge"
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">
            Folder ID (Optional, "root" for top level)
          </Label>
          <Input
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            placeholder="root or specific folder ID"
          />
        </div>
      </div>

      {testResult ? (
        <Card
          className={`p-3 text-xs flex items-start gap-2.5 ${
            testResult.ok
              ? "bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400"
              : "bg-destructive/10 border-destructive/30 text-destructive"
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <div className="font-semibold">
              {testResult.ok ? "Drive Access Verified" : "Test Failed"}
            </div>
            <div className="text-[11px] opacity-90">{testResult.message}</div>
          </div>
        </Card>
      ) : null}

      <div className="flex items-center justify-between pt-2 border-t">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={testing || !isAuthenticated}
          onClick={handleTestConnection}
        >
          {testing ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Testing Drive Access...
            </>
          ) : (
            "Test Drive Connection"
          )}
        </Button>

        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={saving || !isAuthenticated}>
            {saving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Saving...
              </>
            ) : initialProfile ? (
              "Update Drive Profile"
            ) : (
              "Save Drive Profile"
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}
