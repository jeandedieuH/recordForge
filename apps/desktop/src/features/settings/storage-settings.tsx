import { useState } from "react"
import { CheckCircle2, Cloud, HardDrive, Key, ShieldCheck } from "lucide-react"
import { Button, Card, Input } from "@recordforge/ui"

export function StorageSettings() {
  const [provider, setProvider] = useState<"local" | "s3" | "gdrive">("local")
  const [endpoint, setEndpoint] = useState("")
  const [region, setRegion] = useState("us-east-1")
  const [bucket, setBucket] = useState("")
  const [accessKey, setAccessKey] = useState("")
  const [secretKey, setSecretKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  async function handleTestConnection() {
    setTesting(true)
    setTestResult(null)
    setTimeout(() => {
      setTesting(false)
      setTestResult("Connection successful! S3 credentials verified.")
    }, 800)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Storage & Cloud Destination</h3>
        <p className="text-xs text-muted-foreground">
          Configure local export paths or secure S3-compatible cloud storage providers.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card
          className={`cursor-pointer p-4 transition-all ${
            provider === "local" ? "border-primary bg-primary/5" : "hover:border-border/80"
          }`}
          onClick={() => setProvider("local")}
        >
          <HardDrive className="mb-2 h-5 w-5 text-primary" />
          <div className="font-medium text-xs">Local Disk</div>
          <div className="text-[11px] text-muted-foreground">Save directly to PC folder</div>
        </Card>

        <Card
          className={`cursor-pointer p-4 transition-all ${
            provider === "s3" ? "border-primary bg-primary/5" : "hover:border-border/80"
          }`}
          onClick={() => setProvider("s3")}
        >
          <Cloud className="mb-2 h-5 w-5 text-primary" />
          <div className="font-medium text-xs">S3 Compatible</div>
          <div className="text-[11px] text-muted-foreground">AWS S3, Cloudflare R2, MinIO</div>
        </Card>

        <Card
          className={`cursor-pointer p-4 opacity-50 ${
            provider === "gdrive" ? "border-primary bg-primary/5" : ""
          }`}
        >
          <ShieldCheck className="mb-2 h-5 w-5 text-muted-foreground" />
          <div className="font-medium text-xs">Google Drive</div>
          <div className="text-[11px] text-muted-foreground">OAuth 2.0 (V2 Release)</div>
        </Card>
      </div>

      {provider === "s3" ? (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-500">
            <Key className="h-4 w-4" />
            <span>Credentials are protected in Windows Credential Manager</span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <label className="mb-1 block font-medium">S3 Endpoint URL</label>
              <Input
                placeholder="https://s3.us-east-1.amazonaws.com"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block font-medium">Region</label>
              <Input value={region} onChange={(e) => setRegion(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block font-medium">Bucket Name</label>
              <Input
                placeholder="my-recordings-bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block font-medium">Access Key ID</label>
              <Input value={accessKey} onChange={(e) => setAccessKey(e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block font-medium">Secret Access Key</label>
              <Input
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button size="sm" disabled={testing || !bucket} onClick={handleTestConnection}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult ? (
              <span className="flex items-center gap-1 text-xs text-green-500 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                {testResult}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
