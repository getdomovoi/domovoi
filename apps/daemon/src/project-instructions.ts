import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { fromMarkdown } from "mdast-util-from-markdown"

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

// An import in code is not an import. The file is parsed as CommonMark, and
// imports are read from text only, never from a code block, a code span or
// raw HTML, so containers, escapes, paragraph boundaries and tab stops follow
// Markdown's own rules. Inline HTML tags arrive as separate nodes beside the
// text they enclose, so text between an opening <code>, <pre>, <kbd> or <samp>
// and its closing tag is skipped too, within the same paragraph. The parser
// gives one node per tag and one per comment, so only a node's leading tag
// name counts: a tag written inside an attribute value or a comment does not.
// A tag can open inside emphasis and close after it, so each paragraph's
// inline nodes are read as one sequence in document order, with a stack of
// open code tags; a closing tag pops back to its own name and is otherwise
// ignored.
//
// An import is read from the text as written, not as CommonMark decodes it,
// the way Claude Code reads its lexer's text tokens: a backslash escape
// (\@x.md) or a character reference (&#64;x.md) is not an at sign, and the
// text after an escape starts a new run, so \\@x.md, an escaped backslash
// then @x.md, is an import.
type MarkdownNode = {
  type: string
  value?: unknown
  children?: MarkdownNode[]
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined
}

const backslashEscape = /\\[!-/:-@[-`{-~]/

const codeTag = /^<(\/?)(code|pre|kbd|samp)(?=[\s>/])/i
const inlineContainers = new Set(["paragraph", "heading", "tableCell"])

export function importReferences(text: string): string[] {
  const references: string[] = []
  const collect = (value: string) => {
    for (const match of value.matchAll(/(?:^|\s)@([^\s]+)/g)) references.push(match[1]!)
  }
  const collectText = (node: MarkdownNode) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    for (const run of text.slice(start, end).split(backslashEscape)) collect(run)
  }
  const leaves = (node: MarkdownNode, sequence: MarkdownNode[]): void => {
    if (node.children === undefined) {
      sequence.push(node)
      return
    }
    for (const child of node.children) leaves(child, sequence)
  }
  const visit = (node: MarkdownNode): void => {
    if (inlineContainers.has(node.type)) {
      const sequence: MarkdownNode[] = []
      for (const child of node.children ?? []) leaves(child, sequence)
      const open: string[] = []
      for (const leaf of sequence) {
        if (leaf.type === "html" && typeof leaf.value === "string") {
          const tag = codeTag.exec(leaf.value)
          if (!tag) continue
          const name = tag[2]!.toLowerCase()
          if (tag[1] !== "/") {
            open.push(name)
            continue
          }
          const index = open.lastIndexOf(name)
          if (index !== -1) open.length = index
          continue
        }
        if (open.length === 0 && leaf.type === "text") collectText(leaf)
      }
      return
    }
    if (node.type === "text") {
      collectText(node)
      return
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(fromMarkdown(text))
  return references
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
