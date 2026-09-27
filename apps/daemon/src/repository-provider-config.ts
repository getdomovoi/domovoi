import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, lstat, open, opendir, readlink } from "node:fs/promises"
import { join } from "node:path"

import {
  toolInventoryEntrySchema,
  type ToolInventoryEntry,
  type ToolInventoryFile,
  type ToolInventoryProvider,
  type ToolInventorySource,
} from "@getdomovoi/protocol"
import { parse as parseYaml } from "yaml"

import { redactInventoryArgv, redactInventoryText } from "./inventory-redaction.js"

// What a repository's own Claude Code, OpenCode and Kilo configuration
// declares, and the digest repository trust pins to. Nothing here executes,
// imports or evaluates a repository file: files are read as bytes and parsed
// as JSON, JSONC or YAML data. Only the fixed provider paths below, relative
// to the repository root, are read, and no symbolic link is followed: every
// path component, the repository root itself included, is checked with lstat,
// and the root must stay the directory the reader first found. The file itself
// is opened with O_NOFOLLOW, and the open descriptor must be the file lstat
// found, in the same directories before and after the open. Node cannot open
// relative to a directory descriptor, so a directory swapped for a link and
// back between those checks is narrowed, not ruled out. A file with a second
// hard link is refused, since it can be another name for a file outside the
// repository.
//
// The digest covers each path in scope, present or absent: a file by its
// content hash, a directory by every name and file under it, and a refused
// path by why it was refused (a link by its target text, never by what the
// target holds). A change to any of them changes the digest; a change
// anywhere else does not. Instruction files (CLAUDE.md, AGENTS.md) are out of
// scope because the daemon loads them without trust, OpenCode themes because
// they run nothing, and .claude/settings.local.json because it is the
// person's own file, not the repository's.

export const maximumRepositoryConfigFileBytes = 256 * 1024
const maximumDirectoryMembers = 256
const maximumDirectoryDepth = 8
const maximumProviderEntries = 512
const maximumProviderFiles = 32
const digestVersion = "domovoi-repository-config/1"

type Parser = "claude-mcp" | "claude-settings" | "opencode-config" | "tui-config" | "kilo-mcp" | "kilo-modes" | "none"
type ScopedFile = { path: string; source: ToolInventorySource; parser: Parser }
// Directory members give plugin or skill entries, or count in the digest only.
type ScopedDirectory = { path: string; members?: "plugin" | "skill" }
type ProviderScope = { provider: string; files: readonly ScopedFile[]; directories: readonly ScopedDirectory[] }

// OpenCode and Kilo load these under each of their config directories: read
// from sst/opencode config/paths.ts, agent.ts, command.ts, plugin.ts,
// tool/registry.ts and skill/index.ts, and the Kilo fork's kilocode/config.
// Both also take skills from .claude/skills and .agents/skills.
const configDirectoryMembers: readonly ScopedDirectory[] = [
  { path: "agent" }, { path: "agents" }, { path: "mode" }, { path: "modes" },
  { path: "command" }, { path: "commands" }, { path: "plugin", members: "plugin" }, { path: "plugins", members: "plugin" },
  { path: "tool" }, { path: "tools" }, { path: "skill", members: "skill" }, { path: "skills", members: "skill" },
]
const sharedSkillDirectories: readonly ScopedDirectory[] = [{ path: ".claude/skills", members: "skill" }, { path: ".agents/skills", members: "skill" }]
const openCodeConfigNames = ["opencode.json", "opencode.jsonc"]
// Kilo 7.8.1 also reads config.json at the root and in .kilo/ and .kilocode/
// (its v2 Config and config sources lists), and both load TUI plugins from
// tui.json and tui.jsonc at the root and in each config directory
// (TuiConfig: ConfigPaths.projectFiles("tui") and fileInDirectory(dir, "tui")).
const kiloConfigNames = ["kilo.json", "kilo.jsonc", ...openCodeConfigNames, "config.json"]
const kiloConfigDirectories = [".kilocode", ".kilo"]
const tuiConfigNames = ["tui.json", "tui.jsonc"]

