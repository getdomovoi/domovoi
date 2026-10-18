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

import {
  ApprovalRequestNotPendingError,
  type AgentAdapter,
  type AgentEvent,
  type AgentRepositoryTrust,
  type AgentWorkingPlanStep,
  type ApprovalScope,
} from "./agents.js"
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
  codexCatalogPage,
  codexHomeCandidates,
  codexLaunchIsLocalOnly,
  codexOwnServerNames,
  codexRepositoryLoad,
  codexTrustedThreadConfig,
  withoutOwnServers,
  type CodexLaunch,
  type CodexRepositoryServer,
} from "./codex-repository-trust.js"
import { codexSecretFileSummary, codexSecretGlobs } from "./codex-secret-globs.js"
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
  // Domovoi numbers its own requests; Codex numbers its own too, but a
  // JSON-RPC id may be a string, and a request with one is still answered.
  id?: number | string
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
  // Whether the app-server behind this transport gets Codex's local
  // environment alone, so its threads bring no plugin servers beyond the
  // catalog mcpServerStatus/list names (codexLaunchIsLocalOnly). Once false,
  // false for the transport's life. Absent: no repository server passes.
  environmentIsLocalOnly?(): boolean
}

function judgedLocalOnly(launch: CodexLaunch): boolean {
  try {
    return codexLaunchIsLocalOnly(launch)
  } catch {
    return false
  }
}

// What the app-server is started with, read once per transport.
function currentCodexLaunch(): CodexLaunch {
  const env = { ...process.env }
  return { env, cwd: process.cwd(), homeCandidates: codexHomeCandidates(env), platform: process.platform }
}

export type CodexPermissionProfile = "domovoi-read" | "domovoi-build"

export type CodexPolicy = {
  approvalPolicy: "on-request" | "never"
  permissions: CodexPermissionProfile
  // Codex sends an approval to the reviewer its configuration names. The
  // person's own approvals_reviewer = "auto_review" made Codex 0.162.1 decide
  // a request to run outside the sandbox with its own reviewer, so Domovoi
  // never saw it (walk finding F15). Every thread and turn names the person.
  approvalsReviewer: "user"
}

// Codex reads anywhere its sandbox allows without asking. Until a strict
// allow-list exists (it needs a survey of the toolchains commands load), both
// Domovoi profiles keep today's read access and refuse these credential
// stores. Every other read outside the worktree still runs without a card.
export const codexSecretLocations: readonly string[] = credentialStores.map(({ location }) => location)

// Secret files inside the worktree are refused too (owner ruling, 2026-09-22),
// in every mode: every name the card classifier calls secret, in any letter
// case (codex-secret-globs.ts). A test or build that loads one of them inside
// the sandbox fails with "Operation not permitted".
export { codexSecretGlobs } from "./codex-secret-globs.js"

// Codex emits no item for a command its sandbox refuses, so Domovoi cannot see
// the attempt. The person is told when a session reaches Codex, and the model
// is asked to say so itself when a command fails on one of these files.
export const codexWorktreeSecretNotice = {
  body: "Codex cannot read secret files in this worktree.",
  detail: `The Codex sandbox refuses reads of secret files at any depth and in any letter case: ${codexSecretFileSummary}. A test or build that loads .env fails with "Operation not permitted". Codex does not report the refused read to Domovoi, so it shows only in the agent's reply.`,
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

export const codexDeveloperInstructions = `Domovoi runs you in a sandbox that refuses reads of secret files anywhere in the worktree, in any letter case: ${codexSecretFileSummary}. A command that opens one of them fails with "Operation not permitted", for example a test or build that loads .env. Domovoi cannot see that failure. When a command fails on one of these files, say so in your reply and name the file.`

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
  // Codex registers update_plan only when tools.update_plan.enabled is true
  // (openai/codex #41744; measured with codex-cli 0.160.1). Without it no
  // turn/plan/updated arrives. A Codex older than that ignores the key.
  const tools = { update_plan: { enabled: true } }
  return Object.keys(servers).length === 0 ? { projects, tools } : { projects, tools, ...codexTrustedThreadConfig(servers) }
}

