import { constants } from "node:fs"
import { type FileHandle, lstat, open, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { fromMarkdown } from "mdast-util-from-markdown"

// Providers run with repository configuration switched off until a trust gate
// exists, and that switch also stops them reading the repository's instruction
// files. The daemon reads those files itself: text only, from inside the
// session worktree, never a hook, server, plugin or environment block.

export type ProjectInstructionReader = "claude" | "codex" | "opencode"

const claudeInstructionFiles = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]
const openCodeInstructionFiles = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]
// Codex takes AGENTS.override.md when it is a file, else AGENTS.md, and reads
// at most project_doc_max_bytes of it, 32 KiB unless configured. Read from
// agents_md.rs and config_toml.rs at rust-v0.156.1.
const codexInstructionFiles = ["AGENTS.override.md", "AGENTS.md"]
const codexInstructionBudgetBytes = 32 * 1024
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
  if (reader === "codex") return codexInstructions(root)
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

// The first candidate that is a file decides, as in Codex: an override that is
// empty or refused here does not hand the turn to AGENTS.md.
async function codexInstructions(root: string): Promise<string | undefined> {
  for (const name of codexInstructionFiles) {
    const candidate = join(root, name)
    if (!(await isFile(candidate))) continue
    const file = await worktreeFile(root, candidate)
    if (!file) return undefined
    const text = utf8Prefix(file.text, codexInstructionBudgetBytes)
    if (!text.trim()) return undefined
    return `# AGENTS.md instructions for ${root}\n\n<INSTRUCTIONS>\n${escapeWrapperTags(text)}\n</INSTRUCTIONS>`
  }
  return undefined
}

// Codex wraps each additionalContext entry in a tag named by its key, beside
// Domovoi's own domovoi-sandbox entry, and does not escape the value. A file
// could close INSTRUCTIONS and its entry and open a forged Domovoi entry, so
// the < of any INSTRUCTIONS or domovoi- tag in it is sent as &lt;.
const wrapperTag = /<(?=\s*\/?\s*(?:instructions|domovoi-))/gi

