import { useEffect, useRef, useState } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import { Dialog, DialogClose, DialogPortal, DialogTitle } from "./components/ui/dialog"
import { Textarea } from "./components/ui/textarea"
import { cn } from "./lib/utils"

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

const contextChip = "flex items-center gap-2 rounded-full border px-[13px] py-[7px] font-machine text-[11.5px] whitespace-nowrap"

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
  turnRunning,
  machineName,
  machineReachable,
  modelLabel,
  modeLabel,
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
  turnRunning: boolean
  machineName: string
  machineReachable: boolean
  modelLabel: string
  modeLabel: string
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
      <DialogPortal>
        {/* The design's own scrim: the plain overlay tone, no blur. Clicking it
            closes, clicking the card does not, so a stray click never discards
            a long prompt. */}
        <DialogPrimitive.Overlay
          data-prompt-editor-scrim=""
          className="fixed inset-0 z-50 bg-overlay data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Content
          className="fixed top-1/2 left-1/2 z-50 flex h-[calc(100%-68px)] max-h-[660px] w-[980px] max-w-[calc(100%-68px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[16px] border bg-card text-card-foreground shadow-[var(--shadow-xl)] outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <div className="flex flex-none items-center gap-3 border-b px-[18px] py-4">
            <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em]">Prompt editor</DialogTitle>
            <span className="font-machine text-[11.5px] text-faint">
              {worktreeLabel ? `${projectLabel} · ${worktreeLabel}` : projectLabel}
            </span>
            <span className="flex-1" />
            {/* A segmented control, not pills: the insert chips and the footer
                chips are pills, and this one picks between two states. */}
            <div
              role="radiogroup"
              aria-label="How this prompt is written"
              className="flex items-center gap-[2px] rounded-(--radius) bg-accent p-[3px]"
            >
              <button
                type="button"
                role="radio"
                aria-label="Prose"
                aria-checked={mode === "prose"}
                onClick={() => setMode("prose")}
                className={cn(
                  "flex h-[26px] min-w-[38px] items-center justify-center rounded-[calc(var(--radius)-3px)] px-[11px] text-[12px]",
                  mode === "prose" ? "bg-background text-foreground" : "text-muted-foreground",
                )}
              >
                Aa
              </button>
              <button
                type="button"
                role="radio"
                aria-label="Markdown"
                aria-checked={mode === "markdown"}
                onClick={() => setMode("markdown")}
                className={cn(
                  "flex h-[26px] min-w-[38px] items-center justify-center rounded-[calc(var(--radius)-3px)] px-[11px] font-machine text-[11px]",
                  mode === "markdown" ? "bg-background text-foreground" : "text-muted-foreground",
                )}
              >
                MD
              </button>
            </div>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close the prompt editor"
                className="size-7 flex-none rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <XIcon className="size-4" />
              </Button>
            </DialogClose>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-[13px] px-[18px] py-4">
            {/* Focused by definition: a field that exists to be typed in opens
                with the ring rather than waiting to be clicked. */}
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
              className={cn(
                "min-h-0 flex-1 resize-none rounded-[14px] border-primary bg-code px-4 py-[15px] leading-[1.65] shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_14%,transparent)] focus-visible:ring-0",
                mode === "markdown" ? "font-machine text-[12.5px]" : "text-[13.5px]",
              )}
              placeholder={mode === "markdown"
                ? "Markdown, ## headings, - lists, ``` fences for code and logs. Rendered as written when the agent reads it."
                : "Describe the change in as much detail as you need. Plain prose; @file attaches context and /skill runs one."}
            />
            <div className="flex flex-none flex-wrap items-center gap-2">
              {promptEditorInserts[mode].map((insert) => (
                <button
                  key={insert}
                  type="button"
                  onClick={() => applyInsert(insert)}
                  className="rounded-full border px-3 py-[6px] font-machine text-[11px] whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {insert}
                </button>
              ))}
              <span className="flex-1" />
              <span role="status" className="font-machine text-[11px] text-faint">
                {promptDraftStats(draft)}
              </span>
            </div>
          </div>

          {/* v1's editor lost every piece of context when it opened, so a long
              prompt was written without knowing whether it would run in ask or
              build. These read the composer's own values and are display only. */}
          <div
            role="group"
            aria-label="What this turn runs under"
            className="flex flex-none flex-wrap items-center gap-[9px] border-t px-[18px] py-[14px]"
          >
            <span className={cn(contextChip, "text-strong")}>
              <span
                aria-hidden
                className={cn("size-[7px] rounded-full", machineReachable ? "bg-success" : "bg-muted-foreground")}
              />
              {machineName}
            </span>
            <span className={cn(contextChip, "text-muted-foreground")}>{modelLabel}</span>
            <span className={cn(contextChip, "text-muted-foreground")}>
              <span aria-hidden className="size-[7px] rounded-full bg-current" />
              {modeLabel}
            </span>
            <span className="flex-1" />
            <span className="font-machine text-[11px] text-faint">⌘⏎ send · esc close</span>
            <DialogClose asChild>
              <Button variant="outline" size="sm" className="text-[12.5px]">Keep as draft</Button>
            </DialogClose>
            <Button size="sm" className="text-[12.5px]" disabled={sendDisabled || pending} onClick={onSend}>
              {turnRunning ? "Queue it" : "Send"}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
