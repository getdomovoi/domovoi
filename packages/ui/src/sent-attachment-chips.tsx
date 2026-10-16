import { sentAttachmentChips, type SessionAttachmentSummary } from "@getdomovoi/protocol"

import { cn } from "./lib/utils"

// What a sent turn carried, in the composer chip's mark, name and meta
// (Desktop V2 composer attachments), read only: the draft is gone, so there
// is nothing to remove. The daemon records sizes and names, not bytes, so an
// image is a chip rather than a thumbnail this client could not draw.
// The thread's user turn sits on the right, so its chips do too; a history
// row reads left to right and passes align="start".
export function SentAttachmentChips({ attachments, align = "end" }: {
  attachments: readonly SessionAttachmentSummary[] | undefined
  align?: "start" | "end"
}) {
  const chips = sentAttachmentChips(attachments)
  if (chips.length === 0) return null
  return (
    <ul aria-label="Sent with this message" className={cn("m-0 mt-2 flex list-none flex-wrap gap-[7px] p-0", align === "end" ? "justify-end" : "justify-start")}>
      {chips.map((chip, index) => (
        <li
          key={`${chip.kind}-${index}`}
          aria-label={chip.label}
          title={chip.label}
          className="flex min-w-0 max-w-[300px] items-center gap-[7px] rounded-full border bg-background px-2.5 py-[5px]"
        >
          {/* Unlike the composer's chip, the name gives way here: the size
              is what a sent turn adds, and the meta is always short. */}
          <span aria-hidden className="shrink-0 rounded bg-muted px-[5px] py-0.5 font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">{chip.mark}</span>
          <span aria-hidden className="min-w-0 truncate font-machine text-[10.5px] text-strong">{chip.name}</span>
          <span aria-hidden className="shrink-0 whitespace-nowrap text-[10.5px] text-faint">{chip.meta}</span>
        </li>
      ))}
    </ul>
  )
}
