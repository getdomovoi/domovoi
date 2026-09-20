import { describe, expect, it } from "vitest"
import { sessionSendParamsSchema } from "./rpc.js"
import { sessionAttachmentRefusalSchema } from "./image-upload.js"

const image = { mimeType: "image/png", width: 1, height: 1, data: "AAAA" }
const send = { sessionId: "session-images", prompt: "Read these images", client: "phone" }

describe("session image attachments", () => {
  it("preserves two bounded PNG or JPEG uploads and text-only sends", () => {
    expect(sessionSendParamsSchema.parse(send)).toEqual(send)
    const attachments = [image, { ...image, mimeType: "image/jpeg", width: 2048, height: 2048, data: Buffer.alloc(1_500_000).toString("base64") }]
    const parsed = sessionSendParamsSchema.parse({ ...send, attachments })
    expect(parsed.attachments?.length).toBe(2)
    const jpeg = parsed.attachments?.[1]
    expect(jpeg && "data" in jpeg ? jpeg.data.length : 0).toBe(2_000_000)
    expect(parsed.attachments?.[0]).toEqual(image)
  })

  it.each([
    [image, image, image],
    [{ ...image, data: Buffer.alloc(1_500_001).toString("base64") }],
    [{ ...image, data: "AB==" }],
    [{ ...image, data: "AA==\n" }],
    [{ ...image, data: "AA" }],
    [{ ...image, width: 2049 }],
    [{ ...image, height: 0 }],
    [{ ...image, width: 1.5 }],
    [{ ...image, mimeType: "image/webp" }],
    [{ ...image, url: "https://example.test/photo.png" }],
    [{ kind: "file", path: "photo.png" }],
  ])("refuses uploads outside the image-only contract: %#", (...attachments) => {
    expect(sessionSendParamsSchema.safeParse({ ...send, attachments }).success).toBe(false)
  })

  it("accepts bounded text and project-contained workspace attachments", () => {
    const attachments = [
      { kind: "text", name: "pasted-output.txt", mimeType: "text/plain", content: "line one\nline two" },
      { kind: "workspace-file", path: "src/webhooks/replay.spec.ts" },
    ]
    expect(sessionSendParamsSchema.parse({ ...send, attachments }).attachments).toEqual(attachments)
  })

  it.each([
    { kind: "text", name: "output.txt", mimeType: "text/html", content: "hello" },
    { kind: "text", name: "output.txt", mimeType: "text/plain", content: "x".repeat(262_145) },
    { kind: "workspace-file", path: "../secret.txt" },
    { kind: "workspace-file", path: "/etc/passwd" },
    { kind: "workspace-file", path: "src/../secret.txt" },
  ])("refuses unsafe non-image attachments: %#", (attachment) => {
    expect(sessionSendParamsSchema.safeParse({ ...send, attachments: [attachment] }).success).toBe(false)
  })

  it("does not silently accept reference fields", () => {
    expect(sessionSendParamsSchema.safeParse({ ...send, references: [{ kind: "url", url: "https://example.test" }] }).success).toBe(false)
  })

  it("validates named refusal reasons", () => {
    for (const reason of ["image-input-unsupported", "invalid-image"]) {
      expect(sessionAttachmentRefusalSchema.safeParse({ kind: "session-attachment-refused", reason }).success).toBe(true)
    }
    expect(sessionAttachmentRefusalSchema.safeParse({ kind: "session-attachment-refused", reason: "ignored" }).success).toBe(false)
  })
})
