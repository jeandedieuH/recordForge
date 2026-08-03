import * as SliderPrimitive from "@radix-ui/react-slider"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

function Slider({ className, ...props }: ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-overlay">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label="Value"
        className="block size-3.5 cursor-pointer rounded-full border border-border-strong bg-foreground shadow-e1 transition-transform duration-fast ease-forge outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent/50"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
