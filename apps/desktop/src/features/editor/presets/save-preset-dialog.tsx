import { useMemo, useState } from "react"
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
  Textarea,
} from "@recordforge/ui"
import { Save } from "lucide-react"

export interface SavePresetFormData {
  name: string
  description: string
  category: string
  tags: string
}

interface SavePresetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultCategory?: string
  categories: string[]
  onSave: (data: SavePresetFormData) => Promise<void> | void
}

export function SavePresetDialog({
  open,
  onOpenChange,
  defaultCategory,
  categories,
  onSave,
}: SavePresetDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState(defaultCategory ?? "")
  const [tags, setTags] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const trimmedName = name.trim()
  const isValid = trimmedName.length > 0 && category.trim().length > 0

  const categoryOptions = useMemo(() => {
    const base = categories.length > 0 ? categories : ["custom"]
    return Array.from(new Set([...base, category.trim()].filter(Boolean)))
  }, [categories, category])

  function reset() {
    setName("")
    setDescription("")
    setCategory(defaultCategory ?? "")
    setTags("")
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!isValid) return
    setIsSaving(true)
    try {
      await onSave({
        name: trimmedName,
        description: description.trim(),
        category: category.trim(),
        tags,
      })
      onOpenChange(false)
      reset()
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Save className="size-4 text-primary" aria-hidden />
              Save as Preset
            </DialogTitle>
            <DialogDescription>
              Store the current style so you can reuse it later. Position and timing are not saved.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="preset-name">Name</Label>
              <Input
                id="preset-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My custom preset"
                className="h-9 text-xs"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-description">Description</Label>
              <Textarea
                id="preset-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this preset is for..."
                className="min-h-[72px] resize-none text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-category">Category</Label>
              <Input
                id="preset-category"
                list="preset-categories"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="custom"
                className="h-9 text-xs"
              />
              <datalist id="preset-categories">
                {categoryOptions.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="preset-tags">Tags</Label>
              <Input
                id="preset-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="brand, lower-third, dark (comma separated)"
                className="h-9 text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!isValid || isSaving}>
              {isSaving ? "Saving..." : "Save Preset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
