import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"

import {
  buildVersion,
  maximumToolInventoryNameLength,
  type ApprovalDecision,
  type ProviderModel,
  type ProviderUsageLimits,
  type Runtime,
} from "@getdomovoi/protocol"

import type { AgentAdapter, AgentEvent, AgentRepositoryTrust, AgentWorkingPlanStep, ApprovalScope } from "./agents.js"
import { codexSandboxReach } from "./approval-facts.js"
import {
  codexMainCheckoutConfigFile,
  codexMainCheckoutConfigRefusal,
  codexMainCheckoutHooksFile,
  codexMainCheckoutHooksRefusal,
  codexProjectTrustKeys,
  codexRepositoryConfigFile,
  codexRepositoryConfigRefusal,
} from "./codex-repository-config.js"
import {
  codexOwnServerNames,
  codexRepositoryLoad,
  codexTrustedThreadConfig,
  withoutOwnServers,
  type CodexRepositoryServer,
} from "./codex-repository-trust.js"
import { credentialStores } from "./credential-stores.js"
import { redactInventoryText } from "./inventory-redaction.js"
import { projectInstructions } from "./project-instructions.js"
import { repositoryTrustVerdict } from "./repository-trust-apply.js"
import { redactDurableText } from "./secret-redaction.js"
import type { RepositoryProviderConfigReader } from "./tool-inventory.js"
import { normalizeProviderUsage } from "./usage.js"
import { onProcessEnd } from "./process-end.js"

export type { AgentAdapter, AgentEvent } from "./agents.js"

export type JsonRpcMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

export interface CodexTransport {
  send(message: JsonRpcMessage): void
  onMessage(listener: (message: JsonRpcMessage) => void): () => void
  onError?(listener: (error: Error) => void): () => void
  close(): Promise<void>
}

export type CodexPermissionProfile = "domovoi-read" | "domovoi-build"

export type CodexPolicy = {
  approvalPolicy: "on-request" | "never"
  permissions: CodexPermissionProfile
}

// Codex reads anywhere its sandbox allows without asking. Until a strict
// allow-list exists (it needs a survey of the toolchains commands load), both
// Domovoi profiles keep today's read access and refuse these credential
// stores. Every other read outside the worktree still runs without a card.
export const codexSecretLocations: readonly string[] = credentialStores.map(({ location }) => location)

// Secret files inside the worktree are refused too (owner ruling, 2026-09-22),
// in every mode. A test or build that loads one of them inside the sandbox
// fails with "Operation not permitted".
export const codexWorktreeSecretPatterns = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
] as const

