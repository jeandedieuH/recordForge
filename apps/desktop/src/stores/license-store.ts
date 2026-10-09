import { create } from "zustand"
import type { LicenseStatus, ProFeatureKey } from "@recordforge/contracts"
import { isTauri } from "../lib/settings"
import {
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
  onLicenseChanged,
  refreshLicense,
} from "../lib/license"
import { toErrorMessage } from "../lib/errors"

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

interface LicenseStore {
  status: LicenseStatus
  /** True until the first `get_license_status` answers — UI treats unknown as Free. */
  isLoading: boolean
  isBusy: boolean
  error: string | null
  isListening: boolean
  unlisten: (() => void) | null
  /** Feature keys that triggered the current upgrade dialog, for context copy. */
  upgradeContext: ProFeatureKey[]
  upgradeDialogOpen: boolean

  load: () => Promise<void>
  startListening: () => Promise<void>
  stopListening: () => void
  activate: (key: string) => Promise<boolean>
  deactivate: () => Promise<void>
  refresh: () => Promise<void>
  clearError: () => void
  openUpgradeDialog: (features?: ProFeatureKey[]) => void
  closeUpgradeDialog: () => void
}

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  status: FREE_STATUS,
  isLoading: true,
  isBusy: false,
  error: null,
  isListening: false,
  unlisten: null,
  upgradeContext: [],
  upgradeDialogOpen: false,

  load: async () => {
    if (!isTauri()) {
      set({ status: FREE_STATUS, isLoading: false })
      return
    }
    try {
      const status = await getLicenseStatus()
      set({ status, isLoading: false, error: null })
    } catch (error) {
      // A status read must never block the app — fail closed to Free.
      set({ status: FREE_STATUS, isLoading: false, error: toErrorMessage(error) })
    }
  },

  startListening: async () => {
    if (get().isListening || !isTauri()) return
    const unlisten = await onLicenseChanged((status) => {
      set({ status })
    })
    set({ isListening: true, unlisten })
  },

  stopListening: () => {
    const { unlisten, isListening } = get()
    if (!isListening) return
    if (unlisten) unlisten()
    set({ isListening: false, unlisten: null })
  },

  activate: async (key) => {
    const trimmed = key.trim()
    if (!trimmed || get().isBusy) return false
    set({ isBusy: true, error: null })
    try {
      const status = await activateLicense(trimmed)
      set({ status, isBusy: false })
      return status.tier === "pro"
    } catch (error) {
      set({ isBusy: false, error: toErrorMessage(error) })
      return false
    }
  },

  deactivate: async () => {
    if (get().isBusy) return
    set({ isBusy: true, error: null })
    try {
      const status = await deactivateLicense()
      set({ status, isBusy: false })
    } catch (error) {
      set({ isBusy: false, error: toErrorMessage(error) })
    }
  },

  refresh: async () => {
    if (get().isBusy) return
    set({ isBusy: true, error: null })
    try {
      const status = await refreshLicense()
      set({ status, isBusy: false })
    } catch (error) {
      set({ isBusy: false, error: toErrorMessage(error) })
    }
  },

  clearError: () => set({ error: null }),

  openUpgradeDialog: (features) => set({ upgradeContext: features ?? [], upgradeDialogOpen: true }),
  closeUpgradeDialog: () => set({ upgradeDialogOpen: false }),
}))

/** Convenience selector — Free while status is loading or when not Pro. */
export function useIsPro(): boolean {
  return useLicenseStore((state) => state.status.tier === "pro")
}
