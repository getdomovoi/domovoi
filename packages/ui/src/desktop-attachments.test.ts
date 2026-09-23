import { expect, it } from "vitest"

import {
  attachmentMeta,
  attachmentName,
  inlineTextPreview,
  terminalOutputAttachment,
  workspacePathAttachment,
} from "./desktop-attachments"

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