// Codex emits no item for a command its sandbox refuses, so Domovoi cannot see
// the attempt. The person is told when a session reaches Codex, and the model
// is asked to say so itself when a command fails on one of these files.
const codexWorktreeSecretFiles = codexWorktreeSecretPatterns.map((pattern) => pattern.replace(/^\*\*\//, ""))

export const codexWorktreeSecretNotice = {
  body: "Codex cannot read secret files in this worktree.",
  detail: `The Codex sandbox refuses reads of ${codexWorktreeSecretFiles.slice(0, -1).join(", ")} and ${codexWorktreeSecretFiles.at(-1)} at any depth. A test or build that loads .env fails with "Operation not permitted". Codex does not report the refused read to Domovoi, so it shows only in the agent's reply.`,
} as const

// The notice names committed copies of those files too, which Codex can
// still read through Git, or says the history could not be checked.
export function codexSandboxNotice(committed: readonly string[] | undefined): { body: string; detail: string } {
  if (committed === undefined) {
    return {
      body: codexWorktreeSecretNotice.body,
      detail: `${codexWorktreeSecretNotice.detail} Domovoi could not finish checking the repository history.`,
    }
  }
  if (committed.length === 0) return codexWorktreeSecretNotice
  const list = committed.length === 1
    ? committed[0]!
    : `${committed.slice(0, -1).join(", ")} and ${committed.at(-1)!}`
  return {
    body: codexWorktreeSecretNotice.body,
    detail: `${codexWorktreeSecretNotice.detail} Codex can still read these through Git: ${list}.`,
  }
}

export const codexDeveloperInstructions = `Domovoi runs you in a sandbox that refuses reads of these files anywhere in the worktree: ${codexWorktreeSecretFiles.join(", ")}. A command that opens one of them fails with "Operation not permitted", for example a test or build that loads .env. Domovoi cannot see that failure. When a command fails on one of these files, say so in your reply and name the file.`

type CodexContextEntry = { kind: "application"; value: string }

const codexSandboxContext: Record<string, CodexContextEntry> = {
  "domovoi-sandbox": { kind: "application", value: codexDeveloperInstructions },
}

// Codex shortens the middle of any additionalContext value over 1,000 tokens,
// counted as 4,000 bytes (context-fragments and utils/string at
// rust-v0.156.1). Longer instructions go as numbered entries, each within that
// size and cut after a line where one falls in its second half. Codex orders
// entries by key.
const codexContextValueBytes = 4_000
const projectInstructionsKey = "domovoi-project-instructions"

export function codexProjectInstructionsContext(text: string | undefined): Record<string, CodexContextEntry> {
  if (text === undefined) return {}
  const parts = utf8Parts(text, codexContextValueBytes)
  if (parts.length === 1) return { [projectInstructionsKey]: { kind: "application", value: text } }
  return Object.fromEntries(parts.map((value, index) => [
    `${projectInstructionsKey}-${String(index + 1).padStart(2, "0")}`,
    { kind: "application", value },
  ]))
}

function utf8Parts(text: string, limit: number): string[] {
  const bytes = Buffer.from(text, "utf8")
  const parts: string[] = []
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + limit, bytes.length)
    if (end < bytes.length) {
      while (end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1
      const newline = bytes.lastIndexOf(0x0a, end - 1)
      if (newline >= start + limit / 2) end = newline + 1
      // An escaped tag (&lt;) stays whole in one entry.
      const escape = bytes.lastIndexOf(0x26, end - 1)
      if (escape > start && escape > end - 4 && bytes.toString("latin1", escape, escape + 4) === "&lt;") end = escape
    }
    parts.push(bytes.toString("utf8", start, end))
    start = end
  }
  return parts
}

// Marking every path Codex consults for trust as untrusted keeps Codex from
// loading repository configuration and from recording trust of its own when a
// writable thread starts. It also stops Codex reading the repository's
// AGENTS.md, which Domovoi sends with each turn instead. A trusted
// repository's servers that pass are added beside it (codex-repository-trust.ts).
function codexThreadConfig(cwd: string, servers: Readonly<Record<string, CodexRepositoryServer>> = {}): Record<string, unknown> {
  const projects = Object.fromEntries(codexProjectTrustKeys(cwd).map((key) => [key, { trust_level: "untrusted" as const }]))
  return Object.keys(servers).length === 0 ? { projects } : { projects, ...codexTrustedThreadConfig(servers) }
}

// What a thread may take from a trusted worktree: the digest its verdict
// compared, and the servers codex-repository-trust.ts lets pass.
type RepositoryPlan = { digest: string; servers: Record<string, CodexRepositoryServer> }

export function codexAppServerArguments(): string[] {
  const worktreeSecrets = `{${codexWorktreeSecretPatterns.map((pattern) => `${JSON.stringify(pattern)}="deny"`).join(",")}}`
  const denied = `{${[
    ...codexSecretLocations.map((location) => `${JSON.stringify(location)}="deny"`),
    `":workspace_roots"=${worktreeSecrets}`,
  ].join(",")}}`
  const profile = (name: CodexPermissionProfile, base: string) => [
    "-c", `permissions.${name}.extends=${JSON.stringify(base)}`,
    "-c", `permissions.${name}.filesystem=${denied}`,
    "-c", `permissions.${name}.network.enabled=false`,
  ]
  return [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    `default_permissions=${JSON.stringify(":workspace")}`,
    ...profile("domovoi-read", ":read-only"),
    ...profile("domovoi-build", ":workspace"),
  ]
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
}

const STDERR_TAIL_BYTES = 16_384

export function codexPolicyFor(runtime: Runtime): CodexPolicy {
  if (runtime.permissionMode === "ask") return { approvalPolicy: "on-request", permissions: "domovoi-read" }
  if (runtime.permissionMode === "plan") return { approvalPolicy: "never", permissions: "domovoi-read" }
  return {
    approvalPolicy: runtime.permissionMode === "build" && runtime.auto ? "never" : "on-request",
    permissions: "domovoi-build",
  }
}

export class StdioCodexTransport implements CodexTransport {
  #child: ChildProcessWithoutNullStreams
  #messageListeners = new Set<(message: JsonRpcMessage) => void>()
  #errorListeners = new Set<(error: Error) => void>()
  #closing = false
  #closed = false
  #failed = false
  #closePromise: Promise<void> | undefined
  #shutdownGraceMs: number

  constructor(childFactory: () => ChildProcessWithoutNullStreams = () => spawn(
    "codex",
    codexAppServerArguments(),
    { stdio: ["pipe", "pipe", "pipe"] },
  ), shutdownGraceMs = 2_000) {
    this.#child = childFactory()
    this.#shutdownGraceMs = shutdownGraceMs
    const stderrTail = captureStderrTail(this.#child.stderr)
    // Once the process has exited, or its stdout has ended, an unparseable line
    // is not reported: the process-end report below carries the reason it
    // stopped, usually a sign-in failure on stderr. Such a line is a fragment
    // the process died in the middle of, or output a background process that
    // inherited the pipe wrote after the exit. The end listener is registered
    // before readline's own, so it is set by the time readline flushes a last
    // line that had no newline.
    let stdoutEnded = false
    let exited = false
    this.#child.stdout.once("end", () => { stdoutEnded = true })
    this.#child.once("exit", () => { exited = true })
    const lines = createInterface({ input: this.#child.stdout })
    lines.on("line", (line) => {
      try {
        const message = requireJsonRpcMessage(JSON.parse(line))
        for (const listener of this.#messageListeners) listener(message)
      } catch {
        if (stdoutEnded || exited) return
        this.#emitError(new Error("Codex app-server emitted invalid JSONL"))
      }
    })
    this.#child.on("error", (error) => this.#emitError(error))
    this.#child.stdin.on("error", (error) => this.#emitError(error))
    this.#child.stdout.on("error", (error) => this.#emitError(error))
    this.#child.stderr.on("error", (error) => this.#emitError(error))
    onProcessEnd(this.#child, (code, signal) => {
      if (this.#closing) return
      const exit = code !== null
        ? `Codex app-server exited with code ${code}`
        : `Codex app-server exited from signal ${signal ?? "unknown"}`
      const stderr = redactDurableText(stderrTail()).value
      this.#emitError(new Error(stderr ? `${exit}: ${stderr}` : exit))
    })
    this.#child.once("close", () => {
      this.#closed = true
    })
  }

  send(message: JsonRpcMessage): void {
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.#emitError(failure)
      throw failure
    }
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#messageListeners.add(listener)
    return () => this.#messageListeners.delete(listener)
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener)
    return () => this.#errorListeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    if (this.#closed || this.#child.exitCode !== null || this.#child.signalCode !== null) return
    this.#closePromise = new Promise<void>((resolve) => {
      let settled = false
      let forced: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forced) clearTimeout(forced)
        this.#child.off("close", finish)
        resolve()
      }
      const timer = setTimeout(() => {
        if (
          this.#closed
          || this.#child.exitCode !== null
          || this.#child.signalCode !== null
        ) {
          finish()
          return
        }
        this.#child.kill("SIGKILL")
        // A kill is a request to the kernel, not the exit itself. Waiting for
        // the real close keeps the caller from treating an app-server that
        // still holds its workspace open as stopped, and keeps a replacement
        // from starting alongside it.
        forced = setTimeout(finish, this.#shutdownGraceMs)
        forced.unref()
      }, this.#shutdownGraceMs)
      timer.unref()
      this.#child.once("close", finish)
      this.#child.kill("SIGTERM")
    })
    await this.#closePromise
  }

  #emitError(error: Error): void {
    if (this.#closing || this.#failed) return
    this.#failed = true
    for (const listener of this.#errorListeners) listener(error)
  }
}

