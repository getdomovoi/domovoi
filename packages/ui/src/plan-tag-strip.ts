const planTagName = "proposed_plan"
const standaloneTagLine = /^[ \t]*<\/?proposed_plan>[ \t]*$/u
const standaloneTagFragment = /^[ \t]*<\/?[A-Za-z_]*$/u

function isTagFragment(line: string): boolean {
  if (!standaloneTagFragment.test(line)) return false
  const typed = line.trim().replace(/^<\/?/u, "")
  return `${planTagName}>`.startsWith(typed)
}

export function stripPlanTags(body: string): string {
  if (!body.includes("<")) return body
  const lines = body.split(/\r?\n/u)
  const trailing = lines.length > 0 && isTagFragment(lines[lines.length - 1] ?? "")
  if (trailing) lines.pop()
  if (!trailing && !lines.some((line) => standaloneTagLine.test(line))) return body
  const groups: string[][] = [[]]
  for (const line of lines) {
    if (standaloneTagLine.test(line)) {
      groups.push([])
      continue
    }
    groups[groups.length - 1]?.push(line)
  }
  return groups.map((group) => group.join("\n").trim()).filter(Boolean).join("\n\n")
}
