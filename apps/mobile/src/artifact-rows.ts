import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

type Artifact = WorkspaceSnapshot["artifacts"][number]

// A phone should not scroll ten thousand lines of diff, and the desktop is
// where a large one is read anyway. What was left out is counted rather than
// silently truncated.
export const maximumRenderedArtifactLines = 400

export type ArtifactRow = {
  id: string
  title: string
  type: Artifact["type"]
  revision: number
  // Whether the phone holds the bytes. The daemon sends plan and diff contents
  // inline; a preview is a path into the worktree that only a signed fetch can
  // read, and this app cannot make one yet.
  readable: boolean
  detail: string
  variantLabel: string | undefined
}

const unreadableReasons: Record<Artifact["type"], string> = {
  preview: "A preview needs a signed fetch this phone cannot make yet.",
  plan: "The daemon sent no contents for this plan.",
  diff: "The daemon sent no contents for this diff.",
  terminal: "A terminal is watched live on the desktop, not read here.",
}

export function artifactRows(
  snapshot: WorkspaceSnapshot,
  sessionId: string,
): ArtifactRow[] {
  return snapshot.artifacts
    .filter((artifact) => artifact.sessionId === sessionId)
    // Variants of one preview belong together, and within a group the order the
    // daemon assigned is the order the person named them in.
    .sort((left, right) => {
      const group = (left.variant?.groupId ?? "").localeCompare(right.variant?.groupId ?? "")
      if (group !== 0) return group
      return (left.variant?.order ?? 0) - (right.variant?.order ?? 0)
    })
    .map((artifact) => {
      const readable = typeof artifact.content === "string"
      return {
        id: artifact.id,
        title: artifact.title,
        type: artifact.type,
        revision: artifact.revision,
        readable,
        detail: readable
          ? artifact.mimeType ?? artifact.type
          : unreadableReasons[artifact.type],
        variantLabel: artifact.variant?.label,
      }
    })
}

export type ArtifactBody =
  | { readable: false, reason: string }
  | { readable: true, lines: string[], omitted: number }

export function artifactBody(artifact: Artifact): ArtifactBody {
  if (typeof artifact.content !== "string") {
    return { readable: false, reason: unreadableReasons[artifact.type] }
  }
  const lines = artifact.content.split("\n")
  return {
    readable: true,
    lines: lines.slice(0, maximumRenderedArtifactLines),
    omitted: Math.max(0, lines.length - maximumRenderedArtifactLines),
  }
}

export type DiffLine = { text: string, tone: "added" | "removed" | "meta" | "context" }

// A diff read on a phone is read for its shape, not its detail, so the only
// thing the phone adds is which side of the change a line is on.
export function diffLines(lines: readonly string[]): DiffLine[] {
  return lines.map((text) => {
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@")) {
      return { text, tone: "meta" }
    }
    if (text.startsWith("+")) return { text, tone: "added" }
    if (text.startsWith("-")) return { text, tone: "removed" }
    return { text, tone: "context" }
  })
}

export function findArtifact(
  snapshot: WorkspaceSnapshot,
  artifactId: string,
): Artifact | undefined {
  return snapshot.artifacts.find((artifact) => artifact.id === artifactId)
}