// Codex runs a command inside its sandbox unless the request is to run outside
// it, which is what most approvals are. The sandbox is the one codexPolicyFor
// picks for the mode: read-only in Ask and Plan, workspace-write in Build, and
// both read the whole disk. Neither has network: workspace-write sets it off,
// and read-only's networkAccess defaults to false in the app-server schema.
export function codexApprovalScope(runtime: Runtime): ApprovalScope {
  const profile = codexPolicyFor(runtime).permissions
  return {
    command: profile === "domovoi-read" ? codexSandboxReach.read : codexSandboxReach.write,
    network: "None inside the Codex sandbox. A request to run outside the sandbox has this machine's network access.",
  }
}

export class CodexAppServerAdapter implements AgentAdapter {
  approvalScope(runtime: Runtime): ApprovalScope { return codexApprovalScope(runtime) }
  readonly permissionCapabilities = { ask: "read-only", buildAuto: "unsupported" } as const
  #transportFactory: () => CodexTransport
  #transport: CodexTransport | undefined
  #nextId = 0
  #pending = new Map<number, PendingRequest>()
  #eventListeners = new Set<(event: AgentEvent) => void>()
  #unsubscribeMessage: (() => void) | undefined
  #unsubscribeError: (() => void) | undefined
  #connectPromise: Promise<void> | undefined
  #collaborationModeAvailable = true
  #additionalContextAvailable = true
  // Running mcpToolCall items by item id, so a tool server approval can name
  // its call, and the approvals Codex asked for as MCP elicitations, which are
  // answered in that shape. Both belong to the transport that sent them.
  #toolServerCalls = new Map<string, ToolServerCall>()
  #toolServerApprovals = new Set<number>()
  // Threads opened on this transport under a trusted verdict, by thread id,
  // with the digest it compared: their turns skip the worktree refusal
  // (ruling Q143 A). And threads given a trusted repository's servers: Codex
  // ignores a resume's config for a thread it still holds, so one stays here
  // until it is archived or the transport ends.
  #trustedThreads = new Map<string, string>()
  #trustApplied = new Map<string, { digest: string }>()
  readonly #readRepositoryConfig: RepositoryProviderConfigReader | undefined

  constructor(
    transportFactory: () => CodexTransport = () => new StdioCodexTransport(),
    // How a session's worktree configuration is read for its trust verdict;
    // the repository reader unless a test gives another.
    readRepositoryConfig?: RepositoryProviderConfigReader,
  ) {
    this.#transportFactory = transportFactory
    this.#readRepositoryConfig = readRepositoryConfig
  }

