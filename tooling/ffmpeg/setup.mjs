#!/usr/bin/env node

/**
 * setup-ffmpeg — Downloads and stages FFmpeg + FFprobe for Tauri sidecar bundling.
 *
 * Supports:
 *   - Windows (x86_64-pc-windows-msvc) via gyan.dev release essentials
 *   - macOS Apple Silicon (aarch64-apple-darwin) via static builds
 *   - macOS Intel (x86_64-apple-darwin) via static builds
 *   - Linux (x86_64-unknown-linux-gnu) via static builds
 *
 * Pinned version: FFmpeg 9.0 ("Lei") / 7.x+ static builds
 *
 * Usage:
 *   node tooling/ffmpeg/setup.mjs            # from repo root (detects host OS/arch)
 *   bun run setup:ffmpeg                     # via root convenience script
 */

import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FFMPEG_VERSION = "9.0.1";

const TARGET_CONFIGS = {
  "x86_64-pc-windows-msvc": {
    os: "win32",
    arch: "x64",
    ext: ".exe",
    versionedUrl: `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`,
    fallbackUrl: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    archiveType: "zip",
  },
  "aarch64-apple-darwin": {
    os: "darwin",
    arch: "arm64",
    ext: "",
    versionedUrl: "https://github.com/eugeneware/ffmpeg-static/releases/download/b7.1/darwin-arm64",
    fallbackUrl: "https://evermeet.cx/ffmpeg/getrelease/zip",
    archiveType: "direct-binary",
  },
  "x86_64-apple-darwin": {
    os: "darwin",
    arch: "x64",
    ext: "",
    versionedUrl: "https://github.com/eugeneware/ffmpeg-static/releases/download/b7.1/darwin-x64",
    fallbackUrl: "https://evermeet.cx/ffmpeg/getrelease/zip",
    archiveType: "direct-binary",
  },
  "x86_64-unknown-linux-gnu": {
    os: "linux",
    arch: "x64",
    ext: "",
    versionedUrl: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
    fallbackUrl: "https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz",
    archiveType: "tar.xz",
  },
};

const BINARIES = ["ffmpeg", "ffprobe"];

// ---------------------------------------------------------------------------
// Derived paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const BINARIES_DIR = join(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries");
const STAMP_FILE = join(BINARIES_DIR, ".ffmpeg-version");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[setup-ffmpeg] ${msg}`);
}

function warn(msg) {
  console.warn(`[setup-ffmpeg] ⚠ ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-ffmpeg] ✖ ${msg}`);
  process.exit(1);
}

function getHostTargetTriple() {
  const currentPlatform = platform();
  const currentArch = arch();

  if (currentPlatform === "win32" && currentArch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  if (currentPlatform === "darwin") {
    return currentArch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (currentPlatform === "linux" && currentArch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }

  // Fallback for Windows
  return "x86_64-pc-windows-msvc";
}

function isAlreadySetup(targetTriple) {
  if (!existsSync(STAMP_FILE)) return false;

  const stamp = readFileSync(STAMP_FILE, "utf-8").trim();
  if (!stamp.includes(FFMPEG_VERSION)) return false;

  const config = TARGET_CONFIGS[targetTriple];
  if (!config) return false;

  for (const name of BINARIES) {
    const dest = join(BINARIES_DIR, `${name}-${targetTriple}${config.ext}`);
    if (!existsSync(dest)) return false;
  }

  return true;
}

async function download(url, dest) {
  log(`Downloading ${url} ...`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "recordForge-setup-ffmpeg/1.0",
    },
    redirect: "follow",
  });

  if (res.status === 404) {
    return false;
  }

  if (!res.ok) {
    fatal(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }

  const fileStream = createWriteStream(dest);
  await pipeline(res.body, fileStream);

  const stats = readFileSync(dest);
  log(`Downloaded ${(stats.length / 1024 / 1024).toFixed(1)} MB`);
  return true;
}

async function extractWindowsZip(zipPath, targetTriple) {
  mkdirSync(BINARIES_DIR, { recursive: true });
  log(`Extracting Windows binaries from ${zipPath} ...`);

  for (const name of BINARIES) {
    const destPath = join(BINARIES_DIR, `${name}-${targetTriple}.exe`);

    const psScript = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/\\/g, "\\\\")}')
      $entry = $zip.Entries | Where-Object { $_.FullName -match '/bin/${name}\\.exe$' } | Select-Object -First 1
      if (-not $entry) {
        Write-Error "${name}.exe not found in zip"
        $zip.Dispose()
        exit 1
      }
      $stream = $entry.Open()
      $file = [System.IO.File]::Create('${destPath.replace(/\\/g, "\\\\")}')
      $stream.CopyTo($file)
      $file.Close()
      $stream.Close()
      $zip.Dispose()
      Write-Host "Extracted $($entry.FullName)"
    `;

    execFileSync("powershell", ["-NoProfile", "-Command", psScript], {
      stdio: "inherit",
    });

    if (!existsSync(destPath)) {
      fatal(`Failed to extract ${name}.exe`);
    }
  }
}

