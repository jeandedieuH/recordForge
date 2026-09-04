import * as SelectPrimitive from "@radix-ui/react-select"
import { cva, type VariantProps } from "class-variance-authority"
import { Check, ChevronDown, ChevronUp, type LucideIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/cn"

const Select = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group
const SelectValue = SelectPrimitive.Value

const selectTriggerVariants = cva(
  "group flex w-full min-w-0 cursor-pointer items-center justify-between whitespace-nowrap rounded-md border border-border bg-surface/90 text-foreground shadow-xs outline-none transition-[border-color,background-color,box-shadow] duration-fast ease-forge hover:border-border-strong hover:bg-surface focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-subtle-foreground [&>span]:line-clamp-1 [&>span]:truncate [&>span]:text-left [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
  {
    variants: {
      size: {
        sm: "h-7 gap-1.5 px-2 text-[11px] rounded-md [&_svg]:size-3",
        default: "h-8 gap-2 px-3 text-xs rounded-md [&_svg]:size-3.5",
        lg: "h-9 gap-2.5 px-3.5 text-sm rounded-lg [&_svg]:size-4",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
)

interface SelectTriggerProps
  extends
    ComponentProps<typeof SelectPrimitive.Trigger>,
    VariantProps<typeof selectTriggerVariants> {}

function SelectTrigger({ className, size, children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger className={cn(selectTriggerVariants({ size }), className)} {...props}>
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown
          className="shrink-0 opacity-70 transition-transform duration-fast ease-forge group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 4,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={sideOffset}
        className={cn(
          "relative z-50 max-h-72 min-w-32 overflow-hidden rounded-xl border border-border-strong/70 bg-elevated/95 text-foreground shadow-e2 backdrop-blur-xl p-1",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex items-center justify-center py-1 text-muted-foreground hover:text-foreground">
          <ChevronUp className="size-3.5" aria-hidden />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className={cn(
            "p-0.5",
            position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex items-center justify-center py-1 text-muted-foreground hover:text-foreground">
          <ChevronDown className="size-3.5" aria-hidden />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-md py-1.5 pr-7 pl-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors duration-fast ease-forge",
        "hover:bg-overlay hover:text-foreground focus:bg-overlay focus:text-foreground data-[highlighted]:bg-overlay data-[highlighted]:text-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        "data-[state=checked]:bg-primary/10 data-[state=checked]:font-semibold data-[state=checked]:text-primary",
        "[&_span]:truncate",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-3.5 items-center justify-center text-primary">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 stroke-[2.5]" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
}

function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn(
        "px-2.5 py-1.5 text-[10px] font-semibold tracking-wider text-subtle-foreground uppercase",
        className,
      )}
      {...props}
    />
  )
}

function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
  )
}

interface SelectOption {
  value: string
  label: ReactNode
  disabled?: boolean
  icon?: LucideIcon
}

interface SimpleSelectProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  size?: "sm" | "default" | "lg"
  className?: string
  triggerClassName?: string
  contentClassName?: string
  "aria-label"?: string
}

/**
 * Concise, pre-composed Select dropdown component for quick use without Radix boilerplate.
 */
function SimpleSelect({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder,
  disabled,
  size = "default",
  className,
  triggerClassName,
  contentClassName,
  "aria-label": ariaLabel,
}: SimpleSelectProps) {
  return (
    <Select
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectTrigger size={size} className={cn(className, triggerClassName)} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.icon ? (
              <opt.icon className="mr-1.5 size-3.5 inline-block shrink-0" aria-hidden />
            ) : null}
            <span>{opt.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SimpleSelect,
  selectTriggerVariants,
}
export type { SelectOption, SelectTriggerProps, SimpleSelectProps }