const configFiles = (directory: string | undefined, names: readonly string[], parser: Parser = "opencode-config"): ScopedFile[] => names.map((name) => ({
  path: directory ? `${directory}/${name}` : name, source: "project-settings", parser,
}))
const tuiFiles = (directory: string | undefined) => configFiles(directory, tuiConfigNames, "tui-config")
const memberDirectories = (directory: string): ScopedDirectory[] => configDirectoryMembers.map((member) => ({ ...member, path: `${directory}/${member.path}` }))

export const repositoryProviderScopes: readonly ProviderScope[] = [
  {
    provider: "claude-code",
    files: [
      { path: ".mcp.json", source: "repository-file", parser: "claude-mcp" },
      { path: ".claude/settings.json", source: "project-settings", parser: "claude-settings" },
    ],
    directories: [{ path: ".claude/skills", members: "skill" }, { path: ".claude/commands" }, { path: ".claude/agents" }],
  },
  {
    provider: "opencode",
    files: [
      ...configFiles(undefined, openCodeConfigNames),
      ...tuiFiles(undefined),
      ...configFiles(".opencode", openCodeConfigNames),
      ...tuiFiles(".opencode"),
      { path: ".opencode/package.json", source: "repository-file", parser: "none" },
    ],
    directories: [...memberDirectories(".opencode"), ...sharedSkillDirectories],
  },
  {
    // Kilo does not read .opencode/.
    provider: "kilo",
    files: [
      ...configFiles(undefined, kiloConfigNames),
      ...tuiFiles(undefined),
      ...kiloConfigDirectories.flatMap((directory): ScopedFile[] => [
        ...configFiles(directory, kiloConfigNames),
        ...tuiFiles(directory),
        { path: `${directory}/mcp.json`, source: "repository-file", parser: "kilo-mcp" },
        { path: `${directory}/package.json`, source: "repository-file", parser: "none" },
      ]),
      { path: ".kilocodemodes", source: "repository-file", parser: "kilo-modes" },
    ],
    directories: [...kiloConfigDirectories.flatMap(memberDirectories), ...sharedSkillDirectories],
  },
]

// Short reason codes, not prose: a client words them.
type RefusalReason = "symbolic-link" | "hard-link" | "not-a-file" | "not-a-directory" | "too-large" | "changed-while-read"
  | "too-many-members" | "too-deep" | "unreadable-member" | "io-error" | "invalid-json" | "invalid-yaml"
type Refused = { state: "unreadable"; reason: RefusalReason; digest: string }
type FileRead = { state: "absent" } | { state: "read"; bytes: Buffer } | Refused
type Identity = { dev: bigint; ino: bigint }

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown"

async function lstatOrAbsent(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    const code = errorCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw error
  }
}

async function linkRefusal(path: string): Promise<Refused> {
  return { state: "unreadable", reason: "symbolic-link", digest: `link:${sha256(await readlink(path))}` }
}

// The repository directory every read is anchored to: its path, and its
// identity when it was a real directory as the reader started.
type RepositoryRoot = { path: string; identity: Identity | undefined }

async function anchorRoot(path: string): Promise<RepositoryRoot> {
  try {
    const info = await lstatOrAbsent(path)
    return { path, identity: info?.isDirectory() ? { dev: info.dev, ino: info.ino } : undefined }
  } catch {
    // Each read meets the same error and records it.
    return { path, identity: undefined }
  }
}

// The directories from the root itself down through `segments`, each of which
// must be a real directory. A missing one makes the path absent; a link
// refuses it, the root included. The root must still be the directory the
// reader anchored to, so a root swapped mid-read reads nothing from elsewhere.
async function directoryChain(root: RepositoryRoot, segments: readonly string[]): Promise<Identity[] | { state: "absent" } | Refused> {
  const identities: Identity[] = []
  for (let index = 0; index <= segments.length; index += 1) {
    const path = join(root.path, ...segments.slice(0, index))
    const info = await lstatOrAbsent(path)
    if (info?.isSymbolicLink()) return linkRefusal(path)
    if (!info?.isDirectory()) return { state: "absent" }
    if (index === 0 && (info.dev !== root.identity?.dev || info.ino !== root.identity.ino)) {
      return { state: "unreadable", reason: "changed-while-read", digest: "changed-while-read" }
    }
    identities.push({ dev: info.dev, ino: info.ino })
  }
  return identities
}

const sameIdentities = (left: readonly Identity[], right: readonly Identity[]) => (
  left.length === right.length && left.every((identity, index) => identity.dev === right[index]!.dev && identity.ino === right[index]!.ino)
)