function escapeWrapperTags(text: string): string {
  return text.replace(wrapperTag, "&lt;")
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function utf8Prefix(text: string, bytes: number): string {
  const encoded = Buffer.from(text, "utf8")
  if (encoded.length <= bytes) return text
  let end = bytes
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return encoded.toString("utf8", 0, end)
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
// Markdown's own rules. HTML arrives as separate nodes beside the text it
// encloses, inline or as a block of its own, so text between an opening
// <code>, <pre>, <kbd> or <samp> and its closing tag is skipped too. The whole
// document is read as one sequence in order, with one stack of open code tags.
//
// The stack fails closed. Any HTML node can open a code tag: its start tags
// are read, with quoted attribute values skipped. Only a node
// whose whole trimmed text is exactly one closing tag, such as </code>, closes
// one, popping back to its own name. Nothing else closes: not a comment, a
// processing instruction, CDATA, a declaration, a script or style body, nor a
// node with attributes or any other text beside the closing tag. A node whose
// markup ends inside an unfinished tag or quoted value hides everything after
// it, and so does an end tag that carries attributes or an unfinished quote,
// and so does any comment, processing instruction, CDATA section or
// declaration, finished or not. The cost: an import after any of those, after
// a code tag closed in any other way, or after a <pre> block, whose closing tag
// shares its HTML block, stays hidden.
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
const codeTagNames = new Set(["code", "pre", "kbd", "samp"])
const tagStart = /<([A-Za-z][A-Za-z0-9-]*)/y
const endTagStart = /<\/([A-Za-z][A-Za-z0-9-]*)/y
const closingCodeTag = /^<\/(code|pre|kbd|samp)\s*>$/i
const unfinished = Symbol("unfinished markup")

// The code tags an HTML node's markup opens, and whether the markup ends
// inside something unfinished.
function openedCodeTags(html: string): { opened: string[]; unfinished: boolean } {
  const opened: string[] = []
  let at = 0
  while (at < html.length) {
    const open = html.indexOf("<", at)
    if (open === -1) break
    // A comment, CDATA section, processing instruction or declaration fails
    // closed: HTML ends each of them in more ways than a scanner should guess
    // at, so its markup counts as unfinished and hides every later import.
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) return { opened, unfinished: true }
    // Start and end tags are scanned alike, with quoted values tracked. An end
    // tag carries nothing but its name, so one with attributes, an unfinished
    // quote or no name is treated as unfinished markup.
    const closing = html.startsWith("</", open)
    const pattern = closing ? endTagStart : tagStart
    pattern.lastIndex = open
    const tag = pattern.exec(html)
    if (!tag) {
      if (closing) return { opened, unfinished: true }
      at = open + 1
      continue
    }
    let end = pattern.lastIndex
    let quote: string | undefined
    for (; end < html.length; end += 1) {
      const character = html[end]
      if (quote) {
        if (character === quote) quote = undefined
      } else if (character === "\"" || character === "'") quote = character
      else if (character === ">") break
    }
    if (end >= html.length) return { opened, unfinished: true }
    if (closing && html.slice(pattern.lastIndex, end).trim() !== "") return { opened, unfinished: true }
    const name = tag[1]!.toLowerCase()
    if (!closing && codeTagNames.has(name)) opened.push(name)
    at = end + 1
  }
  return { opened, unfinished: false }
}

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
  const open: Array<string | typeof unfinished> = []
  const visit = (node: MarkdownNode): void => {
    if (node.type === "html" && typeof node.value === "string") {
      const closing = closingCodeTag.exec(node.value.trim())
      if (closing) {
        const index = open.lastIndexOf(closing[1]!.toLowerCase())
        if (index !== -1 && !open.includes(unfinished)) open.length = index
        return
      }
      const markup = openedCodeTags(node.value)
      open.push(...markup.opened)
      if (markup.unfinished) open.push(unfinished)
      return
    }
    if (node.type === "text") {
      if (open.length === 0) collectText(node)
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
  } catch {
    return undefined
  }
  const inside = relative(root, path)
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  // Git metadata and another repository's files are not this repository's
  // instructions: no .git segment, and no .git entry in any directory between
  // the file and the worktree root (a nested clone or a submodule).
  const segments = inside.split(sep)
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return undefined
  for (let directory = dirname(path); directory !== root && directory.startsWith(root); directory = dirname(directory)) {
    try {
      await lstat(join(directory, ".git"))
      return undefined
    } catch {
      // No .git entry here; keep walking toward the root.
    }
  }
  const directories = segments.slice(0, -1).map((_, index) => join(root, ...segments.slice(0, index + 1)))
  const text = await readWorktreeFile(directories, path)
  return text === undefined ? undefined : { path, text }
}

// A writer in the worktree can swap any name for a link between a check and a
// read, so the file is opened once and read only from that descriptor. The
// final name is opened without following a link. Windows has no O_NOFOLLOW;
// there the lstat taken before the open stands in, and the identity check
// below refuses a link swapped in after it. The descriptor must be the very
// file lstat found (device and inode), and each directory between the worktree
// root and the file must be a real directory, the same one before and after the
// open. Node cannot open relative to a directory descriptor, so a directory
// swapped for a link and back between these checks is narrowed, not ruled out.
// O_NONBLOCK keeps a FIFO swapped in from holding the open.
type FileIdentity = { dev: bigint; ino: bigint }

async function readWorktreeFile(directories: readonly string[], path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined
  try {
    const before = await pathIdentities(directories, path)
    if (!before) return undefined
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.size > BigInt(maximumInstructionFileBytes)) return undefined
    if (!sameFile(opened, before.at(-1))) return undefined
    const after = await pathIdentities(directories, path)
    if (!after || after.length !== before.length || !after.every((identity, index) => sameFile(identity, before[index]))) {
      return undefined
    }
    // A file can grow after fstat: read at most the limit plus one byte.
    const buffer = Buffer.alloc(maximumInstructionFileBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maximumInstructionFileBytes) return undefined
    return buffer.toString("utf8", 0, length)
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function pathIdentities(directories: readonly string[], path: string): Promise<FileIdentity[] | undefined> {
  const identities: FileIdentity[] = []
  for (const directory of directories) {
    const info = await lstat(directory, { bigint: true })
    if (!info.isDirectory()) return undefined
    identities.push({ dev: info.dev, ino: info.ino })
  }
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.size > BigInt(maximumInstructionFileBytes)) return undefined
  identities.push({ dev: info.dev, ino: info.ino })
  return identities
}

function sameFile(left: FileIdentity, right: FileIdentity | undefined): boolean {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino
}
