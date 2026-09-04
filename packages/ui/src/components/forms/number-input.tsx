import { cva, type VariantProps } from "class-variance-authority"
import { ChevronDown, ChevronUp, type LucideIcon } from "lucide-react"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import { cn } from "../../lib/cn"

const numberInputContainerVariants = cva(
  "group relative inline-flex w-full items-center rounded-md border border-border bg-surface/90 text-foreground transition-[border-color,background-color,box-shadow] duration-fast ease-forge hover:border-border-strong hover:bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        sm: "h-7 text-[11px]",
        default: "h-8 text-xs",
        lg: "h-9 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
)

interface NumberInputProps
  extends
    Omit<
      React.InputHTMLAttributes<HTMLInputElement>,
      "size" | "onChange" | "value" | "defaultValue"
    >,
    VariantProps<typeof numberInputContainerVariants> {
  value?: number
  defaultValue?: number
  onChange?: (value: number) => void
  onValueChange?: (value: number) => void
  min?: number
  max?: number
  step?: number
  precision?: number
  unit?: string
  icon?: LucideIcon
  error?: boolean
  scrub?: boolean
  containerClassName?: string
}

function clamp(val: number, min?: number, max?: number): number {
  let res = val
  if (min !== undefined && res < min) res = min
  if (max !== undefined && res > max) res = max
  return res
}

function roundToPrecision(val: number, step = 1, precision?: number): number {
  if (precision !== undefined) {
    const factor = Math.pow(10, precision)
    return Math.round(val * factor) / factor
  }
  const stepDecimals = step.toString().split(".")[1]?.length ?? 0
  if (stepDecimals > 0) {
    const factor = Math.pow(10, stepDecimals)
    return Math.round(val * factor) / factor
  }
  return Math.round(val)
}

