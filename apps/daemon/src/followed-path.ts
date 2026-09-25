import { lstat, readlink, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path"

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
// component that does not exist is kept as written. What exists is written as
// native realpath writes it (spelledPath). Undefined when the links loop past
// the bound.
export async function followPath(path: string): Promise<string | undefined> {
  return (await walkPath(path))?.path
}

// The walk behind followPath. Unreadable is true when a component could not be
// read for a reason other than being absent: what lies there, a link included,
// is then unknown, and the path is only a guess.
async function walkPath(path: string): Promise<{ path: string; unreadable: boolean } | undefined> {
  const root = parse(path).root
  let current = root
  const pending = path.slice(root.length).split(separators).filter((part) => part !== "")
  let links = 0
  let unreadable = false
  while (pending.length > 0) {
    const part = pending.shift()!
    if (part === ".") continue
    if (part === "..") { current = dirname(current); continue }
    const next = join(current, part)
    let isLink = false
    try {
      isLink = (await lstat(next)).isSymbolicLink()
    } catch (error) {
      // Absent or unreadable: kept as written.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") unreadable = true
    }
    if (!isLink) { current = next; continue }
    if (++links > maximumLinksFollowed) return undefined
    const target = await readlink(next)
    const targetRoot = parse(target).root
    if (targetRoot !== "") current = targetRoot
    pending.unshift(...target.slice(targetRoot.length).split(separators).filter((item) => item !== ""))
  }
  return { path: unreadable ? current : await spelledPath(current), unreadable }
}

// The walked path written the way native realpath writes it, as canonicalCwd
// writes the worktree. lstat and readlink keep a name as the request spelled
// it, but a Windows 8.3 short name (RUNNER~1) and a name in another case on a
// case-insensitive filesystem are aliases, not links, so the walk cannot see
// them. The deepest part that exists is passed through realpath and the
// missing rest joined back as walked. The walk has already replaced every
// link, so this changes only how the path is written, unless a link was put
// in its place since: realpath then follows it, and the path names where that
// link leads, which a later reading or the worktree check sees. Any failure
// other than a missing part keeps the path as walked.
async function spelledPath(path: string): Promise<string> {
  if (!isAbsolute(path)) return path
  const missing: string[] = []
  let existing = path
  for (;;) {
    try {
      return join(await realpath(existing), ...missing)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = dirname(existing)
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === existing) return path
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

// The worktree and the target, each followed the same way. Undefined when
// either loops.
export async function followedTarget(workspace: string, path: string, cwd?: string): Promise<{ workspace: string; target: string } | undefined> {
  const target = await followPath(requestedPath(workspace, path, cwd))
  const realWorkspace = await followPath(resolve(workspace))
  if (target === undefined || realWorkspace === undefined) return undefined
  return { workspace: realWorkspace, target }
}

type NodeKind = "regular" | "directory" | "fifo" | "socket" | "device" | "symlink" | "missing" | "unreadable"

// One filesystem entry as lstat reports it. Numbers are kept as decimal
// strings from bigint stats, since a Windows file index can pass 2^53.
type NodeIdentity = { kind: NodeKind; dev: string; ino: string; nlink: string }

// What a file target is: the entry at the requested path (a link is its own
// entry), the path it really leads to, and the entry there. Two readings that
// differ in any field are two different targets.
export type FileTargetIdentity = { entry: NodeIdentity; realPath: string | undefined; target: NodeIdentity }

async function nodeIdentity(path: string): Promise<NodeIdentity> {
  try {
    // Only lstat reads it: opening a FIFO with no writer would block.
    const stats = await lstat(path, { bigint: true })
    const kind: NodeKind = stats.isFile() ? "regular"
      : stats.isDirectory() ? "directory"
      : stats.isSymbolicLink() ? "symlink"
      : stats.isFIFO() ? "fifo"
      : stats.isSocket() ? "socket"
      : "device"
    return { kind, dev: String(stats.dev), ino: String(stats.ino), nlink: String(stats.nlink) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", dev: "", ino: "", nlink: "" }
  }
}

// Read a file target without opening it. It never throws: a path that cannot
// be read, at the requested path, on the walk to where it leads, or there, is
// recorded as such, with no real path.
export async function fileTargetIdentity(workspace: string, path: string, cwd?: string): Promise<FileTargetIdentity> {
  const requested = requestedPath(workspace, path, cwd)
  const entry = await nodeIdentity(requested)
  let walk: { path: string; unreadable: boolean } | undefined
  try { walk = await walkPath(requested) } catch { walk = undefined }
  const realPath = walk === undefined || walk.unreadable ? undefined : walk.path
  const target = realPath === undefined
    ? { kind: "unreadable" as const, dev: "", ino: "", nlink: "" }
    : await nodeIdentity(realPath)
  return { entry, realPath, target }
}

// Whether any part of a reading could not be read.
function fileTargetUnreadable(identity: FileTargetIdentity): boolean {
  return identity.entry.kind === "unreadable" || identity.realPath === undefined || identity.target.kind === "unreadable"
}

// Whether the file a reading reaches has more than one name (lstat nlink > 1,
// which NTFS reports too). Its other names share its bytes and may lie
// anywhere, outside the worktree included, and moving one of them changes
// nothing a reading holds, so no reading can vouch for the file (ruled
// 2026-09-24). A directory always has several links and is not counted.
export function fileTargetHasOtherNames(identity: FileTargetIdentity): boolean {
  return identity.target.kind === "regular" && Number(identity.target.nlink) > 1
}

function sameNode(one: NodeIdentity, other: NodeIdentity): boolean {
  return one.kind === other.kind && one.dev === other.dev && one.ino === other.ino && one.nlink === other.nlink
}

// Whether a file target changed between two readings. A target that cannot be
// read now counts as changed whatever the earlier reading was: two unreadable
// readings match field for field and say nothing about what lies beneath, so a
// file replaced there would pass. With no earlier reading to compare, only a
// regular file, or a path with nothing at it, stands.
export function fileTargetChanged(before: FileTargetIdentity | undefined, now: FileTargetIdentity): boolean {
  if (fileTargetUnreadable(now)) return true
  if (before === undefined) {
    return !(now.target.kind === "regular" || (now.entry.kind === "missing" && now.target.kind === "missing"))
  }
  return !sameNode(before.entry, now.entry) || before.realPath !== now.realPath || !sameNode(before.target, now.target)
}
