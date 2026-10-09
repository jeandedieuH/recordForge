#!/usr/bin/env node
/**
 * Prints this machine's RecordForge license device hash — the value needed
 * for `license-keys.mjs token --device`. Mirrors `licensing/device.rs`:
 * sha256("recordforge-license-device-v1" + machine_uid) as hex.
 *
 *   node device-hash.mjs
 *
 * On Windows the machine UID is HKLM\SOFTWARE\Microsoft\Cryptography
 * \MachineGuid; on macOS the IOPlatformUUID; on Linux /etc/machine-id (or
 * /var/lib/dbus/machine-id). Prefer the in-app `deviceHash` from
 * get_license_status when a build is available.
 */

import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { platform } from "node:os"

const DEVICE_SALT = "recordforge-license-device-v1"

function machineUid() {
  if (platform() === "win32") {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: "utf8" },
    )
    const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/)
    if (!match) throw new Error("MachineGuid not found in registry output")
    return match[1].trim()
  }
  if (platform() === "darwin") {
    const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
      encoding: "utf8",
    })
    const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    if (!match) throw new Error("IOPlatformUUID not found in ioreg output")
    return match[1].trim()
  }
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      return readFileSync(path, "utf8").trim()
    } catch {
      // try the next source
    }
  }
  throw new Error("no machine-id source found")
}

const hash = createHash("sha256")
  .update(DEVICE_SALT)
  .update(machineUid())
  .digest("hex")
console.log(hash)
