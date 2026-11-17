#!/usr/bin/env bun
/**
 * Regenerates the shared TS<->Rust camera-frame parity fixture (ADR 023):
 * `resolveCameraFrame` outputs for a fixed matrix of frames, canvases and
 * layout-lane segments. `camera-frame.test.ts` regenerates the document in
 * memory and compares it with the checked-in JSON so the fixture cannot drift.
 *
 * Usage: bun run packages/editor-core/scripts/generate-camera-frame-fixtures.ts
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildCameraFrameFixtureDocument } from "./camera-frame-fixture-cases"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const document = buildCameraFrameFixtureDocument()

writeFileSync(
  `${repoRoot}/tooling/fixtures/camera-fixtures/camera-frame-resolve.json`,
  JSON.stringify(document, null, 2) + "\n",
)
console.log(
  `wrote tooling/fixtures/camera-fixtures/camera-frame-resolve.json (${document.cases.length} cases)`,
)
