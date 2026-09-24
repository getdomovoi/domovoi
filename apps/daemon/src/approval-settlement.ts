import { dirname, join, resolve } from "node:path"

import type { ExecutionResolution, WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  approvalDirectory,
  approvalFacts,
  approvalOperands,
  executionRecordPaths,
  hiddenAffects,
  hiddenDirectory,
  hiddenFile,
  inWorktree,
  requestDirectory,
  requestOperands,
  resolveApprovalPath,
  savedApprovalAffects,
  scriptOperands,
  unrestrictedApprovalScope,
  type ApprovalScope,
} from "./approval-facts.js"
import {
  canonicalPath,
  isCredentialPath,
  operandsReachCredentialPath,
  realPathLookupBudgetMs,
} from "./credential-stores.js"
import { resolveExecution } from "./execution-resolution.js"
import { OperationDeadline } from "./operation-deadline.js"
import { namesSecretPath } from "./permission-policy.js"
import { redactDurableCommand, redactDurableText } from "./secret-redaction.js"
import { executionContainsSecret } from "./workspace-redaction.js"

// The one way an approval card is made. A new card, a card judged again
// before an Allow, a card read back from disk, and the request a standing rule
// would answer all come through settleApproval, and only the ledger below puts
// an approval into the snapshot. Under one deadline for the whole request it
// resolves the execution, reads every operand from the command and from that
// execution, judges every path the card or its record holds as written and at
// its real path, makes the card a hard gate when any of them is a credential
// path, and hides each such path. A request whose lookups do not finish in
// time is a hard gate with every path hidden.

export type Approval = WorkspaceSnapshot["approvals"][number]

declare const settledApproval: unique symbol
export type SettledApproval = Approval & { readonly [settledApproval]: true }

type DerivedField = "risk" | "operation" | "command" | "directory" | "affects" | "network" | "execution"
export type ApprovalIdentity = Omit<Approval, DerivedField>

// The request as the agent gave it, held in memory while its card waits. The
// directory and file are as written; a card read back from disk has only the
// text it saved.
export type ApprovalRequest = Readonly<{
  workspace: string
  cwd?: string | undefined
  path?: string | undefined
  command?: string | undefined
  reason?: string | undefined
  blockedPath?: string | undefined
}>

export type SavedCard = Readonly<{ directory: string; affects: string; network: string }>

export type SettlementInput = Readonly<{
  approval: ApprovalIdentity
  request: ApprovalRequest
  // Set for a card read back from disk: its directory, file and network
  // lines as saved, since the request behind them is gone.
  saved?: SavedCard | undefined
  scope: ApprovalScope | undefined
  // Resolve the execution now, or judge the record the card holds.
  execution: "resolve" | ExecutionResolution
  // The permission policy's risk for this execution, when no path is a
  // credential path.
  risk: (execution: ExecutionResolution) => Approval["risk"]
}>

export type Settlement = Readonly<{
  approval: SettledApproval
  // The execution as resolved, before the card hides it.
  execution: ExecutionResolution
  // Whether a path, operand, or text on the card is secret, or could not be
  // judged in time.
  sensitive: boolean
}>

const hiddenExecution: ExecutionResolution = { state: "unresolved", reason: "sensitive-content" }

const minted = new WeakSet<object>()

function mint(approval: Approval): SettledApproval {
  minted.add(approval)
  return approval as SettledApproval
}