  async connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise
    if (this.#transport) return
    const connecting = this.#openTransport()
    this.#connectPromise = connecting
    try {
      await connecting
    } finally {
      if (this.#connectPromise === connecting) this.#connectPromise = undefined
    }
  }

  async resetConnection(): Promise<void> {
    const transport = this.#transport
    this.#connectPromise = undefined
    if (transport) this.#detachTransport(transport)
    this.#rejectPending(new Error("Codex connection reset"))
    await transport?.close()
  }

  // Each open, a start or a resume, decides from the grant it is given what
  // the worktree may bring (#repositoryPlan). With no grant, as for an
  // archive resume (ruling Q149 A), the check runs before Codex is asked
  // anything, as it always has.
  async startThread({ cwd, runtime, repositoryTrust }: Parameters<AgentAdapter["startThread"]>[0]): Promise<string> {
    const plan = repositoryTrust === undefined ? undefined : await this.#repositoryPlan(cwd, repositoryTrust)
    refuseRepositoryConfig(cwd, plan !== undefined)
    const policy = codexPolicyFor(runtime)
    const sandbox = policy.permissions === "domovoi-read" ? "read-only" : "workspace-write"
    // thread/start developerInstructions replaces the person's own
    // developer_instructions rather than adding to them, so Domovoi reads the
    // value Codex resolved for this worktree and sends both. With servers to
    // pass, the same read names the person's own servers, layer by layer.
    const offered = plan !== undefined && Object.keys(plan.servers).length > 0
    const read = await this.#request("config/read", offered ? { cwd, includeLayers: true } : { cwd })
    const own = resolvedDeveloperInstructions(read)
    const servers = plan === undefined ? {} : serversToPass(plan, read)
    refuseRepositoryConfig(cwd, plan !== undefined)
    const result = await this.#request("thread/start", {
      cwd,
      model: runtime.model,
      approvalPolicy: policy.approvalPolicy,
      sandbox,
      serviceName: "domovoi",
      developerInstructions: own ? `${own}\n\n${codexDeveloperInstructions}` : codexDeveloperInstructions,
      config: codexThreadConfig(cwd, servers),
    })
    const threadId = nestedId(result, "thread")
    if (!threadId) throw new Error("Codex did not return a thread id")
    this.#opened(threadId, plan, servers)
    return threadId
  }

  // The digest of the trusted configuration whose servers this thread was
  // given, or undefined when it was given none: held back, or trusted with
  // no server that passes. Codex cannot confirm a server's process stopped
  // with the thread (ruling Q152 A), so a thread stays reported until it is
  // archived or this transport ends.
  repositoryTrustApplied(threadId: string): { digest: string } | undefined {
    return this.#trustApplied.get(threadId)
  }

  // The worktree's verdict under the grant, read just before Codex is asked
  // to open the thread: only a trusted one brings anything, and it brings the
  // documents its digest was computed from.
  async #repositoryPlan(cwd: string, grant: AgentRepositoryTrust): Promise<RepositoryPlan | undefined> {
    const verdict = await repositoryTrustVerdict(cwd, grant, this.#readRepositoryConfig)
    return verdict.state === "trusted"
      ? { digest: verdict.configDigest, servers: codexRepositoryLoad(verdict.documents).mcpServers }
      : undefined
  }

  #opened(threadId: string, plan: RepositoryPlan | undefined, servers: Readonly<Record<string, CodexRepositoryServer>>): void {
    if (plan === undefined) this.#trustedThreads.delete(threadId)
    else this.#trustedThreads.set(threadId, plan.digest)
    if (plan !== undefined && Object.keys(servers).length > 0) this.#trustApplied.set(threadId, { digest: plan.digest })
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const models: ProviderModel[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    let pageCount = 0
    do {
      if (cursor) {
        if (seenCursors.has(cursor)) break
        seenCursors.add(cursor)
      }
      if (pageCount >= 50) break
      pageCount += 1
      const page = requireModelPage(await this.#request("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }, signal))
      for (const candidate of page.data) {
        const id = candidate.id
        if (!id || candidate.hidden) continue
        const displayName = candidate.displayName?.trim() || id
        const supportedReasoningEfforts = (candidate.supportedReasoningEfforts ?? [])
          .map((effort) => effort.trim())
          .filter((effort) => effort.length > 0)
        const requestedDefault = candidate.defaultReasoningEffort?.trim()
        const defaultReasoningEffort = requestedDefault
          ? requestedDefault
          : supportedReasoningEfforts[0] ?? "medium"
        if (
          supportedReasoningEfforts.length > 0
          && !supportedReasoningEfforts.includes(defaultReasoningEffort)
        ) {
          supportedReasoningEfforts.unshift(defaultReasoningEffort)
        }
        models.push({
          provider: "codex",
          id,
          displayName,
          description: candidate.description ?? "",
          supportedReasoningEfforts,
          defaultReasoningEffort,
          isDefault: candidate.isDefault ?? false,
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return models
  }

  async usageLimits(signal?: AbortSignal): Promise<ProviderUsageLimits | undefined> {
    return parseCodexUsageLimits(await this.#request(
      "account/rateLimits/read",
      { excludeResetCreditDetails: true },
      signal,
    ))
  }

  async stopThread(threadId: string): Promise<void> {
    await this.#request("thread/archive", { threadId })
    this.#trustedThreads.delete(threadId)
    this.#trustApplied.delete(threadId)
  }

  async resumeThread({ threadId, cwd, repositoryTrust }: Parameters<AgentAdapter["resumeThread"]>[0]): Promise<void> {
    // This open decides again: until it succeeds under a trusted verdict, the
    // thread's turns meet the worktree refusal (ruling Q144 A).
    this.#trustedThreads.delete(threadId)
    const plan = repositoryTrust === undefined ? undefined : await this.#repositoryPlan(cwd, repositoryTrust)
    refuseRepositoryConfig(cwd, plan !== undefined)
    let servers: Record<string, CodexRepositoryServer> = {}
    if (plan !== undefined && Object.keys(plan.servers).length > 0) {
      servers = serversToPass(plan, await this.#request("config/read", { cwd, includeLayers: true }))
      refuseRepositoryConfig(cwd, true)
    }
    const result = await this.#request("thread/resume", { threadId, config: codexThreadConfig(cwd, servers) })
    if (nestedId(result, "thread") !== threadId) {
      throw new Error("Codex did not resume the requested thread")
    }
    this.#opened(threadId, plan, servers)
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#request("turn/interrupt", { threadId, turnId })
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    const result = await this.#request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: prompt }],
    })
    if (asRecord(result)?.turnId !== turnId) throw new Error("Codex steered a different turn")
  }

  // A turn's grant is not read: a running thread keeps what it was opened
  // with, checked again at its next open (rulings Q143 A and Q144 A).
  async startTurn({ threadId, cwd, prompt, runtime }: Parameters<AgentAdapter["startTurn"]>[0]): Promise<string> {
    const policy = codexPolicyFor(runtime)
    const params = {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      model: runtime.model,
      effort: runtime.reasoning,
      ...policy,
    }
    const collaborationMode = {
      mode: runtime.permissionMode === "plan" ? "plan" : "default",
      settings: {
        model: runtime.model,
        reasoning_effort: runtime.reasoning,
        developer_instructions: null,
      },
    }
    // Thread developer instructions reach the model only when the thread
    // starts, so a thread started before Domovoi sent them, then resumed,
    // would never learn which files the sandbox refuses. Every turn carries
    // the same text as context, which Codex keeps once per source key, and
    // the repository's AGENTS.md, read again for each turn. A Codex without
    // the field gets the rest of the turn unchanged.
    const additionalContext = {
      ...codexProjectInstructionsContext(await projectInstructions(cwd, "codex")),
      ...codexSandboxContext,
    }
    let result: unknown
    for (;;) {
      const withCollaboration = this.#collaborationModeAvailable
      const withContext = this.#additionalContextAvailable
      refuseRepositoryConfig(cwd, this.#trustedThreads.has(threadId))
      try {
        result = await this.#request("turn/start", {
          ...params,
          ...(withCollaboration ? { collaborationMode } : {}),
          ...(withContext ? { additionalContext } : {}),
        })
        break
      } catch (error) {
        if (withContext && additionalContextUnavailable(error)) {
          this.#additionalContextAvailable = false
          continue
        }
        if (withCollaboration && collaborationModeUnavailable(error)) {
          this.#collaborationModeAvailable = false
          continue
        }
        throw error
      }
    }
    const turnId = nestedId(result, "turn")
    if (!turnId) throw new Error("Codex did not return a turn id")
    return turnId
  }

  resolveApproval(
    requestId: number,
    decision: ApprovalDecision,
  ): void {
    const mapped = decision === "allow-once" || decision === "always-project"
      ? "accept"
      : "decline"
    // An accepted elicitation with no persist in its _meta runs the call once;
    // Codex is never asked to remember a tool server answer.
    if (this.#toolServerApprovals.delete(requestId)) {
      this.#transport?.send({ id: requestId, result: { action: mapped, content: null } })
      return
    }
    this.#transport?.send({ id: requestId, result: { decision: mapped } })
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  async close(): Promise<void> {
    const transport = this.#transport
    if (transport) this.#detachTransport(transport)
    this.#rejectPending(new Error("Codex adapter closed"))
    await transport?.close()
  }

  #request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const transport = this.#transport
    if (!transport) return Promise.reject(new Error("Codex adapter is not connected"))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id)
        reject(signal!.reason)
      }
      const cleanup = () => signal?.removeEventListener("abort", abort)
      signal?.addEventListener("abort", abort, { once: true })
      this.#pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
      })
      try {
        transport.send({ id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async #openTransport(): Promise<void> {
    const transport = this.#transportFactory()
    this.#transport = transport
    this.#collaborationModeAvailable = true
    this.#additionalContextAvailable = true
    this.#unsubscribeMessage = transport.onMessage((message) => {
      if (this.#transport === transport) this.#receive(message)
    })
    this.#unsubscribeError = transport.onError?.((error) => {
      this.#handleTransportFailure(transport, error)
    })
    try {
      const clientInfo = { name: "domovoi", title: "Domovoi", version: buildVersion }
      try {
        await this.#request("initialize", {
          clientInfo,
          capabilities: { experimentalApi: true },
        })
      } catch (error) {
        if (!collaborationModeUnavailable(error)) throw error
        this.#collaborationModeAvailable = false
        await this.#request("initialize", { clientInfo })
      }
      if (this.#transport !== transport) {
        throw new Error("Codex transport disconnected during initialization")
      }
      transport.send({ method: "initialized", params: {} })
    } catch (error) {
      if (this.#transport === transport) {
        this.#detachTransport(transport)
        this.#rejectPending(error instanceof Error ? error : new Error(String(error)))
        await transport.close().catch(() => undefined)
      }
      throw error
    }
  }

  #handleTransportFailure(transport: CodexTransport, error: Error): void {
    if (this.#transport !== transport) return
    this.#detachTransport(transport)
    this.#rejectPending(error)
    this.#emit({ type: "provider-disconnected", reason: error.message })
    void transport.close().catch(() => undefined)
  }

  #detachTransport(transport: CodexTransport): void {
    if (this.#transport !== transport) return
    this.#unsubscribeMessage?.()
    this.#unsubscribeError?.()
    this.#unsubscribeMessage = undefined
    this.#unsubscribeError = undefined
    this.#transport = undefined
    this.#toolServerCalls.clear()
    this.#toolServerApprovals.clear()
    // The app-server that held these threads is gone; each is opened again,
    // and checked again, on the next transport.
    this.#trustedThreads.clear()
    this.#trustApplied.clear()
  }

  #receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"))
      else pending.resolve(message.result)
      return
    }

    const params = message.params ?? {}
    const common = {
      ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
      ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
    }
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.#emit({
        type: "text-delta",
        ...common,
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
        delta: params.delta,
      })
    } else if (message.method === "item/plan/delta" && typeof params.delta === "string") {
      this.#emit({ type: "plan-delta", ...common, delta: params.delta })
    } else if (message.method === "turn/plan/updated" && typeof params.threadId === "string") {
      const steps = codexPlanSteps(params.plan)
      if (steps) this.#emit({ type: "plan-updated", ...common, threadId: params.threadId, steps })
    } else if (
      message.method === "item/commandExecution/outputDelta" &&
      typeof params.delta === "string"
    ) {
      this.#emit({
        type: "command-output",
        ...common,
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
        delta: params.delta,
      })
    } else if (message.method === "turn/diff/updated" && typeof params.diff === "string") {
      this.#emit({ type: "diff-updated", ...common, diff: params.diff })
    } else if (
      message.method === "item/commandExecution/requestApproval" &&
      message.id !== undefined
    ) {
      this.#emit({
        type: "approval-requested",
        requestId: message.id,
        ...common,
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
        ...(typeof params.command === "string" ? { command: params.command } : {}),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      })
    } else if (message.method === "mcpServer/elicitation/request" && message.id !== undefined) {
      // A server's own question is not an approval and is left as before; a
      // marked request that is not tied to one running call is declined.
      const request = toolServerApproval(params, this.#toolServerCalls)
      if (request === "not-approval") return
      if (request === "decline") {
        this.#transport?.send({ id: message.id, result: { action: "decline", content: null } })
        return
      }
      this.#toolServerApprovals.add(message.id)
      this.#emit({ type: "approval-requested", requestId: message.id, ...common, ...request })
    } else if (message.method === "item/started" || message.method === "item/completed") {
      const item = asRecord(params.item)
      if (
        item?.type === "mcpToolCall" && typeof item.id === "string" && typeof params.threadId === "string"
        && typeof params.turnId === "string" && typeof item.server === "string" && typeof item.tool === "string"
      ) {
        if (message.method === "item/started") {
          this.#toolServerCalls.set(item.id, {
            threadId: params.threadId,
            turnId: params.turnId,
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
          })
        } else this.#toolServerCalls.delete(item.id)
      }
      this.#emit({
        type: "item",
        phase: message.method === "item/started" ? "started" : "completed",
        params,
      })
    } else if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params.tokenUsage)
      const last = asRecord(tokenUsage?.last)
      // Codex defines last.totalTokens as current context. tokenUsage.total is
      // cumulative session usage and must never drive context occupancy.
      const usage = last ? normalizeProviderUsage({
        usage: last,
        contextTokens: last.totalTokens,
        contextWindowTokens: tokenUsage?.modelContextWindow,
      }) : undefined
      if (usage && typeof params.threadId === "string" && typeof params.turnId === "string") {
        this.#emit({ type: "usage", threadId: params.threadId, turnId: params.turnId, usage })
      }
    } else if (message.method === "turn/completed") {
      for (const [itemId, call] of this.#toolServerCalls) {
        if (call.threadId === params.threadId) this.#toolServerCalls.delete(itemId)
      }
      const usage = normalizeProviderUsage(params.turn ?? params)
      if (usage && typeof params.threadId === "string" && typeof params.turnId === "string") {
        this.#emit({ type: "usage", threadId: params.threadId, turnId: params.turnId, usage })
      }
      this.#emit({ type: "turn-completed", params })
    }
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#eventListeners) listener(event)
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

