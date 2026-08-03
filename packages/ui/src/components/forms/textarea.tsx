import type { TextareaHTMLAttributes } from "react"
import { cn } from "../../lib/cn"

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean
}

function Textarea({ className, error, ...props }: TextareaProps) {
  return (
    <textarea
      aria-invalid={error || undefined}
      className={cn(
        "min-h-20 w-full rounded-md border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-fast ease-forge placeholder:text-subtle-foreground focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-50",
        error ? "border-recording/60 focus-visible:ring-recording/30" : "border-border",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
export type { TextareaProps }
