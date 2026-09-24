import { realpath } from "node:fs/promises"
import { resolve } from "node:path"

import { pathStaysInside } from "./execution-resolution.js"
import { isReadOnlyGitCommand } from "./permission-policy.js"

// Claude Code approves its read-only Bash commands and file reads inside the
// working directory before Domovoi's callback runs. This finds the calls whose
// reach Domovoi has to judge itself: a read that can leave the session
// worktree. Anything it cannot place inside the worktree counts as outside.

const readToolPathFields: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  NotebookRead: ["notebook_path"],
  Glob: ["path", "pattern"],
  Grep: ["path", "glob"],
  LS: ["path"],
}

const shellSeparators = /[\s;&|()<>]+/
const deviceFiles = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "NUL"])
const bareDirectoryChange = /(?:^|[;&|(]\s*)(?:cd|pushd|popd)(?:\s+-)?\s*(?:$|[;&|)])/

export function isClaudeReadTool(toolName: string): boolean {
  return Object.hasOwn(readToolPathFields, toolName)
}

// The first path-like value the call reaches outside the worktree, or
// undefined when every one stays inside it.
export async function claudeReadOutsideWorktree(
  toolName: string,
  input: Record<string, unknown>,
  worktree: string,
  shellDirectory: string = worktree,
): Promise<string | undefined> {
  let root: string
  try {
    root = await realpath(worktree)
  } catch {
    return worktree
  }
  const base = resolve(worktree, shellDirectory)
  if (!await pathStaysInside(root, root, base)) return shellDirectory
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : ""
    return shellCommandOutside(command, root, base)
  }
  for (const field of readToolPathFields[toolName] ?? []) {
    const value = input[field]
    if (typeof value !== "string" || value.trim().length === 0) continue
    if (await pathValueOutside(value.trim(), root, base)) return value.trim()
  }
  return undefined
}

// Only these reads skip the card (owner rulings 2026-09-23), and only when every
// argument is a path Domovoi can see before the command runs. pwd and echo read
// no file; echo is only listed without a redirect to a file or a substitution. Anything that
// computes, finds or follows paths at run time (a pipe into xargs, find -exec,
// a recursive read, a glob) asks, because the screen above cannot place it.
const listedReaders = new Set(["cat", "head", "tail", "wc", "ls", "pwd", "echo"])
const unresolvableSyntax = /[`$(){}\\\n*?[\]~<>]/
const deviceRedirect = /\s*\d*>>?\s*(?:\/dev\/null|\/dev\/stderr|\/dev\/stdout|&[12])(?=\s|$)/g
const plainFlag = /^(?:-[A-Za-z0-9]+|--[a-z][a-z-]*)$/

export function claudeShellReadIsListed(command: string): boolean {
  const withoutRedirects = command.replace(deviceRedirect, " ")
  if (unresolvableSyntax.test(withoutRedirects)) return false
  for (const segment of withoutRedirects.split(/&&|\|\||[;|&]/)) {
    const trimmed = segment.trim()
    if (trimmed.length === 0) return false
    if (/^git\s/.test(trimmed)) {
      if (!isReadOnlyGitCommand(trimmed)) return false
      continue
    }
    const [program, ...args] = trimmed.replace(/["']/g, "").split(/\s+/)
    if (!program || !listedReaders.has(program)) return false
    for (const argument of args) {
      if (!argument.startsWith("-")) continue
      if (!plainFlag.test(argument) || argument.startsWith("--files0")) return false
      if (program === "ls" && (argument === "--recursive" || /^-[A-Za-z0-9]*R/.test(argument))) return false
    }
  }
  return true
}

async function shellCommandOutside(command: string, root: string, base: string): Promise<string | undefined> {
  if (bareDirectoryChange.test(command)) return "cd"
  for (const raw of command.split(shellSeparators)) {
    const token = raw.replace(/["']/g, "")
    if (token.length === 0) continue
    if (token.includes("$") || token.includes("`")) return token
    for (const piece of token.split("=")) {
      const value = piece.replace(/^-+[A-Za-z0-9]*/, "")
      if (value.length === 0 || deviceFiles.has(value)) continue
      if (await pathValueOutside(value, root, base)) return value
    }
  }
  return undefined
}

async function pathValueOutside(value: string, root: string, base: string): Promise<boolean> {
  if (value.startsWith("~")) return true
  const staticPrefix = value.split(/[*?[{]/)[0] ?? ""
  return !await pathStaysInside(root, base, staticPrefix.length === 0 ? "." : staticPrefix)
}
