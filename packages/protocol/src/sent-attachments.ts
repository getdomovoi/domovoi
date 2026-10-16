import type { SessionAttachmentSummary } from "./image-upload.js"

// How every client names an attachment a sent turn carried, so the desktop,
// the browser, the phone and the tablet say the same thing about it. Drawn
// from the recorded metadata alone: the bytes stay on the execution machine
// and are not kept there either once the provider has them, so no client
// can draw a thumbnail of a sent image yet.
export type SentAttachmentChip = {
  kind: SessionAttachmentSummary["kind"]
  // The composer's per-kind badge: PNG or JPG for an image, LOG for terminal
  // output, TXT for other text, and a worktree file by its extension.
  mark: string
  name: string
  meta: string
  // The whole fact in one sentence, for a screen reader.
  label: string
}

const terminalOutputName = "terminal-output.txt"

function byteSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function pathMark(path: string): string {
  return /\.([a-z0-9]{1,4})$/iu.exec(path)?.[1]?.toUpperCase() ?? "FILE"
}

export function sentAttachmentChips(attachments: readonly SessionAttachmentSummary[] | undefined): SentAttachmentChip[] {
  if (!attachments?.length) return []
  // An image has no name on the wire. It is called what it is, numbered only
  // when the turn carried two, rather than given a file name it never had.
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length
  let imageOrdinal = 0
  return attachments.map((attachment) => {
    if (attachment.kind === "image") {
      imageOrdinal += 1
      const png = attachment.mimeType === "image/png"
      const size = byteSize(attachment.bytes)
      return {
        kind: "image",
        mark: png ? "PNG" : "JPG",
        name: imageCount > 1 ? `Image ${imageOrdinal}` : "Image",
        meta: `${size} · ${attachment.width} × ${attachment.height}`,
        label: `${png ? "PNG" : "JPEG"} image, ${size}, ${attachment.width} by ${attachment.height} pixels`,
      }
    }
    if (attachment.kind === "text") {
      const size = byteSize(attachment.bytes)
      return {
        kind: "text",
        mark: attachment.name === terminalOutputName ? "LOG" : "TXT",
        name: attachment.name,
        meta: size,
        label: `Text file ${attachment.name}, ${size}`,
      }
    }
    // A worktree path is read where it is, so the send recorded no size.
    return {
      kind: "workspace-file",
      mark: pathMark(attachment.path),
      name: attachment.path,
      meta: "worktree file",
      label: `Worktree file ${attachment.path}, read in place`,
    }
  })
}
