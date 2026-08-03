import {
  Circle,
  FolderOpen,
  HardDrive,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Scissors,
  Settings,
} from "lucide-react"
import {
  Badge,
  IconButton,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@recordforge/ui"
import { cn } from "@recordforge/ui"
import { useJobsStore } from "../stores/jobs-store"
import { useRecorderStore } from "../stores/recorder-store"

export type View = "record" | "library" | "editor" | "settings"

interface SidebarProps {
  activeView: View
  onNavigate: (view: View) => void
  editorOpen: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
}

interface NavItem {
  view: View
  label: string
  icon: typeof Circle
}

const NAV_ITEMS: NavItem[] = [
  { view: "record", label: "Record", icon: Circle },
  { view: "library", label: "Library", icon: FolderOpen },
  { view: "settings", label: "Settings", icon: Settings },
]

// Icon sidebar rail: primary navigation, contextual editor entry, and a footer
// with the jobs indicator + disk meter (Jobs Drawer wiring lands in R2).
export function Sidebar({
  activeView,
  onNavigate,
  editorOpen,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const jobs = useJobsStore((state) => state.jobs)
  const recorderStatus = useRecorderStore((state) => state.status)
  const activeJobCount = jobs.filter((j) => j.status === "pending" || j.status === "running").length
  const isRecording = recorderStatus?.state === "recording"

  function navButton(item: NavItem) {
    const Icon = item.icon
    const active = activeView === item.view
    const button = (
      <button
        key={item.view}
        type="button"
        onClick={() => onNavigate(item.view)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex cursor-pointer items-center gap-3 rounded-md text-sm transition-colors duration-fast ease-forge",
          collapsed ? "size-9 justify-center" : "h-9 px-3",
          active
            ? "bg-accent-soft text-accent"
            : "text-muted-foreground hover:bg-overlay hover:text-foreground",
        )}
      >
        <Icon
          className={cn(
            "size-5 shrink-0",
            item.view === "record" && isRecording && "fill-recording text-recording",
          )}
          aria-hidden
        />
        {collapsed ? null : <span>{item.label}</span>}
      </button>
    )

    if (!collapsed) return button
    return (
      <Tooltip key={item.view}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-surface/60 py-3 transition-[width] duration-base ease-forge",
        collapsed ? "w-14 items-center px-2" : "w-50 px-2",
      )}
    >
      <nav className={cn("flex flex-col gap-1", collapsed && "items-center")}>
        {NAV_ITEMS.map(navButton)}

        {editorOpen ? (
          <>
            <Separator className="my-2" />
            {(() => {
              const active = activeView === "editor"
              const button = (
                <button
                  type="button"
                  onClick={() => onNavigate("editor")}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md text-sm transition-colors duration-fast ease-forge",
                    collapsed ? "size-9 justify-center" : "h-9 px-3",
                    active
                      ? "bg-accent-soft text-accent"
                      : "text-muted-foreground hover:bg-overlay hover:text-foreground",
                  )}
                >
                  <Scissors className="size-5 shrink-0" aria-hidden />
                  {collapsed ? null : (
                    <>
                      <span>Editor</span>
                      <Badge variant="accent" className="ml-auto px-1.5 text-[10px]">
                        open
                      </Badge>
                    </>
                  )}
                </button>
              )
              if (!collapsed) return button
              return (
                <Tooltip>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent side="right">Editor</TooltipContent>
                </Tooltip>
              )
            })()}
          </>
        ) : null}
      </nav>

      <div className="flex-1" />

      <div className={cn("flex flex-col gap-1", collapsed && "items-center")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-fast hover:bg-overlay hover:text-foreground",
                collapsed && "justify-center",
              )}
            >
              <ListTodo className="size-4 shrink-0" aria-hidden />
              {collapsed ? (
                activeJobCount > 0 ? (
                  <span className="tnum">{activeJobCount}</span>
                ) : null
              ) : (
                <span className="tnum">
                  {activeJobCount > 0
                    ? `${activeJobCount} active ${activeJobCount === 1 ? "job" : "jobs"}`
                    : "No active jobs"}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Jobs — drawer arrives in the library milestone
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground",
                collapsed && "justify-center",
              )}
            >
              <HardDrive className="size-4 shrink-0" aria-hidden />
              {collapsed ? null : <span className="tnum">Disk: —</span>}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            Free disk space — wired up in the library milestone
          </TooltipContent>
        </Tooltip>

        <Separator className="my-1" />

        <IconButton
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapsed}
          tooltipSide="right"
          className={collapsed ? "" : "self-start"}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </IconButton>
      </div>
    </aside>
  )
}
