import { z } from "zod"

import { inventoryText, toolInventoryPathSchema } from "./inventory-text.js"
import {
  refineRepositoryTrustPin, repositoryGitFilterDriverNameSchema, repositoryGitFilterScopeSchema, repositoryTrustStateSchema,
} from "./repository-trust.js"
import { skillContentDigestSchema, skillInventoryMachineSchema } from "./skills.js"
import { utf16MaxLength, wireRule } from "./validation.js"

export { toolInventoryPathSchema }

// What each agent's own configuration files on one machine declare: tool
// servers, hooks, permission rules, environment keys, helpers, plugins and
// skills. The daemon reads the files and reports; reading starts nothing, and
// Domovoi installs, enables and changes nothing here. Environment entries carry
// key names only: a value is never read, so no field can hold one, and every
// object is strict so a reader cannot attach one under another name.

// Every free-text field below is what a provider's own file says; see
// inventory-text.ts for the rule each one is held to.
const text = inventoryText

// The cap on each free-text field of an inventory entry, in UTF-16 code
// units. The daemon's reader fits every redacted text to its field's cap, so
// it reads the caps from here rather than keeping its own copy.
// A hook's, helper's or local tool server's command.
export const maximumToolInventoryCommandLength = 2_048
// A permission rule's detail.
export const maximumToolInventoryDetailLength = 1_024
// A hook's matcher.
export const maximumToolInventoryMatcherLength = 256
// A tool server's, plugin's or skill's name.
export const maximumToolInventoryNameLength = 256
// A helper's name.
export const maximumToolInventoryHelperNameLength = 128
// A permission rule's rule.
export const maximumToolInventoryRuleLength = 128
// A hook's event.
export const maximumToolInventoryEventLength = 64

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
  // One terminal root dot is an absolute name: example.com.
  const absolute = name!.endsWith(".") ? name!.slice(0, -1) : name!
  const labels = absolute.split(".")
  if (absolute.length > 253 || !labels.every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/u.test(label))) return false
  if (labels.every((label) => /^\d+$/u.test(label))) {
    return absolute === name && labels.length === 4 && labels.every((label) => Number(label) <= 255 && (label === "0" || !label.startsWith("0")))
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
    name: text(maximumToolInventoryNameLength),
    transport: toolServerTransportSchema,
    // A local server's command line; a remote one's host.
    command: text(maximumToolInventoryCommandLength).optional(),
    host: toolServerHostSchema.optional(),
    envKeys: z.array(toolInventoryEnvKeySchema).max(64),
  }).strict(),
  z.object({
    ...entryFields,
    kind: z.literal("hook"),
    event: text(maximumToolInventoryEventLength),
    matcher: text(maximumToolInventoryMatcherLength).optional(),
    command: text(maximumToolInventoryCommandLength),
  }).strict(),
  // A provider-side rule or setting: allow Bash(pnpm test:*), sandbox_mode workspace-write.
  z.object({ ...entryFields, kind: z.literal("permission-rule"), rule: text(maximumToolInventoryRuleLength), detail: text(maximumToolInventoryDetailLength) }).strict(),
  z.object({ ...entryFields, kind: z.literal("env-key"), key: toolInventoryEnvKeySchema }).strict(),
  // A command the provider runs for its own needs, such as apiKeyHelper.
  z.object({ ...entryFields, kind: z.literal("helper"), name: text(maximumToolInventoryHelperNameLength), command: text(maximumToolInventoryCommandLength) }).strict(),
  z.object({ ...entryFields, kind: z.literal("plugin"), name: text(maximumToolInventoryNameLength) }).strict(),
  z.object({ ...entryFields, kind: z.literal("skill"), name: text(maximumToolInventoryNameLength) }).strict(),
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

// The git filter drivers the repository's own Git config sets, grouped by the
// config file that sets each one: they are the repository's, whichever agent
// runs, and checking the repository out runs them, so they sit beside the
// providers rather than under one. A command is shown redacted, as every
// inventory command is. heldBack: the daemon refuses what would run it.
export const maximumToolInventoryGitFilters = 64
export const maximumToolInventoryGitFilterFiles = 32
// clean, smudge and process are a filter driver's commands. The lfs-* ones are
// the Git LFS settings that make git-lfs, once a filter runs it, start a
// program of the repository's choosing: a custom transfer agent's path and
// arguments, the agent it uses without asking the server, and an extension's
// clean or smudge command. The driver is the agent's or extension's name, or
// for lfs-standalone-agent the name it selects.
export const repositoryGitFilterOperations = [
  "clean", "smudge", "process",
  "lfs-transfer-path", "lfs-transfer-args", "lfs-standalone-agent", "lfs-extension-clean", "lfs-extension-smudge",
] as const

