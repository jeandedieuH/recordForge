#!/usr/bin/env node

/**
 * Synthetic Media Fixture Generator for recordForge
 *
 * Generates deterministic test media files for proxy, waveform, thumbnail,
 * and export validation. Uses FFmpeg to create synthetic video and audio
 * with known properties.
 *
 * Usage:
 *   bun run tooling/fixtures/generate.ts [--output-dir <dir>]
 *
 * Prerequisites:
 *   - FFmpeg must be available in PATH or FFMPEG_PATH env var
 */

import { execSync, type ExecSyncOptionsWithStringEncoding } from "child_process"
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs"
import { join, resolve } from "path"

interface FixtureSpec {
  name: string
  description: string
  ffmpegArgs: string[]
  expectedDurationMs: number
  expectedWidth?: number
  expectedHeight?: number
  expectedFps?: number
  hasAudio: boolean
}

const FIXTURE_SPECS: FixtureSpec[] = [
  {
    name: "1080p30_10s",
    description: "10-second 1080p 30fps test video with 440Hz sine audio",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
    ],
    expectedDurationMs: 10000,
    expectedWidth: 1920,
    expectedHeight: 1080,
    expectedFps: 30,
    hasAudio: true,
  },
  {
    name: "720p30_30s",
    description: "30-second 720p 30fps test video with audio for proxy/waveform tests",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=30",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
    ],
    expectedDurationMs: 30000,
    expectedWidth: 1280,
    expectedHeight: 720,
    expectedFps: 30,
    hasAudio: true,
  },
  {
    name: "1080p30_video_only_5s",
    description: "5-second 1080p 30fps video without audio for edge-case tests",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-an",
    ],
    expectedDurationMs: 5000,
    expectedWidth: 1920,
    expectedHeight: 1080,
    expectedFps: 30,
    hasAudio: false,
  },
  {
    name: "4_3_aspect_10s",
    description: "10-second 4:3 aspect ratio video for non-standard aspect tests (P0.5)",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc2=size=1024x768:rate=30:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
    ],
    expectedDurationMs: 10000,
    expectedWidth: 1024,
    expectedHeight: 768,
    expectedFps: 30,
    hasAudio: true,
  },
  {
    name: "ultrawide_10s",
    description: "10-second 21:9 ultrawide video for non-standard aspect tests",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc2=size=2560x1080:rate=30:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
    ],
    expectedDurationMs: 10000,
    expectedWidth: 2560,
    expectedHeight: 1080,
    expectedFps: 30,
    hasAudio: true,
  },
  {
    name: "segment_a_5s",
    description: "First 5-second segment for concatenation / recovery tests",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
    ],
    expectedDurationMs: 5000,
    expectedWidth: 1920,
    expectedHeight: 1080,
    expectedFps: 30,
    hasAudio: true,
  },
  {
    name: "segment_b_5s",
    description: "Second 5-second segment for concatenation / recovery tests",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
    ],
    expectedDurationMs: 5000,
    expectedWidth: 1920,
    expectedHeight: 1080,
    expectedFps: 30,
    hasAudio: true,
  },
  {
    name: "tiny_1s",
    description: "1-second tiny file for fast unit tests",
    ffmpegArgs: [
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k",
    ],
    expectedDurationMs: 1000,
    expectedWidth: 320,
    expectedHeight: 240,
    expectedFps: 30,
    hasAudio: true,
  },
]

function findFfmpeg(): string {
  const envPath = process.env.FFMPEG_PATH
  if (envPath && existsSync(envPath)) return envPath

  // Try common locations on Windows
  const candidates = [
    "ffmpeg",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  ]

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" -version`, { stdio: "pipe" })
      return candidate
    } catch {
      // Continue to next candidate
    }
  }

  throw new Error(
    "FFmpeg not found. Install FFmpeg and ensure it is in PATH, or set FFMPEG_PATH environment variable."
  )
}

function generateFixture(ffmpeg: string, spec: FixtureSpec, outputDir: string): void {
  const outputPath = join(outputDir, `${spec.name}.mp4`)

  if (existsSync(outputPath)) {
    console.log(`  ⏭ ${spec.name} — already exists, skipping`)
    return
  }

  const args = [
    ...spec.ffmpegArgs,
    "-y",
    outputPath,
  ]

  console.log(`  ⏳ ${spec.name} — ${spec.description}`)

  const execOptions: ExecSyncOptionsWithStringEncoding = {
    encoding: "utf-8",
    stdio: "pipe",
  }

  try {
    execSync(`"${ffmpeg}" ${args.join(" ")}`, execOptions)
  } catch (error) {
    const execError = error as { stderr?: string }
    console.error(`  ❌ ${spec.name} — generation failed: ${execError.stderr?.slice(0, 200)}`)
    return
  }

  const stat = statSync(outputPath)
  console.log(`  ✅ ${spec.name} — ${(stat.size / 1024).toFixed(1)} KB`)
}

interface ManifestEntry {
  name: string
  description: string
  path: string
  expectedDurationMs: number
  expectedWidth?: number
  expectedHeight?: number
  expectedFps?: number
  hasAudio: boolean
  sizeBytes: number
}

function writeManifest(specs: FixtureSpec[], outputDir: string): void {
  const manifest: ManifestEntry[] = specs.map((spec) => {
    const filePath = join(outputDir, `${spec.name}.mp4`)
    const sizeBytes = existsSync(filePath) ? statSync(filePath).size : 0

    return {
      name: spec.name,
      description: spec.description,
      path: `${spec.name}.mp4`,
      expectedDurationMs: spec.expectedDurationMs,
      expectedWidth: spec.expectedWidth,
      expectedHeight: spec.expectedHeight,
      expectedFps: spec.expectedFps,
      hasAudio: spec.hasAudio,
      sizeBytes,
    }
  })

  const manifestPath = join(outputDir, "manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`\n📋 Manifest written to ${manifestPath}`)
}

function main(): void {
  const args = process.argv.slice(2)
  const outputDirIdx = args.indexOf("--output-dir")
  const outputDir = outputDirIdx !== -1
    ? resolve(args[outputDirIdx + 1])
    : resolve(join(__dirname, "output"))

  console.log("🎬 recordForge Synthetic Media Fixture Generator")
  console.log(`📁 Output directory: ${outputDir}\n`)

  mkdirSync(outputDir, { recursive: true })

  const ffmpeg = findFfmpeg()
  console.log(`🔧 FFmpeg: ${ffmpeg}\n`)

  console.log("Generating fixtures:")
  for (const spec of FIXTURE_SPECS) {
    generateFixture(ffmpeg, spec, outputDir)
  }

  writeManifest(FIXTURE_SPECS, outputDir)

  console.log("\n✅ All fixtures generated. Add output/ to .gitignore.")
}

main()
