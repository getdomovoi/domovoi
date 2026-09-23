import {
  maximumImageUploadBytes,
  maximumSessionAttachments,
  maximumTextAttachmentBytes,
  sessionAttachmentSchema,
  type SessionAttachment,
} from "@getdomovoi/protocol"

export const desktopAttachmentLimit = maximumSessionAttachments
export const desktopInlineLineLimit = 40

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function attachmentFromBrowserFile(file: File): Promise<SessionAttachment> {
  if (file.type === "image/png" || file.type === "image/jpeg") {
    if (file.size > maximumImageUploadBytes) throw new Error("Image exceeds the 1.5 MB attachment limit")
    const bitmap = await createImageBitmap(file)
    try {
      return sessionAttachmentSchema.parse({
        mimeType: file.type,
        width: bitmap.width,
        height: bitmap.height,
        data: base64(new Uint8Array(await file.arrayBuffer())),
      })
    } finally {
      bitmap.close()
    }
  }
  if (file.size > maximumTextAttachmentBytes) throw new Error("Text file exceeds the 256 KB attachment limit")
  return sessionAttachmentSchema.parse({
    kind: "text",
    name: file.name,
    mimeType: "text/plain",
    content: await file.text(),
  })
}

export function terminalOutputAttachment(content: string): SessionAttachment {
  return sessionAttachmentSchema.parse({
    kind: "text",
    name: "terminal-output.txt",
    mimeType: "text/plain",
    content,
  })
}

export function workspacePathAttachment(path: string): SessionAttachment {
  return sessionAttachmentSchema.parse({ kind: "workspace-file", path: path.trim() })
}

export function attachmentName(attachment: SessionAttachment): string {
  if ("kind" in attachment) return attachment.kind === "text" ? attachment.name : attachment.path
  return attachment.mimeType === "image/png" ? "image.png" : "image.jpg"
}

export function attachmentMeta(attachment: SessionAttachment): string {
  if ("kind" in attachment) {
    if (attachment.kind === "workspace-file") return "read from worktree"
    const lines = attachment.content.split(/\r?\n/u).length
    return `${new TextEncoder().encode(attachment.content).byteLength} bytes · ${lines} lines`
  }
  return `${attachment.width}×${attachment.height}`
}

export function inlineTextPreview(attachment: SessionAttachment): string | undefined {
  if (!("kind" in attachment) || attachment.kind !== "text") return undefined
  const lines = attachment.content.split(/\r?\n/u)
  if (lines.length <= desktopInlineLineLimit) return undefined
  return lines.slice(0, desktopInlineLineLimit).join("\n")
}
