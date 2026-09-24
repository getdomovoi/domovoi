import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { approvalDirectory } from "./approval-facts.js"
import {
  redactDurableCommand,
  redactDurableOutput,
  redactDurableText,
} from "./secret-redaction.js"

function executionContainsSecret(
  execution: WorkspaceSnapshot["approvals"][number]["execution"],
): boolean {
  if (execution.state !== "resolved" || execution.record.kind !== "shell") return false
  return execution.record.entries.some((entry) => (
    entry.parts.some((part) => redactDurableCommand(part.argv.join(" ")).redacted)
    || (entry.source.kind === "package-script"
      && redactDurableCommand(entry.source.arguments.join(" ")).redacted)
  ))
}

export function redactWorkspaceCopies(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const sanitized = structuredClone(snapshot)
  sanitized.approvals = sanitized.approvals.map((approval) => {
    const command = redactDurableCommand(approval.command)
    const operation = redactDurableText(approval.operation)
    // A directory saved before it was classified is hidden here too, judged
    // as written; its location is read against the session worktree.
    const directory = approvalDirectory({
      directory: approval.directory,
      workspace: sanitized.sessions.find((session) => session.id === approval.sessionId)?.workspacePath
        ?? sanitized.project?.path,
    })
    const affects = redactDurableText(approval.affects)
    const network = redactDurableText(approval.network)
    const unsafeExecution = executionContainsSecret(approval.execution)
    return {
      ...approval,
      risk: command.redacted || operation.redacted || directory.redacted || directory.sensitive
        || affects.redacted || network.redacted || unsafeExecution
        ? "hard-gate"
        : approval.risk,
      command: command.value,
      operation: operation.value,
      directory: directory.text,
      affects: affects.value,
      network: network.value,
      execution: unsafeExecution
        ? { state: "unresolved", reason: "sensitive-content" }
        : approval.execution,
    }
  })
  sanitized.approvalRules = sanitized.approvalRules.flatMap((rule) => {
    const command = redactDurableCommand(rule.command)
    const operation = redactDurableText(rule.operation)
    if (
      command.redacted
      || operation.redacted
      || ((rule.status === "active" || rule.inactiveReason === "revoked") && executionContainsSecret(rule.execution))
    ) return []
    return [{ ...rule, command: command.value, operation: operation.value }]
  })
  sanitized.thread = sanitized.thread.map((item) => {
    if (item.kind === "tool") {
      return {
        ...item,
        title: redactDurableCommand(item.title).value,
        ...(item.output === undefined
          ? {}
          : { output: redactDurableOutput(item.output).value }),
      }
    }
    if (item.kind === "receipt") {
      return {
        ...item,
        operation: redactDurableText(item.operation).value,
        ...(item.explanation === undefined
          ? {}
          : { explanation: redactDurableText(item.explanation).value }),
      }
    }
    if (item.kind === "policy-refusal") {
      return {
        ...item,
        operation: redactDurableText(item.operation).value,
        command: redactDurableCommand(item.command).value,
        rule: redactDurableText(item.rule).value,
        setBy: redactDurableText(item.setBy).value,
        scope: redactDurableText(item.scope).value,
        remedy: redactDurableText(item.remedy).value,
      }
    }
    if (item.kind === "checkpoint") {
      return { ...item, label: redactDurableText(item.label).value }
    }
    if (item.kind === "system") {
      return {
        ...item,
        body: redactDurableText(item.body).value,
        ...(item.detail === undefined
          ? {}
          : { detail: redactDurableText(item.detail).value }),
      }
    }
    return { ...item, body: redactDurableText(item.body).value }
  })
  return sanitized
}
