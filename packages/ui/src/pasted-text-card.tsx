import { useId, useState } from "react"
import { XIcon } from "lucide-react"
import type { TextAttachment } from "@getdomovoi/protocol"

import { desktopInlineLineLimit, pastedTextMeta, pastedTextPeek } from "./desktop-attachments"

// A paste past the inline limit, kept as a file in the message. The design
// draws it as an info card: TXT, the name, size and lines, Peek, drop, and
// the note saying what the prompt carries.
export function PastedTextCard({
  attachment,
  onRemove,
}: {
  attachment: TextAttachment
  onRemove: () => void
}) {
  const [peek, setPeek] = useState(false)
  const peekId = useId()
  return (
    <div
      role="group"
      aria-label={attachment.name}
      className="overflow-hidden rounded-[calc(var(--radius)-2px)] border border-info-border bg-info-background"
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="rounded-[4px] bg-info-border px-[5px] py-0.5 font-machine text-[10.5px] tracking-[.04em] text-info-foreground">TXT</span>
        <span className="min-w-0 truncate font-machine text-[11px] text-info-foreground">{attachment.name}</span>
        <span className="font-machine text-[10.5px] whitespace-nowrap text-info-dim">{pastedTextMeta(attachment)}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-expanded={peek}
          aria-controls={peek ? peekId : undefined}
          className="cursor-pointer text-[11px] text-info-foreground hover:underline"
          onClick={() => setPeek((open) => !open)}
        >
          {peek ? "Hide" : "Peek"}
        </button>
        <button
          type="button"
          aria-label={`Remove ${attachment.name}`}
          className="inline-flex cursor-pointer text-info-dim hover:text-info-foreground"
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </button>
      </div>
      <p className="m-0 px-3 pb-[11px] text-[11.5px] leading-[1.55] text-info-foreground">
        Too long to send inline. The prompt carries the first 40 lines, the agent reads the rest on request.
      </p>
      {peek ? (
        <pre
          id={peekId}
          role="region"
          aria-label={`First ${desktopInlineLineLimit} lines of ${attachment.name}`}
          className="m-0 max-h-[132px] overflow-y-auto border-t border-info-border bg-code px-3 py-[11px] font-machine text-[10.5px] leading-[1.7] whitespace-pre-wrap text-muted-foreground"
        >
          {pastedTextPeek(attachment)}
        </pre>
      ) : null}
    </div>
  )
}
