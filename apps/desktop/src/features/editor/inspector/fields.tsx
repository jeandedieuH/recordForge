import { useState, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { ChevronDown } from "lucide-react"
import { Button, Input } from "@recordforge/ui"

export function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-dim px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-wider text-subtle-foreground">{label}</span>
      <span className="truncate font-mono tabular-nums text-foreground">{value}</span>
    </div>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  step,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  step?: number
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-subtle-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={min ?? 0}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

export function TrimField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 rounded-md bg-surface-dim px-2 py-1.5 text-[10px] uppercase tracking-wider text-subtle-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 border-0 bg-transparent p-0 font-mono text-xs normal-case tracking-normal text-foreground shadow-none"
      />
    </label>
  )
}

export function PresetButton({
  active,
  label,
  onClick,
  icon: Icon,
}: {
  active: boolean
  label: string
  onClick: () => void
  icon: LucideIcon
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="flex-col gap-1"
      onClick={onClick}
    >
      <Icon />
      <span className="text-[10px]">{label}</span>
    </Button>
  )
}

export function SectionHeader({ title, icon: Icon }: { title: string; icon?: LucideIcon }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
      {Icon ? <Icon className="size-4 text-primary" aria-hidden /> : null}
      <span>{title}</span>
    </div>
  )
}

interface InspectorSectionProps {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}

export function InspectorSection({ title, defaultOpen = true, children }: InspectorSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-subtle-foreground transition-colors duration-fast ease-forge hover:text-foreground"
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown
          className={`size-4 shrink-0 transition-transform duration-fast ease-forge ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open ? <div className="flex flex-col gap-3">{children}</div> : null}
    </div>
  )
}
