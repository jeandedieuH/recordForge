import { createServerFn } from "@tanstack/react-start"

export const GITHUB_URL = "https://github.com/jeandedieuH/recordForge"
export const RELEASES_URL = `${GITHUB_URL}/releases`
const LATEST_MANIFEST_URL = `${RELEASES_URL}/latest/download/latest.json`

export type DownloadPlatform = "windows" | "macos" | "linux"
export type DetectedPlatform = DownloadPlatform | "other"

export interface ReleaseAsset {
  id: string
  label: string
  fileName: string
  url: string
  primary: boolean
}

export interface ReleaseInfo {
  version: string
  pubDate: string
  releasesUrl: string
  assets: Record<DownloadPlatform, ReleaseAsset[]>
}

/**
 * Resolves the newest desktop release from the `latest.json` updater manifest
 * published by release-desktop.yml. Server-side fetch avoids GitHub API rate
 * limits and CORS; asset URLs are built from the version + CI naming scheme.
 * Returns null when no release exists or the manifest can't be read.
 */
export const getLatestRelease = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReleaseInfo | null> => {
    try {
      const res = await fetch(LATEST_MANIFEST_URL, {
        headers: { accept: "application/json" },
      })
      if (!res.ok) return null
      const manifest = (await res.json()) as { version?: string; pub_date?: string }
      if (!manifest.version) return null

      const v = manifest.version
      const base = `${RELEASES_URL}/download/app-v${v}`

      return {
        version: v,
        pubDate: manifest.pub_date ?? "",
        releasesUrl: `${RELEASES_URL}/latest`,
        assets: {
          windows: [
            {
              id: "nsis",
              label: "Installer (.exe)",
              fileName: `RecordForge_${v}_x64-setup.exe`,
              url: `${base}/RecordForge_${v}_x64-setup.exe`,
              primary: true,
            },
            {
              id: "msi",
              label: "MSI package (.msi)",
              fileName: `RecordForge_${v}_x64_en-US.msi`,
              url: `${base}/RecordForge_${v}_x64_en-US.msi`,
              primary: false,
            },
          ],
          macos: [
            {
              id: "dmg",
              label: "Apple Silicon (.dmg)",
              fileName: `RecordForge_${v}_aarch64.dmg`,
              url: `${base}/RecordForge_${v}_aarch64.dmg`,
              primary: true,
            },
            {
              id: "dmg-intel",
              label: "Intel (.dmg)",
              fileName: `RecordForge_${v}_x64.dmg`,
              url: `${base}/RecordForge_${v}_x64.dmg`,
              primary: false,
            },
          ],
          linux: [
            {
              id: "appimage",
              label: "AppImage",
              fileName: `RecordForge_${v}_amd64.AppImage`,
              url: `${base}/RecordForge_${v}_amd64.AppImage`,
              primary: true,
            },
            {
              id: "deb",
              label: "Debian package (.deb)",
              fileName: `RecordForge_${v}_amd64.deb`,
              url: `${base}/RecordForge_${v}_amd64.deb`,
              primary: false,
            },
          ],
        },
      }
    } catch {
      return null
    }
  },
)

/** Client-side OS detection; returns "other" during SSR or on unknown agents. */
export function detectPlatform(): DetectedPlatform {
  if (typeof navigator === "undefined") return "other"
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes("windows")) return "windows"
  if (ua.includes("mac os") || ua.includes("macos") || ua.includes("macintosh")) return "macos"
  if (ua.includes("linux") || ua.includes("x11")) return "linux"
  return "other"
}

export const PLATFORM_META: Record<
  DownloadPlatform,
  { name: string; tagline: string; notes: string[] }
> = {
  windows: {
    name: "Windows",
    tagline: "Windows 10 / 11 · 64-bit",
    notes: [
      "If SmartScreen appears, choose “More info” → “Run anyway”.",
      "In-app updates keep you on the latest release automatically.",
    ],
  },
  macos: {
    name: "macOS",
    tagline: "Apple Silicon & Intel · macOS 12.3+",
    notes: [
      "Open the DMG and drag recordForge into Applications.",
      "Apple Silicon build for M-series Macs; Intel build for older x86 Macs.",
    ],
  },
  linux: {
    name: "Linux",
    tagline: "x86_64 · Ubuntu 22.04+, Fedora 38+",
    notes: [
      "AppImage: chmod +x, then run it.",
      "Some distros need WebKit2GTK 4.1 and AppIndicator installed.",
    ],
  },
}
