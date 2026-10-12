import { useEffect, useState } from "react"
import type {
  CameraCapturePlan,
  CameraProfileId,
  RecordingStorageInfo,
} from "@recordforge/contracts"
import { cameraTiers } from "@recordforge/contracts"
import { getRecordingStorageInfo, planCameraTiers } from "../../../lib/recorder"

export type CameraPlansStatus = "idle" | "loading" | "ready" | "unavailable"

export interface UseCameraPlans {
  // Per-tier plan keyed by tier id. `null` until the probe lands — the UI
  // falls back to the static `cameraTiers` budgets and shows "Auto".
  plans: Record<CameraProfileId, CameraCapturePlan> | null
  status: CameraPlansStatus
}

interface CacheEntry {
  plans: Record<CameraProfileId, CameraCapturePlan>
  fetchedAt: number
}

// Module-level cache: probing a device via FFmpeg takes ~1-3 s, so tier
// switching and re-opening the modal must not re-probe. 60 s TTL keeps the
// numbers fresh across a plugged/unplugged device cycle.
const CACHE_TTL_MS = 60_000
const planCache = new Map<string, CacheEntry>()

// Device switches shouldn't fire a probe per keystroke of selection drift.
const DEBOUNCE_MS = 250

export function useCameraPlans(deviceId: string | null | undefined): UseCameraPlans {
  const [plans, setPlans] = useState<Record<CameraProfileId, CameraCapturePlan> | null>(null)
  const [status, setStatus] = useState<CameraPlansStatus>(deviceId ? "loading" : "idle")

  useEffect(() => {
    if (!deviceId) {
      setPlans(null)
      setStatus("idle")
      return
    }

    const cached = planCache.get(deviceId)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setPlans(cached.plans)
      setStatus("ready")
      return
    }

    setStatus("loading")
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const tierPlans = await planCameraTiers(deviceId)
        if (cancelled) return
        // planCameraTiers returns one plan per tier in tier order — key them
        // by profileId for O(1) lookup from the quality picker.
        const byTier = Object.fromEntries(
          cameraTiers.map((tier) => [
            tier.id,
            tierPlans.find((plan) => plan.profileId === tier.id) ?? null,
          ]),
        )
        if (Object.values(byTier).some((plan) => plan === null)) {
          setStatus("unavailable")
          return
        }
        const resolved = byTier as Record<CameraProfileId, CameraCapturePlan>
        planCache.set(deviceId, { plans: resolved, fetchedAt: Date.now() })
        setPlans(resolved)
        setStatus("ready")
      } catch {
        if (!cancelled) setStatus("unavailable")
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [deviceId])

  return { plans, status }
}

export interface UseStorageInfo {
  freeBytes: number | null
  loaded: boolean
}

// Fetched once per mount — the modal opens fresh each time, so a single
// call is enough; a failure leaves freeBytes null and the UI says
// "Free space unknown".
export function useStorageInfo(): UseStorageInfo {
  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    getRecordingStorageInfo()
      .then((info: RecordingStorageInfo) => {
        if (!cancelled) setFreeBytes(info.freeBytes ?? null)
      })
      .catch(() => {
        if (!cancelled) setFreeBytes(null)
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { freeBytes, loaded }
}
