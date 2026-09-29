import { lstatSync, realpathSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join, resolve } from "node:path"

import { toolInventoryEnvKeySchema, type ToolInventoryEntry } from "@getdomovoi/protocol"

import { inventoryFieldCaps, redactInventoryText } from "./inventory-redaction.js"
import type { RepositoryConfigDocuments } from "./repository-provider-config.js"

// What Codex is given from a trusted repository (slice P6c), and so what the
// inventory reports as loading: repository-trust-apply.ts marks entries with
// codexEntryHeldBack below, from the same plan the adapter passes.
//
// Codex keeps every path it consults for trust marked untrusted, so it loads
// nothing from the repository itself: no config.toml, hooks.json or rules.
// Under a trusted verdict the adapter passes `mcp_servers` entries from the
// config.toml the verdict digested, as written, in the thread config of
// thread/start and thread/resume. Nothing else in the file passes: approval
// and sandbox settings, permission profiles, network and shell environment
// settings, profiles, model providers and base addresses, experimental keys,
// hooks and plugins stay held back, and .codex/rules are never read.
//
// Measured against codex-cli 0.157.1 and codex-rs at rust-v0.157.1
// (core/src/mcp_tool_call.rs, codex-mcp/src/mcp/mod.rs and server.rs,
// core/src/tools/approvals.rs, features/src/lib.rs): a tool of a configured
// server runs without asking when its approval mode is "approve", or is
// "auto" (the default) or "writes" and the server marks the tool read-only
// (readOnlyHint) or neither destructive nor open-world. Those are the
// server's own answers, so every passed server is forced to "prompt", which
// asks for every tool, and its per-tool modes are dropped. The question then
// goes to a PermissionRequest hook, the automatic reviewer when
// approvals_reviewer is "auto_review", or the person; the thread config sets
// the reviewer to the person and turns on tool_call_mcp_elicitation, so the
// question reaches Domovoi as the MCP elicitation codex.ts turns into a card.
// Under approval policy "never" (Plan, and Build with Auto) Codex refuses the
// call instead, since neither Domovoi profile writes the whole disk.

// A server's keys that pass as written. Every other key is left out, or holds
// the whole server back (heldBackKeys).
type KeyCheck = (value: unknown) => boolean
const isString: KeyCheck = (value) => typeof value === "string"
const isStringArray: KeyCheck = (value) => Array.isArray(value) && value.every((item) => typeof item === "string")
const isStringRecord = (value: unknown): value is Record<string, string> => (
  isRecord(value) && Object.values(value).every((item) => typeof item === "string")
)
const isDuration: KeyCheck = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const isMilliseconds: KeyCheck = (value) => Number.isSafeInteger(value) && (value as number) >= 0
// Ruling Q151 A: nothing that names a variable goes into a request.
const noVariable = (text: string) => !text.includes("$")

const localKeys: Readonly<Record<string, KeyCheck>> = { command: isString, args: isStringArray, env: isStringRecord, cwd: isString }
const remoteKeys: Readonly<Record<string, KeyCheck>> = {
  url: (value) => typeof value === "string" && noVariable(value),
  http_headers: (value) => isStringRecord(value) && Object.entries(value).every(([name, text]) => noVariable(name) && noVariable(text)),
}
const sharedKeys: Readonly<Record<string, KeyCheck>> = {
  // A disabled server loads nothing, so it is held back rather than passed.
  enabled: (value) => value === true,
  startup_timeout_sec: isDuration,
  startup_timeout_ms: isMilliseconds,
  tool_timeout_sec: isDuration,
  enabled_tools: isStringArray,
  disabled_tools: isStringArray,
}

// Keys that put a value from the person's environment, or a program's
// output, into the server's requests (ruling Q151 A): the server is held
// back. Keys left out instead, the server still passing: approval modes
// (forced above), env_vars (copies the person's variables into the server),
// auth, oauth, scopes and oauth_resource (the person's stored or ChatGPT
// credentials), bearer_token, environment_id, required, omit_tools_from and
// supports_parallel_tool_calls (left at Codex's default, off, so one call of
// a server runs at a time and a card names that call).
const heldBackKeys = ["bearer_token_env_var", "env_http_headers", "http_headers_helper"] as const

// Names Codex treats as its own: it calls "notes" each turn without asking
// when its token budget feature is on, "codex_apps" is its apps server, and
// node_repl and cua_repl get extra request data (rust-v0.157.1).
export const codexReservedServerNames: ReadonlySet<string> = new Set(["codex_apps", "codex_app", "notes", "node_repl", "cua_repl"])

// A name the inventory and a card show as written, and that Codex reads as
// one key of a dotted path.
const serverName = /^[A-Za-z0-9_-]{1,64}$/u
const loadableName = (name: string) => serverName.test(name) && redactInventoryText(name, inventoryFieldCaps.name) === name
  && !codexReservedServerNames.has(name.toLowerCase())

