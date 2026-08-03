import type { ReactNode } from "react"
import { Kbd } from "../display/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlay/tooltip"
import { Button, type ButtonProps } from "./button"

interface IconButtonProps extends Omit<ButtonProps, "children"> {
  /** Accessible name — also shown in the tooltip. Required: icon-only buttons must be labelled. */
  label: string
  /** Optional shortcut hint rendered as a Kbd inside the tooltip. */
  shortcut?: string
  tooltipSide?: "top" | "right" | "bottom" | "left"
  children: ReactNode
}

/** Icon-only button with built-in tooltip + aria-label (Forge UI quality bar). */
function IconButton({ label, shortcut, tooltipSide, children, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

export { IconButton }
export type { IconButtonProps }