async function readRepositoryFile(root: RepositoryRoot, relative: string): Promise<FileRead> {
  const segments = relative.split("/")
  let handle: FileHandle | undefined
  try {
    const before = await directoryChain(root, segments.slice(0, -1))
    if (!Array.isArray(before)) return before
    const path = join(root.path, ...segments)
    const info = await lstatOrAbsent(path)
    if (!info) return { state: "absent" }
    if (info.isSymbolicLink()) return await linkRefusal(path)
    if (!info.isFile()) return { state: "unreadable", reason: "not-a-file", digest: "not-a-file" }
    if (info.nlink > 1n) return { state: "unreadable", reason: "hard-link", digest: "hard-link" }
    if (info.size > BigInt(maximumRepositoryConfigFileBytes)) return { state: "unreadable", reason: "too-large", digest: `too-large:${info.size}` }
    // O_NONBLOCK keeps a FIFO swapped in from holding the open.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat({ bigint: true })
    const after = await directoryChain(root, segments.slice(0, -1))
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink > 1n
      || !Array.isArray(after) || !sameIdentities(before, after)) {
      return { state: "unreadable", reason: "changed-while-read", digest: "changed-while-read" }
    }
    // A file can grow after the size check: read at most the cap plus one byte.
    const buffer = Buffer.alloc(maximumRepositoryConfigFileBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maximumRepositoryConfigFileBytes) return { state: "unreadable", reason: "too-large", digest: "too-large:grew" }
    return { state: "read", bytes: buffer.subarray(0, length) }
  } catch (error) {
    // O_NOFOLLOW refuses a link swapped in after lstat with ELOOP. Neither a
    // path nor any content goes into the reason or the digest.
    const code = errorCode(error)
    if (code === "ELOOP") return { state: "unreadable", reason: "symbolic-link", digest: "link:swapped" }
    return { state: "unreadable", reason: "io-error", digest: `io-error:${code}` }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

// A directory's names in order, or undefined when it holds more than `limit`.
// Names are read one at a time, so a huge directory is never listed whole.
async function boundedNames(path: string, limit: number): Promise<string[] | undefined> {
  const names: string[] = []
  const directory = await opendir(path)
  try {
    for (let entry = await directory.read(); entry; entry = await directory.read()) {
      if (names.length >= limit) return undefined
      names.push(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return names.sort()
}

type DirectoryRead = { state: "absent" } | Refused | { state: "read" | "empty"; members: string[]; digest: string }

// Every member of a scoped directory, depth first in name order, each file by
// its content hash. A member that is a link or cannot be read refuses the
// whole directory, so no entry is listed from part of one.
async function readRepositoryDirectory(root: RepositoryRoot, relative: string): Promise<DirectoryRead> {
  const segments = relative.split("/")
  try {
    const chain = await directoryChain(root, segments.slice(0, -1))
    if (!Array.isArray(chain)) return chain
    const info = await lstatOrAbsent(join(root.path, ...segments))
    if (!info) return { state: "absent" }
    if (info.isSymbolicLink()) return await linkRefusal(join(root.path, ...segments))
    if (!info.isDirectory()) return { state: "unreadable", reason: "not-a-directory", digest: "not-a-directory" }
    const records: string[] = []
    const members: string[] = []
    let refused: RefusalReason | undefined
    const walk = async (directory: string, depth: number): Promise<void> => {
      const names = await boundedNames(join(root.path, ...directory.split("/")), maximumDirectoryMembers - records.length)
      if (!names) {
        refused = "too-many-members"
        return
      }
      for (const name of names) {
        if (refused === "too-many-members") return
        const member = `${directory}/${name}`
        if ((await lstatOrAbsent(join(root.path, ...member.split("/"))))?.isDirectory()) {
          records.push(`directory:${member}`)
          if (depth >= maximumDirectoryDepth) refused ??= "too-deep"
          else await walk(member, depth + 1)
          continue
        }
        const file = await readRepositoryFile(root, member)
        if (file.state === "read") {
          records.push(`file:${member}:${sha256(file.bytes)}`)
          members.push(member.slice(relative.length + 1))
        } else {
          records.push(`${file.state}:${member}:${file.state === "unreadable" ? file.digest : ""}`)
          refused ??= "unreadable-member"
        }
      }
    }
    await walk(relative, 1)
    const digest = sha256(records.join("\n"))
    // Past the member cap the names read so far depend on listing order, so
    // the digest records the refusal alone.
    if (refused === "too-many-members") return { state: "unreadable", reason: refused, digest: refused }
    if (refused) return { state: "unreadable", reason: refused, digest: `${refused}:${digest}` }
    return { state: records.length === 0 ? "empty" : "read", members, digest }
  } catch (error) {
    return { state: "unreadable", reason: "io-error", digest: `io-error:${errorCode(error)}` }
  }
}

// JSONC as OpenCode and Kilo accept it: line and block comments and trailing
// commas. Strings are copied as written, so a // inside one stays.
function parseJsonc(text: string): unknown {
  const skip = (start: number): number => {
    let at = start
    for (;;) {
      while (at < text.length && /\s/u.test(text[at]!)) at += 1
      if (text.startsWith("//", at)) {
        while (at < text.length && text[at] !== "\n") at += 1
      } else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2)
        if (end === -1) throw new SyntaxError("Unterminated comment")
        at = end + 2
      } else return at
    }
  }
  let output = ""
  let index = 0
  while (index < text.length) {
    const next = skip(index)
    if (next > index) {
      output += " "
      index = next
      continue
    }
    const character = text[index]!
    if (character === "\"") {
      let end = index + 1
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1
      output += text.slice(index, end + 1)
      index = end + 1
    } else {
      const after = character === "," ? text[skip(index + 1)] : undefined
      if (after !== "}" && after !== "]") output += character
      index += 1
    }
  }
  return JSON.parse(output)
}

// An entry before the protocol check. Every candidate the check refuses, and
// every omission (an item the reader could not make sense of), is counted.
type Candidate = Record<string, unknown> & { kind: ToolInventoryEntry["kind"] }
type Omission = { omitted: true }
const omission: Omission = { omitted: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
const recordEntries = (value: unknown) => (isRecord(value) ? Object.entries(value) : [])
const keysOf = (value: unknown) => Object.keys(isRecord(value) ? value : {})
const stringArray = (value: unknown) => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined)

// Host and port only: path, query and user info can carry a token.
function remoteHost(url: unknown): { host?: string } {
  if (typeof url !== "string") return {}
  try {
    const { host } = new URL(url)
    return host ? { host } : {}
  } catch {
    return {}
  }
}

// A server in .mcp.json or Kilo's legacy mcp.json: command, args and env for a
// local one; type and url for a remote one. Headers are never read.
function mcpJsonServer(name: string, server: unknown): Candidate | Omission {
  if (!isRecord(server)) return omission
  const type = typeof server.type === "string" ? server.type : undefined
  const startsAtSessionStart = server.disabled !== true
  if (typeof server.command === "string" && (type === undefined || type === "stdio")) {
    const args = server.args === undefined ? [] : stringArray(server.args)
    if (!args) return omission
    return {
      kind: "tool-server", name: redactInventoryText(name), transport: "stdio",
      command: redactInventoryArgv([server.command, ...args]), envKeys: keysOf(server.env), startsAtSessionStart,
    }
  }
  const transport = type === "http" || type === "streamable-http" ? "http" : type === "sse" ? "sse" : "other"
  return { kind: "tool-server", name: redactInventoryText(name), transport, ...remoteHost(server.url), envKeys: [], startsAtSessionStart }
}

// Kilo's legacy servers can name tools that run without asking.
function alwaysAllowed(name: string, server: unknown): Array<Candidate | Omission> {
  if (!isRecord(server) || server.alwaysAllow === undefined) return []
  const tools = stringArray(server.alwaysAllow)
  if (!tools) return [omission]
  return tools.map((tool) => ({ kind: "permission-rule", rule: "alwaysAllow", detail: redactInventoryText(`${name} ${tool}`), startsAtSessionStart: false }))
}

// Claude Code settings that name a command, and whether it runs before the
// first request.
const claudeHelpers: ReadonlyArray<[string, boolean]> = [
  ["apiKeyHelper", true], ["proxyAuthHelper", true], ["awsCredentialExport", true], ["awsAuthRefresh", true],
  ["gcpAuthRefresh", true], ["otelHeadersHelper", true], ["processWrapper", true],
]
const claudeCommandSettings: ReadonlyArray<[string, boolean]> = [["statusLine", false], ["subagentStatusLine", false], ["fileSuggestion", false]]

// A hook's command is what it runs: a command line, a URL it posts to, a
// prompt it sends, or the server and tool it calls.
function claudeHook(event: string, matcher: unknown, hook: unknown): Candidate | Omission {
  if (!isRecord(hook)) return omission
  const args = hook.args === undefined ? [] : stringArray(hook.args)
  let command: string | undefined
  if (hook.type === "command" && typeof hook.command === "string" && args) {
    command = args.length > 0 ? redactInventoryArgv([hook.command, ...args]) : redactInventoryText(hook.command)
  } else if (hook.type === "http" && typeof hook.url === "string") command = redactInventoryText(hook.url)
  else if ((hook.type === "prompt" || hook.type === "agent") && typeof hook.prompt === "string") command = redactInventoryText(hook.prompt)
  else if (hook.type === "mcp_tool" && typeof hook.server === "string" && typeof hook.tool === "string") {
    command = redactInventoryText(`${hook.server} ${hook.tool}`)
  }
  if (command === undefined) return omission
  return {
    kind: "hook", event: redactInventoryText(event), ...(typeof matcher === "string" && matcher !== "" ? { matcher: redactInventoryText(matcher) } : {}),
    command, startsAtSessionStart: event === "SessionStart",
  }
}

function claudeSettings(settings: Record<string, unknown>): Array<Candidate | Omission> {
  const candidates: Array<Candidate | Omission> = []
  const rule = (name: string, detail: string): Candidate => ({ kind: "permission-rule", rule: name, detail: redactInventoryText(detail), startsAtSessionStart: false })
  for (const [event, groups] of recordEntries(settings.hooks)) {
    if (!Array.isArray(groups)) candidates.push(omission)
    else {
      for (const group of groups) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) candidates.push(omission)
        else for (const hook of group.hooks) candidates.push(claudeHook(event, group.matcher, hook))
      }
    }
  }
  for (const key of keysOf(settings.env)) candidates.push({ kind: "env-key", key, startsAtSessionStart: true })
  const permissions = isRecord(settings.permissions) ? settings.permissions : {}
  for (const name of ["allow", "deny", "ask", "additionalDirectories"]) {
    if (permissions[name] === undefined) continue
    const patterns = stringArray(permissions[name])
    if (!patterns) candidates.push(omission)
    else for (const pattern of patterns) candidates.push(rule(name, pattern))
  }
  if (typeof permissions.defaultMode === "string") candidates.push(rule("defaultMode", permissions.defaultMode))
  if (settings.enableAllProjectMcpServers === true) candidates.push(rule("enableAllProjectMcpServers", "true"))
  for (const server of stringArray(settings.enabledMcpjsonServers) ?? []) candidates.push(rule("enabledMcpjsonServers", server))
  for (const [name, startsAtSessionStart] of claudeHelpers) {
    const command = settings[name]
    if (typeof command === "string") candidates.push({ kind: "helper", name, command: redactInventoryText(command), startsAtSessionStart })
  }
  for (const [name, startsAtSessionStart] of claudeCommandSettings) {
    const setting = settings[name]
    if (isRecord(setting) && typeof setting.command === "string") {
      candidates.push({ kind: "helper", name, command: redactInventoryText(setting.command), startsAtSessionStart })
    }
  }
  for (const [plugin, enabled] of recordEntries(settings.enabledPlugins)) {
    if (enabled !== false) candidates.push({ kind: "plugin", name: redactInventoryText(plugin), startsAtSessionStart: true })
  }
  return candidates
}

