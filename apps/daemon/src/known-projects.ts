import { stat } from "node:fs/promises"

import {
  maximumKnownProjects,
  maximumKnownProjectSessions,
  maximumKnownSessionTitleLength,
  workspaceProjects,
  type KnownProject,
  type KnownProjectSession,
  type RpcResult,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { SavedProject, SavedProjectListing } from "./store.js"

// project.list (rulings Q158 A and Q159 A), before the daemon looks for each
// folder. Every live project is read from the live snapshot, which a save may
// not have reached yet: the focused project first, then the others in the
// snapshot's order, each with only the sessions whose projectId names it.
// Saved rows fill in the projects that are not live, newest first. The list
// is cut to the protocol's bounds and says how much it left out.
export function knownProjectEntries(
  snapshot: WorkspaceSnapshot,
  listing: SavedProjectListing,
  now: string = new Date().toISOString(),
): { projects: SavedProject[]; omittedProjects: number } {
  const live = workspaceProjects(snapshot)
  const focused = snapshot.project
  const ordered = focused ? [focused, ...live.filter((project) => project.id !== focused.id)] : live
  const liveIds = new Set(ordered.map((project) => project.id))
  const savedAt = new Map(listing.projects.map((known) => [known.project.id, known.savedAt]))
  const entries: SavedProject[] = ordered.map((project) => {
    const sessions = snapshot.sessions
      .filter((session) => session.projectId === project.id)
      .map((session): KnownProjectSession => ({
        id: session.id,
        title: session.title.slice(0, maximumKnownSessionTitleLength),
        state: session.state,
        updatedAt: session.updatedAt,
      }))
      .sort(newestFirst)
    const omittedSessions = sessions.length - maximumKnownProjectSessions
    return {
      project,
      savedAt: savedAt.get(project.id) ?? now,
      sessions: sessions.slice(0, maximumKnownProjectSessions),
      ...(omittedSessions > 0 ? { omittedSessions } : {}),
    }
  })
  entries.push(...listing.projects.filter((known) => !liveIds.has(known.project.id)))
  const listed = entries.slice(0, maximumKnownProjects)
  const budgeted = withinByteBudget(listed)
  return { projects: budgeted.projects, omittedProjects: entries.length - listed.length + budgeted.omittedProjects }
}

// The most the serialized list may take. The daemon closes a socket whose
// unsent frames pass 1 MiB (rpcWebSocketHighWaterBytes), so one answer stays
// well under it with room for whatever else is queued.
export const maximumProjectListBytes = 512 * 1024

// Spends the byte budget in list order: each project's own fields first, at
// their longest (an unreadable folder, a seven-digit omitted count), then its
// sessions newest first while they fit. What does not fit is counted, never
// dropped silently; a project whose own fields no longer fit is left out
// whole and counted with the omitted projects.
function withinByteBudget(entries: readonly SavedProject[]): { projects: SavedProject[]; omittedProjects: number } {
  let used = Buffer.byteLength(JSON.stringify({ projects: [], omittedProjects: 1_000_000 }))
  const projects: SavedProject[] = []
  let omittedProjects = 0
  for (const entry of entries) {
    const fields = Buffer.byteLength(JSON.stringify({ ...entry, folder: "unreadable", sessions: [], omittedSessions: 1_000_000 })) + 1
    if (used + fields > maximumProjectListBytes) {
      omittedProjects += 1
      continue
    }
    used += fields
    const sessions: KnownProjectSession[] = []
    for (const session of entry.sessions) {
      const bytes = Buffer.byteLength(JSON.stringify(session)) + 1
      if (used + bytes > maximumProjectListBytes) break
      used += bytes
      sessions.push(session)
    }
    const omittedSessions = (entry.omittedSessions ?? 0) + entry.sessions.length - sessions.length
    projects.push({
      project: entry.project,
      savedAt: entry.savedAt,
      sessions,
      ...(omittedSessions > 0 ? { omittedSessions } : {}),
    })
  }
  return { projects, omittedProjects }
}

function newestFirst(left: KnownProjectSession, right: KnownProjectSession): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
}

// How long project.list waits on one project folder before it says the
// folder could not be read. A path on an unreachable network mount can hang.
export const projectFolderCheckTimeoutMs = 2_000
// How long one folder's answer is reused. A client may ask for the list over
// and over; the folders are checked at most this often.
export const projectFolderCheckReuseMs = 5_000

type FolderStat = (path: string) => Promise<{ isDirectory(): boolean }>

// Whether a known project's folder is still there. Gone, or replaced by a
// file, is missing; any other answer, a permission refusal or a check that
// does not return in time, is unreadable, because the daemon could not tell.
async function projectFolderState(underlying: ReturnType<FolderStat>): Promise<KnownProject["folder"]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const entry = await Promise.race([
      underlying,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Project folder check timed out")), projectFolderCheckTimeoutMs)
      }),
    ])
    return entry.isDirectory() ? "present" : "missing"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable"
  } finally {
    clearTimeout(timer)
  }
}

// One check per folder at a time (security review on #907): a request that
// arrives while a folder's check still runs, or within a few seconds of its
// answer, gets that answer. The answer gives up after two seconds, but the
// check itself may hang on a dead mount for as long as the mount does; no
// second check of that folder starts until it settles, so a hung mount costs
// one pending check, not one per request.
export function createProjectFolderProbe(options: { stat?: FolderStat; now?: () => number } = {}): (path: string) => Promise<KnownProject["folder"]> {
  const check = options.stat ?? stat
  const now = options.now ?? Date.now
  const answers = new Map<string, { at: number; answer: Promise<KnownProject["folder"]> }>()
  // The underlying check per folder, until it settles.
  const running = new Map<string, Promise<unknown>>()
  return (path) => {
    const held = answers.get(path)
    if (held && (running.has(path) || now() - held.at <= projectFolderCheckReuseMs)) return held.answer
    const underlying = check(path)
    running.set(path, underlying)
    const entry = { at: now(), answer: projectFolderState(underlying) }
    answers.set(path, entry)
    // The reuse window starts when the check settles, so a slow check is
    // never followed at once by another.
    void underlying.then(() => {}, () => {}).then(() => {
      if (running.get(path) === underlying) running.delete(path)
      if (answers.get(path) === entry) entry.at = now()
    })
    if (answers.size > 256) {
      for (const [key, value] of answers) {
        if (!running.has(key) && now() - value.at > projectFolderCheckReuseMs) answers.delete(key)
      }
    }
    return entry.answer
  }
}

export async function knownProjectList(
  snapshot: WorkspaceSnapshot,
  listing: SavedProjectListing,
  folderOf: (path: string) => Promise<KnownProject["folder"]>,
): Promise<RpcResult<"project.list">> {
  const { projects, omittedProjects } = knownProjectEntries(snapshot, listing)
  return {
    projects: await Promise.all(projects.map(async (known) => ({ ...known, folder: await folderOf(known.project.path) }))),
    ...(omittedProjects > 0 ? { omittedProjects } : {}),
  }
}