type ToolServerCall = { threadId: string; turnId: string; server: string; tool: string; arguments: unknown }

type ToolServerApproval = { itemId: string; command: string; tool: string; toolServer: { name: string }; reason: string }

// Bounds for what a card quotes from a tool server call, after the inventory
// redaction cuts each text at its first secret-looking word.
const toolServerArgumentsLength = 1_024
const toolServerMessageLength = 512

// Codex asks before a tool server's tool runs with an MCP elicitation whose
// _meta.codex_approval_kind is mcp_tool_call and whose form is empty (codex-rs
// core mcp_tool_call.rs, 0.157), after the call's mcpToolCall item started.
// Codex also passes an MCP server's own elicitation, _meta included, through
// to the client (codex-mcp elicitation.rs), so the marker proves nothing. A
// marked request is an approval only when it is the empty form and exactly
// one running mcpToolCall item of that server is on the same thread and turn;
// any other marked request is declined. Unmarked requests are not approvals
// ("not-approval") and are left as before.
function toolServerApproval(
  params: Record<string, unknown>,
  calls: ReadonlyMap<string, ToolServerCall>,
): ToolServerApproval | "decline" | "not-approval" {
  if (asRecord(params._meta)?.codex_approval_kind !== "mcp_tool_call") return "not-approval"
  const server = params.serverName
  const schema = asRecord(params.requestedSchema)
  const properties = asRecord(schema?.properties)
  if (
    typeof server !== "string" || !server || typeof params.threadId !== "string" || typeof params.turnId !== "string"
    || params.mode !== "form" || !properties || Object.keys(properties).length > 0
  ) return "decline"
  const running = [...calls].filter(([, call]) => (
    call.threadId === params.threadId && call.turnId === params.turnId && call.server === server
  ))
  if (running.length !== 1) return "decline"
  const [itemId, call] = running[0]!
  const command = `${server}.${call.tool}`
  // What Domovoi checked comes first: the running call's tool, server and
  // arguments. The request's own message follows, labelled as unchecked.
  const argumentsLine = call.arguments === undefined || call.arguments === null
    ? "Arguments are not available."
    : typeof call.arguments === "object" && Object.keys(call.arguments).length === 0
      ? "Arguments: none."
      : `Arguments: ${redactInventoryText(JSON.stringify(call.arguments).slice(0, 8 * toolServerArgumentsLength), toolServerArgumentsLength)}.`
  const message = typeof params.message === "string" && params.message.trim()
    ? ` Message sent with the request, not checked by Domovoi: ${redactInventoryText(params.message.slice(0, 8 * toolServerMessageLength), toolServerMessageLength)}`
    : ""
  const name = (text: string) => redactInventoryText(text, maximumToolInventoryNameLength)
  return {
    itemId,
    command,
    tool: command,
    toolServer: { name: server },
    reason: `Call ${name(call.tool)} on the ${name(server)} tool server. ${argumentsLine}${message}`,
  }
}

