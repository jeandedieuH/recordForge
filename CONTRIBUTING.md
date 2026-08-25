# Contributing to recordForge

Thank you for your interest in contributing to **recordForge**! As a free and open-source project, recordForge thrives on contributions from creators, developers, and designers around the world.

Please take a few moments to review this guide before submitting issues or pull requests.

---

## 🧭 Core Architecture & Ground Rules

recordForge is a local-first, low-overhead desktop application for Windows 11. To maintain performance, stability, and security, we enforce strict architectural boundaries:

1. **Rust owns:** Native screen capture, WASAPI audio pipelines, SQLite persistence, OS credential storage, and FFmpeg media render jobs.
2. **React owns:** User interface, client-side visual states, and declarative user feedback.
3. **Never pass raw video frames or audio buffers through React state, Tauri IPC commands, or events.**
4. **Local-First & Privacy:** Never log user screen content, audio transcripts, or raw media paths. Never transmit user data to external servers without explicit user initiation.
5. **Design Token Discipline:** Do not hardcode arbitrary hex or pixel values. Use design tokens defined in `@recordforge/ui` (`packages/ui/src/styles/theme.css`).
6. **Icons:** Use `lucide-react` icons. No raw emoji in product UI.

---

## 🛠️ Development Setup

### 1. Prerequisites

- **OS:** Windows 11 (or Windows 10 build 19041+)
- **Package Manager:** [Bun](https://bun.sh) (>= 1.4.0)
- **Rust Toolchain:** [Rustup](https://rustup.rs) (stable channel, >= 1.80) with target `wasm32-unknown-unknown` and [wasm-pack](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack`)
- **Build Tools:** Visual Studio C++ Build Tools with Windows 10/11 SDK

### 2. Initial Setup

```bash
# Clone the repository
git clone https://github.com/jeandedieuH/recordForge.git
cd recordForge

# Install monorepo dependencies
bun install

# Download pinned FFmpeg/FFprobe sidecars
bun run setup:ffmpeg

# Build WASM overlay engines
bun run build:wasm:overlay
```

### 3. Launch Development

```bash
# Launch the Tauri v2 Desktop App in hot-reload dev mode
cd apps/desktop
bun run tauri:dev
```

---

## 🧪 Testing & Validation

Before opening a pull request, ensure all validation suites pass:

```bash
# Run TypeScript type check across all monorepo packages
bun run typecheck

# Run unit and integration tests
bun run test

# Check code formatting
bun run format:check

# Auto-format files
bun run format
```

> **Note for Rust tests on Windows:** If parallel linking causes intermittent `LNK1104` locks, run tests with single-threaded compilation:
>
> ```bash
> cargo test -j 1
> ```

### Official Desktop Releases

Official Windows releases are built from `app-v*` tags by `.github/workflows/release-desktop.yml` and published to GitHub Releases. The workflow creates signed updater artifacts and the `latest.json` manifest.

The updater public key is supplied through the `RECORD_FORGE_UPDATER_PUBLIC_KEY` GitHub Actions variable. The Tauri signing private key and password are protected GitHub Actions secrets and must never be committed, logged, or exposed to frontend code.

Before creating a release tag, run:

```bash
bun run check:versions
bun run typecheck
bun run test
```

---

## 🔀 Pull Request Process

1. **Branch Naming:** Use clear branch prefixes:
   - `feat/feature-name`
   - `fix/bug-description`
   - `docs/documentation-update`
   - `perf/optimization-target`
2. **Keep PRs Focused:** Small, single-purpose pull requests are reviewed and merged much faster than monolithic diffs.
3. **Write Tests:** Add unit tests for new logic in packages (`packages/*`) or frontend components (`apps/desktop/src/**/__tests__`).
4. **Check Capabilities:** If your change requires modifying Tauri security permissions (`src-tauri/capabilities/`), note it clearly in the PR description for security review.
5. **Fill the PR Template:** Complete all sections of the [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md).

---

## 📜 Code Style Guidelines

- **TypeScript:** Strict mode enabled. Prefer `interface` over `type`. Functional components with named exports. Guard clauses and early returns for error handling.
- **State Management:** Use Zustand for React client state.
- **Async UI States:** Every async UI surface must follow the 4-states pattern: `skeleton` → `content` | `empty` | `error` (with retry button). No raw text loaders.
- **Feedback:** Background operations must finish with user feedback (toast notification or job drawer entry).

---

## 💬 Community & Communication

- **Discussions & Feature Requests:** Use GitHub Issues or Discussions.
- **Code of Conduct:** Please treat everyone with empathy and respect. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
