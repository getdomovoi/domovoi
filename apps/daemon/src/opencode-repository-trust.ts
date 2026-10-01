import { toolInventoryEnvKeySchema, type ToolInventoryEntry } from "@getdomovoi/protocol"

import { codexRiskyEnvKey } from "./codex-repository-trust.js"
import { inventoryFieldCaps, redactInventoryText } from "./inventory-redaction.js"
import { repositoryProviderScopes, type RepositoryConfigDocuments } from "./repository-provider-config.js"

// What OpenCode and Kilo are given from a trusted repository (slice P7), and
// so what the inventory reports as loading: repository-trust-apply.ts marks
// entries with openCodeEntryHeldBack below, from the same plan the adapter
// passes.
//
// Both servers keep their project switch set, so they read nothing from the
// repository themselves. Under a trusted verdict the adapter adds `mcp`
// entries of the config files the verdict digested, as written, to the
// session directory's instance with mcp.add (opencode v1.18.32
// mcp/index.ts add, kilo v7.8.1 the same): a server added there starts at
// once and serves only that directory. Nothing else in the files passes:
// plugins, permissions, agents, modes, commands, formatters, language
// servers, instructions, providers and models stay held back (rulings Q139 A
// and Q142 A). Kilo's legacy .kilo/mcp.json, .kilocode/mcp.json and
// .kilocodemodes keep refusing the session, trusted or not (Q230 A): Kilo
// reads them itself, whole.

export type OpenCodeProvider = "opencode" | "kilo"

// The config files each server reads, in the reader's order.
export const openCodeRepositoryFiles: Readonly<Record<OpenCodeProvider, ReadonlySet<string>>> = {
  opencode: configFilesOf("opencode"),
  kilo: configFilesOf("kilo"),
}

function configFilesOf(provider: OpenCodeProvider): ReadonlySet<string> {
  const scope = repositoryProviderScopes.find((candidate) => candidate.provider === provider)
  return new Set((scope?.files ?? []).filter((file) => file.parser === "opencode-config").map((file) => file.path))
}

export type OpenCodeRepositoryServer =
  | { type: "local"; command: string[]; environment: Record<string, string>; enabled?: true; timeout?: number }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled?: true; timeout?: number; oauth: false }

export type OpenCodeRepositoryLoad = {
  mcpServers: Record<string, OpenCodeRepositoryServer>
  // Per passed server, the env keys left out as risky, as written.
  filteredEnvKeys: Record<string, string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
const isStringRecord = (value: unknown): value is Record<string, string> => (
  isRecord(value) && Object.values(value).every((item) => typeof item === "string")
)

// Ruling Q151 A: OpenCode fills in {env:NAME} and {file:path} when it reads a
// config file, and mcp.add takes values as written, so a server naming one is
// held back rather than passed changed. A remote address or header with `$`
// is held back as for Claude and Codex.
const namesInput = (text: string) => text.includes("{env:") || text.includes("{file:")
const namesVariable = (text: string) => text.includes("$") || namesInput(text)

// Keys that choose an agent's account, model endpoint or network path, or what
// the programs a server starts load (ruling Q141 A, Codex's list), and every
// OpenCode and Kilo setting.
const riskyEnvKey = (key: string) => codexRiskyEnvKey(key) || /^(?:OPENCODE|KILO)_/iu.test(key)

// OpenCode passes its own environment, the embedded server's password
// included, to every local server it starts, then the server's own; Kilo
// removes it. The password names are set empty in every passed server's
// environment, so a repository's server cannot answer the session's approvals.
const blankPassword = (provider: OpenCodeProvider) => {
  const prefix = provider === "kilo" ? "KILO" : "OPENCODE"
  return { [`${prefix}_SERVER_PASSWORD`]: "", [`${prefix}_SERVER_USERNAME`]: "" }
}

const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0
const localKeys: ReadonlySet<string> = new Set(["type", "command", "environment", "enabled", "timeout"])
const remoteKeys: ReadonlySet<string> = new Set(["type", "url", "headers", "enabled", "timeout", "oauth"])

// A server as written, or undefined when it is held back whole. A disabled
// server loads nothing, so it is held back rather than passed, as for Codex.
// A working directory is held back: Kilo's add takes none.
function loadableServer(provider: OpenCodeProvider, server: unknown): { server: OpenCodeRepositoryServer; filtered: string[] } | undefined {
  if (!isRecord(server)) return undefined
  const common = (server.enabled === undefined || server.enabled === true) && (server.timeout === undefined || positiveInteger(server.timeout))
  const shared = { ...(server.enabled === true ? { enabled: true as const } : {}), ...(server.timeout === undefined ? {} : { timeout: server.timeout as number }) }
  if (server.type === "local") {
    const command = server.command
    const environment = server.environment ?? {}
    if (!common || !Object.keys(server).every((key) => localKeys.has(key))) return undefined
    if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === "string" && !namesInput(item))) return undefined
    if (!isStringRecord(environment) || Object.values(environment).some(namesInput)) return undefined
    const filtered = Object.keys(environment).filter((key) => riskyEnvKey(key) || !toolInventoryEnvKeySchema.safeParse(key).success)
    const kept = Object.fromEntries(Object.entries(environment).filter(([key]) => !filtered.includes(key)))
    return { server: { type: "local", command: command as string[], environment: { ...kept, ...blankPassword(provider) }, ...shared }, filtered }
  }
  if (server.type === "remote") {
    const headers = server.headers
    if (!common || !Object.keys(server).every((key) => remoteKeys.has(key))) return undefined
    if (typeof server.url !== "string" || namesVariable(server.url)) return undefined
    if (headers !== undefined && (!isStringRecord(headers) || Object.entries(headers).some(([name, value]) => namesVariable(name) || namesVariable(value)))) return undefined
    // OAuth is always off, so a server never gets the person's stored tokens,
    // which OpenCode keeps by server name (mcp/index.ts).
    return { server: { type: "remote", url: server.url, ...(headers === undefined ? {} : { headers }), ...shared, oauth: false }, filtered: [] }
  }
  return undefined
}

