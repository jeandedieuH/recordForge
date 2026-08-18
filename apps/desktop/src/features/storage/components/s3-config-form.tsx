import { useState } from "react"
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Server } from "lucide-react"
import { Button, Card, Input, Label, NativeSelect } from "@recordforge/ui"
import type { S3Config, SaveS3ProfileInput, StorageProfile } from "@recordforge/contracts"
import { testS3Credentials } from "../storage-api"

interface S3Preset {
  name: string
  endpoint: string
  region: string
  forcePathStyle: boolean
}

const S3_PRESETS: S3Preset[] = [
  {
    name: "Amazon Web Services (AWS S3)",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    forcePathStyle: false,
  },
  {
    name: "Cloudflare R2",
    endpoint: "https://<account_id>.r2.cloudflarestorage.com",
    region: "auto",
    forcePathStyle: false,
  },
  {
    name: "MinIO (Self-Hosted)",
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    forcePathStyle: true,
  },
  {
    name: "Backblaze B2",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    forcePathStyle: false,
  },
  {
    name: "Wasabi Hot Cloud Storage",
    endpoint: "https://s3.wasabisys.com",
    region: "us-east-1",
    forcePathStyle: false,
  },
  {
    name: "Custom S3 Endpoint",
    endpoint: "",
    region: "us-east-1",
    forcePathStyle: false,
  },
]

interface S3ConfigFormProps {
  initialProfile?: StorageProfile | null
  onSave: (input: SaveS3ProfileInput) => Promise<void>
  onCancel?: () => void
}

export function S3ConfigForm({ initialProfile, onSave, onCancel }: S3ConfigFormProps) {
  const [name, setName] = useState(initialProfile?.name ?? "My S3 Storage")
  const [endpoint, setEndpoint] = useState(initialProfile?.s3Config?.endpoint ?? S3_PRESETS[0].endpoint)
  const [region, setRegion] = useState(initialProfile?.s3Config?.region ?? S3_PRESETS[0].region)
  const [bucket, setBucket] = useState(initialProfile?.s3Config?.bucket ?? "")
  const [prefix, setPrefix] = useState(initialProfile?.s3Config?.prefix ?? "recordings")
  const [accessKeyId, setAccessKeyId] = useState("")
  const [secretAccessKey, setSecretAccessKey] = useState("")
  const [forcePathStyle, setForcePathStyle] = useState(
    initialProfile?.s3Config?.forcePathStyle ?? false
  )
  const [showSecret, setShowSecret] = useState(false)
  const [isDefault] = useState(initialProfile?.isDefault ?? false)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handlePresetChange(presetName: string) {
    const preset = S3_PRESETS.find((p) => p.name === presetName)
    if (preset) {
      if (preset.endpoint) setEndpoint(preset.endpoint)
      setRegion(preset.region)
      setForcePathStyle(preset.forcePathStyle)
    }
  }

  async function handleTestConnection() {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      setError("Please fill in Endpoint, Bucket, Access Key, and Secret Key to test.")
      return
    }

    setTesting(true)
    setTestResult(null)
    setError(null)

    try {
      const config: S3Config = {
        endpoint,
        region,
        bucket,
        prefix,
        partSizeBytes: 8 * 1024 * 1024,
        forcePathStyle,
      }
      const res = await testS3Credentials(config, accessKeyId, secretAccessKey)
      setTestResult(res)
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
    if (!endpoint.trim() || !bucket.trim()) {
      setError("Endpoint and Bucket are required")
      return
    }
    if (!initialProfile?.hasCredentials && (!accessKeyId.trim() || !secretAccessKey.trim())) {
      setError("Access Key ID and Secret Access Key are required")
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onSave({
        id: initialProfile?.id,
        name,
        config: {
          endpoint,
          region,
          bucket,
          prefix,
          partSizeBytes: 8 * 1024 * 1024,
          forcePathStyle,
        },
        accessKeyId,
        secretAccessKey,
        isDefault,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save S3 profile")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between border-b pb-3">
        <div>
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            {initialProfile ? "Edit S3 Destination" : "Add S3-Compatible Destination"}
          </h4>
          <p className="text-xs text-muted-foreground">
            Configure AWS S3, Cloudflare R2, MinIO, or any standard S3 bucket.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-amber-500 font-medium">
          <KeyRound className="h-3.5 w-3.5" />
          <span>Windows Credential Manager Encrypted</span>
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
            placeholder="e.g. AWS Production Recordings"
            required
          />
        </div>

        <div className="col-span-2">
          <Label className="mb-1 block font-medium">Provider Preset</Label>
          <NativeSelect
            onChange={(e) => handlePresetChange(e.target.value)}
            defaultValue={S3_PRESETS[0].name}
          >
            {S3_PRESETS.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">Endpoint URL</Label>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://s3.us-east-1.amazonaws.com"
            required
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">Region</Label>
          <Input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="us-east-1"
            required
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">Bucket Name</Label>
          <Input
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="my-recordings-bucket"
            required
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">Key Prefix / Subfolder (Optional)</Label>
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="recordings/forge"
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">
            Access Key ID {initialProfile?.hasCredentials ? "(Leave blank to keep current)" : ""}
          </Label>
          <Input
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder={initialProfile?.hasCredentials ? "••••••••••••••••" : "AKIAIOSFODNN7EXAMPLE"}
            required={!initialProfile?.hasCredentials}
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <Label className="mb-1 block font-medium">
            Secret Access Key {initialProfile?.hasCredentials ? "(Leave blank to keep current)" : ""}
          </Label>
          <div className="relative">
            <Input
              type={showSecret ? "text" : "password"}
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              placeholder={
                initialProfile?.hasCredentials ? "••••••••••••••••" : "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
              }
              required={!initialProfile?.hasCredentials}
              className="pr-8"
            />
            <button
              type="button"
              onClick={() => setShowSecret(!showSecret)}
              className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
            >
              {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
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
            <div className="font-semibold">{testResult.ok ? "Connection Verified" : "Test Failed"}</div>
            <div className="text-[11px] opacity-90">{testResult.message}</div>
          </div>
        </Card>
      ) : null}

      <div className="flex items-center justify-between pt-2 border-t">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={testing || !bucket || (!accessKeyId && !initialProfile?.hasCredentials)}
          onClick={handleTestConnection}
        >
          {testing ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Testing S3 Connection...
            </>
          ) : (
            "Test S3 Connection"
          )}
        </Button>

        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Saving...
              </>
            ) : initialProfile ? (
              "Update S3 Profile"
            ) : (
              "Save S3 Profile"
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}
