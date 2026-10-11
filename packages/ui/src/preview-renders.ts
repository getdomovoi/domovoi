import type { Artifact, WorkspaceSnapshot } from "@getdomovoi/protocol"

export type RenderedPreview = {
  key: string
  // The artifact a pick opens: the render itself, or a group's first variant.
  artifactId: string
  artifactIds: string[]
  label: string
  meta: string
}

function previewDirectory(path: string | undefined): string | undefined {
  const normal = path?.replaceAll("\\", "/") ?? ""
  const slash = normal.lastIndexOf("/")
  return slash > 0 ? normal.slice(0, slash) : undefined
}

// The name a render goes by in RENDERED THIS SESSION: a variant group's (the
// last part of its id, which the watcher sets to the variants' directory), or
// the render's own title. A variant's title names one variant (the watcher
// titles a file by its name), not the group.
export function previewRenderName(artifact: Pick<Artifact, "title" | "variant">): string {
  if (!artifact.variant) return artifact.title
  const { groupId } = artifact.variant
  return groupId.split("/").findLast((part) => part.length > 0) ?? groupId
}

function joinMeta(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined).join(" · ")
}

// RENDERED THIS SESSION lists what the preview frame can open: HTML previews
// of the active session with a path. A variant group is one render with its
// variants inside it, so it is one row. Rows keep the snapshot's order, which
// is the order the daemon first saw each render; a later revision of a render
// keeps its place. The wire carries no render time, so the meta line names
// the directory and the revision (or the variant count) instead.
export function renderedPreviewsForActiveSession(snapshot: WorkspaceSnapshot): RenderedPreview[] {
  if (!snapshot.activeSessionId) return []
  const rows: RenderedPreview[] = []
  const groups = new Map<string, Artifact[]>()
  for (const artifact of snapshot.artifacts) {
    if (
      artifact.sessionId !== snapshot.activeSessionId
      || artifact.type !== "preview"
      || artifact.mimeType !== "text/html"
      || !artifact.path
    ) continue
    if (!artifact.variant) {
      rows.push({
        key: `render:${artifact.id}`,
        artifactId: artifact.id,
        artifactIds: [artifact.id],
        label: artifact.title,
        meta: joinMeta(previewDirectory(artifact.path), `revision ${artifact.revision}`),
      })
      continue
    }
    const members = groups.get(artifact.variant.groupId)
    if (members) {
      members.push(artifact)
      continue
    }
    const group = [artifact]
    groups.set(artifact.variant.groupId, group)
    // A placeholder keeps the group at its first member's place; it is filled
    // in below once every member is known.
    rows.push({ key: `group:${artifact.variant.groupId}`, artifactId: artifact.id, artifactIds: [], label: "", meta: "" })
  }
  return rows.map((row) => {
    if (!row.key.startsWith("group:")) return row
    const members = [...groups.get(row.key.slice("group:".length))!].sort((left, right) =>
      (left.variant?.order ?? 0) - (right.variant?.order ?? 0) || left.id.localeCompare(right.id))
    const first = members[0]!
    // The meta names the directory that holds the group.
    return {
      ...row,
      artifactId: first.id,
      artifactIds: members.map((artifact) => artifact.id),
      label: previewRenderName(first),
      meta: joinMeta(
        previewDirectory(previewDirectory(first.path)),
        members.length === 1 ? "1 variant" : `${members.length} variants`,
      ),
    }
  })
}
