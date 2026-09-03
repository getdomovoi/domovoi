import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  executionRecordSchema,
  executionResolutionSchema,
  maximumExecutionEntries,
  type ExecutionEntry,
  type ExecutionRecord,
  type ExecutionResolution,
  type ResolvedExecution,
  type UnresolvedExecutionReason,
} from "@getdomovoi/protocol"

import { redactDurableCommand } from "./secret-redaction.js"

type ExecutionInput = {
  workspaceRoot: string
  cwd?: string
  command?: string
  filePath?: string
  blockedPath?: string
}

type ParsedPart = {
  operator: null | "&&" | "||" | "|" | ";"
  argv: string[]
}

type PackageScripts = Readonly<Record<string, string>>

type PackageInvocation = {
  manager: "npm" | "pnpm" | "yarn" | "bun"
  script: string
  arguments: string[]
  argv: string[]
}

type Manifest = {
  path: string
  scripts: PackageScripts
}

const fileTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const packageManagers = new Set(["npm", "pnpm", "yarn", "bun"])
const packageSubcommands = new Set([
  "add", "audit", "create", "dedupe", "dlx", "exec", "i", "init", "install", "link",
  "pack", "patch", "publish", "remove", "rm", "store", "up", "update", "why", "x",
])
const npmScriptShortcuts = new Set(["start", "stop", "test"])
const scriptName = /^[a-z0-9](?:[a-z0-9:._-]*[a-z0-9])?$/iu
const unsupportedUnquoted = new Set(["$", "`", "<", ">", "(", ")", "{", "}", "[", "]", "*", "?", "#"])
const statefulShellCommands = new Set([
  ".", "alias", "cd", "eval", "exec", "export", "popd", "pushd", "set", "source", "unalias", "unset",
])
const maximumResolutionDepth = 8
const digestPrefix = "domovoi.execution-record.v1\0"

function unresolved(reason: UnresolvedExecutionReason): ExecutionResolution {
  return executionResolutionSchema.parse({ state: "unresolved", reason })
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
}

async function canonicalCwd(
  workspaceRoot: string,
  cwd: string | undefined,
): Promise<{ root: string; absolute: string; relative: string } | undefined> {
  try {
    const root = await realpath(workspaceRoot)
    const requested = cwd === undefined
      ? root
      : isAbsolute(cwd) ? cwd : resolve(root, cwd)
    const absolute = await realpath(requested)
    if (!inside(root, absolute)) return undefined
    const fromRoot = relative(root, absolute)
    return {
      root,
      absolute,
      relative: fromRoot === "" ? "." : fromRoot.split(sep).join("/"),
    }
  } catch {
    return undefined
  }
}

async function pathStaysInside(root: string, cwd: string, path: string): Promise<boolean> {
  const lexical = resolve(cwd, path)
  if (!inside(root, lexical)) return false
  let existing = lexical
  while (inside(root, existing)) {
    try {
      return inside(root, await realpath(existing))
    } catch {
      if (existing === root) return false
      existing = dirname(existing)
    }
  }
  return false
}

function parseCommand(command: string): ParsedPart[] | undefined {
  if (command.length === 0 || command.length > 8_192 || /[\r\n\0]/u.test(command)) return undefined
  const parts: ParsedPart[] = []
  let operator: ParsedPart["operator"] = null
  let argv: string[] = []
  let token = ""
  let tokenStarted = false
  let quote: "single" | "double" | undefined
  let escaped = false

  const pushToken = () => {
    if (!tokenStarted) return
    argv.push(token)
    token = ""
    tokenStarted = false
  }
  const pushPart = (nextOperator: Exclude<ParsedPart["operator"], null>) => {
    pushToken()
    if (argv.length === 0) return false
    parts.push({ operator, argv })
    operator = nextOperator
    argv = []
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (escaped) {
      token += character
      tokenStarted = true
      escaped = false
      continue
    }
    if (quote === "single") {
      if (character === "'") quote = undefined
      else token += character
      tokenStarted = true
      continue
    }
    if (quote === "double") {
      if (character === "\"") {
        quote = undefined
      } else if (character === "\\") {
        const next = command[index + 1]
        if (next !== "\"" && next !== "\\") return undefined
        escaped = true
      } else {
        if (character === "$" || character === "`") return undefined
        token += character
      }
      tokenStarted = true
      continue
    }
    if (character === "\\") {
      escaped = true
      tokenStarted = true
      continue
    }
    if (character === "'") {
      quote = "single"
      tokenStarted = true
      continue
    }
    if (character === "\"") {
      quote = "double"
      tokenStarted = true
      continue
    }
    if (/\s/u.test(character)) {
      pushToken()
      continue
    }
    if (unsupportedUnquoted.has(character)) return undefined
    const pair = command.slice(index, index + 2)
    if (pair === "&&" || pair === "||") {
      if (!pushPart(pair)) return undefined
      index += 1
      continue
    }
    if (character === "|" || character === ";") {
      if (!pushPart(character)) return undefined
      continue
    }
    if (character === "&") return undefined
    token += character
    tokenStarted = true
  }
  if (quote !== undefined || escaped) return undefined
  pushToken()
  if (argv.length === 0) return undefined
  parts.push({ operator, argv })
  if (parts.some((part) => {
    const executable = part.argv[0]!.toLowerCase()
    return statefulShellCommands.has(executable) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(part.argv[0]!)
  })) return undefined
  return parts
}

