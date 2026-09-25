import { lstat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

import type { ExecutionResolution, WorkspaceSnapshot } from "@getdomovoi/protocol"

import {
  affectsLinePaths,
  approvalDirectory,
  approvalFacts,
  approvalOperands,
  executionRecordPaths,
  executionRecordText,
  hiddenAffects,
  hiddenDirectory,
  hiddenFile,
  hiddenFilePaths,
  inWorktree,
  requestDirectory,
  requestOperands,
  resolveApprovalPath,
  savedApprovalAffects,
  savedRequestPath,
  scriptOperands,
  unrestrictedApprovalScope,
  type ApprovalScope,
} from "./approval-facts.js"
import { pathHider } from "./approval-path-text.js"
import {
  canonicalPath,
  commandOperands,
  operandsAtCredentialPaths,
  realPathLookupBudgetMs,
  textOperands,
} from "./credential-stores.js"
import { resolutionReadsFilePath, resolveExecution } from "./execution-resolution.js"
import { cardDirectory, hidePaths, namesCredential, pathSpellings } from "./file-target-affects.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { isFileToolCommand, namesSecretPath } from "./permission-policy.js"
import { redactDurableCommand, redactDurableText } from "./secret-redaction.js"
import { executionContainsSecret } from "./workspace-redaction.js"

// The one way an approval card is made. A new card, a card judged again
// before an Allow, a card read back from disk, and the request a standing rule
// would answer all come through settleApproval, and only the ledger below puts
// an approval into the snapshot. Under one deadline for the whole request it
// resolves the execution, reads every operand from the command and from that
// execution, judges every path the card or its record holds as written and at
// its real path, makes the card a hard gate when any of them is a credential
// path, and hides each such path, on its own lines and where the card's
// command and operation lines name it. A secret file that only the agent's
// operation text names is judged by the same classifier and hidden the same
// way, and makes the card a hard gate. A request whose lookups do not finish in
// time is a hard gate with every path hidden. A card read back from disk
// trusts no path in its saved execution record: the execution is resolved
// again from the card's saved lines, and a record that differs, or any path
// that reaches a credential store, makes it a hard gate with the record
// hidden.
//
// Every path on a new or held card (its file, its directory and a path the
// provider blocked on) is also judged on #545's closed set of spellings
// (pathSpellings in file-target-affects.ts); a hidden path's forms are replaced
// with hidePaths before this module's own hider runs, and a set that hit its
// bound hides the card's command and operation whole.

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
  // The provider tool behind a request that is not a shell command.
  tool?: string | undefined
}>

export type SavedCard = Readonly<{
  directory: string
  affects: string
  network: string
  // The record the saved card held. It is compared with the execution
  // resolved now, never judged in its place.
  execution: ExecutionResolution
}>

