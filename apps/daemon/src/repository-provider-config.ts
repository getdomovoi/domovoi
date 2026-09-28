import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, lstat, open, opendir, readlink, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  toolInventoryEntrySchema,
  toolInventoryProviderSchema,
  type ToolInventoryEntry,
  type ToolInventoryFile,
  type ToolInventoryProvider,
  type ToolInventorySource,
} from "@getdomovoi/protocol"
import { parse as parseYaml } from "yaml"

import {
  inventoryFieldCaps as caps, redactInventoryArgv, redactInventoryCommand, redactInventoryPath, redactInventoryProgram, redactInventoryText,
} from "./inventory-redaction.js"
import { parseRepositoryToml, RepositoryTomlTooSlowError } from "./repository-toml.js"

// What a repository's own Claude Code, OpenCode, Kilo and Codex configuration
// declares, and the digest repository trust pins to. Nothing here executes,
// imports or evaluates a repository file: files are read as bytes and parsed
// as JSON, JSONC, YAML or TOML data. Only the fixed provider paths below, relative
// to the repository root, are read, and the one instruction file a Codex
// config.toml names when it is in the repository. No symbolic link is followed: every
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

type Parser = "claude-mcp" | "claude-settings" | "opencode-config" | "tui-config" | "kilo-mcp" | "kilo-modes" | "codex-config" | "codex-hooks" | "none"
type ScopedFile = { path: string; source: ToolInventorySource; parser: Parser }
// Directory members give plugin or skill entries, or count in the digest only.
type ScopedDirectory = { path: string; members?: "plugin" | "skill" }
// homeFolder: a folder the provider skips when it is the provider's own home.
type ProviderScope = { provider: string; files: readonly ScopedFile[]; directories: readonly ScopedDirectory[]; homeFolder?: string }

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
  {
    // Codex loads a trusted project's .codex folder: config.toml, hooks.json
    // and rules/*.rules (codex-repository-config.ts lists the same files for
    // its refusal), and skills from .codex/skills and .agents/skills. Read
    // from the config loader, hooks discovery and skill roots at
    // rust-v0.156.1. Rules are execution policy source, so they count in the
    // digest only. A .codex folder that is Codex's own home is the person's
    // configuration, so Codex skips it and so does this reader. Only the
    // repository root's folder is read and hashed: Codex input below the root
    // on a session's way down, or hooks a linked worktree takes from its main
    // checkout, keep the repository untrusted instead (trustRefusals).
    provider: "codex",
    homeFolder: ".codex",
    files: [
      { path: ".codex/config.toml", source: "project-settings", parser: "codex-config" },
      { path: ".codex/hooks.json", source: "project-settings", parser: "codex-hooks" },
    ],
    directories: [{ path: ".codex/rules" }, { path: ".codex/skills", members: "skill" }, { path: ".agents/skills", members: "skill" }],
  },
]

// Short reason codes, not prose: a client words them.
type RefusalReason = "symbolic-link" | "hard-link" | "not-a-file" | "not-a-directory" | "too-large" | "changed-while-read"
  | "too-many-members" | "too-deep" | "unreadable-member" | "io-error" | "invalid-json" | "invalid-yaml" | "invalid-toml" | "too-slow"
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

async function anchorRoot(given: string): Promise<RepositoryRoot> {
  // lstat follows a link named with a trailing separator (`repo/`), so the
  // root is normalized first and a linked final component is refused.
  // Normalizing resolves `.` and `..` lexically, as the daemon's other
  // workspace paths do.
  const path = resolve(given)
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
      kind: "tool-server", name: redactInventoryText(name, caps.name), transport: "stdio",
      command: redactInventoryArgv([server.command, ...args]), envKeys: keysOf(server.env), startsAtSessionStart,
    }
  }
  const transport = type === "http" || type === "streamable-http" ? "http" : type === "sse" ? "sse" : "other"
  return { kind: "tool-server", name: redactInventoryText(name, caps.name), transport, ...remoteHost(server.url), envKeys: [], startsAtSessionStart }
}

// Kilo's legacy servers can name tools that run without asking.
function alwaysAllowed(name: string, server: unknown): Array<Candidate | Omission> {
  if (!isRecord(server) || server.alwaysAllow === undefined) return []
  const tools = stringArray(server.alwaysAllow)
  if (!tools) return [omission]
  return tools.map((tool) => ({ kind: "permission-rule", rule: "alwaysAllow", detail: redactInventoryText(`${name} ${tool}`, caps.detail), startsAtSessionStart: false }))
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
    command = args.length > 0 ? redactInventoryArgv([hook.command, ...args]) : redactInventoryCommand(hook.command)
  } else if (hook.type === "http" && typeof hook.url === "string") command = redactInventoryText(hook.url, caps.command)
  else if ((hook.type === "prompt" || hook.type === "agent") && typeof hook.prompt === "string") command = redactInventoryText(hook.prompt, caps.command)
  else if (hook.type === "mcp_tool" && typeof hook.server === "string" && typeof hook.tool === "string") {
    command = redactInventoryText(`${hook.server} ${hook.tool}`, caps.command)
  }
  if (command === undefined) return omission
  return {
    kind: "hook", event: redactInventoryText(event, caps.event),
    ...(typeof matcher === "string" && matcher !== "" ? { matcher: redactInventoryText(matcher, caps.matcher) } : {}),
    command, startsAtSessionStart: event === "SessionStart",
  }
}

