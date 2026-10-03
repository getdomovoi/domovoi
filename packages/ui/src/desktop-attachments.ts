import {
  maximumImageUploadBytes,
  maximumSessionAttachments,
  maximumSessionPromptCharacters,
  maximumTextAttachmentBytes,
  sessionAttachmentSchema,
  type SessionAttachment,
  type TextAttachment,
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

const pastedTextName = /^pasted-text-(\d+)\.txt$/u

// Not a type guard: a text attachment that is not a paste is still text.
export function pastedText(attachment: SessionAttachment): TextAttachment | undefined {
  return "kind" in attachment && attachment.kind === "text" && pastedTextName.test(attachment.name) ? attachment : undefined
}

// One trailing newline ends the last line rather than starting another.
function pastedLineCount(text: string): number {
  return text.replace(/\r?\n$/u, "").split(/\r?\n/u).length
}

// The daemon puts the first desktopInlineLineLimit lines of a text file into
// the prompt, so a paste longer than that is past the inline limit and goes
// as a file. A shorter one stays in the message.
export function pasteBecomesFile(text: string): boolean {
  return pastedLineCount(text) > desktopInlineLineLimit
}

// Numbered after the highest pasted file in the draft, so dropping one never
// gives two files the same name. Throws when the text is past the text
// attachment limit.
export function pastedTextAttachment(content: string, draft: readonly SessionAttachment[]): SessionAttachment {
  const highest = Math.max(0, ...draft.flatMap((attachment) => {
    const pasted = pastedText(attachment)
    return pasted ? [Number(pastedTextName.exec(pasted.name)?.[1] ?? 0)] : []
  }))
  return sessionAttachmentSchema.parse({
    kind: "text",
    name: `pasted-text-${highest + 1}.txt`,
    mimeType: "text/plain",
    content,
  })
}

export type PasteOutcome =
  | { kind: "inline", note?: string }
  | { kind: "file", attachment: SessionAttachment }

// What a paste becomes, for every field that takes one. A paste past the
// inline limit goes as a file. When it cannot, because the draft holds the
// most attachments or the text is past the attachment limit, it stays in the
// message and the note says why, and says too when the message is then past
// the prompt limit and cannot be sent.
// keptLength is how much of the typed message the paste leaves in place: the
// prompt limit counts the whole message, not the paste alone.
export function pasteOutcome(text: string, draft: readonly SessionAttachment[], keptLength = 0): PasteOutcome {
  if (!pasteBecomesFile(text)) return { kind: "inline" }
  if (draft.length >= desktopAttachmentLimit) {
    return { kind: "inline", note: `Attach up to ${desktopAttachmentLimit} items per message. The pasted text stayed in the message.` }
  }
  try {
    return { kind: "file", attachment: pastedTextAttachment(text, draft) }
  } catch {
    const unsendable = keptLength + text.length > maximumSessionPromptCharacters
      ? ` A message over ${maximumSessionPromptCharacters.toLocaleString("en-US")} characters cannot be sent.`
      : ""
    return { kind: "inline", note: `Pasted text exceeds the ${maximumTextAttachmentBytes / 1024} KB attachment limit, so it stayed in the message.${unsendable}` }
  }
}

export function pastedTextMeta(attachment: TextAttachment): string {
  const bytes = new TextEncoder().encode(attachment.content).byteLength
  const size = bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`
  const lines = pastedLineCount(attachment.content)
  return `${size} · ${lines} ${lines === 1 ? "line" : "lines"}`
}

// What Peek shows: the lines the prompt carries, and how many more the agent
// reads only on request. The rest is counted as the card counts lines, so a
// trailing newline does not add one.
export function pastedTextPeek(attachment: TextAttachment): string {
  const shown = attachment.content.split(/\r?\n/u).slice(0, desktopInlineLineLimit).join("\n")
  const rest = pastedLineCount(attachment.content) - desktopInlineLineLimit
  return rest > 0 ? `${shown}\n… ${rest} more ${rest === 1 ? "line" : "lines"}` : shown
}

export function inlineTextPreview(attachment: SessionAttachment): string | undefined {
  if (!("kind" in attachment) || attachment.kind !== "text") return undefined
  const lines = attachment.content.split(/\r?\n/u)
  if (lines.length <= desktopInlineLineLimit) return undefined
  return lines.slice(0, desktopInlineLineLimit).join("\n")
}
