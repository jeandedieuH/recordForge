import { listen } from "@tauri-apps/api/event"
import {
  LICENSE_CHANGED_EVENT,
  licenseStatusSchema,
  type LicenseStatus,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

/**
 * Where the "Upgrade" buttons point. Static for now — replaced by the Polar
 * checkout link once the product is created (H4/marketing keeps the same URL).
 */
export const PRO_CHECKOUT_URL = "https://recordforge.prestigetech.dev/pricing"

export async function getLicenseStatus(): Promise<LicenseStatus> {
  return invokeValidated("get_license_status", undefined, licenseStatusSchema)
}

export async function activateLicense(key: string): Promise<LicenseStatus> {
  return invokeValidated("activate_license", { key }, licenseStatusSchema)
}

export async function deactivateLicense(): Promise<LicenseStatus> {
  return invokeValidated("deactivate_license", undefined, licenseStatusSchema)
}

export async function refreshLicense(): Promise<LicenseStatus> {
  return invokeValidated("refresh_license", undefined, licenseStatusSchema)
}

export function onLicenseChanged(callback: (status: LicenseStatus) => void): Promise<() => void> {
  return listen<unknown>(LICENSE_CHANGED_EVENT, (event) => {
    const parsed = licenseStatusSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}
