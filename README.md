# RecordForge

<div align="center">

**A high-performance, local-first desktop screen recorder and lightweight timeline editor for Windows, macOS, and Linux.**

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8D8.svg?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-DEA584.svg?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38B2AC.svg?logo=tailwind-css&logoColor=white)](https://tailwindcss.com)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20•%20macOS%20•%20Linux-0078D4.svg)](https://github.com/jeandedieuH/recordForge)

[Key Features](#-key-features) • [Architecture](#-architecture) • [Quick Start](#-quick-start) • [Development](#-development-workflow) • [Contributing](#-contributing) • [License](#-license)

</div>

---

## 🌟 Highlights & Philosophy

RecordForge is built from the ground up to be **recorder-first, privacy-focused, and low-end friendly**:

- 🔒 **100% Local-First & Private:** No mandatory accounts, no cloud sync lock-in, and zero analytics/telemetry spyware. Your recordings never leave your machine unless you choose to export them.
- ⚡ **Native Performance (Sub-50MB Idle RAM):** Built on Tauri v2 and native Rust. No bloated Chromium background engines chewing up your CPU and battery.
- 🎯 **Subpixel Cursor Telemetry (60Hz / 120Hz):** Records raw cursor vectors alongside video. Preview and export with smooth spring-damping motion, click ripples, and automatic focal framing.
- 🎙️ **Zero-Drift Audio Sync:** Native low-latency audio capture isolates and synchronizes microphone and system audio streams with microsecond precision.
- ✂️ **Non-Destructive Editor:** Multi-track timeline supporting instant trims, cuts, splits, reordering, and unlimited undo/redo without waiting for slow intermediate re-renders.
- 🛡️ **SQLite WAL Crash Recovery:** Real-time state persistence safeguards against power loss, crashes, or unexpected reboots. Relaunch to restore your session seamlessly.
- 🚀 **Hardware Acceleration:** Out-of-the-box hardware encoding with NVIDIA NVENC, Apple VideoToolbox, Intel QuickSync, Linux VAAPI, and AMD AMF via pinned FFmpeg 9.0 sidecars.

---

## 🏗️ Architecture

RecordForge enforces a strict separation between native systems engineering and declarative user interaction:

```mermaid
flowchart TD
    subgraph Frontend["React 19 Frontend"]
        F1["Vite • Tailwind v4 • Radix UI • Zustand • @recordforge/ui"]
    end

    subgraph Backend["Rust Backend (Tauri v2)"]
        B1["• Native Screen Capture (Windows Graphics Capture / DXGI)<br/>• Native Audio Pipeline (WASAPI Loopback + Device Clock)<br/>• SQLite WAL Metadata & State Engine<br/>• Cursor Rasterizer (resvg + tiny-skia)<br/>• Media Processing (FFmpeg / FFprobe Pinned Sidecars)"]
    end

    Frontend -->|"Tauri IPC Commands"| Backend
    Backend -->|"Tauri Events (Status / Progress)"| Frontend
```

### Monorepo Structure

```
recordForge/
├── apps/
│   ├── desktop/             # Tauri v2 desktop application (Rust + React)
│   └── marketing/           # Astro static marketing & documentation site
├── packages/
│   ├── config/              # Shared TypeScript, ESLint, Tailwind configs
│   ├── contracts/           # Zod schemas, IPC contracts, and DTOs
│   ├── cursor-core/         # Pure cursor telemetry normalization & smoothing
│   ├── cursor-engine/       # Native Rust cursor evaluation engine
│   ├── domain/              # Shared domain entities & state machines
│   ├── editor-core/         # Pure timeline command engine (split/trim/undo)
│   ├── media-core/          # FFmpeg render plan specifications & job queues
│   ├── overlay-core/        # TypeScript/WASM overlay engine adapter
│   ├── overlay-engine/      # Canonical Rust overlay evaluation engine
│   ├── storage-core/        # Storage providers & OS Credential Vault adapters
│   └── ui/                  # Shared component system (shadcn/Radix/Tailwind)
├── tooling/
│   ├── benchmarks/          # Editor & timeline performance benchmarks
│   ├── ffmpeg/              # Automated FFmpeg/FFprobe sidecar fetcher (pinned v9.0)
│   └── golden-fixtures/     # Canonical A/V & cursor golden test datasets
└── docs/                    # Architectural Decision Records (ADRs) & Specifications
```

---

## 🚀 Quick Start

### Prerequisites

1. **Operating System:** Windows 10/11, macOS 12+ (Apple Silicon or Intel), or Linux (Ubuntu 22.04+, Fedora 38+, Arch)
2. **Runtime & Package Manager:** [Bun](https://bun.sh) (>= v1.4.0) or Node.js (>= v22.15.0)
3. **Rust Toolchain:** [Rustup](https://rustup.rs) (stable, >= 1.80) with target `wasm32-unknown-unknown`
4. **Wasm Pack:** `cargo install wasm-pack` (required for `bun run build:wasm:overlay`)
5. **System Dependencies:**
   - **Windows:** Visual Studio C++ Build Tools (with Windows SDK)
   - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
   - **Linux:** WebKit2GTK, AppIndicator, and ALSA dev libraries (`sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev`)

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/jeandedieuH/recordForge.git
cd recordForge
bun install
```

### 2. Set Up FFmpeg Sidecars

Download and configure the pinned FFmpeg and FFprobe binary dependencies for your host OS/architecture:

```bash
bun run setup:ffmpeg
```

### 3. Build WASM Engines

```bash
bun run build:wasm:overlay
```

### 4. Run Development Server

Launch the full Tauri desktop application in live-reloading development mode:

```bash
cd apps/desktop
bun run tauri:dev
```

---

## 🛠️ Development Workflow

| Command                                  | Description                                               |
| ---------------------------------------- | --------------------------------------------------------- |
| `bun run check`                          | Run linter, formatting checks, typecheck, and test suites |
| `bun run typecheck`                      | Run TypeScript type checks across all workspaces          |
| `bun run test`                           | Execute Vitest unit and integration test suites           |
| `bun run format:check`                   | Verify codebase formatting with Prettier                  |
| `bun run format`                         | Auto-format all code files across the repository          |
| `cd apps/desktop && bun run tauri:build` | Build production installer (`.msi`/`.exe`, `.dmg`, `.deb`)|

---

## 🤝 Contributing

We welcome contributions from developers, designers, and creators of all skill levels!

1. Read our [Contributing Guidelines](CONTRIBUTING.md) to understand our codebase standards, architecture boundaries, and PR workflow.
2. Adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).
3. Check open [Issues](https://github.com/jeandedieuH/recordForge/issues) or join discussions to propose new features.

---

## 🔒 Security & Privacy

For security vulnerability disclosures, please review our [Security Policy](SECURITY.md).

RecordForge strictly complies with local-first security boundaries:

- Cloud credentials and API keys are stored exclusively in the **OS Credential Vault** (Windows Credential Manager, macOS Keychain, Linux Secret Service), never in plaintext or SQLite.
- Desktop capabilities are locked down via narrow Tauri security permissions.
- Telemetry, screen content, and transcripts are never logged or transmitted.

---

## � Free & Pro

RecordForge ships two tiers:

- **Free** — the full recorder and editor: capture up to 4K, the complete timeline, captions, cursor effects, GIF/WebP, hardware encoders, exports up to 1080p, and cloud uploads through your own storage. No watermark, no time limit, no account.
- **Pro Lifetime** — a one-time purchase that unlocks 1440p/4K export presets, non-16:9 canvases, chapters & YouTube timestamps, all title presets beyond Clean Text, and annotations — on up to 3 personal devices, with lifetime updates.

Pro features stay usable in the Free editor; at export you can upgrade or export without them. See the pricing page for the current offer.

## �📜 License

The RecordForge **desktop app** is licensed under the **GNU General Public License v3.0 (GPL-3.0-or-later)** — including the gated-feature engines and the license client. See the [LICENSE](LICENSE) file for details.

The project is **open core**: the license server and hosted services live in a private repository, and Pro keys are governed by [PRO-LICENSE-TERMS.md](PRO-LICENSE-TERMS.md). Read [LICENSING.md](LICENSING.md) for the full model, [TRADEMARKS.md](TRADEMARKS.md) if you plan to fork, and [CLA.md](CLA.md) before contributing.

```
Copyright (C) 2024-present Prestige Tech & RecordForge Contributors
```