// OpenCode permissions: one action for everything, an action per tool, or an
// action per pattern of a tool. The rule is the action, as in Claude Code's
// allow Bash(pattern), and the detail names what it covers.
function openCodePermissions(permission: unknown, prefix: string): Array<Candidate | Omission> {
  const rule = (action: unknown, detail: string): Candidate | Omission => (
    typeof action === "string" ? { kind: "permission-rule", rule: redactInventoryText(action), detail: redactInventoryText(detail), startsAtSessionStart: false } : omission
  )
  if (permission === undefined) return []
  if (typeof permission === "string") return [rule(permission, `${prefix}*`)]
  if (!isRecord(permission)) return [omission]
  return Object.entries(permission).flatMap(([tool, value]) => (
    isRecord(value) ? Object.entries(value).map(([pattern, action]) => rule(action, `${prefix}${tool} ${pattern}`)) : [rule(value, `${prefix}${tool}`)]
  ))
}

// A plugin list: a spec, or a spec and its options.
function pluginSpecs(plugins: unknown): Array<Candidate | Omission> {
  if (plugins === undefined) return []
  if (!Array.isArray(plugins)) return [omission]
  return (plugins as unknown[]).map((plugin) => {
    const spec = typeof plugin === "string" ? plugin : Array.isArray(plugin) && typeof plugin[0] === "string" ? plugin[0] : undefined
    return spec === undefined ? omission : { kind: "plugin", name: redactInventoryText(spec), startsAtSessionStart: true }
  })
}