function identityOf(approval: Approval): ApprovalIdentity {
  const { risk: _risk, operation: _operation, command: _command, directory: _directory, affects: _affects, network: _network, execution: _execution, ...identity } = approval
  return identity
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

export function sameApproval(left: Approval, right: Approval): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export function sameExecution(left: ExecutionResolution, right: ExecutionResolution): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function savedDirectoryHidden(saved: SavedCard | undefined): boolean {
  return saved !== undefined && saved.directory.includes("[REDACTED]")
}

// A card whose paths could not be judged: a hard gate, with the directory,
// the file and the execution record hidden. The command and operation lines
// stay the agent's own text, redacted as always.
function sealedCard(input: SettlementInput): SettledApproval {
  const { request, saved } = input
  const scope = input.scope ?? unrestrictedApprovalScope
  const directoryInside = inWorktree(request.workspace, request.cwd ?? request.workspace)
  const directory = saved !== undefined && savedDirectoryHidden(saved) ? saved.directory : hiddenDirectory(directoryInside)
  const affects = request.path !== undefined
    ? hiddenFile(inWorktree(request.workspace, resolve(request.workspace, request.cwd ?? ".", request.path)))
    : saved !== undefined ? hiddenAffects(redactDurableText(saved.affects).value) : scope.command
  return mint({
    ...input.approval,
    risk: "hard-gate",
    operation: redactDurableText(input.request.reason ?? "Run a command").value,
    command: redactDurableCommand(input.request.command ?? "Command details unavailable").value,
    directory,
    affects,
    network: saved !== undefined ? redactDurableText(saved.network).value : scope.network,
    execution: hiddenExecution,
  })
}

async function settleWithin(input: SettlementInput, deadline: OperationDeadline): Promise<Settlement> {
  const { request, saved } = input
  const execution = input.execution === "resolve"
    ? await resolveExecution({
        workspaceRoot: request.workspace,
        cwd: request.cwd ?? request.workspace,
        ...(request.command === undefined ? {} : { command: request.command }),
        ...(request.path === undefined ? {} : { filePath: request.path }),
        ...(request.blockedPath === undefined ? {} : { blockedPath: request.blockedPath }),
        deadline,
      })
    : input.execution
  const directoryHidden = savedDirectoryHidden(saved)
  const written = requestDirectory(request.workspace, request.cwd)
  const realDirectory = directoryHidden ? undefined : await canonicalPath(written, undefined, deadline)
  const realWorkspace = await canonicalPath(request.workspace, undefined, deadline)
  const workspaceOnDisk = typeof realWorkspace === "string" ? realWorkspace : request.workspace
  const directory = directoryHidden
    ? { text: saved!.directory, redacted: false, sensitive: true }
    : approvalDirectory({ directory: request.cwd ?? request.workspace, workspace: request.workspace, canonical: realDirectory })

  // Operands of the command, and of each script body from its package's
  // directory, each as written and at its real path.
  const operands = approvalOperands(request.command, execution)
  const operandsName = operands.some(isCredentialPath)
  let operandsReach = await operandsReachCredentialPath(
    requestOperands(request.command, execution),
    typeof realDirectory === "string" ? realDirectory : undefined,
    deadline,
  )
  for (const script of scriptOperands(execution)) {
    if (operandsReach) break
    operandsReach = await operandsReachCredentialPath(script.operands, join(workspaceOnDisk, dirname(script.manifest)), deadline)
  }

  // The record's own paths are relative to the worktree's real path.
  const recordNames = executionRecordPaths(execution).some((path) => (
    namesSecretPath(path) || namesSecretPath(join(workspaceOnDisk, path))
  ))

  let facts: { affects: string; network: string; redacted: boolean; sensitive: boolean }
  if (request.path !== undefined) {
    facts = approvalFacts({
      path: request.path,
      workspace: request.workspace,
      cwd: request.cwd,
      scope: input.scope,
      resolved: await resolveApprovalPath(request.workspace, request.path, request.cwd, deadline),
    })
  } else if (saved !== undefined) {
    // The saved line is all that is left of the request's file, so the file it
    // names is judged on disk now, as a new card's is.
    const affects = redactDurableText(saved.affects)
    const line = await savedApprovalAffects(affects.value, request.workspace, deadline)
    const network = redactDurableText(saved.network)
    facts = { affects: line.text, network: network.value, redacted: affects.redacted || network.redacted, sensitive: line.sensitive }
  } else {
    facts = approvalFacts({ workspace: request.workspace, cwd: request.cwd, scope: input.scope })
  }

  // A lookup that ran out of time gave no answer to trust.
  deadline.throwIfExpired()

  const command = redactDurableCommand(request.command ?? "Command details unavailable")
  const operation = redactDurableText(request.reason ?? "Run a command")
  const recordSecret = executionContainsSecret(execution)
  const hideRecord = directory.sensitive || recordNames || recordSecret
  const sensitive = command.redacted
    || operation.redacted
    || directory.redacted
    || directory.sensitive
    || facts.redacted
    || facts.sensitive
    || operandsName
    || operandsReach
    || recordNames
    || recordSecret
    || (execution.state === "unresolved" && execution.reason === "sensitive-content")
  const approval = mint({
    ...input.approval,
    risk: sensitive ? "hard-gate" : input.risk(execution),
    operation: operation.value,
    command: command.value,
    directory: directory.text,
    affects: facts.affects,
    network: facts.network,
    execution: hideRecord ? hiddenExecution : execution,
  })
  return { approval, execution, sensitive }
}

export async function settleApproval(input: SettlementInput, deadline?: OperationDeadline): Promise<Settlement> {
  const clock = deadline ?? OperationDeadline.start(realPathLookupBudgetMs)
  try {
    return await settleWithin(input, clock)
  } catch {
    // Out of time, or a lookup that failed: nothing on the card was judged.
    return { approval: sealedCard(input), execution: hiddenExecution, sensitive: true }
  } finally {
    if (deadline === undefined) clock.clear()
  }
}

// The settlement input for a card read back from disk: its command and
// operation as saved, its directory unless the saved card hid it, and its
// saved file and network lines.
export function savedSettlementInput(
  approval: Approval,
  workspace: string,
  scope: ApprovalScope | undefined,
  execution: "resolve" | ExecutionResolution,
  risk: SettlementInput["risk"],
): SettlementInput {
  return {
    approval: identityOf(approval),
    request: {
      workspace,
      ...(approval.directory.includes("[REDACTED]") ? {} : { cwd: approval.directory }),
      command: approval.command,
      reason: approval.operation,
    },
    saved: { directory: approval.directory, affects: approval.affects, network: approval.network },
    scope,
    execution,
    risk,
  }
}

// The settlement input for a request the daemon holds in memory.
export function heldSettlementInput(
  approval: Approval,
  request: ApprovalRequest,
  scope: ApprovalScope | undefined,
  execution: "resolve" | ExecutionResolution,
  risk: SettlementInput["risk"],
): SettlementInput {
  return { approval: identityOf(approval), request, scope, execution, risk }
}

// A card sealed as it stands, without a lookup: a hard gate with its paths
// hidden, located against the worktree when there is one.
export function sealedApproval(approval: Approval, workspace: string | undefined): SettledApproval {
  if (workspace !== undefined) {
    return sealedCard(savedSettlementInput(approval, workspace, undefined, approval.execution, () => "hard-gate"))
  }
  return mint({
    ...approval,
    risk: "hard-gate",
    operation: redactDurableText(approval.operation).value,
    command: redactDurableCommand(approval.command).value,
    directory: approval.directory.includes("[REDACTED]") ? approval.directory : hiddenDirectory(false),
    affects: hiddenAffects(redactDurableText(approval.affects).value),
    network: redactDurableText(approval.network).value,
    execution: hiddenExecution,
  })
}

type WorkspaceOf = (approval: Approval) => string | undefined

// Where settled approvals enter the snapshot, and the record of what each one
// looked like when it was settled. Every save and broadcast checks the live
// list against that record: an approval that did not come out of settlement,
// or that changed since, is sealed there.
export class ApprovalLedger {
  readonly #settled = new Map<string, string>()

  // The one write of an approval into a list: it replaces the approval with
  // the same id, or is appended.
  admit(approvals: Approval[], approval: SettledApproval): void {
    if (!minted.has(approval)) throw new TypeError("Only an approval settleApproval made can enter the snapshot")
    this.#settled.set(approval.id, canonicalJson(approval))
    const index = approvals.findIndex(({ id }) => id === approval.id)
    if (index === -1) approvals.push(approval)
    else approvals[index] = approval
  }

  // Put back a copy of an approval taken out, as when a decision is undone. A
  // copy that no longer matches what was settled goes back sealed.
  restore(approvals: Approval[], approval: Approval, workspaceOf: WorkspaceOf): void {
    if (approvals.some(({ id }) => id === approval.id)) return
    const copy = structuredClone(approval)
    if (this.isSettled(copy)) {
      approvals.push(copy)
      return
    }
    const sealed = sealedApproval(copy, workspaceOf(copy))
    this.#settled.set(sealed.id, canonicalJson(sealed))
    approvals.push(sealed)
  }

  isSettled(approval: Approval): boolean {
    return this.#settled.get(approval.id) === canonicalJson(approval)
  }

  // Seal every approval in the list that settlement did not produce, in
  // place, and name them.
  sealUnsettled(approvals: Approval[], workspaceOf: WorkspaceOf): string[] {
    const sealedIds: string[] = []
    for (const [index, approval] of approvals.entries()) {
      if (this.isSettled(approval)) continue
      const sealed = sealedApproval(approval, workspaceOf(approval))
      this.#settled.set(sealed.id, canonicalJson(sealed))
      approvals[index] = sealed
      sealedIds.push(approval.id)
    }
    if (this.#settled.size > approvals.length + 1_024) {
      const live = new Set(approvals.map(({ id }) => id))
      for (const id of this.#settled.keys()) if (!live.has(id)) this.#settled.delete(id)
    }
    return sealedIds
  }
}
