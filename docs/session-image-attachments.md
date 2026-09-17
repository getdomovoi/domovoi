# Session image attachments

`session.send` accepts optional `attachments`, at most two objects with `mimeType`,
`width`, `height` and `data`. Existing text-only sends remain valid.

- PNG and JPEG only, not WebP, URLs, file references or terminal ranges.
- Each image: canonical Base64, at most 1,500,000 decoded bytes, positive integer
  dimensions at most 2048 pixels on either side.
- The same Base64 and dimension validators back annotation uploads. Annotations
  remain PNG-only and retain their artifact revision field.

The daemon bounds bytes before decoding Base64, checks the image header and its
declared dimensions, then hands bytes to the adapter as turn-local `visualContexts`
beside the composed prompt. Header validation is not a full image decoder; the
provider still decodes the pixels. Uploads do not become annotations, files,
snapshot fields, history entries or audit payloads. They are not attached again on
a later send. A provider may retain its own transcript under its own rules.

Both a new turn and steering an active turn use this path. If the registered
adapter does not explicitly declare `capabilities.vision`, the entire send refuses
before thread resume, provider dispatch or prompt persistence. Error data validates
with `sessionAttachmentRefusalSchema`:

```json
{"kind":"session-attachment-refused","reason":"image-input-unsupported"}
```

Invalid decoded images use `invalid-image`. Invalid parameter shapes receive the
normal invalid-params refusal. No image is silently omitted to make a send work.
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
