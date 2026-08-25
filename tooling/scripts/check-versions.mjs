#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)))
const repositoryRoot = resolve(scriptDirectory, "..", "..")
const rootPackagePath = resolve(repositoryRoot, "package.json")
const desktopPackagePath = resolve(repositoryRoot, "apps", "desktop", "package.json")
const tauriConfigPath = resolve(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json")
const cargoManifestPath = resolve(repositoryRoot, "apps", "desktop", "src-tauri", "Cargo.toml")

const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"))
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"))
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"))
const cargoManifest = readFileSync(cargoManifestPath, "utf8")
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

const versions = {
  rootPackage: rootPackage.version,
  desktopPackage: desktopPackage.version,
  tauriConfig: tauriConfig.version,
  cargoManifest: cargoVersion,
}

const missing = Object.entries(versions).filter(([, version]) => !version)
if (missing.length > 0) {
  console.error(`Missing application version in: ${missing.map(([name]) => name).join(", ")}`)
  process.exit(1)
}

const uniqueVersions = new Set(Object.values(versions))
if (uniqueVersions.size !== 1) {
  console.error("Application versions are inconsistent:")
  for (const [name, version] of Object.entries(versions)) {
    console.error(`  ${name}: ${version}`)
  }
  process.exit(1)
}

console.log(`Application version: ${versions.rootPackage}`)