function claudeSettings(settings: Record<string, unknown>): Array<Candidate | Omission> {
  const candidates: Array<Candidate | Omission> = []
  const rule = (name: string, detail: string): Candidate => ({ kind: "permission-rule", rule: name, detail: redactInventoryText(detail, caps.detail), startsAtSessionStart: false })
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
    if (typeof command === "string") candidates.push({ kind: "helper", name, command: redactInventoryCommand(command), startsAtSessionStart })
  }
  for (const [name, startsAtSessionStart] of claudeCommandSettings) {
    const setting = settings[name]
    if (isRecord(setting) && typeof setting.command === "string") {
      candidates.push({ kind: "helper", name, command: redactInventoryCommand(setting.command), startsAtSessionStart })
    }
  }
  for (const [plugin, enabled] of recordEntries(settings.enabledPlugins)) {
    if (enabled !== false) candidates.push({ kind: "plugin", name: redactInventoryText(plugin, caps.name), startsAtSessionStart: true })
  }
  return candidates
}

// OpenCode permissions: one action for everything, an action per tool, or an
// action per pattern of a tool. The rule is the action, as in Claude Code's
// allow Bash(pattern), and the detail names what it covers.
function openCodePermissions(permission: unknown, prefix: string): Array<Candidate | Omission> {
  const rule = (action: unknown, detail: string): Candidate | Omission => (
    typeof action === "string" ? { kind: "permission-rule", rule: redactInventoryText(action, caps.rule), detail: redactInventoryText(detail, caps.detail), startsAtSessionStart: false } : omission
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
    return spec === undefined ? omission : { kind: "plugin", name: redactInventoryText(spec, caps.name), startsAtSessionStart: true }
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
        ? { kind: "tool-server", name: redactInventoryText(name, caps.name), transport: "stdio", command: redactInventoryArgv(command), envKeys: keysOf(server.environment), startsAtSessionStart }
        : omission)
    } else if (server.type === "remote") {
      candidates.push({ kind: "tool-server", name: redactInventoryText(name, caps.name), transport: "http", ...remoteHost(server.url), envKeys: [], startsAtSessionStart })
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
        ? { kind: "helper", name: redactInventoryText(`${key} ${name}`, caps.helperName), command: redactInventoryArgv(command), startsAtSessionStart: false }
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
    return { kind: "permission-rule", rule: "customModes", detail: redactInventoryText([mode.slug, ...groups].join(" "), caps.detail), startsAtSessionStart: false }
  })
}

const permissionRule = (rule: string, detail: unknown): Candidate | Omission => (
  typeof detail === "string" ? { kind: "permission-rule", rule, detail: redactInventoryText(detail, caps.detail), startsAtSessionStart: false } : omission
)
const flagRule = (rule: string, value: unknown): Candidate | Omission => (typeof value === "boolean" ? permissionRule(rule, String(value)) : omission)

// Codex hooks, from config.toml's [hooks] table or hooks.json's `hooks`: each
// event holds matcher groups, each group its handlers. A command handler runs
// `command`, or `commandWindows` in its place on Windows, so both are listed;
// an mcp_tool handler calls a server's tool. Codex skips prompt and agent
// handlers, so they list nothing. `state` holds per-hook trust and is read
// from the person's own config only.
function codexHook(event: string, matcher: unknown, hook: unknown): Array<Candidate | Omission> {
  if (!isRecord(hook)) return [omission]
  const hookOf = (command: string): Candidate => ({
    kind: "hook", event: redactInventoryText(event, caps.event),
    ...(typeof matcher === "string" && matcher !== "" ? { matcher: redactInventoryText(matcher, caps.matcher) } : {}),
    command, startsAtSessionStart: event === "SessionStart",
  })
  if (hook.type === "command" && typeof hook.command === "string") {
    const windows = hook.commandWindows ?? hook.command_windows
    if (windows !== undefined && typeof windows !== "string") return [omission]
    return [hook.command, ...(windows === undefined ? [] : [windows])].map((command) => hookOf(redactInventoryCommand(command)))
  }
  if (hook.type === "mcp_tool" && typeof hook.server === "string" && typeof hook.tool === "string") {
    return [hookOf(redactInventoryText(`${hook.server} ${hook.tool}`, caps.command))]
  }
  return hook.type === "prompt" || hook.type === "agent" ? [] : [omission]
}

function codexHooks(events: unknown): Array<Candidate | Omission> {
  if (events === undefined) return []
  if (!isRecord(events)) return [omission]
  return Object.entries(events).filter(([event]) => event !== "state").flatMap(([event, groups]) => {
    if (!Array.isArray(groups)) return [omission]
    return (groups as unknown[]).flatMap((group) => {
      if (!isRecord(group) || (group.hooks !== undefined && !Array.isArray(group.hooks))) return [omission]
      return ((group.hooks ?? []) as unknown[]).flatMap((hook) => codexHook(event, group.matcher, hook))
    })
  })
}

