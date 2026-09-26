import { z } from "zod"

import { skillContentDigestSchema, skillInventoryMachineSchema } from "./skills.js"
import { utf16MaxLength, wireRule } from "./validation.js"

// What each agent's own configuration files on one machine declare: tool
// servers, hooks, permission rules, environment keys, helpers, plugins and
// skills. The daemon reads the files and reports; reading starts nothing, and
// Domovoi installs, enables and changes nothing here. Environment entries carry
// key names only: a value is never read, so no field can hold one, and every
// object is strict so a reader cannot attach one under another name.

// Every free-text field below is what a provider's own file says, and a file
// can hold a credential anywhere: in a command's arguments, a rule, even a
// name. The daemon's reader (slice P2a) must pass every field through its
// durable redaction before emitting it, which writes [REDACTED] in place of a
// value. This check is only the backstop behind that: it refuses an assignment
// or a known credential shape that still carries a value, so a reader that
// forgets to redact fails loudly instead of leaking.
const redactedValue = String.raw`\[REDACTED\]`
const sensitiveName = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|secret[_-]?key|secret|client[_-]?secret|credentials?|cookie|private[_-]?key)`
const credentialShapes: readonly RegExp[] = [
  // A shell assignment, NAME=value.
  new RegExp(String.raw`(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=(?!${redactedValue})\S`, "u"),
  // A sensitive name with its value: token=x, --token=x, password: x.
  new RegExp(String.raw`(?<![A-Za-z0-9])${sensitiveName}\s*[=:]\s*(?!${redactedValue})\S`, "iu"),
  // A sensitive flag and its value as the next word: --api-key x.
  new RegExp(String.raw`(?:^|[^A-Za-z0-9])-{1,2}${sensitiveName}\s+(?!${redactedValue})[^\s-]`, "iu"),
  new RegExp(String.raw`\bBearer\s+(?!${redactedValue})\S`, "iu"),
  // The token shapes the daemon's redaction knows.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/u,
  /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  new RegExp(String.raw`:\/\/[^\s/@:]+:(?!${redactedValue}@)[^\s/@]*@`, "u"),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
]
const holdsNoCredential = (value: string) => !credentialShapes.some((shape) => shape.test(value))

// One line of plain text, checked as sent and never normalized: no control or
// format characters and no line or paragraph separators, so a row cannot be
// split or reordered on a card, and no padding.
const text = (maximum: number) => z.string().min(1).check(utf16MaxLength(maximum))
  .regex(/^(?!\s)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*(?<!\s)$/u)
  .refine(holdsNoCredential, "Text must not carry a credential; the reader redacts it first")

export const toolInventoryPathSchema = text(1_024)
// An environment variable identifier, never `NAME=value`.
export const toolInventoryEnvKeySchema = z.string().check(utf16MaxLength(128)).regex(/^[A-Za-z_][A-Za-z0-9_]*$/)

function isHost(value: string): boolean {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::([1-9]\d{0,4}))?$/u.exec(value)
  if (!match) return false
  const [, ipv6, name, port] = match
  if (port !== undefined && Number(port) > 65_535) return false
  if (ipv6 !== undefined) {
    try {
      new URL(`http://[${ipv6}]/`)
      return true
    } catch {
      return false
    }
  }
  const labels = name!.split(".")
  if (name!.length > 253 || !labels.every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/u.test(label))) return false
  if (labels.every((label) => /^\d+$/u.test(label))) {
    return labels.length === 4 && labels.every((label) => Number(label) <= 255 && (label === "0" || !label.startsWith("0")))
  }
  return !/^\d+$/u.test(labels.at(-1)!)
}
// Host and optional port only: a DNS name, IPv4 or bracketed IPv6 address, and
// a port from 1 to 65535. A URL's path, query and user info can carry a token,
// so a remote server is named by where it connects and nothing more.
export const toolServerHostSchema = z.string().check(utf16MaxLength(260)).refine(isHost, "Expected a host and an optional port")
// "other" is a transport the file declares and Domovoi does not recognise; the
// server is still listed rather than dropped.
export const toolServerTransportSchema = z.enum(["stdio", "http", "sse", "other"])

// Where a file sits. repository-file and project-settings come with the
// repository (.mcp.json, .claude/settings.json, .codex/config.toml); local
// settings are the person's own, untracked, beside it; user settings live in
// their home directory. Repository paths are relative to its root.
export const toolInventorySourceSchema = z.enum(["repository-file", "project-settings", "local-settings", "user-settings"])
const repositorySources: ReadonlySet<ToolInventorySource> = new Set(["repository-file", "project-settings"])

const fileFields = { path: toolInventoryPathSchema, source: toolInventorySourceSchema }
// An unreadable file is named with its reason, and its entries are not listed:
// Domovoi does not guess what the file holds.
export const toolInventoryFileSchema = z.discriminatedUnion("state", [
  z.object({ ...fileFields, state: z.enum(["read", "empty", "absent"]) }).strict(),
  z.object({ ...fileFields, state: z.literal("unreadable"), reason: text(256) }).strict(),
])

const entryFields = {
  // The path of the file that declared it, as listed in the provider's files.
  file: toolInventoryPathSchema,
  // Runs or connects when a session starts, before the agent does anything.
  startsAtSessionStart: z.boolean(),
  // A repository-brought entry the daemon keeps from the agent until the
  // repository is trusted. Only repository sources can be held back.
  heldBack: z.boolean(),
}