// What a thread may take from a trusted worktree: the digest its verdict
// compared, and the servers codex-repository-trust.ts lets pass.
type RepositoryPlan = { digest: string; servers: Record<string, CodexRepositoryServer> }

// The most mcpServerStatus/list pages read before a thread opens. Codex
// answers in one page unless asked for a limit.
const maximumCatalogPages = 50

// Session worktrees live in ~/.domovoi/worktrees, inside a store the sandbox
// refuses. Codex 0.162.1 keeps every deny entry when it runs a command the
// person allowed outside its sandbox, and there a deny on a directory
// outranks the worktree within it (measured 2026-10-15), so refusing
// ~/.domovoi whole refused an approved write in the worktree with "Operation
// not permitted", and in Ask every read of it (walk finding F15). The store is
// refused by globs that match every name in it but worktrees. In every
// session worktree, the thread's own included, the secret names are refused
// as :workspace_roots refuses them in the thread's own: every name the card
// classifier calls secret, credential stores by card name included, as the
// whole-store deny refused them (codex-secret-globs.ts).
const codexProfileStore = "~/.domovoi"
const codexSessionWorktrees = "worktrees"

// Globs for every entry of directory except kept, and everything below them:
// a name that differs from kept at some character ([!c] is any one character
// but c), a name kept begins with, and a name that begins with kept and goes
// on. kept must hold no glob character.
function codexGlobsExcept(directory: string, kept: string): string[] {
  const names = [...kept].flatMap((character, index) => {
    const prefix = kept.slice(0, index)
    return index === 0 ? [`[!${character}]*`] : [prefix, `${prefix}[!${character}]*`]
  })
  names.push(`${kept}?*`)
  return names.flatMap((name) => [`${directory}/${name}`, `${directory}/${name}/**`])
}

// Each location once: a TOML table may not repeat a key.
function codexDeniedLocations(secretGlobs: readonly string[]): string[] {
  return [...new Set(codexSecretLocations.flatMap((location) => location === codexProfileStore
    ? [
        ...codexGlobsExcept(location, codexSessionWorktrees),
        ...secretGlobs.map((pattern) => `${location}/${codexSessionWorktrees}/${pattern}`),
      ]
    : [location]))]
}

// A TOML basic string. JSON escapes every control character TOML forbids in
// one but DEL, which the secret globs hold (codex-secret-globs.ts).
function tomlString(text: string): string {
  return JSON.stringify(text).replaceAll("\u007f", String.raw`\u007f`)
}

