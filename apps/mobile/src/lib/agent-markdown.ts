// What an agent actually writes: paragraphs, fenced code, inline code, bold,
// and bullets. The phone rendered all of it as one run of plain text, so a
// reply carrying a command showed the backticks and the fence markers as
// characters and the command itself lost its monospace, which is exactly the
// content someone reading on a phone most needs to copy correctly.
//
// This is deliberately not a Markdown implementation. It covers the shapes an
// assistant emits and leaves everything else as literal text, because a half
// parser that guesses at the rest would corrupt prose that merely looks like
// markup.

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }

export type MarkdownBlock =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "code"; language: string | undefined; text: string }
  | { kind: "bullet"; spans: InlineSpan[] }

const fence = /^\s*```(\w*)\s*$/

export function parseAgentMarkdown(body: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = body.split("\n")
  let paragraph: string[] = []

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    paragraph = []
    if (text) blocks.push({ kind: "paragraph", spans: parseInlineSpans(text) })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const opening = fence.exec(line)
    if (opening) {
      flushParagraph()
      const language = opening[1] ? opening[1] : undefined
      const code: string[] = []
      index += 1
      // An unterminated fence is kept as code rather than dropped: the text is
      // still the command, and losing it would be worse than a missing close.
      while (index < lines.length && !fence.test(lines[index]!)) {
        code.push(lines[index]!)
        index += 1
      }
      blocks.push({ kind: "code", language, text: code.join("\n") })
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      blocks.push({ kind: "bullet", spans: parseInlineSpans(bullet[1]!) })
      continue
    }
    if (line.trim() === "") { flushParagraph(); continue }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks
}

export function parseInlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  // Code first: a backticked run is literal, so bold markers inside it are
  // characters rather than formatting.
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) spans.push({ kind: "text", text: text.slice(last, match.index) })
    if (match[1] !== undefined) spans.push({ kind: "code", text: match[1] })
    else if (match[2] !== undefined) spans.push({ kind: "strong", text: match[2] })
    last = match.index + match[0].length
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) })
  return spans.length > 0 ? spans : [{ kind: "text", text }]
}