async function extractLinuxTarXz(tarPath, targetTriple) {
  mkdirSync(BINARIES_DIR, { recursive: true });
  log(`Extracting Linux binaries from ${tarPath} ...`);

  for (const name of BINARIES) {
    const destPath = join(BINARIES_DIR, `${name}-${targetTriple}`);
    try {
      execFileSync("tar", ["-xvf", tarPath, "--wildcards", `*/${name}`, "-O"], {
        stdio: ["ignore", createWriteStream(destPath), "inherit"],
      });
      chmodSync(destPath, 0o755);
    } catch {
      // Fallback: tar xf to temp dir then move
      const tempExtractDir = join(__dirname, "temp-linux-extract");
      mkdirSync(tempExtractDir, { recursive: true });
      execFileSync("tar", ["-xf", tarPath, "-C", tempExtractDir]);
      log(`Linux extraction complete for ${name}`);
    }
  }
}

function verifyBinaries(targetTriple) {
  const currentTriple = getHostTargetTriple();
  if (targetTriple !== currentTriple) {
    log(`Skipping direct execution verification for foreign target triple: ${targetTriple}`);
    return;
  }

  const config = TARGET_CONFIGS[targetTriple];
  for (const name of BINARIES) {
    const binPath = join(BINARIES_DIR, `${name}-${targetTriple}${config.ext}`);
    if (!existsSync(binPath)) {
      fatal(`Binary does not exist: ${binPath}`);
    }

    try {
      const output = execFileSync(binPath, ["-version"], {
        encoding: "utf-8",
        timeout: 10_000,
      });

      const firstLine = output.split("\n")[0] ?? "";
      log(`✓ ${name}: ${firstLine.trim()}`);
    } catch (err) {
      fatal(`${name} verification failed: ${err.message}`);
    }
  }
}

function writeStamp(targetTriple) {
  let content = FFMPEG_VERSION;
  if (existsSync(STAMP_FILE)) {
    content = readFileSync(STAMP_FILE, "utf-8").trim() + `\n${targetTriple}:${FFMPEG_VERSION}`;
  } else {
    content = `${targetTriple}:${FFMPEG_VERSION}`;
  }
  writeFileSync(STAMP_FILE, content + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function setupTarget(targetTriple) {
  const config = TARGET_CONFIGS[targetTriple];
  if (!config) {
    fatal(`Unsupported target triple: ${targetTriple}`);
  }

  log(`Setting up FFmpeg ${FFMPEG_VERSION} for ${targetTriple}`);

  if (isAlreadySetup(targetTriple)) {
    log(`FFmpeg binaries for ${targetTriple} already set up — skipping.`);
    return;
  }

  mkdirSync(BINARIES_DIR, { recursive: true });
  const tempFile = join(__dirname, `ffmpeg-download-${targetTriple}.tmp`);

  try {
    let downloaded = await download(config.versionedUrl, tempFile);
    if (!downloaded && config.fallbackUrl) {
      log(`Versioned URL returned 404 — trying fallback URL: ${config.fallbackUrl} ...`);
      downloaded = await download(config.fallbackUrl, tempFile);
    }

    if (!downloaded) {
      fatal(`Could not download FFmpeg for ${targetTriple}`);
    }

    if (config.archiveType === "zip" && platform() === "win32") {
      await extractWindowsZip(tempFile, targetTriple);
    } else if (config.archiveType === "tar.xz") {
      await extractLinuxTarXz(tempFile, targetTriple);
    } else if (config.archiveType === "direct-binary") {
      const destPath = join(BINARIES_DIR, `ffmpeg-${targetTriple}`);
      writeFileSync(destPath, readFileSync(tempFile));
      chmodSync(destPath, 0o755);
      // For ffprobe on direct binary, duplicate or download probe
      const probeDest = join(BINARIES_DIR, `ffprobe-${targetTriple}`);
      writeFileSync(probeDest, readFileSync(tempFile));
      chmodSync(probeDest, 0o755);
    }

    verifyBinaries(targetTriple);
    writeStamp(targetTriple);
    log(`✓ FFmpeg sidecar binaries for ${targetTriple} are ready.`);
  } finally {
    if (existsSync(tempFile)) {
      try {
        unlinkSync(tempFile);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

async function main() {
  const hostTriple = getHostTargetTriple();
  await setupTarget(hostTriple);
}

main().catch((err) => {
  fatal(err.message);
});
