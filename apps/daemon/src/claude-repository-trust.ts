import {
  HOOK_EVENTS,
  type McpHttpServerConfig,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk"
import { toolInventoryEnvKeySchema, type ToolInventoryEntry } from "@getdomovoi/protocol"

import { inventoryFieldCaps, redactInventoryText } from "./inventory-redaction.js"
import type { RepositoryConfigDocuments } from "./repository-provider-config.js"

// What Claude Code loads from a trusted repository (slice P6b), and so what
// the inventory reports as loading: repository-trust-apply.ts marks entries
// with claudeEntryHeldBack below, from the same plan the adapter passes.
//
// Claude keeps settingSources ["user"] and never reads the repository. The
// adapter passes parts of the documents the trust verdict digested, as
// written: `settings` goes to the SDK's settings option, which is Claude's
// flag layer, and `mcpServers` are added once the session is open.
//
// Only what is named here passes. The flag layer trusts some keys more than
// project settings (sandbox, synced skills), and other keys widen what runs
// without a card (permissions.allow, defaultMode, additionalDirectories,
// sandbox.autoAllowBashIfSandboxed), so a key Domovoi does not name stays out:
//   hooks: every event but the ones below (rulings Q138 A and Q139 A).
//   env: every key but the risky ones below (Q141 A).
//   permissions.deny and permissions.ask: they only make Claude stricter.
// Plugins, helpers, the .mcp.json switches and everything else are held back
// (Q142 A). Domovoi never loads .claude/skills, commands or agents for Claude.

// A PermissionRequest hook answers an approval card (Q139 A). A PreToolUse
// hook can allow a call, or rewrite its input, before Domovoi asks; that
// Domovoi's own "ask" wins over it has not been measured against the installed
// SDK, so it stays out. An Elicitation or ElicitationResult hook answers a
// tool server's question put to the person.
export const claudeHeldBackHookEvents: ReadonlySet<string> = new Set([
  "PermissionRequest", "PreToolUse", "Elicitation", "ElicitationResult",
])
const loadableHookEvents: ReadonlySet<string> = new Set(HOOK_EVENTS.filter((event) => !claudeHeldBackHookEvents.has(event)))

// Keys that choose Claude's account, model endpoint or network path, or what
// the programs it starts load (Q141 A). Names match in any case.
const riskyEnvKeys = [/^ANTHROPIC_/iu, /^CLAUDE_/iu, /_BASE_URL$/iu, /^(?:HTTPS?|ALL|NO)_PROXY$/iu, /^NODE_OPTIONS$/iu, /^LD_/iu, /^DYLD_/iu, /^PATH$/iu]
export const claudeRiskyEnvKey = (key: string): boolean => riskyEnvKeys.some((pattern) => pattern.test(key))

export type ClaudeRepositorySettings = {
  hooks?: NonNullable<Settings["hooks"]>
  env?: Record<string, string>
  permissions?: { deny?: string[]; ask?: string[] }
}
export type ClaudeRepositoryServer = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig
export type ClaudeRepositoryLoad = {
  settings: ClaudeRepositorySettings
  mcpServers: Record<string, ClaudeRepositoryServer>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string")
const isStringRecord = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === "string")
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)

// A hook as the inventory reader lists it (claudeHook in
// repository-provider-config.ts), so every hook that loads is listed.
function loadableHook(hook: unknown): boolean {
  if (!isRecord(hook)) return false
  switch (hook.type) {
    case "command": return typeof hook.command === "string" && optional(hook.args, isStringArray)
    case "http": return typeof hook.url === "string"
    case "prompt":
    case "agent": return typeof hook.prompt === "string"
    case "mcp_tool": return typeof hook.server === "string" && typeof hook.tool === "string"
    default: return false
  }
}

const loadableGroup = (group: unknown) => isRecord(group) && optional(group.matcher, (matcher) => typeof matcher === "string")
  && Array.isArray(group.hooks) && group.hooks.every(loadableHook)

// An event passes whole or not at all, so a hook that loads is never listed
// beside one of the same event that does not.
function loadedHooks(hooks: unknown): ClaudeRepositorySettings["hooks"] {
  const loaded: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(isRecord(hooks) ? hooks : {})) {
    if (loadableHookEvents.has(event) && Array.isArray(groups) && groups.every(loadableGroup)) loaded[event] = groups
  }
  // Checked above as far as the inventory reads a hook; Claude checks the rest.
  return Object.keys(loaded).length > 0 ? loaded as NonNullable<Settings["hooks"]> : undefined
}

function loadedEnv(env: unknown): Record<string, string> | undefined {
  const loaded = Object.fromEntries(Object.entries(isRecord(env) ? env : {}).filter(([key, value]) => (
    typeof value === "string" && toolInventoryEnvKeySchema.safeParse(key).success && !claudeRiskyEnvKey(key)
  )))
  return Object.keys(loaded).length > 0 ? loaded as Record<string, string> : undefined
}

