import type { LucideIcon } from "lucide-react"
import {
  Captions,
  EyeOff,
  FileOutput,
  LayoutTemplate,
  Library,
  MousePointer2,
  Shapes,
  Shield,
  Type,
  Volume2,
  ZoomIn,
} from "lucide-react"
import { cn } from "@recordforge/ui"

export type EditorTask =
  | "media"
  | "titles"
  | "annotations"
  | "focus"
  | "cursor"
  | "captions"
  | "layout"
  | "audio"
  | "privacy"
  | "export"

interface TaskDefinition {
  value: EditorTask
  label: string
  icon: LucideIcon
}

export const EDITOR_TASKS: TaskDefinition[] = [
  { value: "media", label: "Media", icon: Library },
  { value: "titles", label: "Titles", icon: Type },
  { value: "annotations", label: "Shapes", icon: Shapes },
  { value: "focus", label: "Focus", icon: ZoomIn },
  { value: "cursor", label: "Cursor", icon: MousePointer2 },
  { value: "captions", label: "Captions", icon: Captions },
  { value: "layout", label: "Layout", icon: LayoutTemplate },
  { value: "audio", label: "Audio", icon: Volume2 },
  { value: "privacy", label: "Privacy", icon: EyeOff },
  { value: "export", label: "Export", icon: FileOutput },
]

interface TaskRailProps {
  activeTask: EditorTask
  onSelect: (task: EditorTask) => void
  onToggleInspector?: () => void
  showInspectorToggle?: boolean
}

export function TaskRail({
  activeTask,
  onSelect,
  onToggleInspector,
  showInspectorToggle,
}: TaskRailProps) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, task: EditorTask) {
    const tabs = event.currentTarget.parentElement
    if (!tabs) return

    const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>("[role='tab']"))
    const index = buttons.indexOf(event.currentTarget)
    if (index === -1) return

    let nextIndex: number | null

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = (index + 1) % buttons.length
        break
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = (index - 1 + buttons.length) % buttons.length
        break
      case "Home":
        nextIndex = 0
        break
      case "End":
        nextIndex = buttons.length - 1
        break
      case "Enter":
      case " ":
        event.preventDefault()
        onSelect(task)
        return
      default:
        return
    }

    if (nextIndex !== null) {
      event.preventDefault()
      buttons[nextIndex]?.focus()
    }
  }

  return (
    <nav
      className="flex h-full min-h-0 w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden border-r border-border bg-surface-dim py-2"
      role="tablist"
      aria-label="Editor tasks"
      aria-orientation="vertical"
    >
      {EDITOR_TASKS.map((task) => {
        const Icon = task.icon
        const isActive = activeTask === task.value
        return (
          <button
            key={task.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={task.label}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(task.value)}
            onKeyDown={(event) => handleKeyDown(event, task.value)}
            className={cn(
              "group flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-fast ease-forge focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
              isActive
                ? "bg-surface text-foreground shadow-e1"
                : "hover:bg-surface hover:text-foreground",
            )}
            title={task.label}
          >
            <Icon className="size-5" aria-hidden />
          </button>
        )
      })}

      {showInspectorToggle ? (
        <div className="mt-auto flex flex-col items-center border-t border-border pt-2">
          <button
            type="button"
            aria-label="Open inspector"
            onClick={onToggleInspector}
            className="group flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-fast ease-forge hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            title="Inspector"
          >
            <Shield className="size-5" aria-hidden />
          </button>
        </div>
      ) : null}
    </nav>
  )
}
