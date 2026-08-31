import type { ApprovalRisk, Runtime } from "@getdomovoi/protocol"

export type PermissionDecision = {
  action: "allow" | "review"
  risk: ApprovalRisk
}

const hardGatePatterns = [
  /\b(?:sudo|doas|pkexec)\b/i,
  /\b(?:rm|rmdir|shred|mkfs|chmod|chown)\b/i,
  /\b(?:git\s+(?:clean|reset\s+--hard)|git\s+push\b[^\n]*\s--force(?:-with-lease)?\b|git\s+branch\s+-D\b)/i,
  /\b(?:deploy|release|publish)\b/i,
  /\bterraform\s+(?:apply|destroy)\b/i,
  /\b(?:kubectl\s+(?:apply|delete|patch)|helm\s+(?:upgrade|uninstall))\b/i,
  /\b(?:drop|truncate)\s+(?:database|schema|table)\b/i,
  /\b(?:migrate|migration)\b/i,
  /(?:^|[/\\:])\.env(?:$|\s)|(?:^|[/\\:])\.ssh(?:[/\\]|$)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i,
  /\b(?:printenv|keychain|security\s+find-(?:generic|internet)-password|pass\s+show)\b/i,
  /\b(?:curl|wget|ssh|scp|sftp)\b/i,
  /\bexternal[_ -]?directory\b/i,
] as const

const safeBuildAutoPatterns = [
  /^(?:pnpm|npm|bun|yarn)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)(?:\s[^;&|]*)?$/i,
  /^git\s+(?:status|diff|log|show)(?:\s[^;&|]*)?$/i,
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

export function isSkillInstallCommand(command: string): boolean {
  let candidate = command.trim()
  for (let depth = 0; depth < 4; depth += 1) {
    if (skillCliInstallPatterns.some((pattern) => pattern.test(candidate))) return true
    if (
      /\bskills?\b/i.test(candidate)
      && /\b(?:install|bootstrap)\b/i.test(candidate)
      && downloadBootstrap.test(candidate)
    ) return true
    const shellPayload = shellPayloadFor(candidate)
    if (!shellPayload) return false
    candidate = shellPayload
    if (skillBootstrapScript.test(candidate)) return true
  }
  return false
}

export function permissionDecisionFor(input: {
  runtime: Runtime
  command?: string
  reason?: string
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
  if (
    isBuildAuto
    && command !== undefined
    && !ambiguousShellSyntax.test(command)
    && safeBuildAutoPatterns.some((pattern) => pattern.test(command))
  ) {
    return { action: "allow", risk: "normal" }
  }
  return { action: "review", risk: "normal" }
}
