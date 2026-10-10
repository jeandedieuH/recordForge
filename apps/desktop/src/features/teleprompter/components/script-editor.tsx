import { useLayoutEffect, useRef } from "react"

interface ScriptEditorProps {
  notes: string
  onNotesChange: (notes: string) => void
}

/** The edit-mode scroller — the textarea itself is the only scroll container. */
export function ScriptEditor({ notes, onNotesChange }: ScriptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Mount-only (the component unmounts with every Edit->Prompt switch):
  // hand focus to the textarea, caret at the end, so a script can be
  // pasted or tweaked immediately.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  return (
    <textarea
      ref={textareaRef}
      data-testid="script-editor"
      value={notes}
      onChange={(event) => onNotesChange(event.target.value)}
      placeholder="Paste or type your script..."
      spellCheck={false}
      className="teleprompter-editor block h-full w-full resize-none overflow-y-auto bg-transparent px-8 py-6 text-lg leading-relaxed text-foreground outline-none placeholder:text-subtle-foreground"
    />
  )
}
