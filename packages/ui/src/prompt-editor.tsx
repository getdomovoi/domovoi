import { useEffect, useRef, useState } from "react"
import { PilcrowIcon, CodeIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import { Textarea } from "./components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"

export type PromptEditorMode = "prose" | "markdown"

export const promptEditorInserts: Record<PromptEditorMode, readonly string[]> = {
  prose: ["@file", "/skill", "@selection", "@error"],
  markdown: ["```diff", "`inline code`", "## heading", "- list item"],
}

export function promptDraftStats(draft: string): string {
  const trimmed = draft.trim()
  if (!trimmed) return "empty draft"
  const words = trimmed.split(/\s+/u).length
  return `${words} ${words === 1 ? "word" : "words"} · ${draft.length} chars`
}

// An insert lands where the caret is, so a draft can be built without the
// author losing their place. A selection is replaced rather than pushed aside.
export function insertAtSelection(
  value: string,
  insert: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  const before = value.slice(0, start)
  const after = value.slice(end)
  const spacer = before && !/\s$/u.test(before) ? " " : ""
  const next = `${before}${spacer}${insert}${after}`
  return { value: next, caret: before.length + spacer.length + insert.length }
}

export function PromptEditorDialog({
  open,
  draft,
  pending,
  sendDisabled,
  onOpenChange,
  onDraftChange,
  onSend,
  projectLabel,
  worktreeLabel,
}: {
  open: boolean
  draft: string
  pending: boolean
  sendDisabled: boolean
  onOpenChange: (open: boolean) => void
  onDraftChange: (draft: string) => void
  onSend: () => void
  projectLabel: string
  worktreeLabel?: string | undefined
}) {
  const [mode, setMode] = useState<PromptEditorMode>("prose")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) queueMicrotask(() => textareaRef.current?.focus())
  }, [open])

  const applyInsert = (insert: string) => {
    const field = textareaRef.current
    const start = field?.selectionStart ?? draft.length
    const end = field?.selectionEnd ?? draft.length
    const next = insertAtSelection(draft, insert, start, end)
    onDraftChange(next.value)
    queueMicrotask(() => {
      field?.focus()
      field?.setSelectionRange(next.caret, next.caret)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Prompt editor</DialogTitle>
          <DialogDescription>
            <span className="font-machine text-[10.5px]">
              {worktreeLabel ? `${projectLabel} · ${worktreeLabel}` : projectLabel}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(next) => { if (next) setMode(next as PromptEditorMode) }}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="prose" aria-label="Prose">
              <PilcrowIcon />
            </ToggleGroupItem>
            <ToggleGroupItem value="markdown" aria-label="Markdown">
              <CodeIcon />
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="flex flex-wrap items-center gap-1.5">
            {promptEditorInserts[mode].map((insert) => (
              <Button
                key={insert}
                type="button"
                variant="outline"
                size="sm"
                className="font-machine text-[10px]"
                onClick={() => applyInsert(insert)}
              >
                {insert}
              </Button>
            ))}
          </div>
        </div>
        <Textarea
          ref={textareaRef}
          aria-label="Prompt editor message"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              if (!sendDisabled) onSend()
            }
          }}
          className={`min-h-[300px] resize-y ${mode === "markdown" ? "font-machine text-[12.5px]" : "text-[13.5px]"}`}
          placeholder={mode === "markdown"
            ? "Markdown, ## headings, - lists, ``` fences for code and logs. Rendered as written when the agent reads it."
            : "Describe the change in as much detail as you need. @file attaches context and /skill runs one."}
        />
        <DialogFooter className="sm:justify-between">
          <span role="status" className="font-machine text-[10px] text-faint">
            {promptDraftStats(draft)} · ⌘⏎ send · esc close
          </span>
          <div className="flex items-center gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">Keep as draft</Button>
            </DialogClose>
            <Button size="sm" disabled={sendDisabled || pending} onClick={onSend}>Send</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
