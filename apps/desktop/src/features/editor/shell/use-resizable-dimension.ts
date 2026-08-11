import { useCallback, useEffect, useState } from "react"

interface UseResizableDimensionOptions {
  defaultValue: number
  min: number
  max: number
  storageKey: string
}

export function useResizableDimension({
  defaultValue,
  min,
  max,
  storageKey,
}: UseResizableDimensionOptions) {
  const [value, setValue] = useState(() => loadNumber(storageKey, defaultValue, min, max))

  const onChange = useCallback(
    (next: number) => {
      const clamped = Math.max(min, Math.min(max, next))
      setValue(clamped)
      try {
        localStorage.setItem(storageKey, String(clamped))
      } catch {
        // Storage may be unavailable in private mode or restricted contexts.
      }
    },
    [min, max, storageKey],
  )

  // Re-read the persisted value when the storage key changes (rare).
  useEffect(() => {
    setValue(loadNumber(storageKey, defaultValue, min, max))
  }, [storageKey, defaultValue, min, max])

  return [value, onChange] as const
}

function loadNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(min, Math.min(max, parsed))
  } catch {
    return fallback
  }
}
