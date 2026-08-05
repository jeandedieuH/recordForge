# FFmpeg Sidecar Setup

Downloads and stages FFmpeg + FFprobe binaries for the Tauri desktop app.

## Quick Start

From the repository root:

```bash
bun run setup:ffmpeg
```

Or directly:

```bash
node tooling/ffmpeg/setup.mjs
```

## What It Does

1. Downloads the **gyan.dev release essentials** build (FFmpeg 9.0, GPLv3).
2. Extracts `ffmpeg.exe` and `ffprobe.exe` from the zip.
3. Copies them to `apps/desktop/src-tauri/binaries/` with the Tauri target-triple
   suffix (`ffmpeg-x86_64-pc-windows-msvc.exe`).
4. Verifies each binary runs with `-version`.
5. Writes a `.ffmpeg-version` stamp file — subsequent runs are idempotent.

## Upgrading FFmpeg

Edit `FFMPEG_VERSION` in `setup.mjs`, then re-run the script. The stamp file
ensures the download only happens when the version changes.

## Notes

- The `binaries/` directory is **git-ignored**. Every developer and CI machine
  must run this script after a fresh clone.
- The essentials build includes x264, x265, and all codecs the recorder needs.
- Only Windows x86_64 is supported (V1 scope).