function loadedPermissions(permissions: unknown): ClaudeRepositorySettings["permissions"] {
  if (!isRecord(permissions)) return undefined
  const loaded: { deny?: string[]; ask?: string[] } = {}
  if (isStringArray(permissions.deny)) loaded.deny = permissions.deny
  if (isStringArray(permissions.ask)) loaded.ask = permissions.ask
  return Object.keys(loaded).length > 0 ? loaded : undefined
}

// A name the inventory shows as written, so an entry names the server that
// loads. Claude makes tool names from it (mcp__<server>__<tool>) and turns
// other characters into underscores, which could make two servers look alike.
const serverName = /^[A-Za-z0-9_-]{1,64}$/u
const listedAsWritten = (name: string) => serverName.test(name) && redactInventoryText(name, inventoryFieldCaps.name) === name

// The fields the SDK's own server types name, other than a remote server's
// tool policy, which would answer for the person. A server with any other
// field, a headers helper or OAuth settings included, is held back whole.
const stdioFields: ReadonlySet<string> = new Set(["type", "command", "args", "env", "timeout", "alwaysLoad"])
const remoteFields: ReadonlySet<string> = new Set(["type", "url", "headers", "timeout", "alwaysLoad"])

function loadableServer(server: unknown): server is ClaudeRepositoryServer {
  if (!isRecord(server)) return false
  const fields = Object.keys(server)
  const common = optional(server.timeout, (value) => typeof value === "number") && optional(server.alwaysLoad, (value) => typeof value === "boolean")
  if (server.type === undefined || server.type === "stdio") {
    return common && fields.every((field) => stdioFields.has(field)) && typeof server.command === "string"
      && optional(server.args, isStringArray) && optional(server.env, isStringRecord)
  }
  if (server.type !== "http" && server.type !== "sse") return false
  // Ruling Q151 A: Claude fills ${VAR} in from its environment, so an address
  // or header naming a variable could send the person's value away.
  const headers = server.headers === undefined ? {} : server.headers
  return common && fields.every((field) => remoteFields.has(field)) && typeof server.url === "string" && !server.url.includes("$")
    && isStringRecord(headers) && Object.entries(headers).every(([name, value]) => !name.includes("$") && !value.includes("$"))
}

function loadedServers(servers: unknown): Record<string, ClaudeRepositoryServer> {
  const loaded: Record<string, ClaudeRepositoryServer> = {}
  for (const [name, server] of Object.entries(isRecord(servers) ? servers : {})) {
    if (listedAsWritten(name) && loadableServer(server)) loaded[name] = server
  }
  return loaded
}

// The parts of a trusted repository's documents Claude loads. The values are
// the documents' own, so what reaches Claude is what the digest pinned.
export function claudeRepositoryLoad(documents: RepositoryConfigDocuments): ClaudeRepositoryLoad {
  const settings = documents[".claude/settings.json"] ?? {}
  const hooks = loadedHooks(settings.hooks)
  const env = loadedEnv(settings.env)
  const permissions = loadedPermissions(settings.permissions)
  return {
    settings: { ...(hooks ? { hooks } : {}), ...(env ? { env } : {}), ...(permissions ? { permissions } : {}) },
    mcpServers: loadedServers(documents[".mcp.json"]?.mcpServers),
  }
}

// Ruling Q150 A: Claude replaces a server with an added one of the same name,
// so a repository server named like one of the person's own is held back.
// Names are compared in any case, as a person reading a card would.
export function withoutOwnServers(
  servers: Readonly<Record<string, ClaudeRepositoryServer>>,
  own: Iterable<string>,
): Record<string, ClaudeRepositoryServer> {
  const taken = new Set([...own].map((name) => name.toLowerCase()))
  return Object.fromEntries(Object.entries(servers).filter(([name]) => !taken.has(name.toLowerCase())))
}

// The files whose entries this plan decides.
export const claudeRepositoryFiles: ReadonlySet<string> = new Set([".claude/settings.json", ".mcp.json"])

// Whether an inventory entry from one of those files is kept from Claude
// under this plan. A server held back because the person has one of the same
// name is known only once a session opens, and is reported as loading.
export function claudeEntryHeldBack(entry: ToolInventoryEntry, load: ClaudeRepositoryLoad): boolean {
  if (entry.file === ".mcp.json") return !(entry.kind === "tool-server" && Object.hasOwn(load.mcpServers, entry.name))
  switch (entry.kind) {
    case "hook": return !Object.hasOwn(load.settings.hooks ?? {}, entry.event)
    case "env-key": return !Object.hasOwn(load.settings.env ?? {}, entry.key)
    case "permission-rule": return !((entry.rule === "deny" || entry.rule === "ask") && load.settings.permissions?.[entry.rule] !== undefined)
    default: return true
  }
}
