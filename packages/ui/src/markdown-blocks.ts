const fenceOpening = /^ {0,3}(`{3,}|~{3,})/
const listItem = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/
const blockQuote = /^ {0,3}>/
const indentedContinuation = /^[ \t]{2,}\S/
const linkReferenceDefinition = /^ {0,3}\[[^\]]+\]:[ \t]/m

// A streaming reply only ever appends, so every block above the last blank
// line is final. Splitting there lets a memoised renderer parse each finished
// block once instead of once per token. The rules below refuse to split
// wherever a blank line can still be part of one construct, because cutting
// there would change what the reader sees.
export function splitMarkdownBlocks(source: string): string[] {
  if (source.trim() === "") return []
  if (linkReferenceDefinition.test(source)) return [source]

  const lines = source.split("\n")
  const blocks: string[] = []
  let start = 0
  let fence: string | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (fence !== undefined) {
      if (line.trimStart().startsWith(fence)) fence = undefined
      continue
    }
    const opening = fenceOpening.exec(line)
    if (opening?.[1] !== undefined) {
      fence = opening[1].slice(0, 3)
      continue
    }
    if (line.trim() !== "") continue

    const next = nextContentLine(lines, index)
    if (next === undefined) continue
    if (!canEndBlock(lines[index - 1]) || !canStartBlock(lines[next])) continue

    blocks.push(lines.slice(start, index).join("\n"))
    start = next
    index = next - 1
  }

  blocks.push(lines.slice(start).join("\n"))
  return blocks.filter((block) => block.trim() !== "")
}

function nextContentLine(lines: readonly string[], from: number): number | undefined {
  for (let index = from + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() !== "") return index
  }
  return undefined
}

function canEndBlock(line: string | undefined): boolean {
  return line !== undefined && line.trim() !== "" && isFreeStanding(line)
}

function canStartBlock(line: string | undefined): boolean {
  return line !== undefined && isFreeStanding(line)
}

function isFreeStanding(line: string): boolean {
  return !listItem.test(line) && !blockQuote.test(line) && !indentedContinuation.test(line)
}
