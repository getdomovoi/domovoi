import { maximumTextAttachmentBytes } from "@getdomovoi/protocol"

// The part of xterm's buffer this reads. Taking the rendered rows rather than
// the raw stream means cursor moves, redraws and cleared lines come out as the
// pane showed them, not as the escape sequences that drew them.
export type TerminalBufferLike = {
  length: number
  getLine(y: number): { isWrapped: boolean, translateToString(trimRight?: boolean): string } | undefined
}

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

// The output as text, for an attachment. The newest lines win when the
// scrollback is past the byte limit, because the end is what the person was
// looking at when they attached it.
export function terminalBufferText(
  buffer: TerminalBufferLike,
  limitBytes: number = maximumTextAttachmentBytes,
): string {
  return terminalBufferOutput(buffer, limitBytes).text
}

// The same text, and whether the limit cut its start, so whoever attaches it
// can say so rather than hand over a tail that reads as the whole.
export function terminalBufferOutput(
  buffer: TerminalBufferLike,
  limitBytes: number = maximumTextAttachmentBytes,
): { text: string, truncated: boolean } {
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)
    if (!line) continue
    // Trimming drops only cells nothing was written to. A space the shell
    // printed is content and stays, so a wrap after blanks keeps them, and
    // the padding xterm adds before a wide character that did not fit does not.
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop()

  // Whole lines from the end while they fit, each counted once, plus the
  // newline that joins it to the line after.
  const kept: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    const cost = byteLength(line) + (kept.length > 0 ? 1 : 0)
    if (bytes + cost > limitBytes) {
      if (kept.length === 0) return { text: lineTail(line, limitBytes), truncated: true }
      break
    }
    kept.unshift(line)
    bytes += cost
  }
  return { text: kept.join("\n"), truncated: kept.length < lines.length }
}

// The lines that lead an attachment whose start is missing, by cause.
export const attachmentMarkers = {
  // The attachment byte limit cut the start.
  cut: "[earlier lines were cut to fit the attachment limit]",
  // The pane's xterm history filled. "May", because a buffer exactly full
  // has lost nothing yet.
  history: "[this pane's history filled up; earlier output may be missing from this file]",
  // The daemon's record did not start at the shell's start.
  dropped: "[earlier output was not kept; the record starts here]",
} as const

export type AttachmentMark = keyof typeof attachmentMarkers

// The text for terminal-output.txt, with at most one marker ahead of it: the
// cut that happened last, because what follows starts after it. The output is
// first tried at the full limit, less only a marker already known to be
// needed, so output that fits whole is never cut to make room for one.
export function terminalAttachmentText(
  buffer: TerminalBufferLike,
  known: { historyFilled: boolean, earlierDropped: boolean },
  limitBytes: number = maximumTextAttachmentBytes,
): { content: string, marked: AttachmentMark | undefined } {
  const lead: AttachmentMark | undefined = known.historyFilled ? "history" : known.earlierDropped ? "dropped" : undefined
  const leading = lead ? `${attachmentMarkers[lead]}\n` : ""
  const whole = terminalBufferOutput(buffer, limitBytes - byteLength(leading))
  if (!whole.text) return { content: "", marked: undefined }
  if (!whole.truncated) return { content: `${leading}${whole.text}`, marked: lead }
  const cut = `${attachmentMarkers.cut}\n`
  return { content: `${cut}${terminalBufferOutput(buffer, limitBytes - byteLength(cut)).text}`, marked: "cut" }
}

// The newest line alone is past the limit: keep its tail, counted a code
// point at a time from the end so a multi-byte character is never cut in half.
function lineTail(line: string, limitBytes: number): string {
  const characters = Array.from(line)
  let bytes = 0
  let start = characters.length
  while (start > 0) {
    const next = byteLength(characters[start - 1]!)
    if (bytes + next > limitBytes) break
    bytes += next
    start -= 1
  }
  return characters.slice(start).join("")
}