// A local server's env_vars: names Codex passes through from its own
// environment, each a string or { name, source }.
function codexEnvVarNames(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const names = (value as unknown[]).map((item) => (typeof item === "string" ? item : isRecord(item) && typeof item.name === "string" ? item.name : undefined))
  return names.every((name) => name !== undefined) ? names as string[] : undefined
}

// A Codex MCP server: command, args, env and env_vars for a local one; url for
// a streamable HTTP one, with the names of the variables whose values Codex
// sends it (bearer_token_env_var, env_http_headers). An inline bearer_token and
// http_headers are never read. http_headers_helper is a command Codex runs for
// the headers: its output is header names and values, and its arguments can
// hold one no trigger names, so it is listed by its program alone. The
// approval modes let the server's tools run without asking.
function codexServer(name: string, server: unknown): Array<Candidate | Omission> {
  if (!isRecord(server)) return [omission]
  const startsAtSessionStart = server.enabled !== false
  const serverName = redactInventoryText(name, caps.name)
  const candidates: Array<Candidate | Omission> = []
  if (typeof server.command === "string") {
    const args = server.args === undefined ? [] : stringArray(server.args)
    const envVars = codexEnvVarNames(server.env_vars)
    candidates.push(args && envVars
      ? { kind: "tool-server", name: serverName, transport: "stdio", command: redactInventoryArgv([server.command, ...args]), envKeys: [...keysOf(server.env), ...envVars], startsAtSessionStart }
      : omission)
  } else if (typeof server.url === "string") {
    const bearer = server.bearer_token_env_var
    const headerVariables = Object.values(isRecord(server.env_http_headers) ? server.env_http_headers : {})
    const envKeys = [...(bearer === undefined ? [] : [bearer]), ...headerVariables]
    candidates.push(envKeys.every((key) => typeof key === "string") && (server.env_http_headers === undefined || isRecord(server.env_http_headers))
      ? { kind: "tool-server", name: serverName, transport: "http", ...remoteHost(server.url), envKeys, startsAtSessionStart }
      : omission)
  } else candidates.push(omission)
  if (server.http_headers_helper !== undefined) {
    candidates.push(typeof server.http_headers_helper === "string"
      ? { kind: "helper", name: redactInventoryText(`http_headers_helper ${name}`, caps.helperName), command: redactInventoryProgram(server.http_headers_helper), startsAtSessionStart }
      : omission)
  }
  if (server.default_tools_approval_mode !== undefined) {
    candidates.push(typeof server.default_tools_approval_mode === "string"
      ? permissionRule("default_tools_approval_mode", `${name} ${server.default_tools_approval_mode}`)
      : omission)
  }
  for (const [tool, settings] of recordEntries(server.tools)) {
    if (!isRecord(settings)) candidates.push(omission)
    else if (settings.approval_mode !== undefined) {
      candidates.push(typeof settings.approval_mode === "string" ? permissionRule("approval_mode", `${name} ${tool} ${settings.approval_mode}`) : omission)
    }
  }
  return candidates
}

// approval_policy is a word, or a table naming the approval flows it allows.
function codexApprovalPolicy(policy: unknown): Array<Candidate | Omission> {
  if (policy === undefined) return []
  if (typeof policy === "string") return [permissionRule("approval_policy", policy)]
  if (!isRecord(policy) || !isRecord(policy.granular)) return [omission]
  const allowed = Object.entries(policy.granular).filter(([, value]) => value === true).map(([flow]) => flow)
  return [permissionRule("approval_policy", ["granular", ...allowed].join(" "))]
}

// A profile's network settings that are a word, a flag or a proxy URL.
const codexNetworkSettings = new Set([
  "enabled", "mode", "proxy_url", "enable_socks5", "socks_url", "enable_socks5_udp", "allow_upstream_proxy",
  "dangerously_allow_non_loopback_proxy", "dangerously_allow_all_unix_sockets", "allow_local_binding",
])

// Named permission profiles under [permissions]: what each grants, every
// profile listed so a selected one and those it extends are all shown
// (PermissionProfileToml at rust-v0.156.1). Each detail starts with the
// profile's name: the profile it extends, a workspace root and whether it is
// on, a filesystem path (and subpath) and its access, and each network
// setting, domain and unix socket rule. A description grants nothing.
// Man-in-the-middle hooks, and anything else, are not read here and are
// counted.
function codexPermissionProfiles(permissions: unknown): Array<Candidate | Omission> {
  if (permissions === undefined) return []
  if (!isRecord(permissions)) return [omission]
  const candidates: Array<Candidate | Omission> = []
  const rule = (name: string, parts: unknown[]) => {
    candidates.push(parts.every((part) => typeof part === "string" || typeof part === "boolean")
      ? permissionRule(`permissions.${name}`, parts.map(String).join(" "))
      : omission)
  }
  const each = (value: unknown, visit: (key: string, item: unknown) => void) => {
    if (!isRecord(value)) candidates.push(omission)
    else for (const [key, item] of Object.entries(value)) visit(key, item)
  }
  for (const [profile, fields] of Object.entries(permissions)) {
    each(fields, (field, value) => {
      if (field === "description") return
      if (field === "extends") rule("extends", [profile, value])
      else if (field === "workspace_roots") each(value, (root, enabled) => rule("workspace_roots", [profile, root, enabled]))
      else if (field === "filesystem") {
        each(value, (path, access) => {
          if (path === "glob_scan_max_depth") return
          if (isRecord(access)) for (const [subpath, mode] of Object.entries(access)) rule("filesystem", [profile, path, subpath, mode])
          else rule("filesystem", [profile, path, access])
        })
      } else if (field === "network") {
        each(value, (setting, item) => {
          if (codexNetworkSettings.has(setting)) rule(`network.${setting}`, [profile, item])
          else if (setting === "domains" || setting === "unix_sockets") each(item, (target, action) => rule(`network.${setting}`, [profile, target, action]))
          else candidates.push(omission)
        })
      } else candidates.push(omission)
    })
  }
  return candidates
}

