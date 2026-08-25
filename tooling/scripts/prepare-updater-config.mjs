#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)))
const repositoryRoot = resolve(scriptDirectory, "..", "..")
const templatePath = resolve(
  repositoryRoot,
  "apps",
  "desktop",
  "src-tauri",
  "tauri.release.conf.json",
)
const outputPath = resolve(
  repositoryRoot,
  "apps",
  "desktop",
  "src-tauri",
  "tauri.release.generated.conf.json",
)
const publicKey = process.env.RECORD_FORGE_UPDATER_PUBLIC_KEY?.trim()

if (!publicKey) {
  console.error("RECORD_FORGE_UPDATER_PUBLIC_KEY is required to prepare a release build")
  process.exit(1)
}

const config = JSON.parse(readFileSync(templatePath, "utf8"))
config.plugins.updater.pubkey = publicKey
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
console.log(`Prepared ${outputPath}`)
