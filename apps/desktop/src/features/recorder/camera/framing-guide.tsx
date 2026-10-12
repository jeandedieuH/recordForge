// Rule-of-thirds overlay for the camera preview — lines, a small centre
// cross, and eye-line ticks on the upper third. Decorative only.
export function FramingGuide() {
  const line = "rgba(255,255,255,0.3)"
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <line x1="33.33" y1="0" x2="33.33" y2="100" stroke={line} strokeWidth="0.25" />
      <line x1="66.66" y1="0" x2="66.66" y2="100" stroke={line} strokeWidth="0.25" />
      <line x1="0" y1="33.33" x2="100" y2="33.33" stroke={line} strokeWidth="0.25" />
      <line x1="0" y1="66.66" x2="100" y2="66.66" stroke={line} strokeWidth="0.25" />
      {/* Centre cross */}
      <line x1="48.5" y1="50" x2="51.5" y2="50" stroke={line} strokeWidth="0.35" />
      <line x1="50" y1="47.5" x2="50" y2="52.5" stroke={line} strokeWidth="0.35" />
      {/* Eye-line ticks on the upper third */}
      <line x1="28" y1="33.33" x2="38.5" y2="33.33" stroke={line} strokeWidth="0.6" />
      <line x1="61.5" y1="33.33" x2="72" y2="33.33" stroke={line} strokeWidth="0.6" />
    </svg>
  )
}
