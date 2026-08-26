#!/usr/bin/env node

/**
 * setup-ffmpeg — Downloads and stages FFmpeg + FFprobe for Tauri sidecar bundling.
 *
 * Supports:
 *   - Windows (x86_64-pc-windows-msvc) via GyanD GitHub release essentials
 *   - macOS Apple Silicon (aarch64-apple-darwin) via Martin Riedl builds
 *   - macOS Intel (x86_64-apple-darwin) via Martin Riedl builds
 *   - Linux (x86_64-unknown-linux-gnu) via Martin Riedl builds
 *
 * Pinned version: FFmpeg 9.0.1
 *
 * Usage:
 *   node tooling/ffmpeg/setup.mjs            # from repo root (detects host OS/arch)
 *   bun run setup:ffmpeg                     # via root convenience script
 */

import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { platform, arch } from "node:os"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FFMPEG_VERSION = "9.0.1"

const TARGET_CONFIGS = {
  "x86_64-pc-windows-msvc": {
    os: "win32",
    arch: "x64",
    ext: ".exe",
    sources: [
      {
        label: "gyan-essentials",
        provides: ["ffmpeg", "ffprobe"],
        versionedUrl: `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`,
        fallbackUrl: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        archiveType: "zip",
      },
    ],
  },
  "aarch64-apple-darwin": {
    os: "darwin",
    arch: "arm64",
    ext: "",
    sources: [
      {
        label: "ffmpeg",
        provides: ["ffmpeg"],
        versionedUrl:
          "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
        fallbackUrl: "https://evermeet.cx/ffmpeg/ffmpeg-9.0.1.zip",
        archiveType: "zip",
      },
      {
        label: "ffprobe",
        provides: ["ffprobe"],
        versionedUrl:
          "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip",
        fallbackUrl: "https://evermeet.cx/ffmpeg/ffprobe-9.0.1.zip",
        archiveType: "zip",
      },
    ],
  },
  "x86_64-apple-darwin": {
    os: "darwin",
    arch: "x64",
    ext: "",
    sources: [
      {
        label: "ffmpeg",
        provides: ["ffmpeg"],
        versionedUrl:
          "https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip",
        fallbackUrl: "https://evermeet.cx/ffmpeg/ffmpeg-9.0.1.zip",
        archiveType: "zip",
      },
      {
        label: "ffprobe",
        provides: ["ffprobe"],
        versionedUrl:
          "https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffprobe.zip",
        fallbackUrl: "https://evermeet.cx/ffmpeg/ffprobe-9.0.1.zip",
        archiveType: "zip",
      },
    ],
  },
  "x86_64-unknown-linux-gnu": {
    os: "linux",
    arch: "x64",
    ext: "",
    sources: [
      {
        label: "ffmpeg",
        provides: ["ffmpeg"],
        versionedUrl:
          "https://ffmpeg.martin-riedl.de/redirect/latest/linux/amd64/release/ffmpeg.zip",
        fallbackUrl: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
        archiveType: "zip",
        fallbackArchiveType: "tar.xz",
      },
      {
        label: "ffprobe",
        provides: ["ffprobe"],
        versionedUrl:
          "https://ffmpeg.martin-riedl.de/redirect/latest/linux/amd64/release/ffprobe.zip",
        fallbackUrl: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
        archiveType: "zip",
        fallbackArchiveType: "tar.xz",
      },
    ],
  },
}

const BINARIES = ["ffmpeg", "ffprobe"]

