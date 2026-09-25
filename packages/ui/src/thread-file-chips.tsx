import { memo, type ReactNode } from "react"

import type { ToolFileEntry } from "@getdomovoi/protocol"

const listed = 3

function merge(files: readonly ToolFileEntry[]): ToolFileEntry[] {
  const byPath = new Map<string, ToolFileEntry>()
  for (const file of files) {
    const seen = byPath.get(file.path)
    if (!seen) {
      byPath.set(file.path, file)
      continue
    }
    const additions = (seen.additions ?? 0) + (file.additions ?? 0)
    const deletions = (seen.deletions ?? 0) + (file.deletions ?? 0)
    byPath.set(file.path, {
      path: file.path,
      ...(seen.additions === undefined && file.additions === undefined ? {} : { additions }),
      ...(seen.deletions === undefined && file.deletions === undefined ? {} : { deletions }),
    })
  }
  return [...byPath.values()]
}

function reviewLabel(count: number): string {
  return count === 1 ? "Review the 1 changed file" : `Review all ${count} changed files`
}

/**
 * A chip is a button only where a review surface exists to open. Without one it
 * still names the file, because what a turn touched is worth reading even when
 * there is nowhere to go from it.
 */
function Chip({
  children,
  onReview,
  dashed,
}: {
  readonly children: ReactNode
  readonly onReview?: (() => void) | undefined
  readonly dashed?: boolean | undefined
}) {
  const shape = dashed
    ? "rounded-full border border-dashed border-border px-2.5 py-[5px]"
    : "flex items-center gap-2 rounded-full border border-border bg-card px-2.5 py-[5px]"
  if (!onReview) return <div className={shape}>{children}</div>
  return (
    <button
      type="button"
      onClick={onReview}
      className={`${shape} cursor-pointer transition-colors hover:bg-accent${dashed ? " hover:[&>span]:text-foreground" : ""}`}
    >
      {children}
    </button>
  )
}

/**
 * The files a finished turn touched, named in the thread so the work is legible
 * without opening anything. A count only appears where the provider reported a
 * diff, and the review chip carries the true total even when the row lists
 * fewer, so a long turn cannot read as a short one.
 */
export const ThreadFileChips = memo(function ThreadFileChips({
  files,
  onReview,
}: {
  readonly files: readonly ToolFileEntry[]
  readonly onReview?: (() => void) | undefined
}) {
  const merged = merge(files)
  if (merged.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-[7px]">
      {merged.slice(0, listed).map((file) => (
        <Chip key={file.path} onReview={onReview}>
          <span className="font-machine text-[10.5px] text-strong">{file.path}</span>
          {file.additions !== undefined && file.additions > 0 ? (
            <span className="font-machine text-[10.5px] text-success">{`+${file.additions}`}</span>
          ) : null}
          {file.deletions !== undefined && file.deletions > 0 ? (
            <span className="font-machine text-[10.5px] text-destructive">{`−${file.deletions}`}</span>
          ) : null}
        </Chip>
      ))}
      <Chip onReview={onReview} dashed>
        <span className="text-[10.5px] text-muted-foreground">{reviewLabel(merged.length)}</span>
      </Chip>
    </div>
  )
})