function openCodeConfig(config: Record<string, unknown>): Array<Candidate | Omission> {
  const candidates: Array<Candidate | Omission> = []
  for (const [name, server] of recordEntries(config.mcp)) {
    if (!isRecord(server)) {
      candidates.push(omission)
      continue
    }
    const startsAtSessionStart = server.enabled !== false
    const command = stringArray(server.command)
    if (server.type === "local") {
      candidates.push(command && command.length > 0
        ? { kind: "tool-server", name: redactInventoryText(name), transport: "stdio", command: redactInventoryArgv(command), envKeys: keysOf(server.environment), startsAtSessionStart }
        : omission)
    } else if (server.type === "remote") {
      candidates.push({ kind: "tool-server", name: redactInventoryText(name), transport: "http", ...remoteHost(server.url), envKeys: [], startsAtSessionStart })
    } else if (server.type !== undefined) candidates.push(omission)
    // An entry with only `enabled` switches a server another file declares.
  }
  candidates.push(...pluginSpecs(config.plugin))
  candidates.push(...openCodePermissions(config.permission, ""))
  for (const key of ["agent", "mode"]) {
    for (const [name, agent] of recordEntries(config[key])) {
      if (isRecord(agent)) candidates.push(...openCodePermissions(agent.permission, `${key} ${name}: `))
    }
  }
  // Formatters run on every edit and language servers when a file opens.
  for (const key of ["formatter", "lsp"]) {
    for (const [name, tool] of recordEntries(config[key])) {
      if (!isRecord(tool) || tool.command === undefined) continue
      const command = stringArray(tool.command)
      candidates.push(command && command.length > 0
        ? { kind: "helper", name: redactInventoryText(`${key} ${name}`), command: redactInventoryArgv(command), startsAtSessionStart: false }
        : omission)
    }
  }
  return candidates
}