// A project's own Codex configuration can start programs and change
// permissions. A session is refused before Codex is asked anything about a
// worktree that holds it, or whose main checkout holds configuration Codex
// takes hooks from, unless the thread is opened, or was opened, under a
// trusted verdict: Codex still loads none of it, and Domovoi passes what may
// load in the thread config. A trusted thread is still refused while the main
// checkout holds hooks (ruling Q113 B). Callers check again after every
// await, so each thread/start, thread/resume and turn/start goes out in the
// same tick as a check that passed.
function refuseRepositoryConfig(cwd: string, trusted: boolean): void {
  if (!trusted) {
    const file = codexRepositoryConfigFile(cwd)
    if (file !== undefined) throw new Error(codexRepositoryConfigRefusal(file))
  }
  const hooks = codexMainCheckoutHooksFile(cwd)
  if (hooks !== undefined) throw new Error(codexMainCheckoutHooksRefusal(hooks.file, hooks.mainCheckout))
  if (trusted) return
  const main = codexMainCheckoutConfigFile(cwd)
  if (main !== undefined) throw new Error(codexMainCheckoutConfigRefusal(main.file, main.mainCheckout))
}

// The plan's servers less any named like one of the person's own (ruling
// Q150 A), from a config/read answer with its layers. When the answer does
// not say, none pass.
function serversToPass(plan: RepositoryPlan, configRead: unknown): Record<string, CodexRepositoryServer> {
  const own = codexOwnServerNames(configRead)
  return own === undefined ? {} : withoutOwnServers(plan.servers, own)
}

