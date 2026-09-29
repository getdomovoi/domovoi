import { z } from "zod"

import { holdsCredential } from "./credential-backstop.js"
import { utf16MaxLength } from "./validation.js"

// Text the daemon read from a repository's or a provider's own files, shared by
// tool-inventory.ts and repository-trust.ts. It lives apart from both because
// tool-inventory.ts imports repository-trust.ts.
//
// Every such text is what a provider's own file says, and a file can hold a
// credential anywhere: in a command's arguments, a rule, even a name. The
// daemon's reader (slice P2a) must redact every field before it emits it;
// credential-backstop.ts states what that covers and refuses text that still
// carries a value.
// One line of plain text, checked as sent and never normalized: no control or
// format characters and no line or paragraph separators, so a row cannot be
// split or reordered on a card, and no padding.
export const inventoryText = (maximum: number) => z.string().min(1).check(utf16MaxLength(maximum))
  .regex(/^(?!\s)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*(?<!\s)$/u)
  // An overlength text is already refused by its cap; the backstop does not read it.
  .refine((value) => value.length > maximum || !holdsCredential(value), "Text must not carry a credential; the reader redacts it first")

export const toolInventoryPathSchema = inventoryText(1_024)
