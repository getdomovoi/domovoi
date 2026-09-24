import { lstat, readlink } from "node:fs/promises"
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path"

// Where a path really leads, read the way the filesystem reads it. This is the
// resolver #541 wrote for approval facts (resolveApprovalPath in
// approval-facts.ts), moved here so execution resolution and approval facts
// follow a path the same way. Whichever of #541 and #545 lands second switches
// its caller to this module.

// The path as the request gave it, relative to the directory the request runs
// in, before anything is collapsed: ".." is applied only after the links
// before it are followed, as the filesystem does.
export function requestedPath(workspace: string, path: string, cwd: string | undefined): string {
  if (isAbsolute(path)) return path
  const base = cwd === undefined ? workspace : isAbsolute(cwd) ? cwd : `${workspace}${sep}${cwd}`
  return `${base}${sep}${path}`
}

const separators = process.platform === "win32" ? /[\\/]+/u : /\/+/u
// Linux's bound on links followed in one lookup (macOS stops at 32).
const maximumLinksFollowed = 40

// Walk the path one component at a time from its root. A link, including one
// whose target does not exist yet, is replaced by its target before the rest
// of the path is read; ".." then leaves the directory the link led to. A
// component that does not exist is kept as written. Undefined when the links
// loop past the bound.
export async function followPath(path: string): Promise<string | undefined> {
  const root = parse(path).root
  let current = root
  const pending = path.slice(root.length).split(separators).filter((part) => part !== "")
  let links = 0
  while (pending.length > 0) {
    const part = pending.shift()!
    if (part === ".") continue
    if (part === "..") { current = dirname(current); continue }
    const next = join(current, part)
    let isLink = false
    try { isLink = (await lstat(next)).isSymbolicLink() } catch { /* absent or unreadable: kept as written */ }
    if (!isLink) { current = next; continue }
    if (++links > maximumLinksFollowed) return undefined
    const target = await readlink(next)
    const targetRoot = parse(target).root
    if (targetRoot !== "") current = targetRoot
    pending.unshift(...target.slice(targetRoot.length).split(separators).filter((item) => item !== ""))
  }
  return current
}

// The worktree and the target, each followed the same way. Undefined when
// either loops.
export async function followedTarget(workspace: string, path: string, cwd?: string): Promise<{ workspace: string; target: string } | undefined> {
  const target = await followPath(requestedPath(workspace, path, cwd))
  const realWorkspace = await followPath(resolve(workspace))
  if (target === undefined || realWorkspace === undefined) return undefined
  return { workspace: realWorkspace, target }
}
