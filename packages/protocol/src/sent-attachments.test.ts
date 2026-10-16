import { describe, expect, it } from "vitest"

import { threadItemSchema } from "./schema.js"
import { sentAttachmentChips } from "./sent-attachments.js"

const user = {
  id: "user-1",
  sessionId: "session-1",
  kind: "user",
  body: "Describe this image",
  createdAt: "2026-10-16T12:00:00.000Z",
} as const
const photo = { kind: "image", mimeType: "image/jpeg", width: 2048, height: 1536, bytes: 1_412_000 } as const

describe("attachments a sent turn carried", () => {
  it("records each attachment on the user turn as metadata", () => {
    for (const attachments of [
      [photo, { kind: "text", name: "terminal-output.txt", bytes: 3_200 }],
      [{ kind: "workspace-file", path: "src/webhooks/replay.spec.ts" }],
    ]) {
      expect(threadItemSchema.parse({ ...user, attachments })).toEqual({ ...user, attachments })
    }
  })

  it("keeps a user turn without attachments as it was", () => {
    expect(threadItemSchema.parse(user)).toEqual(user)
  })

  it.each([
    // The bytes stay on the execution machine: a recorded turn never carries them.
    [[{ ...photo, data: "AAAA" }]],
    [[photo, photo, photo]],
    [[]],
    [[{ ...photo, mimeType: "image/webp" }]],
    [[{ ...photo, width: 0 }]],
    [[{ ...photo, bytes: 1_500_001 }]],
    [[{ kind: "text", name: "notes.txt", bytes: 12, content: "hello" }]],
    [[{ kind: "workspace-file", path: "" }]],
    [[{ kind: "file", path: "photo.png" }]],
  ])("refuses an attachment record outside the metadata contract: %#", (attachments) => {
    expect(threadItemSchema.safeParse({ ...user, attachments }).success).toBe(false)
  })
})

describe("sent attachment chips", () => {
  it("names each attachment by name, kind and size", () => {
    expect(sentAttachmentChips([
      photo,
      { kind: "text", name: "terminal-output.txt", bytes: 3_200 },
      { kind: "text", name: "notes.txt", bytes: 640 },
      { kind: "workspace-file", path: "src/webhooks/replay.spec.ts" },
      { kind: "workspace-file", path: "docs" },
    ])).toEqual([
      { kind: "image", mark: "JPG", name: "Image", meta: "1.4 MB · 2048 × 1536", label: "JPEG image, 1.4 MB, 2048 by 1536 pixels" },
      { kind: "text", mark: "LOG", name: "terminal-output.txt", meta: "3.2 kB", label: "Text file terminal-output.txt, 3.2 kB" },
      { kind: "text", mark: "TXT", name: "notes.txt", meta: "640 B", label: "Text file notes.txt, 640 B" },
      { kind: "workspace-file", mark: "TS", name: "src/webhooks/replay.spec.ts", meta: "worktree file", label: "Worktree file src/webhooks/replay.spec.ts, read in place" },
      { kind: "workspace-file", mark: "FILE", name: "docs", meta: "worktree file", label: "Worktree file docs, read in place" },
    ])
  })

  it("numbers images only when a turn carried more than one", () => {
    const png = { kind: "image", mimeType: "image/png", width: 1, height: 1, bytes: 68 } as const
    expect(sentAttachmentChips([png, photo]).map((chip) => [chip.mark, chip.name, chip.meta])).toEqual([
      ["PNG", "Image 1", "68 B · 1 × 1"],
      ["JPG", "Image 2", "1.4 MB · 2048 × 1536"],
    ])
  })

  it("claims nothing for a turn that carried nothing", () => {
    expect(sentAttachmentChips(undefined)).toEqual([])
    expect(sentAttachmentChips([])).toEqual([])
    expect(sentAttachmentChips([{ kind: "text", name: "a.txt", bytes: 1 }]).some((chip) => chip.kind === "image")).toBe(false)
  })
})