// Kilo's legacy custom modes: each mode's slug and the tool groups it grants.
function kiloModes(document: Record<string, unknown>): Array<Candidate | Omission> {
  if (document.customModes === undefined) return []
  if (!Array.isArray(document.customModes)) return [omission]
  return (document.customModes as unknown[]).map((mode): Candidate | Omission => {
    if (!isRecord(mode) || typeof mode.slug !== "string" || !Array.isArray(mode.groups)) return omission
    const groups = (mode.groups as unknown[]).map((group) => (Array.isArray(group) ? group[0] as unknown : group))
    if (!groups.every((group) => typeof group === "string")) return omission
    return { kind: "permission-rule", rule: "customModes", detail: redactInventoryText([mode.slug, ...groups].join(" ")), startsAtSessionStart: false }
  })
}

type Parsed = { state: "read" | "empty"; candidates: Array<Candidate | Omission> } | { state: "unreadable"; reason: RefusalReason }

function parseFile(parser: Parser, bytes: Buffer): Parsed {
  const text = bytes.toString("utf8").replace(/^\uFEFF/u, "")
  if (text.trim() === "") return { state: "empty", candidates: [] }
  if (parser === "none") return { state: "read", candidates: [] }
  const invalid: Parsed = { state: "unreadable", reason: parser === "kilo-modes" ? "invalid-yaml" : "invalid-json" }
  let document: unknown
  try {
    // The yaml package builds plain data: no custom tags run, and alias
    // expansion is capped.
    document = parser === "kilo-modes" ? parseYaml(text, { maxAliasCount: 64 }) : parseJsonc(text)
  } catch {
    return invalid
  }
  if (!isRecord(document)) return invalid
  switch (parser) {
    case "claude-mcp":
    case "kilo-mcp":
      return { state: "read", candidates: recordEntries(document.mcpServers).flatMap(([name, server]) => [mcpJsonServer(name, server), ...alwaysAllowed(name, server)]) }
    case "claude-settings":
      return { state: "read", candidates: claudeSettings(document) }
    case "opencode-config":
      return { state: "read", candidates: openCodeConfig(document) }
    case "tui-config":
      // A TUI file loads plugins; its theme and key bindings run nothing.
      return { state: "read", candidates: pluginSpecs(document.plugin) }
    case "kilo-modes":
      return { state: "read", candidates: kiloModes(document) }
  }
}

