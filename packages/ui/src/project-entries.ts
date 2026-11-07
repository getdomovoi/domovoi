import {
  workspaceProjects,
  type KnownProject,
  type KnownProjectSession,
  type Project,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

// Rulings Q158 A and Q159 A: sessions are the unit and projects are where they
// run. A project is listed from the data whether or not it is active: the
// active ones from the snapshot, whose sessions are live there, and the rest
// from project.list, whose sessions run nothing until the project opens
// again. The focused project comes first, then the other active ones in the
// snapshot's order, then the known ones newest first. Nothing here assumes
// one active project.
export type ProjectEntry = {
  project: Project
  // Active: its sessions are in the snapshot, and nothing switches to start
  // one there.
  active: boolean
  // The project a call that names none acts on.
  focused: boolean
  folder: KnownProject["folder"]
  // The sessions project.list read, for a project that is not active.
  savedSessions: readonly KnownProjectSession[]
  omittedSessions: number
}

export function projectEntries(
  snapshot: Pick<WorkspaceSnapshot, "project" | "projects">,
  known: readonly KnownProject[] | null | undefined,
): ProjectEntry[] {
  const live = workspaceProjects(snapshot)
  const focused = snapshot.project
  const ordered = focused ? [focused, ...live.filter((project) => project.id !== focused.id)] : live
  const listed = new Map((known ?? []).map((entry) => [entry.project.id, entry]))
  const liveIds = new Set(ordered.map((project) => project.id))
  return [
    ...ordered.map((project): ProjectEntry => ({
      project,
      active: true,
      focused: project.id === focused?.id,
      folder: listed.get(project.id)?.folder ?? "present",
      savedSessions: [],
      omittedSessions: 0,
    })),
    ...(known ?? []).filter((entry) => !liveIds.has(entry.project.id)).map((entry): ProjectEntry => ({
      project: entry.project,
      active: false,
      focused: false,
      folder: entry.folder,
      savedSessions: entry.sessions,
      omittedSessions: entry.omittedSessions ?? 0,
    })),
  ]
}

// What "Start a session" lists for its Project field.
export type LauncherProject = {
  name: string
  path: string
  // Starting here needs no project switch.
  open: boolean
  folder: KnownProject["folder"]
}

export function launcherProjects(entries: readonly ProjectEntry[]): LauncherProject[] {
  return entries.map((entry) => ({
    name: entry.project.name,
    path: entry.project.path,
    open: entry.active,
    folder: entry.folder,
  }))
}
