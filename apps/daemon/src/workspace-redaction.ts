import { resolve } from "node:path"

import { maximumPairedDeviceLabelLength, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  affectsLinePaths,
  approvalAffects,
  approvalDirectory,
  executionNamesCredentialPath,
  executionRecordText,
} from "./approval-facts.js"
import { pathHider } from "./approval-path-text.js"
import { commandOperands, textOperands } from "./credential-stores.js"
import { namesSecretPath } from "./permission-policy.js"
import {
  redactDurableCommand,
  redactDurableOutput,
  redactDurableText,
} from "./secret-redaction.js"

// A paired device's label is a person's own text, so it can carry a secret
// the way any durable text can. It is redacted before it enters a receipt or
// a terminal owner, and again on every stored copy for snapshots written
// before that. The replacement marker can lengthen the text past the label's
// schema bound, so the result is cut back to it. The device's id is an
// identifier, not text, and is never touched.
export function redactDeviceLabel(label: string): string {
  return redactDurableText(label).value.slice(0, maximumPairedDeviceLabelLength).trim()
}

export function executionContainsSecret(
  execution: WorkspaceSnapshot["approvals"][number]["execution"],
): boolean {
  if (executionNamesCredentialPath(execution)) return true
  if (execution.state !== "resolved" || execution.record.kind !== "shell") return false
  return execution.record.entries.some((entry) => (
    entry.parts.some((part) => redactDurableCommand(part.argv.join(" ")).redacted)
    || (entry.source.kind === "package-script"
      && redactDurableCommand(entry.source.arguments.join(" ")).redacted)
  ))
}

type ThreadItem = WorkspaceSnapshot["thread"][number]

export function redactWorkspaceCopies(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const sanitized = redactWorkspaceRecords(snapshot)
  sanitized.thread = redactThreadCopies(snapshot.thread)
  return sanitized
}

// Redacted copies of thread items, as redactWorkspaceCopies writes them, for
// items that arrive from elsewhere before they join a snapshot.
export function redactThreadCopies(items: readonly ThreadItem[]): ThreadItem[] {
  return items.map((item) => redactThreadItem(structuredClone(item)))
}

export type WorkspaceRedactor = (snapshot: WorkspaceSnapshot) => WorkspaceSnapshot

// Redacts as redactWorkspaceCopies does, for a writer that is handed the whole
// snapshot again and again while a provider streams into one item of it.
// Redacting a thread item reads that item and nothing else, so an item equal
// to the one the previous call redacted under its id gets the same copy back,
// and a write redacts the items that changed rather than the project's whole
// history. What keeps that sound:
// - an item is reused only when every field equals, by value, the item its
//   copy was made from, so text appended in place under the same id is
//   redacted again;
// - that source is a private copy, so a caller that goes on editing its live
//   item cannot make an old copy look current;
// - reused copies are frozen, so a caller that edits a returned snapshot
//   cannot change what a later write carries;
// - approvals and rules read the sessions and project around them, so they
//   are redacted whole on every call; and
// - only the latest snapshot's items are kept, so the cache is at most one
//   thread (two where redaction changed an item, since the source is kept).
export function createWorkspaceRedactor(): WorkspaceRedactor {
  let redacted = new Map<string, { source: ThreadItem; copy: ThreadItem }>()
  return (snapshot) => {
    const sanitized = redactWorkspaceRecords(snapshot)
    const kept = new Map<string, { source: ThreadItem; copy: ThreadItem }>()
    sanitized.thread = snapshot.thread.map((item) => {
      let entry = redacted.get(item.id)
      if (entry === undefined || !sameValue(entry.source, item)) {
        const copy = deepFreeze(redactThreadItem(structuredClone(item)))
        // Most items hold nothing to redact, and one frozen copy then serves
        // as both the source and the copy.
        entry = { source: sameValue(copy, item) ? copy : structuredClone(item), copy }
      }
      kept.set(item.id, entry)
      return entry.copy
    })
    redacted = kept
    return sanitized
  }
}

// Equality by value over the JSON values a snapshot holds.
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index])) return false
    }
    return true
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  let keys = 0
  for (const key in leftRecord) {
    if (!Object.hasOwn(leftRecord, key)) continue
    keys += 1
    if (!Object.hasOwn(rightRecord, key) || !sameValue(leftRecord[key], rightRecord[key])) return false
  }
  for (const key in rightRecord) {
    if (Object.hasOwn(rightRecord, key)) keys -= 1
  }
  return keys === 0
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

// A copy of everything but the thread, with approvals and rules redacted. The
// thread is left empty for the caller to fill.
function redactWorkspaceRecords(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const sanitized = structuredClone({ ...snapshot, thread: [] })
  sanitized.approvals = sanitized.approvals.map((approval) => {
    const command = redactDurableCommand(approval.command)
    const operation = redactDurableText(approval.operation)
    // A directory saved before it was classified is hidden here too, judged
    // as written; its location is read against the session worktree.
    const workspace = sanitized.sessions.find((session) => session.id === approval.sessionId)?.workspacePath
      ?? sanitized.project?.path
    const directory = approvalDirectory({ directory: approval.directory, workspace })
    const affects = redactDurableText(approval.affects)
    // A file line saved before its path was classified is judged here too.
    const affectsLine = approvalAffects(affects.value)
    const network = redactDurableText(approval.network)
    // Each path the card hides, judged as written, is replaced in its own
    // command and operation lines, and a record that holds one is hidden.
    const hider = pathHider([
      ...(directory.sensitive
        ? [approval.directory, ...(workspace === undefined ? [] : [resolve(workspace, approval.directory)])]
        : []),
      ...(affectsLine.sensitive ? affectsLinePaths(affects.value) : []),
      ...commandOperands(command.value).filter(namesSecretPath),
      ...textOperands(operation.value, namesSecretPath).filter(namesSecretPath),
    ])
    const commandText = hider.hide(command.value)
    const operationText = hider.hide(operation.value)
    const pathsHidden = commandText !== command.value || operationText !== operation.value
    const unsafeExecution = executionContainsSecret(approval.execution)
      || executionRecordText(approval.execution).some(hider.holds)
    return {
      ...approval,
      risk: command.redacted || operation.redacted || directory.redacted || directory.sensitive
        || affects.redacted || affectsLine.sensitive || network.redacted || unsafeExecution || pathsHidden
        ? "hard-gate"
        : approval.risk,
      command: commandText,
      operation: operationText,
      directory: directory.text,
      affects: affectsLine.text,
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
      || ("execution" in rule && executionContainsSecret(rule.execution))
    ) return []
    return [{ ...rule, command: command.value, operation: operation.value }]
  })
  return sanitized
}

// Reads the item and nothing else, which is what lets createWorkspaceRedactor
// reuse a copy. The item is the caller's own copy.
function redactThreadItem(item: ThreadItem): ThreadItem {
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
    // The receipt keeps the card's operation line, so a secret file that
    // line names is replaced here too.
    const operation = redactDurableText(item.operation).value
    return {
      ...item,
      operation: pathHider(textOperands(operation, namesSecretPath).filter(namesSecretPath)).hide(operation),
      ...(item.explanation === undefined
        ? {}
        : { explanation: redactDurableText(item.explanation).value }),
      ...(item.device === undefined
        ? {}
        : { device: { id: item.device.id, label: redactDeviceLabel(item.device.label) } }),
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
}