// The shell's filters on the person's variables: patterns of names, never a
// value (ShellEnvironmentPolicyToml at rust-v0.156.1).
function codexShellFilters(policy: Record<string, unknown>): Array<Candidate | Omission> {
  const candidates: Array<Candidate | Omission> = []
  for (const key of ["include_only", "exclude"]) {
    if (policy[key] === undefined) continue
    const patterns = stringArray(policy[key])
    if (!patterns) candidates.push(omission)
    else for (const pattern of patterns) candidates.push(permissionRule(`shell_environment_policy.${key}`, pattern))
  }
  if (policy.filters !== undefined && !isRecord(policy.filters)) candidates.push(omission)
  for (const [pattern, action] of recordEntries(policy.filters)) {
    candidates.push(typeof action === "string" ? permissionRule("shell_environment_policy.filters", `${pattern} ${action}`) : omission)
  }
  return candidates
}

// config.toml: servers, hooks, the variables set for every command the agent
// runs (names only), the approval, sandbox, permission profile and shell
// environment settings, plugins and instruction overrides. Codex
// ignores notify, model providers, profiles and the other keys that choose
// where credentials go in a project file, so they are not listed; like every
// byte of the file, they are in the digest.
function codexConfig(config: Record<string, unknown>): Array<Candidate | Omission> {
  const candidates: Array<Candidate | Omission> = []
  const defined = (value: unknown, candidate: () => Candidate | Omission) => {
    if (value !== undefined) candidates.push(candidate())
  }
  if (config.mcp_servers !== undefined && !isRecord(config.mcp_servers)) candidates.push(omission)
  for (const [name, server] of recordEntries(config.mcp_servers)) candidates.push(...codexServer(name, server))
  candidates.push(...codexHooks(config.hooks))
  const shell = config.shell_environment_policy
  if (shell !== undefined && !isRecord(shell)) candidates.push(omission)
  const shellPolicy = isRecord(shell) ? shell : {}
  if (shellPolicy.set !== undefined && !isRecord(shellPolicy.set)) candidates.push(omission)
  for (const key of keysOf(shellPolicy.set)) candidates.push({ kind: "env-key", key, startsAtSessionStart: false })
  candidates.push(...codexApprovalPolicy(config.approval_policy))
  defined(config.sandbox_mode, () => permissionRule("sandbox_mode", config.sandbox_mode))
  defined(config.default_permissions, () => permissionRule("default_permissions", config.default_permissions))
  const sandbox = config.sandbox_workspace_write
  if (sandbox !== undefined && !isRecord(sandbox)) candidates.push(omission)
  if (isRecord(sandbox)) {
    if (sandbox.writable_roots !== undefined) {
      const roots = stringArray(sandbox.writable_roots)
      if (!roots) candidates.push(omission)
      else for (const path of roots) candidates.push(permissionRule("sandbox_workspace_write.writable_roots", path))
    }
    defined(sandbox.network_access, () => flagRule("sandbox_workspace_write.network_access", sandbox.network_access))
  }
  candidates.push(...codexPermissionProfiles(config.permissions))
  defined(shellPolicy.inherit, () => permissionRule("shell_environment_policy.inherit", shellPolicy.inherit))
  defined(shellPolicy.ignore_default_excludes, () => flagRule("shell_environment_policy.ignore_default_excludes", shellPolicy.ignore_default_excludes))
  candidates.push(...codexShellFilters(shellPolicy))
  if (config.plugins !== undefined && !isRecord(config.plugins)) candidates.push(omission)
  for (const [plugin, settings] of recordEntries(config.plugins)) {
    if (!isRecord(settings)) candidates.push(omission)
    else if (settings.enabled !== false) candidates.push({ kind: "plugin", name: redactInventoryText(plugin, caps.name), startsAtSessionStart: true })
  }
  // Inline instruction overrides are listed as present, never by their text
  // (ruling Q114); like every byte of the file, the text is in the digest.
  // model_instructions_file is listed where the file it names is read.
  for (const key of ["instructions", "developer_instructions"]) {
    defined(config[key], () => (typeof config[key] === "string" ? permissionRule(key, "inline") : omission))
  }
  return candidates
}

type InstructionsFile = {
  candidate: Candidate | Omission
  // The file, when it is in the repository, as the reader read it: its path
  // below the root, and that path as shown.
  file?: { path: string; shown: string; read: FileRead }
  // The path as written or read, when the file is outside the repository or
  // reached through a link.
  outside?: string
}