function packageInvocation(
  argv: readonly string[],
  forwardedArgumentCount = 0,
): PackageInvocation | "invalid" | undefined {
  const manager = argv[0]
  if (!manager || !packageManagers.has(manager)) return undefined
  const typedManager = manager as PackageInvocation["manager"]
  const subcommand = argv[1]
  if (!subcommand) return undefined
  if (subcommand.startsWith("-")) return "invalid"

  let script: string | undefined
  let remainder: readonly string[]
  if (subcommand === "run") {
    script = argv[2]
    remainder = argv.slice(3)
  } else if (typedManager === "npm") {
    if (!npmScriptShortcuts.has(subcommand)) return undefined
    script = subcommand
    remainder = argv.slice(2)
  } else if (typedManager === "pnpm" || typedManager === "yarn") {
    if (packageSubcommands.has(subcommand)) return undefined
    script = subcommand
    remainder = argv.slice(2)
  } else {
    return undefined
  }
  if (!script || !scriptName.test(script)) return "invalid"
  if (
    remainder.length > 0
    && remainder[0] !== "--"
    && remainder.length !== forwardedArgumentCount
  ) return "invalid"
  const args = remainder.length === 0
    ? []
    : remainder[0] === "--" ? [...remainder.slice(1)] : [...remainder]
  return {
    manager: typedManager,
    script,
    arguments: args,
    argv: [typedManager, "run", script, ...(args.length === 0 ? [] : ["--", ...args])],
  }
}