// The profiles depend on the platform only in how a glob spells letter case
// (codex-secret-globs.ts).
export function codexAppServerArguments(platform: NodeJS.Platform = process.platform): string[] {
  const secretGlobs = codexSecretGlobs(platform)
  const worktreeSecrets = `{${secretGlobs.map((pattern) => `${tomlString(pattern)}="deny"`).join(",")}}`
  const denied = `{${[
    ...codexDeniedLocations(secretGlobs).map((location) => `${tomlString(location)}="deny"`),
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
  const approvalsReviewer = "user"
  if (runtime.permissionMode === "ask") return { approvalPolicy: "on-request", permissions: "domovoi-read", approvalsReviewer }
  if (runtime.permissionMode === "plan") return { approvalPolicy: "never", permissions: "domovoi-read", approvalsReviewer }
  return {
    approvalPolicy: runtime.permissionMode === "build" && runtime.auto ? "never" : "on-request",
    permissions: "domovoi-build",
    approvalsReviewer,
  }
}

// What a thread/start or thread/resume result says about who reviews its
// approvals. A Codex that reports none predates the field and has no reviewer
// but the client; any other reviewer than the person refuses the thread.
function refuseOtherReviewer(result: unknown): void {
  const reviewer = asRecord(result)?.approvalsReviewer
  if (reviewer === undefined || reviewer === null || reviewer === "user") return
  throw new Error(
    `Codex would send this thread's approvals to its own reviewer (${String(reviewer)}) instead of to Domovoi, so Domovoi did not use it.`,
  )
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
  readonly #launch: CodexLaunch
  #localOnly: boolean

  // The app-server is started with exactly the variables in `launch`, judged
  // before the start; environmentIsLocalOnly judges them again later.
  constructor(childFactory: (env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams = (env) => spawn(
    "codex",
    codexAppServerArguments(),
    { stdio: ["pipe", "pipe", "pipe"], env },
  ), shutdownGraceMs = 2_000, launch: CodexLaunch = currentCodexLaunch()) {
    this.#launch = launch
    this.#localOnly = judgedLocalOnly(launch)
    this.#child = childFactory({ ...launch.env })
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

  // Judged again on each call, and ANDed with every earlier answer: a file
  // removed or a link repointed after the app-server read its environments
  // cannot turn the answer back to local while that app-server runs.
  environmentIsLocalOnly(): boolean {
    if (this.#localOnly) this.#localOnly = judgedLocalOnly(this.#launch)
    return this.#localOnly
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
  // The command approvals Codex asked for and has not had an answer to, so
  // an answer to any other id is refused rather than sent (ruling Q285).
  #commandApprovals = new Set<number>()
  // Threads opened on this transport under a trusted verdict, by thread id,
  // with the digest it compared: their turns skip the worktree refusal
  // (ruling Q143 A). And threads given a trusted repository's servers: Codex
  // ignores a resume's config for a thread it still holds, so one stays here
  // until it is archived or the transport ends.
  #trustedThreads = new Map<string, string>()
  #trustApplied = new Map<string, { digest: string }>()
  // Per thread: the turn whose usage is being counted, the thread's
  // cumulative total from before that turn began, and the newest total seen.
  #turnUsageBaselines = new Map<string, { turnId: string; baseline: CodexTokenBreakdown; latest: CodexTokenBreakdown }>()
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
    const servers = plan === undefined ? {} : await this.#serversToPass(plan, read)
    refuseRepositoryConfig(cwd, plan !== undefined)
    const result = await this.#request("thread/start", {
      cwd,
      model: runtime.model,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      sandbox,
      serviceName: "domovoi",
      developerInstructions: own ? `${own}\n\n${codexDeveloperInstructions}` : codexDeveloperInstructions,
      config: codexThreadConfig(cwd, servers),
    })
    const threadId = nestedId(result, "thread")
    if (!threadId) throw new Error("Codex did not return a thread id")
    refuseOtherReviewer(result)
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

  // The plan's servers less any named like one of the person's own (ruling
  // Q150 A): those their config layers declare, from a config/read answer
  // with its layers, and every server of Codex's effective catalog, plugin
  // servers included. When either cannot be read, none pass. None pass either
  // when the thread may get an environment that brings plugin servers the
  // catalog does not list (codexLaunchIsLocalOnly, judged by the transport).
  async #serversToPass(plan: RepositoryPlan, configRead: unknown): Promise<Record<string, CodexRepositoryServer>> {
    if (Object.keys(plan.servers).length === 0 || !this.#localOnly()) return {}
    const own = codexOwnServerNames(configRead)
    const catalog = own === undefined ? undefined : await this.#catalogServerNames()
    return own === undefined || catalog === undefined ? {} : withoutOwnServers(plan.servers, [...own, ...catalog])
  }

  // The current transport's verdict (CodexTransport.environmentIsLocalOnly);
  // a transport without one, or one that throws, cannot tell.
  #localOnly(): boolean {
    try {
      return this.#transport?.environmentIsLocalOnly?.() ?? false
    } catch {
      return false
    }
  }

  // Every server name of Codex's effective catalog, page by page. Without a
  // thread, Codex builds that catalog from the person's configuration and
  // plugins and starts each server once to describe it (McpStartupPolicy
  // Eager in collect_mcp_server_status_snapshot_with_detail at
  // rust-v0.157.1); "toolsAndAuthOnly" is its smaller answer. A failed or
  // unreadable page, or a cursor seen before, gives undefined.
  async #catalogServerNames(): Promise<string[] | undefined> {
    const names: string[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let pages = 0; pages < maximumCatalogPages; pages += 1) {
      let page: ReturnType<typeof codexCatalogPage>
      try {
        page = codexCatalogPage(await this.#request(
          "mcpServerStatus/list",
          cursor === undefined ? { detail: "toolsAndAuthOnly" } : { detail: "toolsAndAuthOnly", cursor },
        ))
      } catch {
        return undefined
      }
      if (page === undefined) return undefined
      names.push(...page.names)
      if (page.nextCursor === undefined) return names
      if (cursors.has(page.nextCursor)) return undefined
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    return undefined
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
    this.#turnUsageBaselines.delete(threadId)
  }

  // A turn's usage is every model request it made: the thread's cumulative
  // total now, less the total before the turn. That baseline is the newest
  // total an earlier turn on this thread reported. Without one (the first turn
  // this adapter sees on the thread), or when the total went backwards (a new
  // app-server), it is the total before this update's own request. A repeated
  // notification with the same counters therefore adds nothing. A total
  // smaller than its own last request is not a running total, and the request
  // alone is reported.
  #turnTokenUsage(
    threadId: string,
    turnId: string,
    total: CodexTokenBreakdown,
    last: CodexTokenBreakdown,
  ): CodexTokenBreakdown {
    if (!codexBreakdownCovers(total, last)) {
      this.#turnUsageBaselines.delete(threadId)
      return last
    }
    const entry = this.#turnUsageBaselines.get(threadId)
    let baseline = entry?.turnId === turnId ? entry.baseline : entry?.latest
    if (!baseline || !codexBreakdownCovers(total, baseline)) baseline = codexBreakdownLess(total, last)
    const turn = codexBreakdownLess(total, baseline)
    // A difference no single turn could produce (more cached input than
    // input, say) means the baseline is not this total's past. Count from this
    // request instead, and report the request alone.
    if (!codexBreakdownConsistent(turn)) {
      this.#turnUsageBaselines.set(threadId, { turnId, baseline: codexBreakdownLess(total, last), latest: total })
      return last
    }
    this.#turnUsageBaselines.set(threadId, { turnId, baseline, latest: total })
    return turn
  }

  async resumeThread({ threadId, cwd, runtime, repositoryTrust }: Parameters<AgentAdapter["resumeThread"]>[0]): Promise<void> {
    // This open decides again: until it succeeds under a trusted verdict, the
    // thread's turns meet the worktree refusal (ruling Q144 A).
    this.#trustedThreads.delete(threadId)
    const plan = repositoryTrust === undefined ? undefined : await this.#repositoryPlan(cwd, repositoryTrust)
    refuseRepositoryConfig(cwd, plan !== undefined)
    let servers: Record<string, CodexRepositoryServer> = {}
    if (plan !== undefined && Object.keys(plan.servers).length > 0) {
      servers = await this.#serversToPass(plan, await this.#request("config/read", { cwd, includeLayers: true }))
      refuseRepositoryConfig(cwd, true)
    }
    const result = await this.#request("thread/resume", {
      threadId,
      approvalsReviewer: codexPolicyFor(runtime).approvalsReviewer,
      config: codexThreadConfig(cwd, servers),
    })
    if (nestedId(result, "thread") !== threadId) {
      throw new Error("Codex did not resume the requested thread")
    }
    refuseOtherReviewer(result)
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
    // Both sets belong to the transport, so with none attached neither holds
    // the request, and nothing is sent.
    const transport = this.#transport
    // An accepted elicitation with no persist in its _meta runs the call once;
    // Codex is never asked to remember a tool server answer.
    if (transport && this.#toolServerApprovals.delete(requestId)) {
      transport.send({ id: requestId, result: { action: mapped, content: null } })
      return
    }
    if (!transport || !this.#commandApprovals.delete(requestId)) throw new ApprovalRequestNotPendingError(requestId)
    transport.send({ id: requestId, result: { decision: mapped } })
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
      // The app-server has read its environments by now: judge the launch
      // again, so a change made while it started counts against it.
      this.#localOnly()
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
    this.#commandApprovals.clear()
    // The app-server that held these threads is gone; each is opened again,
    // and checked again, on the next transport.
    this.#trustedThreads.clear()
    this.#trustApplied.clear()
    // A new app-server keeps its own running totals.
    this.#turnUsageBaselines.clear()
  }

  #receive(message: JsonRpcMessage): void {
    if (typeof message.id === "string") {
      // Domovoi's own requests and its approval cards use numbered ids, so a
      // string id is never an answer Domovoi waits on, and a request with one
      // is refused and shown rather than dropped.
      if (message.method) this.#refuseRequest(message.id, message.method, message.params ?? {})
      return
    }
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
      this.#commandApprovals.add(message.id)
      this.#emit({
        type: "approval-requested",
        requestId: message.id,
        ...common,
        ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
        ...(typeof params.command === "string" ? { command: params.command } : {}),
        ...(typeof params.cwd === "string" ? {
          cwd: params.cwd,
          ...(params.cwd.length > 0 ? { cwdSource: "request" as const } : {}),
        } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      })
    } else if (message.method === "mcpServer/elicitation/request" && message.id !== undefined) {
      // A marked request that is not tied to one running call, and a
      // server's own question (ruling Q156 A), are declined and shown.
      const request = toolServerApproval(params, this.#toolServerCalls)
      if (request === "decline" || request === "not-approval") {
        this.#refuseRequest(message.id, message.method, params)
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
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined
      // Codex defines last.totalTokens as current context. tokenUsage.total is
      // cumulative session usage and must never drive context occupancy.
      // `last` is one model request, so a turn's own usage is how far `total`
      // moved since the turn began; see #turnTokenUsage.
      const total = codexTokenBreakdown(tokenUsage?.total)
      const lastRequest = codexTokenBreakdown(last)
      const turnUsage = threadId && turnId && total && lastRequest
        ? this.#turnTokenUsage(threadId, turnId, total, lastRequest)
        : last
      // Without a running total the request stands alone, and the thread's
      // start is no longer known.
      if (threadId && !(total && lastRequest)) this.#turnUsageBaselines.delete(threadId)
      // Counters that do not add up are an accounting problem: the update is
      // dropped rather than thrown into the transport, which would end it.
      let usage: ReturnType<typeof normalizeProviderUsage>
      try {
        usage = last ? normalizeProviderUsage({
          usage: turnUsage,
          contextTokens: last.totalTokens,
          contextWindowTokens: tokenUsage?.modelContextWindow,
        }) : undefined
      } catch {
        usage = undefined
      }
      if (usage && threadId && turnId) {
        this.#emit({ type: "usage", threadId, turnId, usage })
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
    } else if (codexReviewerNotifications.has(message.method ?? "")) {
      // Every thread and turn names the person as the reviewer, and a thread
      // Codex reports otherwise is refused, so this is a Codex that decided
      // an approval without asking. Its reviewer took about two seconds in
      // the walk; stopping the app-server now stops the command it would run.
      const transport = this.#transport
      if (transport) this.#handleTransportFailure(transport, new Error(codexReviewerStopReason))
    } else if (message.id !== undefined && typeof message.method === "string") {
      this.#refuseRequest(message.id, message.method, params)
    }
  }

  // A request Codex waits on that Domovoi does not show as a card is refused
  // at once, so the turn does not wait on an answer that never comes, and
  // Codex is told. The session shows the refusal. A request that only asks
  // the client for a service shows nothing; one that names no thread has no
  // session to show it in, so Domovoi stops Codex, which every Codex session
  // shows.
  #refuseRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    const decline = Object.hasOwn(codexRequestDeclines, method) ? codexRequestDeclines[method] : undefined
    this.#transport?.send(decline === undefined
      ? { id, error: { code: -32601, message: `Domovoi does not handle ${method}` } }
      : { id, result: decline })
    if (codexServiceRequests.has(method)) return
    const threadId = nonEmpty(params.threadId) ?? nonEmpty(params.conversationId)
    if (!threadId) {
      const transport = this.#transport
      if (transport) {
        this.#handleTransportFailure(transport, new Error(
          `Codex sent a request Domovoi cannot show and could not tie to a session (${clipped(method, 256)}). Domovoi refused it and stopped Codex.`,
        ))
      }
      return
    }
    const itemId = nonEmpty(params.itemId) ?? nonEmpty(params.callId)
    const commandParts = Array.isArray(params.command) && params.command.every((part) => typeof part === "string")
      ? nonEmpty(params.command.join(" "))
      : undefined
    const command = nonEmpty(params.command) ?? commandParts ?? nonEmpty(params.serverName) ?? method
    // An MCP server writes its own message: quoted as unchecked, as on a card.
    const message = nonEmpty(params.message) ?? nonEmpty(params.description)
    const reason = nonEmpty(params.reason)
      ?? (message === undefined ? `Codex sent ${method}` : `Message sent with the request, not checked by Domovoi: ${clipped(message, toolServerMessageLength)}`)
    this.#emit({
      type: "policy-refused",
      threadId,
      ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
      ...(itemId ? { itemId } : {}),
      command: clipped(command, refusalCommandLength),
      reason: clipped(reason, refusalReasonLength),
      refusal: codexRequestRefusal,
    })
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#eventListeners) listener(event)
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