export const toolInventoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...entryFields,
    kind: z.literal("tool-server"),
    name: text(256),
    transport: toolServerTransportSchema,
    // A local server's command line; a remote one's host.
    command: text(2_048).optional(),
    host: toolServerHostSchema.optional(),
    envKeys: z.array(toolInventoryEnvKeySchema).max(64),
  }).strict(),
  z.object({ ...entryFields, kind: z.literal("hook"), event: text(64), matcher: text(256).optional(), command: text(2_048) }).strict(),
  // A provider-side rule or setting: allow Bash(pnpm test:*), sandbox_mode workspace-write.
  z.object({ ...entryFields, kind: z.literal("permission-rule"), rule: text(128), detail: text(1_024) }).strict(),
  z.object({ ...entryFields, kind: z.literal("env-key"), key: toolInventoryEnvKeySchema }).strict(),
  // A command the provider runs for its own needs, such as apiKeyHelper.
  z.object({ ...entryFields, kind: z.literal("helper"), name: text(128), command: text(2_048) }).strict(),
  z.object({ ...entryFields, kind: z.literal("plugin"), name: text(256) }).strict(),
  z.object({ ...entryFields, kind: z.literal("skill"), name: text(256) }).strict(),
])

export const toolInventoryProviderSchema = z.object({
  provider: text(64),
  // none-passed: Domovoi starts this agent with no tool servers, whatever its
  // files say, so the inventory says none passed rather than none found.
  toolServers: z.enum(["read-from-files", "none-passed"]),
  // Entries the daemon left out to keep the response within its caps, so a
  // client never presents a cut list as the whole of it.
  omittedEntries: z.number().int().nonnegative().max(1_000_000),
  files: z.array(toolInventoryFileSchema).max(32),
  entries: z.array(toolInventoryEntrySchema).max(512),
}).strict().superRefine((provider, context) => {
  const files = new Map<string, ToolInventoryFile>()
  for (const [index, file] of provider.files.entries()) {
    if (files.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "A file is listed once" })
    files.set(file.path, file)
  }
  for (const [index, entry] of provider.entries.entries()) {
    const file = files.get(entry.file)
    if (file?.state !== "read") context.addIssue({ code: "custom", path: ["entries", index, "file"], message: "Entries come only from a file that was read" })
    else if (entry.heldBack && !repositorySources.has(file.source)) context.addIssue({ code: "custom", path: ["entries", index, "heldBack"], message: "Only a repository entry is held back" })
    if (entry.kind !== "tool-server") continue
    if (provider.toolServers === "none-passed") context.addIssue({ code: "custom", path: ["entries", index], message: "A provider that passes no tool servers lists none" })
    const local = entry.transport === "stdio"
    const remote = entry.transport === "http" || entry.transport === "sse"
    if ((local && (entry.command === undefined || entry.host !== undefined)) || (remote && (entry.host === undefined || entry.command !== undefined))) {
      context.addIssue({ code: "custom", path: ["entries", index, "transport"], message: "A local server names its command and a remote one its host" })
    }
  }
})

// The daemon closes a connection whose buffered output reaches 1 MiB, and other
// traffic shares that buffer, so a whole response stays at its 256 KiB
// low-water mark. A reader that would exceed it lists fewer entries and counts
// the rest in omittedEntries.
export const maximumToolInventoryBytes = 256 * 1_024

export const toolInventorySchema = wireRule(z.object({
  machine: skillInventoryMachineSchema,
  // The open repository. configDigest covers its provider configuration files,
  // present or absent, so a trust decision pins to what the client was shown.
  repository: z.object({
    projectId: text(256),
    root: toolInventoryPathSchema,
    configDigest: skillContentDigestSchema,
  }).strict().optional(),
  providers: z.array(toolInventoryProviderSchema).max(16),
}).strict().superRefine((inventory, context) => {
  const seen = new Set<string>()
  for (const [index, provider] of inventory.providers.entries()) {
    if (seen.has(provider.provider)) context.addIssue({ code: "custom", path: ["providers", index, "provider"], message: "A provider is listed once" })
    seen.add(provider.provider)
    if (!inventory.repository && provider.files.some((file) => repositorySources.has(file.source))) {
      context.addIssue({ code: "custom", path: ["repository"], message: "Repository files need the repository and its config digest" })
    }
  }
}).refine(
  (inventory) => new TextEncoder().encode(JSON.stringify(inventory)).byteLength <= maximumToolInventoryBytes,
  "The inventory must fit its byte budget",
), { rule: "tool-inventory-serialized-utf8-bytes", maximumBytes: maximumToolInventoryBytes })

// The approval card's fact for a call to a tool server's tool: the server and
// the file that declared it.
export const approvalToolServerSchema = z.object({
  name: text(256),
  transport: toolServerTransportSchema,
  source: toolInventorySourceSchema,
  file: toolInventoryPathSchema,
}).strict()

export type ToolInventory = z.infer<typeof toolInventorySchema>
export type ToolInventoryProvider = z.infer<typeof toolInventoryProviderSchema>
export type ToolInventoryEntry = z.infer<typeof toolInventoryEntrySchema>
export type ToolInventoryFile = z.infer<typeof toolInventoryFileSchema>
export type ToolInventorySource = z.infer<typeof toolInventorySourceSchema>
export type ApprovalToolServer = z.infer<typeof approvalToolServerSchema>