// A permission rule whose detail is a path already shown by
// redactInventoryPath, so the rule, the file record and a refusal show the
// same text.
const pathRule = (rule: string, shown: string): Candidate => ({ kind: "permission-rule", rule, detail: shown, startsAtSessionStart: false })

// model_instructions_file names a file Codex reads in place of its base
// instructions: a path relative to the .codex folder, with `~` for the home
// folder (resolve_relative_paths_in_config_toml and AbsolutePathBuf at
// rust-v0.156.1). It is listed by its path, never its text (ruling Q114). A
// file in the repository is read with the same caps and link handling as
// every other file and hashed; one outside it, or reached through a link,
// hard links included, refuses trust. Nothing outside is read.
async function codexInstructionsFile(root: RepositoryRoot, value: unknown): Promise<InstructionsFile | undefined> {
  const rule = "model_instructions_file"
  if (value === undefined) return undefined
  if (typeof value !== "string") return { candidate: omission }
  const home = value === "~" || value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))
  const resolved = resolve(root.path, ".codex", home ? join(homedir(), value.slice(1)) : value)
  const inRoot = relative(root.path, resolved)
  if (inRoot === "" || inRoot === ".." || inRoot.startsWith(`..${sep}`) || isAbsolute(inRoot)) {
    return { candidate: pathRule(rule, redactInventoryPath(value)), outside: value }
  }
  const path = inRoot.split(sep).join("/")
  const shown = redactInventoryPath(path)
  const read = await readRepositoryFile(root, path)
  const linked = read.state === "unreadable" && (read.reason === "symbolic-link" || read.reason === "hard-link")
  return { candidate: pathRule(rule, shown), file: { path, shown, read }, ...(linked ? { outside: path } : {}) }
}

type Parsed = { state: "read" | "empty"; candidates: Array<Candidate | Omission>; document?: Record<string, unknown> } | { state: "unreadable"; reason: RefusalReason }

// A file's text: UTF-8 without a leading byte order mark (U+FEFF).
const byteOrderMark = String.fromCodePoint(0xfeff)
function decodedText(bytes: Buffer): string {
  const text = bytes.toString("utf8")
  return text.startsWith(byteOrderMark) ? text.slice(byteOrderMark.length) : text
}

function parseFile(parser: Parser, bytes: Buffer): Parsed {
  const text = decodedText(bytes)
  if (text.trim() === "") return { state: "empty", candidates: [] }
  if (parser === "none") return { state: "read", candidates: [] }
  const invalid: Parsed = { state: "unreadable", reason: parser === "kilo-modes" ? "invalid-yaml" : parser === "codex-config" ? "invalid-toml" : "invalid-json" }
  let document: unknown
  try {
    // The yaml package builds plain data: no custom tags run, and alias
    // expansion is capped. repository-toml.ts says the same of TOML.
    document = parser === "kilo-modes" ? parseYaml(text, { maxAliasCount: 64 })
      : parser === "codex-config" ? parseRepositoryToml(text)
        : parseJsonc(text)
  } catch (error) {
    return error instanceof RepositoryTomlTooSlowError ? { state: "unreadable", reason: "too-slow" } : invalid
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
    case "codex-config":
      return { state: "read", candidates: codexConfig(document), document }
    case "codex-hooks":
      return { state: "read", candidates: codexHooks(document.hooks) }
  }
}

function directoryCandidates(directory: ScopedDirectory, members: readonly string[]): Candidate[] {
  if (directory.members === "plugin") {
    return members.filter((member) => /^[^/]+\.(?:ts|js)$/u.test(member))
      .map((name) => ({ kind: "plugin", name: redactInventoryText(name, caps.name), startsAtSessionStart: true }))
  }
  if (directory.members === "skill") {
    return members.filter((member) => member.endsWith("/SKILL.md"))
      .map((member) => ({ kind: "skill", name: redactInventoryText(member.slice(0, -"/SKILL.md".length), caps.name), startsAtSessionStart: false }))
  }
  return []
}

// Why a repository cannot be trusted whatever the person approves: input its
// agent would load that the digest does not cover (ruling Q113; full support
// is #656). Codes, not prose: a client words them.
//   nested-config: a .codex folder or .agents/skills below the root, in a
//     directory on the session folder's way down, or a link on that way.
//   main-checkout-hooks: in a linked worktree, the main checkout's .codex
//     folder for a directory on that way holds hooks (hooks.json, or a
//     [hooks] table in config.toml), or a file there that could hold them
//     cannot be read.
//   main-checkout-unknown: the root's .git file names a linked worktree whose
//     main checkout cannot be found safely: a link or a mismatch on the way.
//   instructions-outside: model_instructions_file names a file outside the
//     repository, or one reached through a link (ruling Q114).
// The path is relative to the root when inside it, and absolute otherwise;
// an instruction file outside is as written. A repository or the machine
// names each one, so it is shown redacted (redactInventoryPath), and the
// digest records it as read.
export type RepositoryTrustRefusalReason = "nested-config" | "main-checkout-hooks" | "main-checkout-unknown" | "instructions-outside"
export type RepositoryTrustRefusal = { provider: string; reason: RepositoryTrustRefusalReason; path: string }