// Codex 0.162.1 reports its own reviewer deciding an approval with these.
const codexReviewerNotifications = new Set(["item/autoApprovalReview/started", "item/autoApprovalReview/completed"])

const codexReviewerStopReason = "Codex asked its own reviewer to decide an approval instead of asking you through Domovoi, so Domovoi stopped Codex. The reviewer may have answered before Codex stopped: check the session's changes."

// Requests that ask the client for a service rather than the person for a
// decision (codex-cli 0.162.1 app-server schema).
const codexServiceRequests = new Set(["account/chatgptAuthTokens/refresh", "attestation/generate", "currentTime/read", "item/tool/call"])

// The refusal each approval request Domovoi does not show takes, in that
// request's own response shape (codex-cli 0.162.1 app-server schema). Any
// other request is answered with a JSON-RPC error.
// The older requests take abort: their denied answer changed from a string to
// an object that carries a rejection, and abort is the same in both.
const codexRequestDeclines: Record<string, Record<string, unknown>> = {
  // Refused only when it carries a string id, which no card can hold.
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { permissions: {} },
  "mcpServer/elicitation/request": { action: "decline", content: null },
  execCommandApproval: { decision: "abort" },
  applyPatchApproval: { decision: "abort" },
}

// Bounds for what a refusal quotes, within the thread item's limits.
const refusalCommandLength = 4_096
const refusalReasonLength = 1_024

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function clipped(text: string, length: number): string {
  return redactInventoryText(text.slice(0, 8 * length), length)
}