export const toolInventoryGitFilterEntrySchema = z.object({
  driver: repositoryGitFilterDriverNameSchema,
  operation: z.enum(repositoryGitFilterOperations),
  command: text(maximumToolInventoryCommandLength),
  file: toolInventoryPathSchema,
  heldBack: z.boolean(),
}).strict()

// Why the daemon could not read the repository's Git config (a reason code a
// client words): too-large, its filter settings passed the daemon's output
// cap; git-failed, `git config` failed for any other reason than the folder
// not being a Git repository. The digest then records the failure, so a grant
// made over a readable config no longer covers it.
export const repositoryGitConfigUnreadableReasons = ["too-large", "git-failed"] as const

export const toolInventoryGitFiltersSchema = z.object({
  files: z.array(z.object({ path: toolInventoryPathSchema, scope: repositoryGitFilterScopeSchema }).strict())
    .max(maximumToolInventoryGitFilterFiles),
  entries: z.array(toolInventoryGitFilterEntrySchema).max(maximumToolInventoryGitFilters),
  // Entries the daemon left out: past the cap, set somewhere other than a
  // file, or whose redacted text the protocol still refuses.
  omittedEntries: z.number().int().nonnegative().max(1_000_000),
  // Present when the config could not be read: nothing is listed or counted.
  unreadable: z.object({ reason: z.enum(repositoryGitConfigUnreadableReasons) }).strict().optional(),
}).strict().superRefine((filters, context) => {
  if (filters.unreadable && (filters.files.length > 0 || filters.entries.length > 0 || filters.omittedEntries > 0)) {
    context.addIssue({ code: "custom", path: ["unreadable"], message: "Unreadable config lists nothing" })
  }
  const files = new Set<string>()
  for (const [index, file] of filters.files.entries()) {
    if (files.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "A file is listed once" })
    files.add(file.path)
  }
  for (const [index, entry] of filters.entries.entries()) {
    if (!files.has(entry.file)) context.addIssue({ code: "custom", path: ["entries", index, "file"], message: "Entries come only from a listed file" })
  }
})

// The daemon closes a connection whose buffered output reaches 1 MiB, and other
// traffic shares that buffer, so a whole response, envelope included, stays at
// its 256 KiB low-water mark. The envelope around the largest request id (512
// code units, each escaped to at most six bytes) is under 4 KiB. A reader that
// would exceed the budget lists fewer entries and counts the rest in
// omittedEntries.
export const toolInventoryEnvelopeReserveBytes = 4 * 1_024
export const maximumToolInventoryBytes = 256 * 1_024 - toolInventoryEnvelopeReserveBytes

export const toolInventorySchema = wireRule(z.object({
  machine: skillInventoryMachineSchema,
  // The open repository. configDigest covers its provider configuration files,
  // present or absent, so a trust decision pins to what the client was shown;
  // trust is this machine's trust in it against that digest.
  repository: z.object({
    projectId: text(256),
    root: toolInventoryPathSchema,
    configDigest: skillContentDigestSchema,
    trust: repositoryTrustStateSchema,
    // Present when the repository's own Git config sets a filter driver.
    gitFilters: toolInventoryGitFiltersSchema.optional(),
  }).strict().superRefine((repository, context) => {
    refineRepositoryTrustPin(repository.configDigest, repository.trust, context, ["trust"])
  }).optional(),
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

// The approval card's fact for a call to a tool server's tool: the server and,
// when the daemon knows them, how it connects and the file that declared it. A
// server the agent loaded from its own configuration is named as the agent
// names it, with no transport, source or file: the daemon did not read where it
// came from, and an absent file means exactly that, never "declared nowhere".
export const approvalToolServerSchema = z.object({
  name: text(256),
  transport: toolServerTransportSchema.optional(),
  source: toolInventorySourceSchema.optional(),
  file: toolInventoryPathSchema.optional(),
}).strict().refine(
  (server) => (server.source === undefined) === (server.file === undefined),
  { path: ["file"], message: "A declaring file is named with its source" },
)

export type ToolInventory = z.infer<typeof toolInventorySchema>
export type ToolInventoryProvider = z.infer<typeof toolInventoryProviderSchema>
export type ToolInventoryEntry = z.infer<typeof toolInventoryEntrySchema>
export type ToolInventoryFile = z.infer<typeof toolInventoryFileSchema>
export type ToolInventorySource = z.infer<typeof toolInventorySourceSchema>
export type ApprovalToolServer = z.infer<typeof approvalToolServerSchema>
export type ToolInventoryGitFilters = z.infer<typeof toolInventoryGitFiltersSchema>
export type ToolInventoryGitFilterEntry = z.infer<typeof toolInventoryGitFilterEntrySchema>
