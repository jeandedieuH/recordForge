import { cva, type VariantProps } from "class-variance-authority"
import { LoaderCircle } from "lucide-react"
import type { ButtonHTMLAttributes } from "react"
import { cn } from "../../lib/cn"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium outline-none transition-[color,background-color,border-color,box-shadow,opacity] duration-fast ease-forge focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-white shadow-e1 hover:bg-primary/90",
        secondary: "border border-border bg-secondary text-white hover:bg-secondary/70",
        ghost: "text-muted-foreground hover:bg-overlay hover:text-foreground",
        outline: "border border-border-strong bg-transparent text-foreground hover:bg-overlay",
        destructive:
          "border border-recording/30 bg-recording/15 text-recording hover:bg-recording/25",
      },
      size: {
        sm: "h-8 px-2.5 text-xs [&_svg]:size-3.5",
        md: "h-9 px-3 text-sm [&_svg]:size-4",
        lg: "h-11 px-4 text-base [&_svg]:size-5",
        icon: "size-8 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
)

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner and disables the button while an action is in flight. */
  loading?: boolean
}

function Button({ className, variant, size, loading, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