function resolvedDeveloperInstructions(result: unknown): string | undefined {
  const instructions = asRecord(asRecord(result)?.config)?.developer_instructions
  return typeof instructions === "string" && instructions.trim() ? instructions.trim() : undefined
}

function additionalContextUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /additionalContext/iu.test(message)
}

function collaborationModeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /collaborationMode|experimentalApi/iu.test(message)
}

function captureStderrTail(stream: Readable): () => string {
  let tail = Buffer.alloc(0)
  stream.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk])
    if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES)
  })
  return () => tail.toString("utf8").trim()
}

type CodexModel = {
  id: string | null | undefined
  displayName: string | null | undefined
  description: string | null | undefined
  hidden: boolean | null | undefined
  supportedReasoningEfforts: string[] | null | undefined
  defaultReasoningEffort: string | null | undefined
  isDefault: boolean | null | undefined
}

type CodexModelPage = {
  data: CodexModel[]
  nextCursor: string | null
}

function requireJsonRpcMessage(value: unknown): JsonRpcMessage {
  const message = asRecord(value)
  if (!message) throw new Error("Codex app-server emitted invalid JSONL")
  const params = asRecord(message.params)
  const error = asRecord(message.error)
  return {
    ...(typeof message.id === "number" ? { id: message.id } : {}),
    ...(typeof message.method === "string" ? { method: message.method } : {}),
    ...(params ? { params } : {}),
    ...("result" in message ? { result: message.result } : {}),
    ...(isNullish(message.error)
      ? {}
      : {
          error: {
            ...(typeof error?.code === "number" ? { code: error.code } : {}),
            ...(typeof error?.message === "string" ? { message: error.message } : {}),
          },
        }),
  }
}

