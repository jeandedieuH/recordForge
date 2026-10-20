import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react"
import { useSyncExternalStore, type ReactNode } from "react"
import { cn } from "../../lib/cn"

/*
 * Lightweight toast system: module-level store + viewport.
 * Bottom-right, 4s auto-dismiss, max 3 stacked, optional action button.
 * Background jobs must always end in a toast — never silently (quality bar §8.6).
 */

type ToastVariant = "default" | "success" | "error" | "warning" | "info"

interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastOptions {
  title: string
  description?: string
  variant?: ToastVariant
  action?: ToastAction
  /** ms; defaults to 4000. Pass Infinity to pin until dismissed. */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
  variant: ToastVariant
}

const MAX_VISIBLE = 3
const DEFAULT_DURATION = 4000

let nextId = 1
let toasts: ToastItem[] = []
const listeners = new Set<() => void>()

function emit() {
  toasts = toasts.slice(-MAX_VISIBLE)
  listeners.forEach((listener) => listener())
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  listeners.forEach((listener) => listener())
}

function toast(options: ToastOptions): number {
  const id = nextId++
  const item: ToastItem = { ...options, id, variant: options.variant ?? "default" }
  toasts = [...toasts, item]
  emit()

  const duration = options.duration ?? DEFAULT_DURATION
  if (Number.isFinite(duration)) {
    setTimeout(() => dismiss(id), duration)
  }
  return id
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ToastItem[] {
  return toasts
}

/** Imperative toast API: `const { toast, dismiss } = useToast()` */
function useToast() {
  return { toast, dismiss }
}

const VARIANT_ICON: Record<ToastVariant, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: TriangleAlert,
  info: Info,
}

const VARIANT_COLOR: Record<ToastVariant, string> = {
  default: "text-muted-foreground",
  success: "text-success",
  error: "text-recording",
  warning: "text-warning",
  info: "text-info",
}

/** Mount once near the app root (bottom-right viewport). */
function ToastViewport(): ReactNode {
  const items = useSyncExternalStore(subscribe, getSnapshot)

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2"
    >
      {items.map((item) => {
        const Icon = VARIANT_ICON[item.variant]
        return (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-elevated p-3 shadow-e2",
              "animate-in slide-in-from-bottom-2 fade-in-0 duration-base",
            )}
          >
            <Icon
              className={cn("mt-0.5 size-4 shrink-0", VARIANT_COLOR[item.variant])}
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-sm font-medium text-foreground">{item.title}</p>
              {item.description ? (
                <p className="text-xs break-words text-muted-foreground">{item.description}</p>
              ) : null}
              {item.action ? (
                <button
                  type="button"
                  className="mt-1 w-fit cursor-pointer text-xs font-medium text-accent hover:underline"
                  onClick={() => {
                    item.action?.onClick()
                    dismiss(item.id)
                  }}
                >
                  {item.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="cursor-pointer rounded-sm text-subtle-foreground transition-colors hover:text-foreground"
              onClick={() => dismiss(item.id)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export { ToastViewport, useToast }
export type { ToastOptions, ToastVariant }
