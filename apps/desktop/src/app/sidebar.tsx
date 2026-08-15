import {
  FolderOpen,
  HardDrive,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  PlaySquare,
  Scissors,
  Settings,
  User,
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

export type View = "library" | "editor" | "settings" | "projects" | "storage" | "export"

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
  icon: typeof PlaySquare
}

const NAV_ITEMS: NavItem[] = [
  { view: "library", label: "Library", icon: PlaySquare },
  { view: "projects", label: "Projects", icon: FolderOpen },
  { view: "storage", label: "Storage", icon: HardDrive },
  { view: "settings", label: "Settings", icon: Settings },
]

export function Sidebar({
  activeView,
  onNavigate,
  editorOpen,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const jobs = useJobsStore((state) => state.jobs)
  const activeJobCount = jobs.filter((j) => j.status === "pending" || j.status === "running").length

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
          "relative flex cursor-pointer items-center gap-3.5 rounded-lg text-sm font-medium transition-all duration-fast ease-forge",
          collapsed ? "size-10 justify-center" : "h-11 px-3.5",
          active
            ? "bg-sidebar-active text-foreground"
            : "text-sidebar-text hover:bg-sidebar-surface hover:text-foreground",
        )}
      >
        <Icon
          className={cn("size-5 shrink-0", active ? "text-foreground" : "text-sidebar-text")}
          aria-hidden
        />
        {collapsed ? null : <span>{item.label}</span>}
        {active && !collapsed ? (
          <span className="absolute right-0 top-2 bottom-2 w-0.5 rounded-l bg-primary" />
        ) : null}
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
        "flex shrink-0 flex-col bg-sidebar text-sidebar-text py-5 px-3 transition-[width] duration-base ease-forge select-none border-r border-sidebar-border",
        collapsed ? "w-16 items-center" : "w-56",
      )}
    >
      {/* Brand Header */}
      <div
        className={cn("mb-6 px-2 flex items-center", collapsed ? "justify-center px-0" : "gap-3")}
      >
        {!collapsed ? (
          <div className="flex flex-col">
            <img
              src="/logo.png"
              alt="recordForge icon"
              className="w-40 shrink-0 object-contain select-none"
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <img
                src="/icon.svg"
                alt="recordForge"
                className="size-8 shrink-0 object-contain select-none"
              />
            </TooltipTrigger>
            <TooltipContent side="right">RecordForge</TooltipContent>
          </Tooltip>
        )}
      </div>

      <nav className={cn("flex flex-col gap-1.5", collapsed && "items-center")}>
        {NAV_ITEMS.map(navButton)}

        {editorOpen ? (
          <>
            <Separator className="my-2 bg-sidebar-border" />
            {(() => {
              const active = activeView === "editor"
              const button = (
                <button
                  type="button"
                  onClick={() => onNavigate("editor")}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex cursor-pointer items-center gap-3.5 rounded-lg text-sm font-medium transition-colors duration-fast ease-forge",
                    collapsed ? "size-10 justify-center" : "h-11 px-3.5",
                    active
                      ? "bg-sidebar-active text-foreground"
                      : "text-sidebar-text hover:bg-sidebar-surface hover:text-foreground",
                  )}
                >
                  <Scissors className="size-5 shrink-0 text-sidebar-text" aria-hidden />
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

      <div className={cn("flex flex-col gap-2", collapsed && "items-center")}>
        {activeJobCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-sidebar-text hover:bg-sidebar-surface hover:text-foreground",
                  collapsed && "justify-center",
                )}
              >
                <ListTodo className="size-4 shrink-0" aria-hidden />
                {collapsed ? (
                  <span className="tnum">{activeJobCount}</span>
                ) : (
                  <span className="tnum">
                    {activeJobCount} active {activeJobCount === 1 ? "job" : "jobs"}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Active Jobs</TooltipContent>
          </Tooltip>
        ) : null}

        {/* User Profile Avatar */}
        <div
          className={cn(
            "flex items-center gap-2 pt-2",
            collapsed && "flex-col justify-center gap-3",
          )}
        >
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-surface text-sidebar-text transition-colors hover:border-foreground/30 hover:text-foreground"
            aria-label="User Account"
          >
            <User className="size-4" />
          </button>

          {!collapsed ? (
            <IconButton
              label="Collapse sidebar"
              onClick={onToggleCollapsed}
              tooltipSide="right"
              className="ml-auto text-sidebar-text hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </IconButton>
          ) : (
            <IconButton
              label="Expand sidebar"
              onClick={onToggleCollapsed}
              tooltipSide="right"
              className="text-sidebar-text hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </IconButton>
          )}
        </div>
      </div>
    </aside>
  )
}