function requireModelPage(value: unknown): CodexModelPage {
  const page = asRecord(value)
  if (
    !page
    || (!isNullish(page.data) && !Array.isArray(page.data))
    || !isOptionalString(page.nextCursor)
  ) throw new Error("Codex did not return a model list")
  const data: CodexModel[] = []
  for (const candidate of page.data ?? []) {
    const model = parseCodexModel(candidate)
    if (model) data.push(model)
  }
  return { data, nextCursor: page.nextCursor ?? null }
}

function parseCodexUsageLimits(value: unknown): ProviderUsageLimits | undefined {
  const rateLimits = asRecord(asRecord(value)?.rateLimits)
  if (!rateLimits) return undefined
  const windows = (["primary", "secondary"] as const).flatMap((kind) => {
    const window = asRecord(rateLimits[kind])
    if (!window) return []
    const usedPercent = window.usedPercent
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      return []
    }
    const duration = window.windowDurationMins
    if (!isNullish(duration) && (typeof duration !== "number" || !Number.isInteger(duration) || duration <= 0)) {
      return []
    }
    const resetSeconds = window.resetsAt
    if (!isNullish(resetSeconds) && (typeof resetSeconds !== "number" || !Number.isFinite(resetSeconds) || resetSeconds < 0)) {
      return []
    }
    return [{
      kind,
      usedPercent,
      ...(typeof duration === "number" ? { windowDurationMinutes: duration } : {}),
      ...(typeof resetSeconds === "number" ? { resetsAt: new Date(resetSeconds * 1_000).toISOString() } : {}),
    }]
  })
  if (windows.length === 0) return undefined
  return {
    provider: "codex",
    ...(typeof rateLimits.planType === "string" && rateLimits.planType.trim()
      ? { planType: rateLimits.planType }
      : {}),
    windows,
  }
}

function parseCodexModel(value: unknown): CodexModel | undefined {
  const model = asRecord(value)
  const supportedReasoningEfforts = isNullish(model?.supportedReasoningEfforts)
    ? undefined
    : parseReasoningEfforts(model.supportedReasoningEfforts)
  if (
    !model
    || !isOptionalString(model.id)
    || !isOptionalString(model.model)
    || !isOptionalString(model.displayName)
    || !isOptionalString(model.description)
    || !isOptionalBoolean(model.hidden)
    || (!isNullish(model.supportedReasoningEfforts) && !supportedReasoningEfforts)
    || !isOptionalString(model.defaultReasoningEffort)
    || !isOptionalBoolean(model.isDefault)
  ) return undefined
  return {
    id: model.model ?? model.id,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  }
}

function parseReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const efforts: string[] = []
  for (const candidate of value) {
    const option = asRecord(candidate)
    if (!option) return undefined
    if (typeof option.reasoningEffort === "string") efforts.push(option.reasoningEffort)
  }
  return efforts
}

function codexPlanSteps(value: unknown): AgentWorkingPlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined
  const steps: AgentWorkingPlanStep[] = []
  for (const candidate of value) {
    const entry = asRecord(candidate)
    if (!entry || typeof entry.step !== "string") return undefined
    const status = entry.status === "inProgress" ? "in-progress" : entry.status
    if (status !== "pending" && status !== "in-progress" && status !== "completed") {
      return undefined
    }
    steps.push({ text: entry.step, status })
  }
  return steps
}

function nestedId(value: unknown, key: "thread" | "turn"): string | undefined {
  const id = asRecord(asRecord(value)?.[key])?.id
  return typeof id === "string" ? id : undefined
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return isNullish(value) || typeof value === "string"
}

function isOptionalBoolean(value: unknown): value is boolean | null | undefined {
  return isNullish(value) || typeof value === "boolean"
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
