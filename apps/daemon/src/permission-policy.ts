import type { ApprovalRisk, Runtime } from "@getdomovoi/protocol"

export type PermissionDecision = {
  action: "allow" | "review"
  risk: ApprovalRisk
}

const secretPathStart = String.raw`(?:^|[\s:=/\\'"])`
const secretPathEnd = String.raw`(?![\w.-])`
const secretFileNames = [
  String.raw`[\w.-]*\.env(?:rc|\.[\w.-]+)?`,
  String.raw`\.ssh`,
  String.raw`\.aws[/\\]credentials`,
  String.raw`\.kube[/\\]config`,
  String.raw`\.docker[/\\]config\.json`,
  String.raw`gh[/\\]hosts\.yml`,
  String.raw`daemon\.token`,
  String.raw`credentials\.json`,
  String.raw`\.netrc`,
  String.raw`\.npmrc`,
  String.raw`\.pypirc`,
  String.raw`[\w.-]+\.(?:pem|key|p12|pfx)`,
] as const
const secretFilePattern = new RegExp(
  `${secretPathStart}(?:${secretFileNames.join("|")})${secretPathEnd}`,
  "i",
)

const hardGatePatterns = [
  /\b(?:sudo|doas|pkexec)\b/i,
  /\b(?:rm|rmdir|shred|mkfs|chmod|chown)\b/i,
  /\b(?:git\s+(?:clean|reset\s+--hard)|git\s+push\b[^\n]*\s--force(?:-with-lease)?\b|git\s+branch\s+-D\b)/i,
  /\b(?:deploy|release|publish)\b/i,
  /\bterraform\s+(?:apply|destroy)\b/i,
  /\b(?:kubectl\s+(?:apply|delete|patch)|helm\s+(?:upgrade|uninstall))\b/i,
  /\b(?:drop|truncate)\s+(?:database|schema|table)\b/i,
  /\b(?:migrate|migration)\b/i,
  secretFilePattern,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i,
  /\b(?:printenv|keychain|security\s+find-(?:generic|internet)-password|pass\s+show)\b/i,
  /\b(?:curl|wget|ssh|scp|sftp)\b/i,
  /\bexternal[_ -]?directory\b/i,
] as const

const fileToolCommands = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

export function isFileToolCommand(command: string): boolean {
  return fileToolCommands.has(command)
}

const gitSummaryFlag = String.raw`--(?:stat|shortstat|numstat|name-only|name-status)`
const safeBuildAutoPatterns = [
  /^git\s+status(?:\s+(?:--(?:porcelain(?:=v[12])?|short|branch|long|untracked-files(?:=(?:no|normal|all))?)|-[sb]+|-u(?:no|normal|all)?))*$/i,
  new RegExp(String.raw`^git\s+diff(?:\s+(?:${gitSummaryFlag}|--(?:check|cached|staged)))*$`, "i"),
  new RegExp(
    String.raw`^git\s+log(?:\s+(?:${gitSummaryFlag}|--(?:oneline|graph|decorate|all|abbrev-commit|no-merges|first-parent)|--max-count=\d+|-n\s*\d+|-\d+))*$`,
    "i",
  ),
  /^pwd$/i,
] as const

