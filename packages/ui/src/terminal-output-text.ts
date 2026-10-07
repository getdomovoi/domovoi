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
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)
    if (!line) continue
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
      if (kept.length === 0) return lineTail(line, limitBytes)
      break
    }
    kept.unshift(line)
    bytes += cost
  }
  return kept.join("\n")
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