export type SettlementInput = Readonly<{
  approval: ApprovalIdentity
  request: ApprovalRequest
  // Set for a card read back from disk: its directory, file and network
  // lines and its record as saved, since the request behind them is gone.
  // Its execution is always resolved again.
  saved?: SavedCard | undefined
  scope: ApprovalScope | undefined
  // Resolve the execution now, or judge the record a held request's card
  // holds.
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

// The command line a card shows when the request gave no command.
const commandUnavailable = "Command details unavailable"

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

// The forms of the directory a request runs in that the card's own text can
// hold: as written, against the worktree, and at its real path.
function directoryPaths(request: ApprovalRequest, real: string | undefined): string[] {
  return [
    request.cwd ?? request.workspace,
    requestDirectory(request.workspace, request.cwd),
    resolve(request.workspace, request.cwd ?? "."),
    ...(real === undefined ? [] : [real]),
  ]
}

async function existsBefore(path: string, deadline: OperationDeadline): Promise<boolean> {
  try {
    await beforeDeadline(lstat(path), deadline)
    return true
  } catch (error) {
    if (deadline.signal.aborted) throw error
    return false
  }
}

// Whether any operand reaches a credential path at its real path, read from
// base, and the operands the card hides with their real paths. Under a base
// that is itself a credential path every relative word reaches one; there a
// relative operand is a hidden path only when it exists, so a program name
// such as "ls" stays in the text.
async function operandsAtRealCredentialPaths(
  operands: readonly string[],
  base: string | undefined,
  deadline: OperationDeadline,
): Promise<{ reach: boolean; paths: string[] }> {
  const found = await operandsAtCredentialPaths(operands, base, deadline, namesSecretPath)
  const paths: string[] = []
  for (const { operand, real } of found) {
    const relative = !isAbsolute(operand) && !/^~(?:[/\\]|$)/u.test(operand)
    if (relative && base !== undefined && namesSecretPath(base) && !await existsBefore(join(base, operand), deadline)) continue
    paths.push(operand, ...(typeof real === "string" ? [real] : []))
  }
  return { reach: found.length > 0, paths }
}

// A card whose paths could not be judged: a hard gate, with the directory,
// the file and the execution record hidden. The command and operation lines
// stay the agent's own text, redacted as always, with each path the card
// hides replaced: the directory, the file, the saved file line's paths,
// every operand that names a credential path as written, and every secret file
// the operation text names.
function sealedCard(input: SettlementInput): SettledApproval {
  const { request, saved } = input
  const scope = input.scope ?? unrestrictedApprovalScope
  const directoryInside = inWorktree(request.workspace, request.cwd ?? request.workspace)
  const directoryWasHidden = savedDirectoryHidden(saved)
  const directory = saved !== undefined && directoryWasHidden ? saved.directory : hiddenDirectory(directoryInside)
  const affects = request.path !== undefined
    ? hiddenFile(inWorktree(request.workspace, resolve(request.workspace, request.cwd ?? ".", request.path)))
    : saved !== undefined ? hiddenAffects(redactDurableText(saved.affects).value) : scope.command
  const command = redactDurableCommand(request.command ?? commandUnavailable).value
  const operation = redactDurableText(request.reason ?? "Run a command").value
  const hider = pathHider([
    ...(directoryWasHidden ? [] : directoryPaths(request, undefined)),
    // The file in every form a new card hides it in, as written only: its
    // real paths could not be read.
    ...(request.path === undefined
      ? []
      : hiddenFilePaths({ path: request.path, workspace: request.workspace, cwd: request.cwd, resolved: undefined })),
    ...(saved === undefined ? [] : affectsLinePaths(redactDurableText(saved.affects).value)),
    ...(request.blockedPath === undefined ? [] : [request.blockedPath]),
    ...commandOperands(command).filter(namesSecretPath),
    ...textOperands(operation).filter(namesSecretPath),
  ])
  return mint({
    ...input.approval,
    risk: "hard-gate",
    operation: hider.hide(operation),
    command: hider.hide(command),
    directory,
    affects,
    network: saved !== undefined ? redactDurableText(saved.network).value : scope.network,
    execution: hiddenExecution,
  })
}

type ResolutionRequest = { cwd: string; command?: string; filePath?: string; blockedPath?: string; tool?: string }

// What a card read back from disk gives resolveExecution: its saved directory
// and command, and for a file or read tool the file its saved line names,
// located against the worktree. A saved card that does not give these back
// cannot be resolved again as its request was, and throws, so it is sealed:
// one whose directory is hidden, and a file or read tool's card whose line is
// not a file line it can read back as a path, whether hidden, unreadable, a
// provider's reach, or an older daemon's wording. Resolving such a card
// without its file would judge a request it never made. A blocked path lived
// only in memory; a card that had one resolves differently now, and so is a
// hard gate.
function savedResolutionRequest(request: ApprovalRequest, saved: SavedCard): ResolutionRequest {
  if (savedDirectoryHidden(saved)) throw new Error("A saved card hides the directory its request ran in")
  const command = request.command === commandUnavailable ? undefined : request.command
  const resolution: ResolutionRequest = { cwd: request.cwd ?? request.workspace, ...(command === undefined ? {} : { command }) }
  if (!resolutionReadsFilePath(command)) return resolution
  const path = savedRequestPath(redactDurableText(saved.affects).value)
  if (path === undefined) throw new Error("A saved file or read tool card does not name the file its request named")
  return { ...resolution, filePath: resolve(request.workspace, path) }
}

function heldResolutionRequest(request: ApprovalRequest): ResolutionRequest {
  return {
    cwd: request.cwd ?? request.workspace,
    ...(request.command === undefined ? {} : { command: request.command }),
    ...(request.path === undefined ? {} : { filePath: request.path }),
    ...(request.blockedPath === undefined ? {} : { blockedPath: request.blockedPath }),
    ...(request.tool === undefined ? {} : { tool: request.tool }),
  }
}

async function settleWithin(input: SettlementInput, deadline: OperationDeadline): Promise<Settlement> {
  const { request, saved } = input
  // A saved card's record is never judged in place of the execution: every
  // path in it may lead somewhere else now.
  const execution = saved !== undefined || input.execution === "resolve"
    ? await resolveExecution({
        workspaceRoot: request.workspace,
        ...(saved === undefined ? heldResolutionRequest(request) : savedResolutionRequest(request, saved)),
        deadline,
      })
    : input.execution
  const savedRecord = saved?.execution
  const recordMatches = savedRecord === undefined || sameExecution(execution, savedRecord)
  const directoryHidden = savedDirectoryHidden(saved)
  const written = requestDirectory(request.workspace, request.cwd)
  const realDirectory = directoryHidden ? undefined : await canonicalPath(written, undefined, deadline)
  const realWorkspace = await canonicalPath(request.workspace, undefined, deadline)
  const workspaceOnDisk = typeof realWorkspace === "string" ? realWorkspace : request.workspace
  const judgedDirectory = directoryHidden
    ? { text: saved!.directory, redacted: false, sensitive: true }
    : approvalDirectory({ directory: request.cwd ?? request.workspace, workspace: request.workspace, canonical: realDirectory })
  // The directory's closed spelling set (#545): a secret name in any spelling
  // hides it too, and its forms are hidden in the card's text.
  const spelledDirectory = directoryHidden
    ? undefined
    : await cardDirectory({ directory: request.cwd ?? request.workspace, workspace: request.workspace }, deadline)
  const directory = spelledDirectory?.hidden === true && !judgedDirectory.sensitive
    ? { text: spelledDirectory.text, redacted: judgedDirectory.redacted, sensitive: true }
    : judgedDirectory

  // Operands of the command, and of each script body from its package's
  // directory, each as written and at its real path.
  const operands = approvalOperands(request.command, execution)
  const operandsName = operands.some(namesSecretPath)
  const reached = [await operandsAtRealCredentialPaths(
    requestOperands(request.command, execution),
    typeof realDirectory === "string" ? realDirectory : undefined,
    deadline,
  )]
  for (const script of scriptOperands(execution)) {
    reached.push(await operandsAtRealCredentialPaths(script.operands, join(workspaceOnDisk, dirname(script.manifest)), deadline))
  }
  const operandsReach = reached.some(({ reach }) => reach)

  // The record's own paths are relative to the worktree's real path.
  const recordNames = executionRecordPaths(execution).some((path) => (
    namesSecretPath(path) || namesSecretPath(join(workspaceOnDisk, path))
  ))

  // The file's closed spelling set (#545), judged with the rest of the file's
  // facts, and hidden in the card's text whenever the file is.
  const fileSpellings = request.path === undefined
    ? undefined
    : await pathSpellings({ workspace: request.workspace, path: request.path, cwd: request.cwd }, deadline)
  // The path a provider blocked on is never drawn on the card; when any
  // spelling of it names a credential path, or the durable redaction changes
  // it, the card hides it and is a hard gate.
  const blockedSpellings = request.blockedPath === undefined
    ? undefined
    : await pathSpellings({ workspace: request.workspace, path: request.blockedPath, cwd: request.cwd }, deadline)
  const blockedHidden = request.blockedPath !== undefined && blockedSpellings !== undefined
    && (namesCredential(blockedSpellings) || redactDurableText(request.blockedPath).redacted)

  let facts: { affects: string; network: string; redacted: boolean; sensitive: boolean; hiddenPaths: string[] }
  if (request.path !== undefined) {
    facts = approvalFacts({
      path: request.path,
      workspace: request.workspace,
      cwd: request.cwd,
      scope: input.scope,
      resolved: await resolveApprovalPath(request.workspace, request.path, request.cwd, deadline),
      spellings: fileSpellings,
    })
  } else if (saved !== undefined) {
    // The saved line is all that is left of the request's file, so the file it
    // names is judged on disk now, as a new card's is.
    const affects = redactDurableText(saved.affects)
    const line = await savedApprovalAffects(affects.value, request.workspace, deadline)
    const network = redactDurableText(saved.network)
    facts = {
      affects: line.text,
      network: network.value,
      redacted: affects.redacted || network.redacted,
      sensitive: line.sensitive,
      hiddenPaths: line.hiddenPaths,
    }
  } else {
    facts = approvalFacts({ workspace: request.workspace, cwd: request.cwd, scope: input.scope })
  }

  // A lookup that ran out of time gave no answer to trust.
  deadline.throwIfExpired()

  // The exact forms #545 hides, from each closed set the card hides: the
  // file, the directory and the blocked path. A set that hit its bound cannot
  // be hidden form by form, so the card's text is hidden whole.
  const fileHidden = facts.redacted || facts.sensitive
  const spelledForms = [
    ...(fileHidden && fileSpellings !== undefined ? fileSpellings.forms : []),
    ...(directory.sensitive && spelledDirectory !== undefined ? spelledDirectory.forms : []),
    ...(blockedHidden ? blockedSpellings!.forms : []),
  ]
  const hidesWhole = fileSpellings?.complete === false
    || spelledDirectory?.complete === false
    || blockedSpellings?.complete === false
  const shownForms = [...spelledForms, ...spelledForms.map((form) => redactDurableText(form).value)]
  // #545's forms go first, on the text as the agent gave it and again after
  // the durable redaction; #541's hider then runs on what is left.
  const spelled = (text: string) => hidesWhole ? "[REDACTED]" : hidePaths(text, spelledForms)
  const commandCopy = redactDurableCommand(spelled(request.command ?? commandUnavailable))
  const operationCopy = redactDurableText(spelled(request.reason ?? "Run a command"))
  const command = { ...commandCopy, value: hidesWhole ? commandCopy.value : hidePaths(commandCopy.value, shownForms) }
  const operation = { ...operationCopy, value: hidesWhole ? operationCopy.value : hidePaths(operationCopy.value, shownForms) }
  // A secret file the agent's own text names is judged by the same
  // classifier, and hidden, even when no request field names it.
  const textPaths = textOperands(operation.value).filter(namesSecretPath)
  // Each path the card hides is replaced in its own text too, and a record
  // that holds one in a command word is hidden.
  const hider = pathHider([
    ...(directory.sensitive && !directoryHidden
      ? directoryPaths(request, typeof realDirectory === "string" ? realDirectory : undefined)
      : []),
    ...facts.hiddenPaths,
    ...operands.filter(namesSecretPath),
    ...reached.flatMap(({ paths }) => paths),
    ...textPaths,
  ])
  const recordHoldsHiddenPath = executionRecordText(execution)
    .some((word) => hider.holds(word) || (spelledForms.length > 0 && hidePaths(word, spelledForms) !== word))
  // A file tool's record names its file, so a card that hides the file shows
  // no record, resolved or not (#545).
  const fileToolRequest = request.path !== undefined
    && request.tool === undefined
    && request.command !== undefined
    && isFileToolCommand(request.command)
  const recordNamesHiddenFile = fileHidden
    && (fileToolRequest || (execution.state === "resolved" && execution.record.kind === "workspace-file-tool"))
  const recordSecret = executionContainsSecret(execution)
  const sensitive = command.redacted
    || operation.redacted
    || directory.redacted
    || directory.sensitive
    || facts.redacted
    || facts.sensitive
    || operandsName
    || operandsReach
    || textPaths.length > 0
    || blockedHidden
    || hidesWhole
    || recordNames
    || recordSecret
    || (execution.state === "unresolved" && execution.reason === "sensitive-content")
    || (savedRecord?.state === "unresolved" && savedRecord.reason === "sensitive-content")
  // A saved card whose record differs from the one resolved now, or with any
  // path or operand that reaches a credential store, is a hard gate and shows
  // no record.
  const hideRecord = directory.sensitive
    || recordNames
    || recordSecret
    || recordHoldsHiddenPath
    || recordNamesHiddenFile
    || !recordMatches
    || (saved !== undefined && sensitive)
  const approval = mint({
    ...input.approval,
    risk: sensitive || !recordMatches ? "hard-gate" : input.risk(execution),
    operation: hider.hide(operation.value),
    command: hider.hide(command.value),
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
// operation as saved, its directory unless the saved card hid it, its saved
// file and network lines, and the record it held. Its execution is resolved
// again from these.
export function savedSettlementInput(
  approval: Approval,
  workspace: string,
  scope: ApprovalScope | undefined,
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
    saved: { directory: approval.directory, affects: approval.affects, network: approval.network, execution: approval.execution },
    scope,
    execution: "resolve",
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
    return sealedCard(savedSettlementInput(approval, workspace, undefined, () => "hard-gate"))
  }
  const directoryWasHidden = approval.directory.includes("[REDACTED]")
  const command = redactDurableCommand(approval.command).value
  const operation = redactDurableText(approval.operation).value
  const hider = pathHider([
    ...(directoryWasHidden ? [] : [approval.directory]),
    ...affectsLinePaths(redactDurableText(approval.affects).value),
    ...commandOperands(command).filter(namesSecretPath),
    ...textOperands(operation).filter(namesSecretPath),
  ])
  return mint({
    ...approval,
    risk: "hard-gate",
    operation: hider.hide(operation),
    command: hider.hide(command),
    directory: directoryWasHidden ? approval.directory : hiddenDirectory(false),
    affects: hiddenAffects(redactDurableText(approval.affects).value),
    network: redactDurableText(approval.network).value,
    execution: hiddenExecution,
  })
}

// A settled card under the next revision: the daemon rewrote it, so an Allow
// given to the card as it was is refused (approval.resolve compares the
// revision the client showed). Only a settled card is carried forward.
export function nextRevision(approval: SettledApproval): SettledApproval {
  if (!minted.has(approval)) throw new TypeError("Only an approval settleApproval made can take a new revision")
  return mint({ ...approval, revision: approval.revision + 1 })
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
