import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  redactDurableCommand,
  redactDurableOutput,
  redactDurableText,
} from "./secret-redaction.js"

export function redactWorkspaceCopies(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const sanitized = structuredClone(snapshot)
  sanitized.approvals = sanitized.approvals.map((approval) => {
    const command = redactDurableCommand(approval.command)
    const operation = redactDurableText(approval.operation)
    const directory = redactDurableText(approval.directory)
    const affects = redactDurableText(approval.affects)
    const network = redactDurableText(approval.network)
    return {
      ...approval,
      risk: command.redacted || operation.redacted || directory.redacted
        || affects.redacted || network.redacted
        ? "hard-gate"
        : approval.risk,
      command: command.value,
      operation: operation.value,
      directory: directory.value,
      affects: affects.value,
      network: network.value,
    }
  })
  sanitized.approvalRules = sanitized.approvalRules.flatMap((rule) => {
    const command = redactDurableCommand(rule.command)
    const operation = redactDurableText(rule.operation)
    if (command.redacted || operation.redacted) return []
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
