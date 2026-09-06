import { IconButton, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@recordforge/ui"
import { Eye, EyeOff, Lock, Shapes, Unlock } from "lucide-react"
import { AnnotationLayoutTab } from "./annotation-layout-tab"
import { AnnotationMotionTab } from "./annotation-motion-tab"
import { AnnotationPresetControls } from "./annotation-preset-controls"
import { AnnotationStyleTab } from "./annotation-style-tab"
import type { AnnotationInspectorProps } from "./annotation-inspector-helpers"

export function AnnotationClipInspector({ clip, onChange }: AnnotationInspectorProps) {
  const hidden = clip.enabled === false
  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 text-xs">
      {/* Top Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Shapes className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">Annotation</h3>
            <p className="truncate text-xs capitalize text-muted-foreground">
              {clip.annotationType.replace("-", " ")}
              {hidden ? " · Hidden" : ""}
              {clip.locked ? " · Locked" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={hidden ? "Show annotation" : "Hide annotation"}
            aria-pressed={!hidden}
            className={cn("size-8", hidden && "text-muted-foreground")}
            onClick={() => onChange({ enabled: hidden })}
          >
            {hidden ? (
              <EyeOff className="size-4" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
          </IconButton>
          <IconButton
            label={clip.locked ? "Unlock position" : "Lock position"}
            aria-pressed={clip.locked}
            className={cn("size-8", clip.locked && "bg-primary/10 text-primary")}
            onClick={() => onChange({ locked: !clip.locked })}
          >
            {clip.locked ? (
              <Lock className="size-4" aria-hidden />
            ) : (
              <Unlock className="size-4" aria-hidden />
            )}
          </IconButton>
        </div>
      </div>
      <AnnotationPresetControls key={clip.id} clip={clip} onChange={onChange} />
      <Tabs defaultValue="style" className="flex min-w-0 flex-col gap-4">
        <TabsList aria-label="Annotation settings" className="grid w-full grid-cols-3">
          <TabsTrigger value="style" className="px-2 text-xs">
            Style
          </TabsTrigger>
          <TabsTrigger value="motion" className="px-2 text-xs">
            Motion
          </TabsTrigger>
          <TabsTrigger value="layout" className="px-2 text-xs">
            Layout
          </TabsTrigger>
        </TabsList>
        {/* Remount field drafts per clip without taking the user out of their current tab. */}
        <TabsContent value="style">
          <AnnotationStyleTab key={clip.id} clip={clip} onChange={onChange} />
        </TabsContent>
        <TabsContent value="motion">
          <AnnotationMotionTab key={clip.id} clip={clip} onChange={onChange} />
        </TabsContent>
        <TabsContent value="layout">
          <AnnotationLayoutTab key={clip.id} clip={clip} onChange={onChange} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
