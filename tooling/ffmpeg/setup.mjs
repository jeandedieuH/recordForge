#!/usr/bin/env node

/**
 * setup-ffmpeg — Downloads and stages FFmpeg + FFprobe for Tauri sidecar bundling.
 *
 * Source: gyan.dev release essentials build (GPLv3, includes x264/x265).
 * Pinned version: FFmpeg 9.0 ("Lei").
 *
 * The script:
 *   1. Downloads the essentials zip from gyan.dev.
 *   2. Extracts ffmpeg.exe and ffprobe.exe.
 *   3. Copies them into apps/desktop/src-tauri/binaries/ with the Tauri
 *      target-triple suffix (e.g. ffmpeg-x86_64-pc-windows-msvc.exe).
 *   4. Verifies each binary runs with `-version`.
 *   5. Writes a stamp file so subsequent runs are idempotent.
 *
 * Usage:
 *   node tooling/ffmpeg/setup.mjs            # from repo root
 *   bun run --cwd tooling/ffmpeg setup       # via package script
 *   bun run setup:ffmpeg                     # via root convenience script
 */

import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Pinned FFmpeg version — change this to upgrade. */
const FFMPEG_VERSION = "9.0";

/**
 * gyan.dev URL for the release essentials zip.
 *
 * The versioned URL pattern is:
 *   https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-{version}-essentials_build.zip
 *
 * We fall back to the "latest release" URL if the versioned one 404s, but
 * still verify the downloaded version matches.
 */
const VERSIONED_URL = `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`;
const LATEST_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/** Tauri target triple for Windows x86_64 MSVC. */
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

/** Binaries we extract from the zip. */
const BINARIES = ["ffmpeg", "ffprobe"];

// ---------------------------------------------------------------------------
// Derived paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const BINARIES_DIR = join(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries");
const STAMP_FILE = join(BINARIES_DIR, ".ffmpeg-version");
const TEMP_ZIP = join(__dirname, `ffmpeg-${FFMPEG_VERSION}-download.zip`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pretty log with a prefix. */
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

/**
 * Check whether the stamp matches the desired version and all binaries exist.
 * Returns true if setup can be skipped.
 */
function isAlreadySetup() {
  if (!existsSync(STAMP_FILE)) return false;

  const stamp = readFileSync(STAMP_FILE, "utf-8").trim();
  if (stamp !== FFMPEG_VERSION) return false;

  for (const name of BINARIES) {
    const dest = join(BINARIES_DIR, `${name}-${TARGET_TRIPLE}.exe`);
    if (!existsSync(dest)) return false;
  }

  return true;
}

/**
 * Download a URL to a local file. Uses the built-in `fetch` API.
 * Returns true on success, false on 404.
 */
async function download(url, dest) {
  log(`Downloading ${url} ...`);
  const res = await fetch(url);

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

/**
 * Extract ffmpeg.exe and ffprobe.exe from the gyan.dev essentials zip.
 *
 * The zip has a top-level directory like `ffmpeg-9.0-essentials_build/bin/`.
 * We use PowerShell's built-in zip handling to avoid extra dependencies.
 */
async function extractBinaries() {
  mkdirSync(BINARIES_DIR, { recursive: true });

  // Use PowerShell to list entries and find the bin/ executables.
  // gyan.dev zips have a structure like:
  //   ffmpeg-9.0-essentials_build/
  //   ffmpeg-9.0-essentials_build/bin/ffmpeg.exe
  //   ffmpeg-9.0-essentials_build/bin/ffprobe.exe
  //   ffmpeg-9.0-essentials_build/bin/ffplay.exe
  //   ...
  log("Extracting binaries from zip ...");

  for (const name of BINARIES) {
    const destPath = join(BINARIES_DIR, `${name}-${TARGET_TRIPLE}.exe`);

    // PowerShell script to find and extract the specific binary.
    // We search all entries for one ending in `/bin/{name}.exe`.
    const psScript = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [System.IO.Compression.ZipFile]::OpenRead('${TEMP_ZIP.replace(/\\/g, "\\\\")}')
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

/**
 * Verify each binary runs and reports the expected version.
 */
function verifyBinaries() {
  for (const name of BINARIES) {
    const binPath = join(BINARIES_DIR, `${name}-${TARGET_TRIPLE}.exe`);

    try {
      const output = execFileSync(binPath, ["-version"], {
        encoding: "utf-8",
        timeout: 10_000,
      });

      // First line: "ffmpeg version 9.0 ..." or "ffprobe version 9.0 ..."
      const firstLine = output.split("\n")[0] ?? "";
      log(`✓ ${name}: ${firstLine.trim()}`);

      // Warn (but don't fail) if the version doesn't match the pin.
      if (!firstLine.includes(FFMPEG_VERSION)) {
        warn(
          `Expected version ${FFMPEG_VERSION} but got: ${firstLine.trim()}. ` +
            `Update FFMPEG_VERSION in setup.mjs if this is intentional.`
        );
      }
    } catch (err) {
      fatal(`${name} verification failed: ${err.message}`);
    }
  }
}

/**
 * Write the stamp file so subsequent runs skip the download.
 */
function writeStamp() {
  writeFileSync(STAMP_FILE, FFMPEG_VERSION + "\n", "utf-8");
}

/**
 * Clean up the temporary zip file.
 */
function cleanup() {
  if (existsSync(TEMP_ZIP)) {
    try {
      unlinkSync(TEMP_ZIP);
    } catch {
      warn(`Could not delete temp file: ${TEMP_ZIP}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Setting up FFmpeg ${FFMPEG_VERSION} for Tauri sidecar (${TARGET_TRIPLE})`);

  // Idempotency check.
  if (isAlreadySetup()) {
    log(`FFmpeg ${FFMPEG_VERSION} already set up — skipping.`);
    return;
  }

  // Try the versioned URL first, fall back to the "latest release" URL.
  let downloaded = await download(VERSIONED_URL, TEMP_ZIP);

  if (!downloaded) {
    log(`Versioned URL returned 404 — trying latest release URL ...`);
    downloaded = await download(LATEST_URL, TEMP_ZIP);
  }

  if (!downloaded) {
    fatal("Could not download FFmpeg from any known URL.");
  }

  try {
    await extractBinaries();
    verifyBinaries();
    writeStamp();
    log("✓ FFmpeg sidecar binaries are ready.");
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  fatal(err.message);
});