// ---------------------------------------------------------------------------
// Derived paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..", "..")
const BINARIES_DIR = join(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries")
const STAMP_FILE = join(BINARIES_DIR, ".ffmpeg-version")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[setup-ffmpeg] ${msg}`)
}

function warn(msg) {
  console.warn(`[setup-ffmpeg] ⚠ ${msg}`)
}

function fatal(msg) {
  console.error(`[setup-ffmpeg] ✖ ${msg}`)
  process.exit(1)
}

function getHostTargetTriple() {
  const currentPlatform = platform()
  const currentArch = arch()

  if (currentPlatform === "win32" && currentArch === "x64") {
    return "x86_64-pc-windows-msvc"
  }
  if (currentPlatform === "darwin") {
    return currentArch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  }
  if (currentPlatform === "linux" && currentArch === "x64") {
    return "x86_64-unknown-linux-gnu"
  }

  // Fallback for Windows
  return "x86_64-pc-windows-msvc"
}

function isAlreadySetup(targetTriple) {
  if (!existsSync(STAMP_FILE)) return false

  const stamp = readFileSync(STAMP_FILE, "utf-8")
  if (!stamp.includes(`${targetTriple}:${FFMPEG_VERSION}`)) return false

  const config = TARGET_CONFIGS[targetTriple]
  if (!config) return false

  for (const name of BINARIES) {
    const dest = join(BINARIES_DIR, `${name}-${targetTriple}${config.ext}`)
    if (!existsSync(dest)) return false
  }

  return true
}

async function download(url, dest) {
  log(`Downloading ${url} ...`)
  const res = await fetch(url, {
    headers: {
      "User-Agent": "recordForge-setup-ffmpeg/1.0",
    },
    redirect: "follow",
  })

  if (res.status === 404) {
    return false
  }

  if (!res.ok) {
    fatal(`HTTP ${res.status} ${res.statusText} from ${url}`)
  }

  const fileStream = createWriteStream(dest)

  const closed = new Promise((resolve, reject) => {
    fileStream.on("close", resolve)
    fileStream.on("error", reject)
  })

  await pipeline(Readable.fromWeb(res.body), fileStream)
  await closed

  const stats = statSync(dest)
  log(`Downloaded ${(stats.size / 1024 / 1024).toFixed(1)} MB`)
  return true
}

function extractArchive(archivePath, extractDir, archiveType) {
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })

  if (archiveType === "zip") {
    extractZip(archivePath, extractDir)
  } else if (archiveType === "tar.xz") {
    extractTarXz(archivePath, extractDir)
  } else {
    fatal(`Unknown archive type: ${archiveType}`)
  }
}

function extractZip(zipPath, destDir) {
  if (platform() === "win32") {
    const psScript = `
      $dest = '${destDir.replace(/'/g, "''")}'
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', $dest)
    `

    execFileSync("powershell", ["-NoProfile", "-Command", psScript], {
      stdio: "inherit",
    })
  } else {
    try {
      execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "inherit" })
    } catch (err) {
      fatal(`Failed to extract zip: ${err.message}. Make sure 'unzip' is installed.`)
    }
  }
}

function extractTarXz(tarPath, destDir) {
  try {
    execFileSync("tar", ["-xf", tarPath, "-C", destDir], { stdio: "inherit" })
  } catch (err) {
    fatal(`Failed to extract tar.xz: ${err.message}. Make sure 'tar' supports xz.`)
  }
}

function* walkDirectory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkDirectory(full)
    } else {
      yield full
    }
  }
}

function locateBinary(extractDir, name, ext) {
  const target = `${name}${ext}`
  for (const file of walkDirectory(extractDir)) {
    if (basename(file) === target) {
      return file
    }
  }
  return undefined
}

function stageBinary(srcPath, destPath) {
  mkdirSync(dirname(destPath), { recursive: true })
  copyFileSync(srcPath, destPath)
  if (platform() !== "win32") {
    chmodSync(destPath, 0o755)
  }
}

function verifyBinaries(targetTriple) {
  const currentTriple = getHostTargetTriple()
  if (targetTriple !== currentTriple) {
    log(`Skipping direct execution verification for foreign target triple: ${targetTriple}`)
    return
  }

  const config = TARGET_CONFIGS[targetTriple]
  for (const name of BINARIES) {
    const binPath = join(BINARIES_DIR, `${name}-${targetTriple}${config.ext}`)
    if (!existsSync(binPath)) {
      fatal(`Binary does not exist: ${binPath}`)
    }

    try {
      const output = execFileSync(binPath, ["-version"], {
        encoding: "utf-8",
        timeout: 10_000,
      })

      const firstLine = output.split("\n")[0] ?? ""
      log(`✓ ${name}: ${firstLine.trim()}`)

      if (!firstLine.includes(FFMPEG_VERSION)) {
        warn(
          `${name} reports a version other than the pinned ${FFMPEG_VERSION}: ${firstLine.trim()}`,
        )
      }
    } catch (err) {
      fatal(`${name} verification failed: ${err.message}`)
    }
  }
}

function writeStamp(targetTriple) {
  const lines = existsSync(STAMP_FILE)
    ? readFileSync(STAMP_FILE, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : []

  const withoutCurrent = lines.filter((line) => !line.startsWith(`${targetTriple}:`))
  withoutCurrent.push(`${targetTriple}:${FFMPEG_VERSION}`)

  writeFileSync(STAMP_FILE, withoutCurrent.join("\n") + "\n", "utf-8")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function setupSource(targetTriple, config, source) {
  const tempFile = join(__dirname, `ffmpeg-download-${targetTriple}-${source.label}.tmp`)
  const extractDir = join(__dirname, `ffmpeg-extract-${targetTriple}-${source.label}`)

  try {
    let usedFallback = false
    let downloaded = await download(source.versionedUrl, tempFile)

    if (!downloaded && source.fallbackUrl) {
      log(`Versioned URL returned 404 — trying fallback URL: ${source.fallbackUrl} ...`)
      downloaded = await download(source.fallbackUrl, tempFile)
      usedFallback = true
    }

    if (!downloaded) {
      fatal(`Could not download FFmpeg source for ${targetTriple}/${source.label}`)
    }

    const archiveType = usedFallback
      ? (source.fallbackArchiveType ?? source.archiveType)
      : source.archiveType

    log(`Extracting ${source.label} archive (${archiveType}) ...`)
    extractArchive(tempFile, extractDir, archiveType)

    for (const name of source.provides) {
      const binPath = locateBinary(extractDir, name, config.ext)
      if (!binPath) {
        fatal(`${name} not found in extracted ${source.label} archive for ${targetTriple}`)
      }

      const destPath = join(BINARIES_DIR, `${name}-${targetTriple}${config.ext}`)
      log(`Staging ${destPath} ...`)
      stageBinary(binPath, destPath)
    }
  } finally {
    for (const p of [tempFile, extractDir]) {
      if (existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true })
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}

async function setupTarget(targetTriple) {
  const config = TARGET_CONFIGS[targetTriple]
  if (!config) {
    fatal(`Unsupported target triple: ${targetTriple}`)
  }

  log(`Setting up FFmpeg ${FFMPEG_VERSION} for ${targetTriple}`)

  if (isAlreadySetup(targetTriple)) {
    log(`FFmpeg binaries for ${targetTriple} already set up — skipping.`)
    return
  }

  mkdirSync(BINARIES_DIR, { recursive: true })

  for (const source of config.sources) {
    await setupSource(targetTriple, config, source)
  }

  verifyBinaries(targetTriple)
  writeStamp(targetTriple)
  log(`✓ FFmpeg sidecar binaries for ${targetTriple} are ready.`)
}

async function main() {
  const hostTriple = getHostTargetTriple()
  await setupTarget(hostTriple)
}

main().catch((err) => {
  fatal(err.message)
})