export type RepositoryProviderConfig = {
  // sha256 over every provider's paths in scope; see the header comment.
  configDigest: string
  providers: ToolInventoryProvider[]
  // Empty unless the repository must stay untrusted; see above.
  trustRefusals: RepositoryTrustRefusal[]
}

// Codex's home as written: CODEX_HOME when set and not empty, else ~/.codex
// (find_codex_home at rust-v0.156.1). `set` says which, since Codex reads the
// two differently; see codexHomePaths.
type CodexHome = { path: string; set: boolean }

function defaultCodexHome(): CodexHome {
  const set = process.env.CODEX_HOME
  return set ? { path: set, set: true } : { path: join(homedir(), ".codex"), set: false }
}

// The home's path as Codex compares it, and its canonical path. A CODEX_HOME
// that is set is canonicalized as written (find_codex_home): a `..` after a
// link steps up from the link's target, so reading it lexically could name
// the repository's own folder while Codex uses another. Codex refuses to
// start when that path is not a directory; a relative one depends on Codex's
// working directory. Either way, no folder is its home here, and the
// repository's folder stays in scope. ~/.codex is made absolute lexically
// (AbsolutePathBuf::from_absolute_path) and canonicalized only to compare.
async function codexHomePaths(home: CodexHome): Promise<{ path: string; canonical: string } | undefined> {
  if (!home.set) {
    const path = resolve(home.path)
    return { path, canonical: await realpath(path).catch(() => path) }
  }
  // Platforms resolve a `..` after a link differently (Windows steps up
  // lexically before following the link), so a set CODEX_HOME with any `..`
  // segment names no folder as the home, on every platform (ruling Q125).
  if (!isAbsolute(home.path) || home.path.split(/[\\/]/u).includes("..")) return undefined
  try {
    const canonical = await realpath(home.path)
    return (await lstat(canonical)).isDirectory() ? { path: canonical, canonical } : undefined
  } catch {
    return undefined
  }
}

// Whether `folder` in the root is the provider's own home: a real directory
// whose path, or canonical path, is the home's as Codex compares them. Codex
// skips such a project folder by the same two comparisons
// (discover_project_layers at rust-v0.156.1). A link there is not skipped: it
// is refused like any other.
async function isProviderHome(root: RepositoryRoot, folder: string, home: CodexHome): Promise<boolean> {
  const chain = await directoryChain(root, folder.split("/")).catch(() => undefined)
  if (!Array.isArray(chain)) return false
  const homePaths = await codexHomePaths(home)
  if (homePaths === undefined) return false
  const path = join(root.path, ...folder.split("/"))
  if (path === homePaths.path) return true
  try {
    return await realpath(path) === homePaths.canonical
  } catch {
    return false
  }
}

// A session folder's segments below the root: a relative path of plain
// names, `/`-separated. Anything else is a caller's mistake.
function sessionSegments(folder: string | undefined): string[] {
  if (folder === undefined) return []
  const segments = folder.split("/")
  if (isAbsolute(folder) || segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new TypeError("A session folder is a relative path of plain names below the repository root")
  }
  return segments
}

// Codex reads a .codex folder and .agents/skills in each directory from the
// session's down to the project root (discover_project_layers and
// repo_agents_skill_roots at rust-v0.156.1). The project root is the nearest
// directory holding a root marker, .git unless the person's own config names
// others, and a repository's config cannot change them. Domovoi starts every
// Codex thread at a worktree's root, which holds .git, so by default this
// reads nothing: a caller naming a deeper session folder has each directory
// below the root on its way checked, and anything found there, or a link on
// the way, refuses trust. A .codex folder that is Codex's home is skipped.
async function nestedCodexInput(root: RepositoryRoot, segments: readonly string[], codexHome: CodexHome): Promise<RepositoryTrustRefusal[]> {
  const refusals: RepositoryTrustRefusal[] = []
  const refuse = (path: string) => refusals.push({ provider: "codex", reason: "nested-config", path })
  const found = (path: string) => lstatOrAbsent(join(root.path, ...path.split("/"))).catch(() => "error" as const)
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const directory = segments.slice(0, depth).join("/")
    const info = await found(directory)
    if (info === "error" || info?.isSymbolicLink()) {
      refuse(directory)
      break
    }
    if (!info?.isDirectory()) break
    for (const folder of [`${directory}/.codex`, `${directory}/.agents/skills`]) {
      const member = await found(folder)
      if (member === undefined) continue
      if (member !== "error" && folder.endsWith("/.codex") && await isProviderHome(root, folder, codexHome)) continue
      refuse(folder)
    }
  }
  return refusals
}

// Git's own metadata files are small.
const maximumGitMetadataBytes = 64 * 1024

// ASCII whitespace as Codex trims it from git's metadata files
// ([u8]::trim_ascii in resolve_root_git_project_for_trust at rust-v0.156.1):
// space, tab, line feed, form feed and carriage return. Anything else, a
// no-break space (U+00A0) or a vertical tab included, is part of the path,
// as it is to git.
const gitBlank = new Set([" ", "\t", "\n", "\f", "\r"])

function trimGitBlank(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && gitBlank.has(text[start]!)) start += 1
  while (end > start && gitBlank.has(text[end - 1]!)) end -= 1
  return text.slice(start, end)
}

