# Session attachments

`session.send` accepts optional `attachments`, at most two objects in total, of three kinds.
Existing text-only sends remain valid. The schemas are in `packages/protocol/src/image-upload.ts`.

- **Image:** `mimeType`, `width`, `height` and `data`. PNG and JPEG only, not WebP or URLs.
  Canonical Base64, at most 1,500,000 decoded bytes, positive integer dimensions at most 2048
  pixels on either side. The same Base64 and dimension validators back annotation uploads.
  Annotations remain PNG-only and retain their artifact revision field.
- **Text file:** `kind: "text"`, a `name` of at most 255 characters, `mimeType: "text/plain"`
  and `content` of at most 262,144 UTF-8 bytes. The daemon writes it into the session worktree
  under `.domovoi/attachments/` with owner-only permissions and gives the agent the path and the
  first 40 lines.
- **Worktree file:** `kind: "workspace-file"` and a relative `path` of at most 1,024 characters.
  The path may not be absolute, start with `-`, contain `..` or `.` segments, or leave the session
  worktree after symlinks are resolved. The file must be a regular file of at most 262,144 bytes.
  Nothing is copied: the agent is told the path and reads the file itself.

Terminal ranges and URLs are not attachments.

The daemon bounds bytes before decoding Base64, checks the image header and its
declared dimensions, then hands bytes to the adapter as turn-local `visualContexts`
beside the composed prompt. Header validation is not a full image decoder; the
provider still decodes the pixels. Uploads do not become annotations, files,
snapshot fields, history entries or audit payloads. They are not attached again on
a later send. A provider may retain its own transcript under its own rules.

Both a new turn and steering an active turn use this path. If the registered
adapter does not explicitly declare `capabilities.vision`, the entire send refuses
before thread resume, provider dispatch or prompt persistence. The refusal names
the session's model and the number of images, with the code the attach sheet
shows. Error data validates with `sessionAttachmentRefusalSchema`:

```json
{"kind":"session-attachment-refused","reason":"image-input-unsupported","code":"attach.image.model_no_input","model":"qwen3-coder-72b","imageCount":2}
```

`runtime.models` says the same per model ahead of a send: `imageInput` is `true` when an image
attachment on a send to that model is delivered, `false` when it is not. Today it comes from the
adapter's vision capability, so it is `true` for every model of an adapter that delivers images
and `false` for the rest, whatever their harness could take. A missing field is an older daemon,
which a client treats as not known rather than as no.

Invalid decoded images use `invalid-image`. A text file over its byte limit uses
`invalid-text`. A worktree file that is missing, outside the worktree, not a regular file or
too large, or any file attachment on a session with no worktree, uses
`invalid-workspace-file`. Invalid parameter shapes receive the normal invalid-params refusal. No image is silently omitted to make a send work.
The handheld method allowlist is unchanged; `session.send` was already allowed.

## Transport bounds

Two maximum uploads occupy 4,000,000 Base64 characters. Direct WebSocket and
encrypted reassembled RPC messages are bounded at 6 MiB to accommodate those
uploads, the existing bounded prompt including JSON escaping, and envelope
overhead. The encrypted carrier backlog is bounded at 8 MiB so one maximum message
plus record overhead can be queued. Frames remain at most 65,535 bytes; encrypted
admission and direct pre-authentication messages remain bounded at 4 KiB. No relay
repository, routing, credential policy or URL fetch path changes.

`system.hello` has an optional boolean `sessionImageAttachments`. This daemon
advertises `true`; clients must require `true` before sending images. Missing or
false means unsupported. Older daemons strip unknown `session.send` fields, so a
text-only success cannot establish image delivery. Never retry by dropping images.
This flag describes daemon support, not the selected adapter's vision capability;
an adapter without vision still refuses the entire image send. The flag is not
persisted in workspace state. Larger sends also require updated transport endpoints.

The phone UI is a separate slice. Its queue must state: two images, 1.5 MB each,
2048 pixels on a side. `terminal.watch` remains deferred until after Phase 1.
