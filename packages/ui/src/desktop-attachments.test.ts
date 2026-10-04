import { maximumSessionPromptCharacters } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import {
  attachmentMeta,
  attachmentName,
  desktopAttachmentLimit,
  inlineTextPreview,
  pasteOutcome,
  terminalOutputAttachment,
  workspacePathAttachment,
} from "./desktop-attachments"

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
  expect(attachmentMeta(attachment)).toContain("55 lines")
  expect(inlineTextPreview(attachment)?.split("\n")).toHaveLength(40)
  expect("kind" in attachment && attachment.kind === "text" ? attachment.content : "").toBe(content)
})

it("accepts only worktree-contained file paths", () => {
  expect(workspacePathAttachment("src/index.ts")).toEqual({ kind: "workspace-file", path: "src/index.ts" })
  expect(() => workspacePathAttachment("../secret.txt")).toThrow()
  expect(() => workspacePathAttachment("/etc/passwd")).toThrow()
})