function NumberInput({
  value,
  defaultValue = 0,
  onChange,
  onValueChange,
  min,
  max,
  step = 1,
  precision,
  unit,
  size = "default",
  icon: Icon,
  error,
  scrub = false,
  disabled = false,
  readOnly = false,
  className,
  containerClassName,
  onKeyDown,
  onBlur,
  ...props
}: NumberInputProps) {
  const isControlled = value !== undefined
  const [internalValue, setInternalValue] = useState<number>(() => {
    const initial = isControlled ? value : defaultValue
    return clamp(roundToPrecision(initial, step, precision), min, max)
  })

  const [draftString, setDraftString] = useState<string>(() => String(internalValue))
  const [isFocused, setIsFocused] = useState(false)

  const currentValue = isControlled ? value : internalValue

  useEffect(() => {
    if (!isFocused) {
      setDraftString(String(currentValue))
    }
  }, [currentValue, isFocused])

  const notifyChange = useCallback(
    (nextVal: number) => {
      const clamped = clamp(roundToPrecision(nextVal, step, precision), min, max)
      if (!isControlled) {
        setInternalValue(clamped)
      }
      setDraftString(String(clamped))
      onChange?.(clamped)
      onValueChange?.(clamped)
    },
    [isControlled, max, min, onChange, onValueChange, precision, step],
  )

  const adjustValue = useCallback(
    (deltaMultiplier: number) => {
      if (disabled || readOnly) return
      const delta = step * deltaMultiplier
      const base = Number.isNaN(Number(draftString)) ? currentValue : Number(draftString)
      notifyChange(base + delta)
    },
    [currentValue, disabled, draftString, notifyChange, readOnly, step],
  )

  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopRepeat = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])

  useEffect(() => stopRepeat, [stopRepeat])

  const startRepeat = useCallback(
    (multiplier: number) => {
      if (disabled || readOnly) return
      adjustValue(multiplier)
      stopRepeat()
      repeatTimerRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          adjustValue(multiplier)
        }, 60)
      }, 300)
    },
    [adjustValue, disabled, readOnly, stopRepeat],
  )

  const isScrubbingRef = useRef(false)
  const startXRef = useRef(0)
  const startValRef = useRef(0)

  const handleScrubMouseDown = (e: ReactMouseEvent) => {
    if (!scrub || disabled || readOnly) return
    isScrubbingRef.current = true
    startXRef.current = e.clientX
    startValRef.current = currentValue

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isScrubbingRef.current) return
      const diffX = moveEvent.clientX - startXRef.current
      const multiplier = moveEvent.shiftKey ? 10 : moveEvent.altKey ? 0.1 : 1
      const delta = Math.round(diffX / 2) * step * multiplier
      notifyChange(startValRef.current + delta)
    }

    const handleMouseUp = () => {
      isScrubbingRef.current = false
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setDraftString(raw)
    const parsed = parseFloat(raw)
    if (!Number.isNaN(parsed)) {
      const clamped = clamp(parsed, min, max)
      if (!isControlled) setInternalValue(clamped)
      onChange?.(clamped)
      onValueChange?.(clamped)
    }
  }

  const handleInputBlur = (e: FocusEvent<HTMLInputElement>) => {
    setIsFocused(false)
    const parsed = parseFloat(draftString)
    if (Number.isNaN(parsed)) {
      notifyChange(currentValue)
    } else {
      notifyChange(parsed)
    }
    onBlur?.(e)
  }

  const handleInputFocus = () => {
    setIsFocused(true)
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || readOnly) return
    if (e.key === "ArrowUp") {
      e.preventDefault()
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
      adjustValue(mult)
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      const mult = e.shiftKey ? -10 : e.altKey ? -0.1 : -1
      adjustValue(mult)
    } else if (e.key === "Enter") {
      const parsed = parseFloat(draftString)
      if (!Number.isNaN(parsed)) {
        notifyChange(parsed)
      }
      e.currentTarget.blur()
    }
    onKeyDown?.(e)
  }

  return (
    <div
      className={cn(
        numberInputContainerVariants({ size }),
        error && "border-recording/60 focus-within:ring-recording/25",
        containerClassName,
      )}
      onMouseDown={scrub ? handleScrubMouseDown : undefined}
    >
      {Icon ? (
        <div
          className={cn(
            "flex shrink-0 items-center pl-2 text-subtle-foreground",
            scrub && "cursor-ew-resize hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </div>
      ) : null}

      <input
        type="text"
        inputMode="decimal"
        value={draftString}
        disabled={disabled}
        readOnly={readOnly}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
        onKeyDown={handleInputKeyDown}
        className={cn(
          "h-full w-full min-w-0 bg-transparent px-2 font-mono text-inherit tabular-nums text-foreground outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed",
          unit ? "pr-1" : "pr-6",
          className,
        )}
        {...props}
      />

      {unit ? (
        <span className="pointer-events-none shrink-0 pr-1.5 font-mono text-[10px] text-subtle-foreground select-none">
          {unit}
        </span>
      ) : null}

      {!readOnly && !disabled ? (
        <div className="flex h-full flex-col justify-center pr-1">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Increment"
            onMouseDown={(e) => {
              e.preventDefault()
              const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
              startRepeat(mult)
            }}
            onMouseUp={stopRepeat}
            onMouseLeave={stopRepeat}
            className="flex h-1/2 cursor-pointer items-center justify-center text-subtle-foreground transition-colors hover:text-foreground active:text-primary"
          >
            <ChevronUp className="size-2.5" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Decrement"
            onMouseDown={(e) => {
              e.preventDefault()
              const mult = e.shiftKey ? -10 : e.altKey ? -0.1 : -1
              startRepeat(mult)
            }}
            onMouseUp={stopRepeat}
            onMouseLeave={stopRepeat}
            className="flex h-1/2 cursor-pointer items-center justify-center text-subtle-foreground transition-colors hover:text-foreground active:text-primary"
          >
            <ChevronDown className="size-2.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

interface NumberInputFieldProps extends NumberInputProps {
  label: ReactNode
  hint?: string
  errorMessage?: string
}

function NumberInputField({
  label,
  hint,
  errorMessage,
  error,
  containerClassName,
  ...props
}: NumberInputFieldProps) {
  const isInvalid = Boolean(error || errorMessage)

  return (
    <div className={cn("flex flex-col gap-1 text-xs", containerClassName)}>
      <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
        <span className="font-medium text-foreground/80">{label}</span>
        {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
      </div>
      <NumberInput error={isInvalid} {...props} />
      {errorMessage ? (
        <span className="text-[10px] font-medium text-recording">{errorMessage}</span>
      ) : null}
    </div>
  )
}

export { NumberInput, NumberInputField, numberInputContainerVariants }
export type { NumberInputFieldProps, NumberInputProps }