// Keys that choose Codex's or another agent's account, model endpoint or
// network path, or what the programs a server starts load (ruling Q141 A).
// Names match in any case.
const riskyEnvKeys = [
  /^ANTHROPIC_/iu, /^CLAUDE_/iu, /^OPENAI_/iu, /^CODEX_/iu, /_BASE_URL$/iu, /PROXY/iu,
  /^NODE_OPTIONS$/iu, /^LD_/iu, /^DYLD_/iu, /^PATH$/iu,
]
export const codexRiskyEnvKey = (key: string): boolean => riskyEnvKeys.some((pattern) => pattern.test(key))

export type CodexRepositoryServer = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  http_headers?: Record<string, string>
  enabled?: true
  startup_timeout_sec?: number
  startup_timeout_ms?: number
  tool_timeout_sec?: number
  enabled_tools?: string[]
  disabled_tools?: string[]
}

export type CodexRepositoryLoad = {
  mcpServers: Record<string, CodexRepositoryServer>
  // Per passed server, the env keys left out as risky, as written.
  filteredEnvKeys: Record<string, string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function loadableServer(server: unknown): { server: CodexRepositoryServer; filtered: string[] } | undefined {
  if (!isRecord(server) || heldBackKeys.some((key) => Object.hasOwn(server, key))) return undefined
  const local = Object.hasOwn(server, "command")
  if (local === Object.hasOwn(server, "url")) return undefined
  const allowed = { ...(local ? localKeys : remoteKeys), ...sharedKeys }
  const other = local ? remoteKeys : localKeys
  const passed: Record<string, unknown> = {}
  let filtered: string[] = []
  for (const [key, value] of Object.entries(server)) {
    if (Object.hasOwn(other, key)) return undefined
    if (!Object.hasOwn(allowed, key)) continue
    if (!allowed[key]!(value)) return undefined
    if (key !== "env") {
      passed[key] = value
      continue
    }
    const env = Object.entries(value as Record<string, string>)
    filtered = env.filter(([name]) => codexRiskyEnvKey(name) || !toolInventoryEnvKeySchema.safeParse(name).success).map(([name]) => name)
    const kept = env.filter(([name]) => !filtered.includes(name))
    if (kept.length > 0) passed.env = Object.fromEntries(kept)
  }
  return { server: passed as CodexRepositoryServer, filtered }
}

// The servers of a trusted repository's documents Codex is given. The values
// are the documents' own, so what reaches Codex is what the digest pinned.
export function codexRepositoryLoad(documents: RepositoryConfigDocuments): CodexRepositoryLoad {
  const servers = documents[".codex/config.toml"]?.mcp_servers
  const mcpServers: Record<string, CodexRepositoryServer> = {}
  const filteredEnvKeys: Record<string, string[]> = {}
  for (const [name, server] of Object.entries(isRecord(servers) ? servers : {})) {
    const loaded = loadableName(name) ? loadableServer(server) : undefined
    if (loaded === undefined) continue
    mcpServers[name] = loaded.server
    if (loaded.filtered.length > 0) filteredEnvKeys[name] = loaded.filtered
  }
  return { mcpServers, filteredEnvKeys }
}

// The thread config keys that carry passed servers: each server made to ask
// before every tool, the question put to the person as an MCP elicitation.
export function codexTrustedThreadConfig(servers: Readonly<Record<string, CodexRepositoryServer>>): {
  mcp_servers: Record<string, CodexRepositoryServer & { default_tools_approval_mode: "prompt" }>
  approvals_reviewer: "user"
  features: { tool_call_mcp_elicitation: true }
} {
  return {
    mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, { ...server, default_tools_approval_mode: "prompt" as const }])),
    approvals_reviewer: "user",
    features: { tool_call_mcp_elicitation: true },
  }
}

// The names of the servers the person's own configuration declares, from a
// config/read answer with its layers: every layer but a project's. Undefined
// when the answer has no layers to read, and then no server passes.
export function codexOwnServerNames(configRead: unknown): string[] | undefined {
  const layers = isRecord(configRead) ? configRead.layers : undefined
  if (!Array.isArray(layers)) return undefined
  const names: string[] = []
  for (const layer of layers as unknown[]) {
    const source = isRecord(layer) && isRecord(layer.name) ? layer.name.type : undefined
    if (typeof source !== "string") return undefined
    if (source === "project") continue
    const servers = isRecord(layer) && isRecord(layer.config) ? layer.config.mcp_servers : undefined
    names.push(...Object.keys(isRecord(servers) ? servers : {}))
  }
  return names
}

// A page of mcpServerStatus/list, the one app-server method that names every
// server of Codex's effective catalog, plugin servers included (pluginId; the
// catalog is McpManager::runtime_config at rust-v0.157.1). Config servers
// win over plugin servers of the same name there (codex-mcp catalog.rs), so a
// repository server named like a plugin's would stand in for it. Undefined
// when the page cannot be read, and then no server passes.
export function codexCatalogPage(page: unknown): { names: string[]; nextCursor?: string } | undefined {
  if (!isRecord(page) || !Array.isArray(page.data)) return undefined
  const names: string[] = []
  for (const server of page.data as unknown[]) {
    if (!isRecord(server) || typeof server.name !== "string") return undefined
    names.push(server.name)
  }
  const cursor = page.nextCursor
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return undefined
  return typeof cursor === "string" ? { names, nextCursor: cursor } : { names }
}