// Codex reads the path bytes as written: text that is not UTF-8 cannot be
// named the same way here, and a byte order mark is not stripped.
const gitMetadataDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// A git metadata file's text trimmed as Codex trims it, or undefined when it
// is absent, a link, not a regular file, too large, not UTF-8 or unreadable.
async function gitMetadata(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined
  try {
    const info = await lstatOrAbsent(path)
    if (!info?.isFile() || info.size > BigInt(maximumGitMetadataBytes)) return undefined
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const buffer = Buffer.alloc(maximumGitMetadataBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length > maximumGitMetadataBytes ? undefined : trimGitBlank(gitMetadataDecoder.decode(buffer.subarray(0, length)))
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

type MainCheckout = { state: "none" } | { state: "unknown" } | { state: "found"; path: string }

// The main checkout of a linked worktree at the root, found as Codex finds it
// (resolve_root_git_project_for_trust at rust-v0.156.1): the root's .git file
// names a git directory in its common directory's worktrees/, whose gitdir
// file names the root's .git again and whose commondir file names that common
// directory, which is the main checkout's .git. A link at any step, or any
// mismatch once the root names a worktree, makes it unknown. A .git
// directory, or a .git file that names no worktree (a submodule's), leaves no
// main checkout elsewhere.
async function mainCheckoutOf(root: RepositoryRoot): Promise<MainCheckout> {
  const none: MainCheckout = { state: "none" }
  const unknown: MainCheckout = { state: "unknown" }
  if (!Array.isArray(await directoryChain(root, []).catch(() => undefined))) return none
  const marker = join(root.path, ".git")
  const info = await lstatOrAbsent(marker).catch(() => "error" as const)
  if (info === undefined || (info !== "error" && info.isDirectory())) return none
  if (info === "error" || !info.isFile()) return unknown
  const gitDirectory = await gitDirectoryNamedBy(marker)
  if (gitDirectory === undefined || !(await lstatOrAbsent(gitDirectory).catch(() => undefined))?.isDirectory()) return unknown
  try {
    const canonical = await realpath(gitDirectory)
    if (basename(dirname(canonical)) !== "worktrees") return none
    const common = dirname(dirname(canonical))
    const [backlink, commonDirectory] = await Promise.all([gitMetadata(join(canonical, "gitdir")), gitMetadata(join(canonical, "commondir"))])
    if (!backlink || !commonDirectory) return unknown
    const registered = resolve(canonical, backlink)
    if (basename(registered) !== ".git") return unknown
    const [registeredCheckout, checkout, linkedCommon] = await Promise.all([
      realpath(dirname(registered)), realpath(root.path), realpath(resolve(canonical, commonDirectory)),
    ])
    if (registeredCheckout !== checkout || linkedCommon !== common) return unknown
    // The main checkout as the .git file spells it, as Codex keeps it.
    const main = dirname(dirname(dirname(gitDirectory)))
    const mainMarker = join(main, ".git")
    const mainInfo = await lstatOrAbsent(mainMarker)
    const mainGit = mainInfo?.isDirectory() ? mainMarker : mainInfo?.isFile() ? await gitDirectoryNamedBy(mainMarker) : undefined
    if (mainGit === undefined || await realpath(mainGit) !== common) return unknown
    return { state: "found", path: main }
  } catch {
    return unknown
  }
}

// The git directory a .git file names, relative to the file's directory.
async function gitDirectoryNamedBy(marker: string): Promise<string | undefined> {
  const text = await gitMetadata(marker)
  const target = text?.startsWith("gitdir:") ? trimGitBlank(text.slice("gitdir:".length)) : undefined
  return target ? resolve(dirname(marker), target) : undefined
}

// In a linked worktree Codex takes hook declarations from the main checkout's
// .codex folder for each directory on the session's way down: hooks.json,
// and the [hooks] table of config.toml in place of the worktree's
// (merge_root_checkout_project_hooks at rust-v0.156.1). Any of them there, or
// one that cannot be read, a link included, refuses trust.
async function mainCheckoutHooks(root: RepositoryRoot, segments: readonly string[]): Promise<RepositoryTrustRefusal[]> {
  const main = await mainCheckoutOf(root)
  if (main.state === "none") return []
  if (main.state === "unknown") return [{ provider: "codex", reason: "main-checkout-unknown", path: ".git" }]
  const mainRoot = await anchorRoot(main.path)
  const refusals: RepositoryTrustRefusal[] = []
  const refuse = (path: string) => refusals.push({ provider: "codex", reason: "main-checkout-hooks", path })
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const folder = [...segments.slice(0, depth), ".codex"]
    const folderPath = join(main.path, ...folder)
    const chain = await directoryChain(mainRoot, folder.slice(0, -1)).catch(() => undefined)
    if (chain === undefined || (!Array.isArray(chain) && chain.state === "unreadable")) {
      refuse(folderPath)
      continue
    }
    if (!Array.isArray(chain)) continue
    const info = await lstatOrAbsent(folderPath).catch(() => "error" as const)
    if (info === undefined) continue
    if (info === "error" || info.isSymbolicLink()) {
      refuse(folderPath)
      continue
    }
    if (!info.isDirectory()) continue
    const hooksFile = join(folderPath, "hooks.json")
    if (await lstatOrAbsent(hooksFile).catch(() => "error" as const) !== undefined) refuse(hooksFile)
    const config = await readRepositoryFile(mainRoot, [...folder, "config.toml"].join("/"))
    if (config.state === "absent") continue
    let hooks = true
    if (config.state === "read") {
      try {
        const document = parseRepositoryToml(decodedText(config.bytes))
        hooks = !isRecord(document) || Object.hasOwn(document, "hooks")
      } catch {
        hooks = true
      }
    }
    if (hooks) refuse(join(folderPath, "config.toml"))
  }
  return refusals
}

export type RepositoryProviderConfigOptions = {
  // Whether the daemon keeps the repository's configuration from the agent;
  // it marks every entry and does not change the digest.
  heldBack: boolean
  // Codex's home, when not the one its environment names: the CODEX_HOME
  // value Codex is given, read as Codex reads a set CODEX_HOME.
  codexHome?: string
  // The folder below the root a session starts in, `/`-separated; the root
  // when not given, where Domovoi starts every session.
  sessionFolder?: string
}

export async function readRepositoryProviderConfig(rootPath: string, options: RepositoryProviderConfigOptions): Promise<RepositoryProviderConfig> {
  const segments = sessionSegments(options.sessionFolder)
  const codexHome: CodexHome = options.codexHome !== undefined ? { path: options.codexHome, set: true } : defaultCodexHome()
  // A root that is itself a link is refused like any other link: every path
  // under it reads as refused, and the digest records the link's target text.
  const root = await anchorRoot(rootPath)
  const digestRecords: string[] = [digestVersion]
  const providers: ToolInventoryProvider[] = []
  const outsideInstructions: RepositoryTrustRefusal[] = []
  for (const scope of repositoryProviderScopes) {
    const files: ToolInventoryFile[] = []
    const entries: ToolInventoryEntry[] = []
    const instructionFiles: ToolInventoryFile[] = []
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
    // The provider's own home is the person's configuration, not the
    // repository's: nothing under it is read, listed or hashed.
    const home = scope.homeFolder !== undefined && await isProviderHome(root, scope.homeFolder, codexHome)
      ? `${scope.homeFolder}/`
      : undefined
    if (home !== undefined) digestRecords.push(`${scope.provider}:home:${home}`)
    for (const scoped of scope.files) {
      if (home !== undefined && scoped.path.startsWith(home)) continue
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
      if (scoped.parser !== "codex-config" || parsed.document === undefined) continue
      const instructions = await codexInstructionsFile(root, parsed.document.model_instructions_file)
      if (instructions === undefined) continue
      take(scoped.path, [instructions.candidate])
      if (instructions.outside !== undefined) outsideInstructions.push({ provider: scope.provider, reason: "instructions-outside", path: instructions.outside })
      if (instructions.file === undefined) continue
      const { path, shown, read: file } = instructions.file
      digestRecords.push(`${scope.provider}:instructions:${path}:${file.state}:${
        file.state === "read" ? sha256(file.bytes) : file.state === "unreadable" ? file.digest : ""}`)
      if (file.state === "unreadable") instructionFiles.push({ path: shown, source: "repository-file", state: "unreadable", reason: file.reason })
      else if (file.state === "read") instructionFiles.push({ path: shown, source: "repository-file", state: decodedText(file.bytes).trim() === "" ? "empty" : "read" })
    }
    for (const directory of scope.directories) {
      if (home !== undefined && directory.path.startsWith(home)) continue
      const read = await readRepositoryDirectory(root, directory.path)
      digestRecords.push(`${scope.provider}:directory:${directory.path}:${read.state}:${read.state === "absent" ? "" : read.digest}`)
      const base = { path: directory.path, source: "repository-file" as const }
      if (read.state === "unreadable") list({ ...base, state: "unreadable", reason: read.reason })
      else list({ ...base, state: read.state })
      if (read.state === "read") take(directory.path, directoryCandidates(directory, read.members))
    }
    // An instruction file is listed after the paths in scope, and not again
    // when it is one of them, so a file is listed once, as its own path's
    // reader found it.
    for (const file of instructionFiles) {
      if (!files.some((listed) => listed.path === file.path)) list(file)
    }
    // Every entry and path was checked on its own; the provider is checked
    // whole as well, so the reader never returns an inventory the protocol
    // refuses. The error names no path or value.
    const provider: ToolInventoryProvider = { provider: scope.provider, toolServers: "read-from-files", omittedEntries, files, entries }
    if (!toolInventoryProviderSchema.safeParse(provider).success) throw new Error(`The ${scope.provider} repository inventory does not fit the protocol`)
    providers.push(provider)
  }
  // Refusals are pinned by their paths as read and shown redacted.
  const refused = [...outsideInstructions, ...await nestedCodexInput(root, segments, codexHome), ...await mainCheckoutHooks(root, segments)]
  for (const refusal of refused) digestRecords.push(`${refusal.provider}:refused:${refusal.reason}:${refusal.path}`)
  const trustRefusals = refused.map((refusal) => ({ ...refusal, path: redactInventoryPath(refusal.path) }))
  return { configDigest: `sha256:${sha256(digestRecords.join("\n"))}`, providers, trustRefusals }
}
