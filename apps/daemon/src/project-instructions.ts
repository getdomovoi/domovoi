import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

// Providers run with repository configuration switched off until a trust gate
// exists, and that switch also stops them reading the repository's instruction
// files. The daemon reads those files itself: text only, from inside the
// session worktree, never a hook, server, plugin or environment block.

export type ProjectInstructionReader = "claude" | "opencode"

const claudeInstructionFiles = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]
const openCodeInstructionFiles = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]
const maximumInstructionFileBytes = 128 * 1024
const maximumInstructionFiles = 32
const maximumImportDepth = 5

type InstructionFile = { path: string; text: string }

export async function projectInstructions(
  worktree: string,
  reader: ProjectInstructionReader,
): Promise<string | undefined> {
  let root: string
  try {
    root = await realpath(worktree)
  } catch {
    return undefined
  }
  if (reader === "opencode") {
    for (const name of openCodeInstructionFiles) {
      const file = await worktreeFile(root, join(root, name))
      if (file) return `Instructions from: ${file.path}\n${file.text}`
    }
    return undefined
  }
  const files: InstructionFile[] = []
  const seen = new Set<string>()
  for (const name of claudeInstructionFiles) {
    await collectClaudeFile(root, join(root, name), 0, seen, files)
  }
  if (files.length === 0) return undefined
  return files
    .map((file) => `Contents of ${relative(root, file.path).split(sep).join("/")} (project instructions, checked into the codebase):\n\n${file.text}`)
    .join("\n\n")
}

async function collectClaudeFile(
  root: string,
  candidate: string,
  depth: number,
  seen: Set<string>,
  files: InstructionFile[],
): Promise<void> {
  if (files.length >= maximumInstructionFiles) return
  const file = await worktreeFile(root, candidate)
  if (!file || seen.has(file.path)) return
  seen.add(file.path)
  files.push(file)
  if (depth >= maximumImportDepth) return
  for (const reference of importReferences(file.text)) {
    if (reference.startsWith("~")) continue
    await collectClaudeFile(root, resolve(dirname(file.path), reference), depth + 1, seen, files)
  }
}

// An import in code is not an import. Code follows Markdown's own rules: a
// fence opened by three or more backticks or tildes (indented up to three
// spaces) runs to a closing fence of the same character at least as long, or
// to the end; a line indented four spaces or a tab is code unless it continues
// a paragraph; a code span opened by a run of backticks closes at the next run
// of the same length, across lines within a paragraph, and a run with no
// closer is plain text.
export function importReferences(text: string): string[] {
  const prose: string[] = []
  let fence: { character: string; length: number } | undefined
  let inParagraph = false
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.character && close[1]!.length >= fence.length) fence = undefined
      prose.push("")
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { character: open[1]![0]!, length: open[1]!.length }
      prose.push("")
      inParagraph = false
      continue
    }
    const blank = line.trim() === ""
    if (!blank && !inParagraph && /^(?: {4}|\t)/.test(line)) {
      prose.push("")
      continue
    }
    prose.push(line)
    inParagraph = !blank
  }
  return prose.join("\n").split(/\n[ \t]*\n/).flatMap((paragraph) =>
    [...withoutCodeSpans(paragraph).matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1]!))
}

function withoutCodeSpans(paragraph: string): string {
  let result = ""
  let index = 0
  while (index < paragraph.length) {
    if (paragraph[index] !== "`") {
      result += paragraph[index]
      index += 1
      continue
    }
    const run = backtickRun(paragraph, index)
    let search = index + run
    let closing = -1
    while (search < paragraph.length) {
      if (paragraph[search] !== "`") {
        search += 1
        continue
      }
      const candidate = backtickRun(paragraph, search)
      if (candidate === run) {
        closing = search
        break
      }
      search += candidate
    }
    if (closing === -1) {
      result += paragraph.slice(index, index + run)
      index += run
      continue
    }
    result += " "
    index = closing + run
  }
  return result
}

function backtickRun(text: string, start: number): number {
  let end = start
  while (text[end] === "`") end += 1
  return end - start
}

async function worktreeFile(root: string, candidate: string): Promise<InstructionFile | undefined> {
  let path: string
  try {
    path = await realpath(candidate)
    const info = await stat(path)
    if (!info.isFile() || info.size > maximumInstructionFileBytes) return undefined
  } catch {
    return undefined
  }
  const inside = relative(root, path)
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  // Git metadata and another repository's files are not this repository's
  // instructions: no .git segment, and no .git entry in any directory between
  // the file and the worktree root (a nested clone or a submodule).
  if (inside.split(sep).some((segment) => segment.toLowerCase() === ".git")) return undefined
  for (let directory = dirname(path); directory !== root && directory.startsWith(root); directory = dirname(directory)) {
    try {
      await lstat(join(directory, ".git"))
      return undefined
    } catch {
      // No .git entry here; keep walking toward the root.
    }
  }
  try {
    return { path, text: await readFile(path, "utf8") }
  } catch {
    return undefined
  }
}
