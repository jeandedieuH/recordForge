import type { InputHTMLAttributes } from "react"

function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 ${className}`}
      {...props}
    />
  )
}

export default Input