// A name the inventory and a card show as written.
const serverName = /^[A-Za-z0-9_-]{1,64}$/u
const loadableName = (name: string) => serverName.test(name) && redactInventoryText(name, inventoryFieldCaps.name) === name

// The servers of a trusted repository's documents a provider is given. A name
// declared in more than one of its files is held back (ruling Q231 A), so
// what passes never depends on the order the server merges files in. The
// values are the documents' own, so what reaches the server is what the
// digest pinned.
export function openCodeRepositoryLoad(provider: OpenCodeProvider, documents: RepositoryConfigDocuments): OpenCodeRepositoryLoad {
  const declared = new Map<string, unknown[]>()
  for (const file of openCodeRepositoryFiles[provider]) {
    const mcp = documents[file]?.mcp
    for (const [name, server] of Object.entries(isRecord(mcp) ? mcp : {})) declared.set(name, [...declared.get(name) ?? [], server])
  }
  const mcpServers: Record<string, OpenCodeRepositoryServer> = {}
  const filteredEnvKeys: Record<string, string[]> = {}
  for (const [name, servers] of declared) {
    const loaded = servers.length === 1 && loadableName(name) ? loadableServer(provider, servers[0]) : undefined
    if (loaded === undefined) continue
    mcpServers[name] = loaded.server
    if (loaded.filtered.length > 0) filteredEnvKeys[name] = loaded.filtered
  }
  return { mcpServers, filteredEnvKeys }
}

// A server's name as its tool keys start (opencode mcp/catalog.ts).
export const openCodeToolPrefixName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/gu, "_")

// Ruling Q150 A: mcp.add replaces a server of the same name, and a tool's key
// joins server and tool with one `_`. A repository server is held back when
// its key prefix, in any case, is one of the person's servers' or begins or
// extends one up to a `_`: their tools could not be told apart.
export function withoutOwnOpenCodeServers<Server>(
  servers: Readonly<Record<string, Server>>,
  own: Iterable<string>,
): Record<string, Server> {
  const taken = [...own].map((name) => openCodeToolPrefixName(name).toLowerCase())
  return Object.fromEntries(Object.entries(servers).filter(([name]) => {
    const prefix = openCodeToolPrefixName(name).toLowerCase()
    return !taken.some((ownName) => ownName === prefix || ownName.startsWith(`${prefix}_`) || prefix.startsWith(`${ownName}_`))
  }))
}

// Whether an inventory entry from one of a provider's config files is kept
// from it under this plan: every entry but a server that passes. A server held
// back because the person has one of the same name is known only once a
// session opens, and is reported as loading.
export function openCodeEntryHeldBack(entry: ToolInventoryEntry, load: OpenCodeRepositoryLoad): boolean {
  return !(entry.kind === "tool-server" && Object.hasOwn(load.mcpServers, entry.name))
}
