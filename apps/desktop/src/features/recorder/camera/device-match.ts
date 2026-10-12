// Shared browser-label ↔ DirectShow-name matching. Browser labels and
// DirectShow device names differ in small ways (trailing "(046d:0825)" USB
// ids, "[device]" suffixes, "@device_..." tokens), so a plain equality check
// fails on most real hardware. Order: exact → substring → cleaned names.
export function matchDeviceLabel(label: string, requestedName: string): boolean {
  if (!label || !requestedName) return false

  const a = label.trim().toLowerCase()
  const b = requestedName.trim().toLowerCase()

  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true

  const aBase = cleanDeviceLabel(a)
  const bBase = cleanDeviceLabel(b)
  if (!aBase || !bBase) return false

  return aBase === bBase || aBase.includes(bBase) || bBase.includes(aBase)
}

function cleanDeviceLabel(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/@device[^\s]+/g, "")
    .trim()
}
