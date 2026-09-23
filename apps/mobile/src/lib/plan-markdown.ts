export type PlanInlineSpan =
  | { kind: "text", text: string }
  | { kind: "code", text: string }
  | { kind: "link", text: string, url: string }

export type PlanMarkdownBlock =
  | { kind: "heading", level: 1 | 2, spans: PlanInlineSpan[] }
  | { kind: "paragraph", spans: PlanInlineSpan[] }
  | { kind: "list-item", ordered: boolean, marker: number | undefined, spans: PlanInlineSpan[] }
  | { kind: "task", checked: boolean, spans: PlanInlineSpan[] }
  | { kind: "code", language: string | undefined, text: string }
  | { kind: "rule" }

const fence = /^\s*```([^`]*)\s*$/

export function safeMarkdownUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function parsePlanInline(text: string): PlanInlineSpan[] {
  const spans: PlanInlineSpan[] = []
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) spans.push({ kind: "text", text: text.slice(last, match.index) })
    if (match[1] !== undefined) {
      spans.push({ kind: "code", text: match[1] })
    } else {
      const label = match[2]!
      const url = safeMarkdownUrl(match[3]!)
      spans.push(url ? { kind: "link", text: label, url } : { kind: "text", text: label })
    }
    last = match.index + match[0].length
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) })
  return spans.length > 0 ? spans : [{ kind: "text", text }]
}

export function plainPlanInline(spans: readonly PlanInlineSpan[]): string {
  return spans.map((span) => span.text).join("")
}

export function parsePlanMarkdown(source: string): PlanMarkdownBlock[] {
  const blocks: PlanMarkdownBlock[] = []
  const lines = source.split("\n")
  let paragraph: string[] = []

  const flush = () => {
    const text = paragraph.join(" ").trim()
    paragraph = []
    if (text) blocks.push({ kind: "paragraph", spans: parsePlanInline(text) })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const opening = fence.exec(line)
    if (opening) {
      flush()
      const code: string[] = []
      index += 1
      while (index < lines.length && !fence.test(lines[index]!)) {
        code.push(lines[index]!)
        index += 1
      }
      const name = opening[1]!.trim()
      blocks.push({ kind: "code", language: name || undefined, text: code.join("\n") })
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ kind: "rule" })
      continue
    }
    const heading = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2, spans: parsePlanInline(heading[2]!) })
      continue
    }
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line)
    if (task) {
      flush()
      blocks.push({ kind: "task", checked: task[1]!.toLowerCase() === "x", spans: parsePlanInline(task[2]!) })
      continue
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (unordered) {
      flush()
      blocks.push({ kind: "list-item", ordered: false, marker: undefined, spans: parsePlanInline(unordered[1]!) })
      continue
    }
    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      flush()
      blocks.push({ kind: "list-item", ordered: true, marker: Number(ordered[1]), spans: parsePlanInline(ordered[2]!) })
      continue
    }
    if (line.trim() === "") {
      flush()
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}
