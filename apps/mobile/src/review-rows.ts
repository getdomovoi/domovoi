import type { Annotation, WorkspaceSnapshot } from "@getdomovoi/protocol"

export type AnnotationRow = {
  id: string
  // The pin the handoff draws over the preview. It numbers the comments on one
  // artifact in the order they were made, so the pin on the page and the card
  // below it are the same comment.
  pin: string
  // What the comment is attached to. A selector is what the desktop anchors on,
  // and a quote is what a person recognises, so the quote wins when there is
  // one.
  anchor: string
  status: "open" | "resolved"
  body: string
  meta: string
}

export type ReviewRow = {
  id: string
  sessionId: string
  sessionTitle: string
  title: string
  detail: string
  variantLabel: string | undefined
  open: number
  resolved: number
}

// Who left a comment, in the words the rest of the app uses for a client. The
// phone says "this phone" about itself, because "phone" reads as some other
// device when you are holding the one that said it.
const origins: Record<Annotation["origin"], string> = {
  desktop: "desktop",
  web: "web",
  tablet: "iPad",
  phone: "this phone",
  cli: "cli",
}

function anchorLabel(annotation: Annotation): string {
  return annotation.anchor.textQuote ?? annotation.anchor.cssSelector ?? "a region of the preview"
}

function metaLabel(annotation: Annotation): string {
  const replies = annotation.thread.length
  if (replies === 0) return origins[annotation.origin]
  return `${origins[annotation.origin]} · ${replies} repl${replies === 1 ? "y" : "ies"}`
}

// Ordered the way the daemon recorded them, so a pin number is stable between
// the phone and every other client reading the same snapshot.
export function annotationRows(
  snapshot: WorkspaceSnapshot,
  artifactId: string,
): AnnotationRow[] {
  return snapshot.annotations
    .filter((annotation) => annotation.artifactId === artifactId)
    .map((annotation, index) => ({
      id: annotation.id,
      pin: String(index + 1),
      anchor: anchorLabel(annotation),
      status: annotation.status,
      body: annotation.body,
      meta: metaLabel(annotation),
    }))
}

export function openAnnotationCount(rows: readonly AnnotationRow[]): number {
  return rows.filter((row) => row.status === "open").length
}

// Everything the workspace has produced that a person can look at, with the
// ones still carrying an open comment first. A phone opened to review is opened
// to answer what is outstanding, not to browse what is finished.
export function reviewRows(snapshot: WorkspaceSnapshot): ReviewRow[] {
  const titles = new Map(snapshot.sessions.map((session) => [session.id, session.title]))
  return snapshot.artifacts
    .map((artifact) => {
      const rows = annotationRows(snapshot, artifact.id)
      const open = openAnnotationCount(rows)
      return {
        id: artifact.id,
        sessionId: artifact.sessionId,
        sessionTitle: titles.get(artifact.sessionId) ?? artifact.sessionId,
        title: artifact.title,
        detail: `${artifact.type} · revision ${artifact.revision}`,
        variantLabel: artifact.variant?.label,
        open,
        resolved: rows.length - open,
      }
    })
    .sort((left, right) => {
      if (left.open !== right.open) return right.open - left.open
      const session = left.sessionTitle.localeCompare(right.sessionTitle)
      return session !== 0 ? session : left.title.localeCompare(right.title)
    })
}

// The same grammar the other two tabs summarise themselves with: what there is,
// then what wants a person.
export function reviewSummary(rows: readonly ReviewRow[]): string {
  const open = rows.reduce((total, row) => total + row.open, 0)
  return `${rows.length} artifact${rows.length === 1 ? "" : "s"} · ${open} open`
}
