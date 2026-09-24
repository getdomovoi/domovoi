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