function directoryCandidates(directory: ScopedDirectory, members: readonly string[]): Candidate[] {
  if (directory.members === "plugin") {
    return members.filter((member) => /^[^/]+\.(?:ts|js)$/u.test(member))
      .map((name) => ({ kind: "plugin", name: redactInventoryText(name), startsAtSessionStart: true }))
  }
  if (directory.members === "skill") {
    return members.filter((member) => member.endsWith("/SKILL.md"))
      .map((member) => ({ kind: "skill", name: redactInventoryText(member.slice(0, -"/SKILL.md".length)), startsAtSessionStart: false }))
  }
  return []
}

export type RepositoryProviderConfig = {
  // sha256 over every provider's paths in scope; see the header comment.
  configDigest: string
  providers: ToolInventoryProvider[]
}

// heldBack marks every entry: whether the daemon keeps the repository's
// configuration from the agent. It does not change the digest.
export async function readRepositoryProviderConfig(rootPath: string, options: { heldBack: boolean }): Promise<RepositoryProviderConfig> {
  // A root that is itself a link is refused like any other link: every path
  // under it reads as refused, and the digest records the link's target text.
  const root = await anchorRoot(rootPath)
  const digestRecords: string[] = [digestVersion]
  const providers: ToolInventoryProvider[] = []
  for (const scope of repositoryProviderScopes) {
    const files: ToolInventoryFile[] = []
    const entries: ToolInventoryEntry[] = []
    let omittedEntries = 0
    // A file past the file cap is not listed, so its entries are counted.
    const list = (file: ToolInventoryFile) => {
      if (file.state !== "absent" && files.length < maximumProviderFiles) files.push(file)
    }
    const take = (path: string, candidates: ReadonlyArray<Candidate | Omission>) => {
      const listed = files.some((file) => file.path === path && file.state === "read")
      for (const candidate of candidates) {
        const checked = "omitted" in candidate || !listed || entries.length >= maximumProviderEntries
          ? undefined
          : toolInventoryEntrySchema.safeParse({ ...candidate, file: path, heldBack: options.heldBack })
        if (checked?.success) entries.push(checked.data)
        else omittedEntries += 1
      }
    }
    for (const scoped of scope.files) {
      const read = await readRepositoryFile(root, scoped.path)
      const base = { path: scoped.path, source: scoped.source }
      digestRecords.push(`${scope.provider}:file:${scoped.path}:${read.state}:${
        read.state === "read" ? sha256(read.bytes) : read.state === "unreadable" ? read.digest : ""}`)
      if (read.state !== "read") {
        list(read.state === "unreadable" ? { ...base, state: "unreadable", reason: read.reason } : { ...base, state: read.state })
        continue
      }
      const parsed = parseFile(scoped.parser, read.bytes)
      if (parsed.state === "unreadable") {
        list({ ...base, state: "unreadable", reason: parsed.reason })
        continue
      }
      list({ ...base, state: parsed.state })
      take(scoped.path, parsed.candidates)
    }
    for (const directory of scope.directories) {
      const read = await readRepositoryDirectory(root, directory.path)
      digestRecords.push(`${scope.provider}:directory:${directory.path}:${read.state}:${read.state === "absent" ? "" : read.digest}`)
      const base = { path: directory.path, source: "repository-file" as const }
      if (read.state === "unreadable") list({ ...base, state: "unreadable", reason: read.reason })
      else list({ ...base, state: read.state })
      if (read.state === "read") take(directory.path, directoryCandidates(directory, read.members))
    }
    providers.push({ provider: scope.provider, toolServers: "read-from-files", omittedEntries, files, entries })
  }
  return { configDigest: `sha256:${sha256(digestRecords.join("\n"))}`, providers }
}
