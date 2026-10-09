import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus } from "@recordforge/contracts"

// Mock the IPC layer — the store is a thin Zustand wrapper and must never
// touch Tauri from tests.
const activateLicense = vi.fn<(_: string) => Promise<LicenseStatus>>()
const deactivateLicense = vi.fn<() => Promise<LicenseStatus>>()
const getLicenseStatus = vi.fn<() => Promise<LicenseStatus>>()
const refreshLicense = vi.fn<() => Promise<LicenseStatus>>()
const onLicenseChanged = vi.fn<(_: (status: LicenseStatus) => void) => Promise<() => void>>()

vi.mock("../lib/license", () => ({
  activateLicense: (key: string) => activateLicense(key),
  deactivateLicense: () => deactivateLicense(),
  getLicenseStatus: () => getLicenseStatus(),
  refreshLicense: () => refreshLicense(),
  onLicenseChanged: (cb: (status: LicenseStatus) => void) => onLicenseChanged(cb),
}))

vi.mock("../lib/settings", () => ({ isTauri: () => true }))

import { useLicenseStore } from "./license-store"

const PRO_STATUS: LicenseStatus = {
  tier: "pro",
  plan: "pro_lifetime",
  licenseId: "lic-1",
  deviceHash: "hash",
  deviceLabel: "Hagen-PC",
  activatedAtMs: 1_700_000_000_000,
  lastVerifiedAtMs: 1_700_000_000_000,
  serverConfigured: true,
  features: ["high-res-export", "annotations"],
}

const FREE_STATUS: LicenseStatus = {
  tier: "free",
  plan: null,
  licenseId: null,
  deviceHash: "",
  deviceLabel: "",
  activatedAtMs: null,
  lastVerifiedAtMs: null,
  serverConfigured: false,
  features: [],
}

function resetStore() {
  useLicenseStore.setState({
    status: FREE_STATUS,
    isLoading: false,
    isBusy: false,
    error: null,
    isListening: false,
    unlisten: null,
    upgradeContext: [],
    upgradeDialogOpen: false,
  })
}

describe("license-store", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })

  it("loads the stored status", async () => {
    getLicenseStatus.mockResolvedValue(PRO_STATUS)
    await useLicenseStore.getState().load()
    expect(useLicenseStore.getState().status.tier).toBe("pro")
  })

  it("fails closed to Free when the status read errors", async () => {
    getLicenseStatus.mockRejectedValue(new Error("ipc down"))
    await useLicenseStore.getState().load()
    expect(useLicenseStore.getState().status.tier).toBe("free")
    expect(useLicenseStore.getState().error).toBeTruthy()
  })

  it("activates a key and returns whether Pro unlocked", async () => {
    activateLicense.mockResolvedValue(PRO_STATUS)
    await expect(useLicenseStore.getState().activate("  dev:key ")).resolves.toBe(true)
    expect(activateLicense).toHaveBeenCalledWith("dev:key")
    expect(useLicenseStore.getState().status.plan).toBe("pro_lifetime")
  })

  it("returns false and surfaces the error on activation failure", async () => {
    activateLicense.mockRejectedValue(new Error("license_invalid_key"))
    await expect(useLicenseStore.getState().activate("bad-key")).resolves.toBe(false)
    expect(useLicenseStore.getState().error).toContain("license_invalid_key")
    expect(useLicenseStore.getState().status.tier).toBe("free")
  })

  it("rejects empty keys without an IPC call", async () => {
    await expect(useLicenseStore.getState().activate("   ")).resolves.toBe(false)
    expect(activateLicense).not.toHaveBeenCalled()
  })

  it("deactivates back to Free", async () => {
    deactivateLicense.mockResolvedValue(FREE_STATUS)
    useLicenseStore.setState({ status: PRO_STATUS })
    await useLicenseStore.getState().deactivate()
    expect(useLicenseStore.getState().status.tier).toBe("free")
  })

  it("applies license-changed events", async () => {
    onLicenseChanged.mockResolvedValue(vi.fn())
    await useLicenseStore.getState().startListening()
    const emit = onLicenseChanged.mock.calls[0][0]
    emit(PRO_STATUS)
    expect(useLicenseStore.getState().status.tier).toBe("pro")
  })

  it("opens the upgrade dialog with feature context", () => {
    useLicenseStore.getState().openUpgradeDialog(["chapters", "annotations"])
    expect(useLicenseStore.getState().upgradeDialogOpen).toBe(true)
    expect(useLicenseStore.getState().upgradeContext).toEqual(["chapters", "annotations"])
    useLicenseStore.getState().closeUpgradeDialog()
    expect(useLicenseStore.getState().upgradeDialogOpen).toBe(false)
  })
})