const ambiguousShellSyntax = /[\r\n`$<>(){}\\]/
const skillInstallerPackage = String.raw`(?:@[a-z0-9._-]+\/)?(?:skills?|skill-installer)(?:@[^\s]+)?`
const skillCliInstallPatterns = [
  new RegExp(String.raw`^npx(?:\s+(?:-y|--yes))*\s+${skillInstallerPackage}\s+(?:add|install)\b`, "i"),
  new RegExp(String.raw`^npm\s+exec(?:\s+(?:-y|--yes))*\s+(?:--\s+)?${skillInstallerPackage}\s+(?:--\s+)?(?:add|install)\b`, "i"),
  new RegExp(String.raw`^pnpm\s+(?:dlx|exec)\s+${skillInstallerPackage}\s+(?:add|install)\b`, "i"),
  new RegExp(String.raw`^bunx\s+${skillInstallerPackage}\s+(?:add|install)\b`, "i"),
  new RegExp(String.raw`^bun\s+x\s+${skillInstallerPackage}\s+(?:add|install)\b`, "i"),
] as const
const downloadBootstrap = /^(?:curl|wget)\b[^\r\n|]*\|\s*(?:(?:ba|z)?sh|pwsh|powershell)(?:\.exe)?(?:\s|$)/i
const shellInvocation = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s\r\n]+))\s+(.+)$/
const shellExecutables = new Set(["sh", "bash", "zsh", "pwsh", "powershell", "powershell.exe"])
const skillBootstrapScript = /(?:install|bootstrap)[-_.]?skills?|skills?[-_.]?(?:install|bootstrap)/i

function withoutOuterQuotes(value: string): string {
  const quote = value[0]
  return value.length >= 2 && (quote === "\"" || quote === "'") && value.at(-1) === quote
    ? value.slice(1, -1).trim()
    : value
}

function shellPayloadFor(value: string): string | undefined {
  const match = shellInvocation.exec(value)
  if (!match) return undefined
  const executable = match[1] ?? match[2] ?? match[3] ?? ""
  const basename = executable.split(/[/\\]/).at(-1)?.toLowerCase()
  if (!basename || !shellExecutables.has(basename)) return undefined
  const remainder = match[4]!.trim()
  const option = /^(?:-c|-lc?|-command|\/c)\s+(.+)$/i.exec(remainder)
  return withoutOuterQuotes(option?.[1] ?? remainder)
}

// A command line is as many commands as it has separators, and an install
// hidden after one of them is still an install. Each piece is judged on its
// own, and an installer is recognised wherever it sits in the piece, since a
// wrapper such as xargs or env in front of it changes nothing about what runs.
const commandSeparators = /\s*(?:&&|\|\||;|\|)\s*/
const skillCliInstallAnywhere = skillCliInstallPatterns.map(
  (pattern) => new RegExp(pattern.source.replace(/^\^/, String.raw`(?:^|\s)`), pattern.flags),
)

function isSkillInstallSegment(segment: string): boolean {
  let candidate = segment.trim()
  for (let depth = 0; depth < 4; depth += 1) {
    if (skillCliInstallPatterns.some((pattern) => pattern.test(candidate))) return true
    if (skillCliInstallAnywhere.some((pattern) => pattern.test(candidate))) return true
    if (
      /\bskills?\b/i.test(candidate)
      && /\b(?:install|bootstrap)\b/i.test(candidate)
      && downloadBootstrap.test(candidate)
    ) return true
    const shellPayload = shellPayloadFor(candidate)
    if (!shellPayload) return false
    candidate = shellPayload
    if (skillBootstrapScript.test(candidate)) return true
    if (candidate.split(commandSeparators).some((inner) => inner !== candidate && isSkillInstallSegment(inner))) {
      return true
    }
  }
  return false
}

export function isSkillInstallCommand(command: string): boolean {
  const trimmed = command.trim()
  if (isSkillInstallSegment(trimmed)) return true
  return trimmed.split(commandSeparators).some((segment) => segment !== trimmed && isSkillInstallSegment(segment))
}

const packageManagers = new Set(["pnpm", "npm", "yarn", "bun"])
const packageSubcommands = new Set([
  "exec", "dlx", "x", "install", "i", "add", "remove", "rm", "up", "update",
  "audit", "publish", "pack", "create", "init", "link", "why", "dedupe", "store", "patch",
])
const scriptName = /^[a-z0-9](?:[a-z0-9:._-]*[a-z0-9])?$/i

type PackageScriptRun = { script: string; rest: string }

function packageScriptRun(command: string): PackageScriptRun | undefined {
  const tokens = command.trim().split(/\s+/)
  const manager = tokens[0]?.toLowerCase()
  if (!manager || !packageManagers.has(manager)) return undefined
  const explicitRun = tokens[1]?.toLowerCase() === "run"
  const index = explicitRun ? 2 : 1
  const script = tokens[index]
  if (!script || !scriptName.test(script)) return undefined
  if (!explicitRun && packageSubcommands.has(script.toLowerCase())) return undefined
  return { script, rest: tokens.slice(index + 1).join(" ") }
}

type BodyDecision = "allow" | "review" | "hard-gate"

// A script name authorizes nothing on its own: what runs is the body the
// manifest defines today, and an agent that can edit the manifest can change
// it. Judge the resolved body, and every body it delegates to, by the same
// rules as a typed command.
// A resolved body is only as safe as what it actually runs, and the hard-gate
// patterns describe what is known dangerous rather than what is known safe.
// Anything outside this list is reviewed, so an unrecognised runner cannot ride
// in on a script name a human once trusted.
const boundedScriptRunners = new Set([
  "vitest", "jest", "mocha", "ava", "tsc", "tsd", "eslint", "biome", "prettier",
  "stylelint", "oxlint", "tsup", "vite", "rollup", "esbuild", "swc", "webpack",
  "next", "astro", "rimraf", "changeset", "attw", "publint", "knip", "madge",
])

function boundedLeafCommand(candidate: string): boolean {
  const tokens = candidate.split(/\s+/)
  const executable = tokens[0]?.toLowerCase()
  if (executable === undefined) return false
  if (boundedScriptRunners.has(executable)) return true
  // `npx vitest run` and `pnpm exec tsc` are the same leaf wearing a runner.
  if (["npx", "pnpm", "npm", "yarn", "bun"].includes(executable)) {
    const rest = tokens.slice(1).filter((token) => !token.startsWith("-"))
    const next = rest[0]?.toLowerCase()
    if (next === "exec" || next === "dlx" || next === "run" || next === "x") {
      return boundedScriptRunners.has(rest[1]?.toLowerCase() ?? "")
    }
    return boundedScriptRunners.has(next ?? "")
  }
  return false
}

function resolvedScriptDecision(
  body: string,
  scripts: Readonly<Record<string, string>>,
  seen: ReadonlySet<string>,
): BodyDecision {
  if (seen.size > 4) return "review"
  if (hardGatePatterns.some((pattern) => pattern.test(body))) return "hard-gate"
  if (ambiguousShellSyntax.test(body)) return "review"
  const segments = body.split(commandSeparators).map((segment) => segment.trim()).filter(Boolean)
  if (segments.length === 0) return "review"
  for (const candidate of segments) {
    if (hardGatePatterns.some((pattern) => pattern.test(candidate))) return "hard-gate"
    const nested = packageScriptRun(candidate)
    if (nested) {
      if (seen.has(nested.script)) return "review"
      const nestedBody = scripts[nested.script]
      if (nestedBody === undefined) return "review"
      const decision = resolvedScriptDecision(
        `${nestedBody} ${nested.rest}`.trim(),
        scripts,
        new Set([...seen, nested.script]),
      )
      if (decision !== "allow") return decision
      continue
    }
    if (!boundedLeafCommand(candidate)) return "review"
  }
  return "allow"
}

export function permissionDecisionFor(input: {
  runtime: Runtime
  command?: string
  reason?: string
  packageScripts?: Readonly<Record<string, string>>
}): PermissionDecision {
  const command = input.command?.trim()
  const operation = `${command ?? ""}\n${input.reason ?? ""}`.trim()
  if (command && isSkillInstallCommand(command)) {
    return { action: "review", risk: "hard-gate" }
  }
  if (hardGatePatterns.some((pattern) => pattern.test(operation))) {
    return { action: "review", risk: "hard-gate" }
  }
  const isBuildAuto = input.runtime.permissionMode === "build" && input.runtime.auto
  if (isBuildAuto && command !== undefined && !ambiguousShellSyntax.test(command)) {
    if (safeBuildAutoPatterns.some((pattern) => pattern.test(command))) {
      return { action: "allow", risk: "normal" }
    }
    const invocation = packageScriptRun(command)
    const scripts = input.packageScripts
    const body = invocation && scripts ? scripts[invocation.script] : undefined
    if (invocation && scripts && body !== undefined) {
      const decision = resolvedScriptDecision(
        `${body} ${invocation.rest}`.trim(),
        scripts,
        new Set([invocation.script]),
      )
      if (decision === "allow") return { action: "allow", risk: "normal" }
      if (decision === "hard-gate") return { action: "review", risk: "hard-gate" }
    }
  }
  return { action: "review", risk: "normal" }
}
