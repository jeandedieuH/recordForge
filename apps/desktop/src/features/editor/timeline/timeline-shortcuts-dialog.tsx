import { memo } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Kbd,
} from "@recordforge/ui"
import { Keyboard } from "lucide-react"

export interface TimelineShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ShortcutGroup {
  title: string
  items: Array<{
    description: string
    keys: string[]
  }>
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Playback & Navigation",
    items: [
      { description: "Play / Pause preview", keys: ["Space"] },
      { description: "Rewind (0.5×) / Stop / Fast-Forward (1×)", keys: ["J", "K", "L"] },
      { description: "Step backward 1 frame", keys: ["←"] },
      { description: "Step forward 1 frame", keys: ["→"] },
      { description: "Jump 1 second backward / forward", keys: ["Shift", "← / →"] },
      { description: "Jump to timeline start / end", keys: ["Home", "End"] },
    ],
  },
  {
    title: "Tools & Quick Actions",
    items: [
      { description: "Selection tool", keys: ["V"] },
      { description: "Razor / Split tool", keys: ["S", "C"] },
      { description: "Range selection tool", keys: ["R"] },
      { description: "Add chapter / note marker", keys: ["M"] },
      { description: "Add smart zoom segment", keys: ["Z"] },
    ],
  },
  {
    title: "Editing & Clips",
    items: [
      { description: "Split selected clip at playhead", keys: ["S"] },
      { description: "Delete selected clip or range", keys: ["Del"] },
      { description: "Ripple delete (close gap automatically)", keys: ["Shift", "Del"] },
      { description: "Duplicate selected clip(s)", keys: ["Ctrl", "D"] },
      { description: "Trim clip edge by 1 frame", keys: ["Alt", "← / →"] },
      { description: "Nudge clip start position", keys: ["Ctrl", "← / →"] },
      { description: "Temporary snap bypass while dragging", keys: ["Alt", "Drag"] },
    ],
  },
  {
    title: "Zoom & Viewport",
    items: [
      { description: "Zoom in timeline", keys: ["Ctrl", "+"] },
      { description: "Zoom out timeline", keys: ["Ctrl", "-"] },
      { description: "Zoom to fit entire timeline", keys: ["Shift", "Z"] },
      { description: "Zoom centered on mouse cursor", keys: ["Ctrl", "Wheel"] },
      { description: "Horizontal pan timeline", keys: ["Shift", "Wheel"] },
      { description: "Cancel current drag / deselect", keys: ["Esc"] },
    ],
  },
]

export const TimelineShortcutsDialog = memo(function TimelineShortcutsDialog({
  open,
  onOpenChange,
}: TimelineShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-6 bg-surface border-border shadow-e3">
        <DialogHeader className="flex flex-row items-center gap-3 space-y-0 pb-3 border-b border-border">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Keyboard className="size-5" />
          </div>
          <div>
            <DialogTitle className="text-base font-semibold text-foreground">
              Timeline Keyboard Shortcuts
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Master rapid editing workflows with tactile keyboard controls
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-3 max-h-[65vh] overflow-y-auto pr-1">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="space-y-2 rounded-lg border border-border/60 bg-surface-dim/50 p-3">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-primary">
                {group.title}
              </h4>
              <div className="space-y-1.5">
                {group.items.map((item) => (
                  <div
                    key={item.description}
                    className="flex items-center justify-between text-xs py-0.5"
                  >
                    <span className="text-muted-foreground">{item.description}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.keys.map((k) => (
                        <Kbd key={k} className="text-[10px] py-0.5 px-1.5">
                          {k}
                        </Kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
})
