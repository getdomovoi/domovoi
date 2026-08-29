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
  /(?:^|[/\\])\.env(?:$|\s)|(?:^|[/\\])\.ssh(?:[/\\]|$)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i,
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

export function permissionDecisionFor(input: {
  runtime: Runtime
  command?: string
  reason?: string
}): PermissionDecision {
  const command = input.command?.trim()
  const operation = `${command ?? ""}\n${input.reason ?? ""}`.trim()
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