async function readManifest(root: string, cwd: string): Promise<Manifest | undefined> {
  const lexicalPath = join(cwd, "package.json")
  try {
    const canonicalPath = await realpath(lexicalPath)
    if (!inside(root, canonicalPath)) return undefined
    const parsed: unknown = JSON.parse(await readFile(canonicalPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const value = (parsed as { scripts?: unknown }).scripts
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const scripts = Object.fromEntries(Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ))
    const pathFromRoot = relative(root, canonicalPath).split(sep).join("/")
    return { path: pathFromRoot, scripts }
  } catch {
    return undefined
  }
}

function sourceDigest(source: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`
}

function fingerprint(record: ExecutionRecord): ResolvedExecution {
  const validated = executionRecordSchema.parse(record)
  return executionResolutionSchema.parse({
    state: "resolved",
    record: validated,
    digest: `sha256:${createHash("sha256").update(digestPrefix).update(canonicalJson(validated)).digest("hex")}`,
  }) as ResolvedExecution
}

function resolveShell(
  command: string,
  cwd: string,
  manifest: Manifest | undefined,
): ExecutionResolution {
  if (redactDurableCommand(command).redacted) return unresolved("sensitive-content")
  const rootParts = parseCommand(command)
  if (!rootParts) return unresolved("unsupported-syntax")
  const entries: ExecutionEntry[] = [{
    id: 0,
    source: { kind: "request" },
    parts: rootParts.map((part) => ({ ...part, expandsTo: [] })),
  }]

  const expand = (
    entry: ExecutionEntry,
    ancestors: ReadonlySet<string>,
    depth: number,
    forwardedArgumentCount = 0,
  ): UnresolvedExecutionReason | undefined => {
    if (depth > maximumResolutionDepth) return "package-script-unresolved"
    for (const [partIndex, part] of entry.parts.entries()) {
      const invocation = packageInvocation(
        part.argv,
        partIndex === entry.parts.length - 1 ? forwardedArgumentCount : 0,
      )
      if (invocation === "invalid") return "package-script-unresolved"
      if (!invocation) continue
      if (!manifest) return "package-script-unresolved"
      part.argv = invocation.argv
      const key = `${invocation.manager}:${invocation.script}`
      if (ancestors.has(key)) return "package-script-unresolved"
      const main = manifest.scripts[invocation.script]
      if (main === undefined) return "package-script-unresolved"
      const nextAncestors = new Set([...ancestors, key])
      const definitions: Array<{
        phase: "pre" | "main" | "post"
        name: string
        body: string
        arguments: string[]
      }> = []
      const pre = manifest.scripts[`pre${invocation.script}`]
      const post = manifest.scripts[`post${invocation.script}`]
      if (pre !== undefined) {
        definitions.push({ phase: "pre", name: `pre${invocation.script}`, body: pre, arguments: [] })
      }
      definitions.push({
        phase: "main",
        name: invocation.script,
        body: main,
        arguments: invocation.arguments,
      })
      if (post !== undefined) {
        definitions.push({ phase: "post", name: `post${invocation.script}`, body: post, arguments: [] })
      }

      for (const definition of definitions) {
        if (entries.length >= maximumExecutionEntries) return "package-script-unresolved"
        const redacted = redactDurableCommand(definition.body)
        if (redacted.redacted) return "sensitive-content"
        if (redacted.truncated) return "package-script-unresolved"
        const parsed = parseCommand(definition.body)
        if (!parsed) return "unsupported-syntax"
        if (definition.arguments.length > 0) parsed.at(-1)!.argv.push(...definition.arguments)
        const nested: ExecutionEntry = {
          id: entries.length,
          source: {
            kind: "package-script",
            manager: invocation.manager,
            manifest: manifest.path,
            name: definition.name,
            phase: definition.phase,
            arguments: definition.arguments,
            sourceDigest: sourceDigest(definition.body),
          },
          parts: parsed.map((candidate) => ({ ...candidate, expandsTo: [] })),
        }
        entries.push(nested)
        part.expandsTo.push(nested.id)
        const failure = expand(nested, nextAncestors, depth + 1, definition.arguments.length)
        if (failure) return failure
      }
    }
    return undefined
  }

  const failure = expand(entries[0]!, new Set(), 0)
  if (failure) return unresolved(failure)
  return fingerprint({
    version: 1,
    coverage: "command-and-script-text",
    cwd,
    kind: "shell",
    entries,
  })
}

export function resolveCommandExecution(input: {
  command?: string
  cwd?: string
  packageScripts?: PackageScripts
  manifest?: string
}): ExecutionResolution {
  const command = input.command?.trim()
  if (!command) return unresolved("command-missing")
  return resolveShell(command, input.cwd ?? ".", input.packageScripts
    ? { path: input.manifest ?? "package.json", scripts: input.packageScripts }
    : undefined)
}

export async function resolveExecution(input: ExecutionInput): Promise<ExecutionResolution> {
  const command = input.command?.trim()
  if (!command) return unresolved("command-missing")
  const directory = await canonicalCwd(input.workspaceRoot, input.cwd)
  if (!directory) return unresolved("cwd-outside-project")
  if (fileTools.has(command)) {
    if (
      input.blockedPath !== undefined
      || input.filePath === undefined
      || !await pathStaysInside(directory.root, directory.absolute, input.filePath)
    ) return unresolved(input.filePath === undefined || input.blockedPath !== undefined
      ? "unsupported-syntax"
      : "cwd-outside-project")
    return fingerprint({
      version: 1,
      coverage: "tool-and-workspace-scope",
      cwd: directory.relative,
      kind: "workspace-file-tool",
      tool: command as "Edit" | "Write" | "MultiEdit" | "NotebookEdit",
      scope: "workspace",
    })
  }
  const parts = parseCommand(command)
  if (!parts) return unresolved("unsupported-syntax")
  const needsManifest = parts.some((part) => packageInvocation(part.argv) !== undefined)
  const manifest = needsManifest ? await readManifest(directory.root, directory.absolute) : undefined
  return resolveShell(command, directory.relative, manifest)
}
