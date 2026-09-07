import type { TextClip } from "@recordforge/contracts"

export type TitleContentField =
  "primaryText" | "secondaryText" | "tagText" | "emphasisText" | "prefix" | "suffix"

function fieldValue(clip: TextClip, field: TitleContentField): string {
  if (field === "emphasisText") return clip.titleDesign?.emphasisText ?? ""
  if (field === "prefix" || field === "suffix") return clip.titleDesign?.metric[field] ?? ""
  return clip[field] ?? ""
}

/** One clip-scoped transaction; no delayed callbacks can target a later selection. */
export function createTitleContentDraft(
  initial: TextClip,
  initialCommit: (patch: Partial<TextClip>) => void,
) {
  let clip = initial
  let commit = initialCommit
  const pending = new Map<TitleContentField, string>()
  return {
    sync(next: TextClip, nextCommit: typeof commit) {
      if (next.id !== initial.id) throw new Error("Title draft cannot change clip identity")
      clip = next
      commit = nextCommit
    },
    value(field: TitleContentField) {
      return pending.get(field) ?? fieldValue(clip, field)
    },
    set(field: TitleContentField, value: string) {
      if (value === fieldValue(clip, field)) pending.delete(field)
      else pending.set(field, value)
    },
    flush() {
      const patch: Partial<TextClip> = {}
      for (const [field, value] of pending) {
        // Keep an invalid primary draft visible without violating the durable contract.
        if (field === "primaryText" && !value.trim()) continue
        if (field === "emphasisText" || field === "prefix" || field === "suffix") {
          if (!clip.titleDesign) {
            pending.delete(field)
            continue
          }
          const design = patch.titleDesign ?? {
            ...clip.titleDesign,
            metric: { ...clip.titleDesign.metric },
          }
          if (field === "emphasisText") design.emphasisText = value
          else design.metric[field] = value
          patch.titleDesign = design
        } else patch[field] = value
        pending.delete(field)
      }
      if (!Object.keys(patch).length) return
      clip = { ...clip, ...patch }
      commit(patch)
    },
  }
}
