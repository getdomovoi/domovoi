import { maximumSessionPromptCharacters } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import {
  attachmentMark,
  attachmentMeta,
  attachmentName,
  desktopAttachmentLimit,
  inlineTextPreview,
  isImageAttachment,
  pasteOutcome,
  terminalOutputAttachment,
  workspacePathAttachment,
} from "./desktop-attachments"

// Eight bytes: the PNG signature, which is all a chip needs to count.
const png = { mimeType: "image/png" as const, width: 2, height: 2, data: "iVBORw0KGgo=" }

// A full draft keeps a long paste in the message. When that puts the message
// past the prompt cap, the note says so as well as naming the attachment
// limit: the daemon refuses the message either way.
it("says a paste kept by a full draft cannot be sent when it passes the prompt cap", () => {
  const draft = Array.from({ length: desktopAttachmentLimit }, () => terminalOutputAttachment("ok"))
  const paste = Array.from({ length: 41 }, () => "x".repeat(100)).join("\n")

  const underCap = pasteOutcome(paste, draft, 0)
  expect(underCap).toEqual({ kind: "inline", note: `Attach up to ${desktopAttachmentLimit} items per message. The pasted text stayed in the message.` })

  const overCap = pasteOutcome(paste, draft, maximumSessionPromptCharacters - paste.length + 1)
  expect(overCap).toEqual({
    kind: "inline",
    note: `Attach up to ${desktopAttachmentLimit} items per message. The pasted text stayed in the message. A message over 262,144 characters cannot be sent.`,
  })
})

it("keeps the full text attachment while limiting the inline preview to forty lines", () => {
  const content = Array.from({ length: 55 }, (_, index) => `line ${index + 1}`).join("\n")
  const attachment = terminalOutputAttachment(content)
  expect(attachmentName(attachment)).toBe("terminal-output.txt")
  expect(inlineTextPreview(attachment)?.split("\n")).toHaveLength(40)
  expect("kind" in attachment && attachment.kind === "text" ? attachment.content : "").toBe(content)
})

// The design's chips carry a muted badge per kind (TS, PNG, LOG, TXT) and a
// meta line: a worktree path stays on the machine, anything from this device
// is copied there, with its size.
it("marks each attachment by its kind", () => {
  expect(attachmentMark(workspacePathAttachment("src/webhooks/replay.spec.ts"))).toBe("TS")
  expect(attachmentMark(workspacePathAttachment("docs/README.markdown"))).toBe("FILE")
  expect(attachmentMark(workspacePathAttachment("Makefile"))).toBe("FILE")
  expect(attachmentMark(terminalOutputAttachment("ok"))).toBe("LOG")
  expect(attachmentMark({ kind: "text", name: "notes.md", mimeType: "text/plain", content: "x" })).toBe("TXT")
  expect(attachmentMark(png)).toBe("PNG")
  expect(attachmentMark({ ...png, mimeType: "image/jpeg" })).toBe("JPG")
})

it("says where each attachment is read from and how big a copied one is", () => {
  expect(attachmentMeta(workspacePathAttachment("src/index.ts"), "mac-mini-m4")).toBe("on mac-mini-m4")
  expect(attachmentMeta(terminalOutputAttachment("12345"), "mac-mini-m4")).toBe("5 B · sent to mac-mini-m4")
  expect(attachmentMeta(terminalOutputAttachment("x".repeat(18_400)), "mac-mini-m4")).toBe("18.4 kB · sent to mac-mini-m4")
  expect(attachmentMeta(png, "mac-mini-m4")).toBe("8 B · sent to mac-mini-m4")
})

it("counts only images as image attachments", () => {
  expect(isImageAttachment(png)).toBe(true)
  expect(isImageAttachment(terminalOutputAttachment("ok"))).toBe(false)
  expect(isImageAttachment(workspacePathAttachment("shot.png"))).toBe(false)
})

it("accepts only worktree-contained file paths", () => {
  expect(workspacePathAttachment("src/index.ts")).toEqual({ kind: "workspace-file", path: "src/index.ts" })
  expect(() => workspacePathAttachment("../secret.txt")).toThrow()
  expect(() => workspacePathAttachment("/etc/passwd")).toThrow()
})
