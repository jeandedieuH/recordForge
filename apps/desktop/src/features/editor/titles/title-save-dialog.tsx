import { useId, useState } from "react"
import { textPresetFromClip, type TextClip } from "@recordforge/editor-core"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useToast,
} from "@recordforge/ui"
import { getTextPresetRegistry } from "../presets/preset-store"

export function TitleSaveDialog({
  clip,
  open,
  onOpenChange,
}: {
  clip: TextClip
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const nameId = useId()
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const preset = textPresetFromClip(clip, {
        name: name.trim(),
        description: "Saved from your timeline",
        category: clip.category,
      })
      // A fresh ID avoids silently overwriting an earlier saved design from the same clip.
      await getTextPresetRegistry().saveCustomPreset({ ...preset, id: undefined })
      toast({ title: "Custom title saved", description: "Find it in the Custom collection." })
      onOpenChange(false)
    } catch {
      setError("The title could not be saved. Try again before closing this dialog.")
      toast({ title: "Custom title could not be saved", variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!saving) onOpenChange(value)
      }}
    >
      <DialogContent className="max-w-sm">
        <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>Save Custom Title</DialogTitle>
            <DialogDescription>
              Save this design and its current words locally. Timing and position are not included.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>Preset Name</Label>
            <Input
              id={nameId}
              name="title-preset-name"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="My title design…"
              aria-invalid={!!error}
              aria-describedby={error ? `${nameId}-error` : undefined}
            />
            {error ? (
              <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save Title"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
