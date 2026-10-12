import { ShieldAlert } from "lucide-react"
import { Button } from "@recordforge/ui"
import type { PrivacyPane, SystemPermissionsReport } from "@recordforge/contracts"
import { isMac } from "../../../lib/platform"
import { useRecorderStore } from "../../../hooks/use-recorder"

interface PermissionsBannerProps {
  /** Which mode the modal is in — screen kinds need the Screen Recording
   * grant; camera mode needs Camera (and warns on a denied mic). */
  cameraMode: boolean
}

interface MissingGrant {
  pane: PrivacyPane
  title: string
  body: string
}

// Picks the single most relevant missing grant for the active mode — one
// banner, not a pile of overlapping warnings.
function missingGrant(
  cameraMode: boolean,
  p: SystemPermissionsReport,
): MissingGrant | null {
  if (!cameraMode && p.screenRecording !== "granted") {
    return {
      pane: "screen",
      title: "Screen Recording permission required",
      body: "macOS blocks screen capture until RecordForge is enabled under Privacy & Security → Screen Recording. You may need to restart the app after granting.",
    }
  }
  if (cameraMode && (p.camera === "denied" || p.camera === "restricted")) {
    return {
      pane: "camera",
      title: "Camera access is blocked",
      body: "RecordForge cannot open your camera until it is enabled under Privacy & Security → Camera.",
    }
  }
  if (cameraMode && (p.microphone === "denied" || p.microphone === "restricted")) {
    return {
      pane: "microphone",
      title: "Microphone access is blocked",
      body: "Audio will not be captured until RecordForge is enabled under Privacy & Security → Microphone.",
    }
  }
  return null
}

// Truthful TCC state on macOS; other platforms report all-granted and the
// banner renders nothing. Re-fetched on every modal open.
export function PermissionsBanner({ cameraMode }: PermissionsBannerProps) {
  const { permissions, requestPermission, openPrivacySettings, loadPermissions } =
    useRecorderStore()

  if (!isMac || !permissions) return null
  const grant = missingGrant(cameraMode, permissions)
  if (!grant) return null

  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold">{grant.title}</span>
        <span className="leading-relaxed">{grant.body}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-7 border-amber-400/60 bg-transparent text-xs text-amber-900 hover:bg-amber-100 cursor-pointer dark:text-amber-200 dark:hover:bg-amber-900"
          onClick={() => {
            // screenRecording has a prompt API — fire it before sending the
            // user to System Settings; the other kinds deep-link directly.
            if (grant.pane === "screen" || grant.pane === "accessibility") {
              void requestPermission(grant.pane === "screen" ? "screenRecording" : "accessibility")
            }
            void openPrivacySettings(grant.pane)
          }}
        >
          Open Settings
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-7 px-2 text-xs text-amber-900 hover:bg-amber-100 cursor-pointer dark:text-amber-200 dark:hover:bg-amber-900"
          onClick={() => void loadPermissions()}
        >
          Check again
        </Button>
      </div>
    </div>
  )
}