// Whether a new Codex thread gets the local environment alone, and so no
// plugin servers beyond the catalog mcpServerStatus/list names. A thread takes
// every registered environment by default (default_environment_ids,
// exec-server environment.rs, and thread_processor.rs at rust-v0.157.1), and
// an environment can bring plugins through the capability roots it reports
// ready (Environment::selected_capability_roots). The threadless catalog has
// no thread, so it lists none of them. Environments other than the local one
// come only from CODEX_HOME/environments.toml or CODEX_EXEC_SERVER_*
// variables (from_codex_home, environment_toml.rs, environment_provider.rs);
// the local environment reports no roots (Environment::local). Anything else,
// or a Codex home this cannot read, counts as an environment that may bring
// plugins: the answer is false, and no repository server passes.
//
// Codex builds its environments once, as the app-server starts (app-server
// lib.rs), so the launch judged is the one the app-server is started with:
// its variables, the directory it starts in, and, with CODEX_HOME unset, the
// homes Codex may take (codexHomeCandidates). StdioCodexTransport judges it
// before the start and again once the app-server has initialized, and keeps
// a false answer for the app-server's life.
export type CodexLaunch = {
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  homeCandidates: readonly string[]
}

const set = (value: string | undefined): value is string => value !== undefined && value !== ""

export function codexLaunchIsLocalOnly(launch: CodexLaunch): boolean {
  const variables = Object.entries(launch.env)
  // Windows reads variable names in any case, so names match in any case on
  // every platform.
  if (variables.some(([name, value]) => name.toUpperCase().startsWith("CODEX_EXEC_SERVER_") && set(value))) return false
  const codexHomes = [...new Set(variables.filter(([name, value]) => name.toUpperCase() === "CODEX_HOME" && set(value)).map(([, value]) => value!))]
  if (codexHomes.length > 1) return false
  // A set CODEX_HOME is canonicalized, and Codex refuses to start without it
  // (find_codex_home, utils/home-dir at rust-v0.157.1).
  if (codexHomes[0] !== undefined) return holdsNoEnvironments(resolve(launch.cwd, codexHomes[0]), true)
  const homes = launch.homeCandidates
  if (homes.length === 0 || homes.some((home) => !set(home))) return false
  return homes.every((home) => holdsNoEnvironments(join(home, ".codex"), false))
}

// Whether a Codex home, read through any link to the folder it names, holds
// no environments.toml. A home that cannot be read cannot be told.
function holdsNoEnvironments(home: string, mustExist: boolean): boolean {
  let folder: string
  try {
    folder = realpathSync.native(home)
  } catch (error) {
    return !mustExist && (error as NodeJS.ErrnoException).code === "ENOENT"
  }
  try {
    lstatSync(join(folder, "environments.toml"))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

// The homes Codex may take when CODEX_HOME is unset: on Windows it asks the
// OS for the profile folder (dirs::home_dir), which can differ from Node's
// homedir() (USERPROFILE first), so every candidate is checked: Node's home,
// the account's home, and USERPROFILE in any case. One that cannot be looked
// up is left out; with none left, nothing can be told.
export function codexHomeCandidates(
  env: Readonly<Record<string, string | undefined>>,
  nodeHome: () => string = homedir,
  accountHome: () => string = () => userInfo().homedir,
): string[] {
  const candidates: string[] = []
  for (const lookup of [nodeHome, accountHome]) {
    try {
      candidates.push(lookup())
    } catch {
      // Left out: a lookup that fails names no home.
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === "USERPROFILE" && set(value)) candidates.push(value)
  }
  return candidates
}

// Ruling Q150 A: Codex merges a thread's server into the person's one of the
// same name, so a repository server named like one of the person's own is
// held back. Names are compared in any case, as a person reading a card would.
export function withoutOwnServers<Server>(
  servers: Readonly<Record<string, Server>>,
  own: Iterable<string>,
): Record<string, Server> {
  const taken = new Set([...own].map((name) => name.toLowerCase()))
  return Object.fromEntries(Object.entries(servers).filter(([name]) => !taken.has(name.toLowerCase())))
}

// The files whose entries this plan decides.
export const codexRepositoryFiles: ReadonlySet<string> = new Set([".codex/config.toml", ".codex/hooks.json"])

// Whether an inventory entry from one of those files is kept from Codex under
// this plan: every entry but a server that passes. A server held back because
// the person has one of the same name is known only once a session opens,
// and is reported as loading.
export function codexEntryHeldBack(entry: ToolInventoryEntry, load: CodexRepositoryLoad): boolean {
  return !(entry.file === ".codex/config.toml" && entry.kind === "tool-server" && Object.hasOwn(load.mcpServers, entry.name))
}
