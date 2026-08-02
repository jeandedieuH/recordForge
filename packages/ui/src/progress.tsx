interface ProgressProps {
  value: number
  className?: string
}

function Progress({ value, className = "" }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value * 100))
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className}`}
    >
      <div
        className="h-full bg-primary transition-all duration-200"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

export default Progress