export const codexRequestRefusal = {
  rule: "Domovoi cannot show this Codex request as an approval card",
  setBy: "Domovoi",
  scope: "This request",
  remedy: "Codex was told the request was refused. Ask the agent to do this another way.",
} as const

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
    ...(typeof message.id === "number" || typeof message.id === "string" ? { id: message.id } : {}),
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

// The counters of one Codex TokenUsageBreakdown that Domovoi reads. inputTokens
// includes cachedInputTokens; outputTokens includes reasoningOutputTokens.
type CodexTokenBreakdown = Record<typeof codexBreakdownKeys[number], number>
const codexBreakdownKeys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const

function codexTokenBreakdown(value: unknown): CodexTokenBreakdown | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const breakdown: Partial<CodexTokenBreakdown> = {}
  for (const key of codexBreakdownKeys) {
    const count = record[key]
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined
    breakdown[key] = count
  }
  return breakdown as CodexTokenBreakdown
}

function codexBreakdownCovers(total: CodexTokenBreakdown, part: CodexTokenBreakdown): boolean {
  return codexBreakdownKeys.every((key) => total[key] >= part[key])
}

function codexBreakdownConsistent(usage: CodexTokenBreakdown): boolean {
  return usage.cachedInputTokens <= usage.inputTokens
    && usage.reasoningOutputTokens <= usage.outputTokens
    && usage.totalTokens >= usage.inputTokens + usage.outputTokens
}

function codexBreakdownLess(total: CodexTokenBreakdown, part: CodexTokenBreakdown): CodexTokenBreakdown {
  return Object.fromEntries(codexBreakdownKeys.map((key) => [key, total[key] - part[key]])) as CodexTokenBreakdown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
