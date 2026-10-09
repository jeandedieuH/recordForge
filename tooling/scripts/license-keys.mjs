#!/usr/bin/env node
/**
 * RecordForge license dev tooling.
 *
 * Generates Ed25519 keypairs and signs offline license tokens so the
 * activate → unlock → enforce flow works without a license server.
 *
 *   node license-keys.mjs keygen [--out license-dev-key.json]
 *   node license-keys.mjs pubkey --key license-dev-key.json
 *   node license-keys.mjs token --key license-dev-key.json --device <sha256-hex>
 *       [--plan pro_lifetime] [--license lic_dev_1] [--kid dev] [--prefix dev]
 *
 * Dev workflow (debug builds only):
 *   1. `keygen` → keep the file OUT of git (it is .gitignored).
 *   2. `pubkey` → set RECORD_FORGE_DEV_LICENSE_PUBLIC_KEY to the printed
 *      base64 key before launching a debug build.
 *   3. `token` → enter the printed `dev:<token>` as the license key in
 *      Settings → License of a debug build running on the same machine
 *      (`--device` is the `deviceHash` from `get_license_status`).
 *
 * Admin workflow (any build, including production):
 *   1. `keygen --out license-admin-key.json` → private half stays on the
 *      owner's machine; it is .gitignored — never commit it.
 *   2. `pubkey --key license-admin-key.json` → embed the printed base64 key
 *      in `ADMIN_KEYS` (apps/desktop/src-tauri/src/licensing/token.rs).
 *   3. `token --key license-admin-key.json --device <hash> --kid admin-1
 *      --prefix admin` → enter the printed `admin:<token>` as the license
 *      key in a production build on that machine. Admin licenses never
 *      contact the license server (kid membership marks them local-only).
 */

import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const USAGE = `usage:
  license-keys.mjs keygen [--out <file>]
  license-keys.mjs pubkey --key <file>
  license-keys.mjs token --key <file> --device <sha256-hex> [--plan pro_lifetime] [--license <id>] [--kid dev] [--prefix dev|admin]`

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url")
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1]
      i += 1
    } else {
      args._.push(arg)
    }
  }
  return args
}

function loadKey(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"))
  return {
    privateKey: createPrivateKey({ key: raw.privateKeyJwk, format: "jwk" }),
    publicKeyBase64: raw.publicKeyBase64,
  }
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]

if (command === "keygen") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  // Raw 32-byte public key: last 32 bytes of the SPKI DER encoding.
  const publicKeyBase64 = Buffer.from(
    publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  ).toString("base64")
  const out = {
    publicKeyBase64,
    privateKeyJwk: privateKey.export({ format: "jwk" }),
  }
  const outPath = args.out ?? "license-dev-key.json"
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`wrote ${outPath} — private key, keep out of git`)
  console.log(`public key (base64): ${publicKeyBase64}`)
} else if (command === "pubkey") {
  if (!args.key) throw new Error("--key <file> is required")
  const { publicKeyBase64 } = loadKey(args.key)
  console.log(publicKeyBase64)
} else if (command === "token") {
  if (!args.key) throw new Error("--key <file> is required")
  if (!args.device || !/^[0-9a-f]{64}$/i.test(args.device)) {
    throw new Error("--device <64-char hex deviceHash> is required (see get_license_status)")
  }
  const prefix = args.prefix ?? "dev"
  if (prefix !== "dev" && prefix !== "admin") {
    throw new Error("--prefix must be 'dev' or 'admin'")
  }
  const isAdmin = prefix === "admin"
  const { privateKey } = loadKey(args.key)
  const payload = {
    v: 1,
    // Admin kids must match an entry in ADMIN_KEYS (licensing/token.rs).
    kid: args.kid ?? (isAdmin ? "admin-1" : "dev"),
    licenseId: args.license ?? `lic_${prefix}_${Date.now().toString(36)}`,
    plan: args.plan ?? (isAdmin ? "pro_admin" : "pro_lifetime"),
    addons: [],
    deviceHash: args.device.toLowerCase(),
    iat: Date.now(),
  }
  const segment = base64url(JSON.stringify(payload))
  const signature = base64url(sign(null, Buffer.from(segment), privateKey))
  // The prefix tells the app to treat the input as a raw signed token
  // instead of calling the license server: `dev:` in debug builds only,
  // `admin:` in every build.
  console.log(`${prefix}:${segment}.${signature}`)
} else {
  console.error(USAGE)
  process.exit(command ? 1 : 0)
}
