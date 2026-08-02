import type { ButtonHTMLAttributes, ReactNode } from "react"

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: "primary" | "secondary" | "ghost"
}

function Button({ children, variant = "primary", className = "", ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-opacity focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"

  const variants = {
    primary: "bg-primary text-primary-foreground hover:opacity-90",
    secondary: "bg-muted text-foreground hover:opacity-90",
    ghost: "bg-transparent text-foreground hover:bg-muted",
  }

  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}

export default Button
