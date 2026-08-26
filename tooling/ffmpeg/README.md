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

1. Detects the host platform/arch and selects the matching target triple:
   - `x86_64-pc-windows-msvc`
   - `aarch64-apple-darwin`
   - `x86_64-apple-darwin`
   - `x86_64-unknown-linux-gnu`
2. Downloads the pinned FFmpeg 9.0.1 archive(s) for that target.
3. Extracts `ffmpeg` and `ffprobe` into a temp directory, then copies them to
   `apps/desktop/src-tauri/binaries/` with the Tauri target-triple suffix
   (`ffmpeg-x86_64-pc-windows-msvc.exe`, `ffprobe-aarch64-apple-darwin`, etc.).
4. Verifies each binary runs with `-version` and warns if the reported version
   differs from the pinned one.
5. Writes a `.ffmpeg-version` stamp file — subsequent runs are idempotent.

## Sources

| Target                      | Primary source                   | Fallback source                  |
| --------------------------- | -------------------------------- | -------------------------------- |
| Windows x86_64              | GyanD GitHub release essentials  | gyan.dev release essentials      |
| macOS Apple Silicon (arm64) | ffmpeg.martin-riedl.de (release) | evermeet.cx release zip          |
| macOS Intel (x64)           | ffmpeg.martin-riedl.de (release) | evermeet.cx release zip          |
| Linux x86_64                | ffmpeg.martin-riedl.de (release) | johnvansickle.com static release |

## Upgrading FFmpeg

Edit `FFMPEG_VERSION` in `setup.mjs`, then re-run the script. The stamp file
ensures the download only happens when the version changes.

## Notes

- The `binaries/` directory is **git-ignored**. Every developer and CI machine
  must run this script after a fresh clone.
- The pinned build includes x264, x265, and the other codecs the recorder needs.
- The script requires `unzip` on macOS/Linux and PowerShell on Windows; the Linux
  fallback also requires `tar` with xz support.
