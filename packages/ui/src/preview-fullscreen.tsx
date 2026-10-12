import type { ReactNode } from "react"
import { CircleStopIcon, Minimize2Icon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog"
import { Field, FieldLabel } from "./components/ui/field"
import { Textarea } from "./components/ui/textarea"

// The design's fullscreen preview (D23): a full surface over the shell with
// the title, the read-only path line, widths and Exit fullscreen (esc) on top,
// the page with its hint and the variant foot on the left, and the comments
// column on the right, where an element picked in this frame is drafted and
// posted. Narrow windows stack the column under the page.
export function PreviewFullscreen({
  open,
  onOpenChange,
  title,
  meta,
  widths,
  stage,
  hint,
  foot,
  commentsTitle,
  commentCount,
  annotate,
  draft,
  comments,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  meta: string
  widths: ReactNode
  stage: ReactNode
  hint?: string | undefined
  foot?: ReactNode
  commentsTitle: string
  commentCount: string
  annotate?: ReactNode
  draft?: ReactNode
  comments: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Radix sees esc first, on the document's capture phase. Stopping it
        // there keeps it from the floating sheet's own esc listener, so esc
        // returns to the dock instead of closing the sheet too.
        onEscapeKeyDown={(event) => event.stopPropagation()}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 ring-0 sm:max-w-none"
      >
        <div className="flex flex-none flex-wrap items-center gap-[11px] border-b px-4 py-3">
          <DialogTitle className="text-[12.5px] font-medium">{title}</DialogTitle>
          <DialogDescription className="font-machine text-mono-xs text-faint">{meta}</DialogDescription>
          <span className="flex-1" />
          {widths}
          <Button variant="outline" size="xs" className="min-h-11 rounded-full text-muted-foreground" onClick={() => onOpenChange(false)}>
            <Minimize2Icon data-icon="inline-start" />
            Exit fullscreen
            <kbd aria-hidden="true" className="font-machine text-mono-xs text-faint">esc</kbd>
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-sidebar px-[26px] pt-[26px] pb-[34px]">
              {stage}
              {hint ? <p className="mx-auto mt-3.5 mb-0 max-w-[640px] text-[11px] leading-normal text-faint">{hint}</p> : null}
            </div>
            {foot}
          </div>
          <aside aria-label={commentsTitle} className="flex max-h-[45dvh] w-full flex-none flex-col overflow-hidden border-t bg-background md:max-h-none md:w-[340px] md:border-t-0 md:border-l">
            <div className="flex flex-none flex-wrap items-center gap-[9px] border-b px-[15px] py-3">
              <span className="text-[13px] font-semibold">{commentsTitle}</span>
              <span className="font-machine text-mono-xs text-faint">{commentCount}</span>
              <span className="flex-1" />
              {annotate}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-[9px] overflow-y-auto">
              {draft}
              {comments}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function PreviewDraftCard({
  id,
  anchor,
  value,
  placeholder,
  pending,
  error,
  submitLabel,
  cancelLabel,
  onChange,
  onPost,
  onCancel,
}: {
  id: string
  anchor: string
  value: string
  placeholder: string
  pending: boolean
  error: string
  submitLabel: string
  cancelLabel: string
  onChange: (value: string) => void
  onPost: () => void
  onCancel: () => void
}) {
  return (
    <div className="mx-[15px] mt-[13px] flex-none overflow-hidden rounded-xl border border-primary bg-card">
      <div className="border-b px-3 py-[9px] text-[11px] leading-[1.45] break-words text-strong">{anchor}</div>
      {error ? (
        <Alert variant="destructive" className="m-3 w-auto" aria-live="polite">
          <CircleStopIcon />
          <AlertTitle>Annotation failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field className="px-3 py-2.5">
        <FieldLabel htmlFor={id} className="sr-only">Comment</FieldLabel>
        <Textarea
          id={id}
          value={value}
          rows={4}
          autoFocus
          disabled={pending}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      <div className="flex items-center gap-[9px] border-t px-3 py-[9px]">
        <Button size="sm" disabled={!value.trim() || pending} onClick={onPost}>{pending ? "Posting" : submitLabel}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onCancel}>{cancelLabel}</Button>
      </div>
    </div>
  )
}
