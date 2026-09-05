import { Worker } from "node:worker_threads"

import { credentialSchema, machineIdSchema } from "@getdomovoi/protocol"

import { MachineCredentialUnavailableError } from "./machine-credentials.js"
import { OperationDeadline } from "./operation-deadline.js"

export const maximumPendingKeyringOperations = 256
const maximumKeyringOperationMs = 5_000

export interface AsyncMachineCredentials {
  save(machineId: string, credential: string, deadline: OperationDeadline): Promise<void>
  forMachine(machineId: string, deadline: OperationDeadline): Promise<string | undefined>
  forget(machineId: string, deadline: OperationDeadline): Promise<void>
  machines(deadline: OperationDeadline): Promise<string[]>
  repairIndex(machineId: string, expectedDigest: string, deadline: OperationDeadline): Promise<boolean>
  forgetIfMatching(machineId: string, expectedDigest: string | null, deadline: OperationDeadline): Promise<boolean>
  close(deadline: OperationDeadline): Promise<void>
}

type Request =
  | { kind: "save"; machineId: string; credential: string }
  | { kind: "forMachine" | "forget"; machineId: string }
  | { kind: "machines" }
  | { kind: "repairIndex"; machineId: string; expectedDigest: string }
  | { kind: "forgetIfMatching"; machineId: string; expectedDigest: string | null }

type Pending = {
  id: number
  request: Request | undefined
  kind: Request["kind"]
  deadline: OperationDeadline
  cancelled: Int32Array
  resolve(value: unknown): void
  reject(error: Error): void
  abort(): void
  settled: boolean
}

function createNativeWorker(): Worker {
  if (new URL(import.meta.url).pathname.endsWith(".ts")) {
    // Explicit registration avoids relying on version-specific loader
    // inheritance. Source development must not execute stale dist code.
    const loader = import.meta.resolve("tsx/esm/api")
    const entry = new URL("./machine-keyring-worker.ts", import.meta.url).href
    const bootstrap = `import { register } from ${JSON.stringify(loader)}; register({ tsconfig: false }); await import(${JSON.stringify(entry)});`
    // Register exactly once in this thread. Inheriting the parent's tsx
    // preload as well installs competing workspace-alias resolution hooks.
    const tsxImports = new Set(["tsx", "tsx/esm", import.meta.resolve("tsx"), import.meta.resolve("tsx/esm")])
    const execArgv: string[] = []
    for (let index = 0; index < process.execArgv.length; index++) {
      const arg = process.execArgv[index]!
      if (arg === "--import" && tsxImports.has(process.execArgv[index + 1] ?? "")) { index++; continue }
      if (arg.startsWith("--import=") && tsxImports.has(arg.slice("--import=".length))) continue
      execArgv.push(arg)
    }
    return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { execArgv })
  }
  return new Worker(new URL("./machine-keyring-worker.js", import.meta.url))
}

// The native constructor can contact the OS keychain too. Keep the complete
// logical operation, including index maintenance, on one worker. No main-thread
// NativeMachineKeyring fallback and no secret cache is allowed here.
export class MachineCredentialWorker implements AsyncMachineCredentials {
  readonly #createWorker: () => Worker
  readonly #queue: Pending[] = []
  #worker: Worker | undefined
  #active: Pending | undefined
  #nextId = 0
  #closed = false
  #closing: Promise<number> | undefined

  constructor(createWorker: () => Worker = createNativeWorker) {
    this.#createWorker = createWorker
  }

  async save(machineId: string, credential: string, deadline: OperationDeadline): Promise<void> {
    machineIdSchema.parse(machineId)
    if (!credentialSchema.safeParse(credential).success) throw new Error("Machine credential is malformed")
    await this.#call({ kind: "save", machineId, credential }, deadline)
  }

  async forMachine(machineId: string, deadline: OperationDeadline): Promise<string | undefined> {
    machineIdSchema.parse(machineId)
    return await this.#call({ kind: "forMachine", machineId }, deadline) as string | undefined
  }

  async forget(machineId: string, deadline: OperationDeadline): Promise<void> {
    machineIdSchema.parse(machineId)
    await this.#call({ kind: "forget", machineId }, deadline)
  }

  async machines(deadline: OperationDeadline): Promise<string[]> {
    return await this.#call({ kind: "machines" }, deadline) as string[]
  }

  async repairIndex(machineId: string, expectedDigest: string, deadline: OperationDeadline): Promise<boolean> {
    machineIdSchema.parse(machineId)
    return await this.#call({ kind: "repairIndex", machineId, expectedDigest }, deadline) as boolean
  }

  async forgetIfMatching(machineId: string, expectedDigest: string | null, deadline: OperationDeadline): Promise<boolean> {
    machineIdSchema.parse(machineId)
    return await this.#call({ kind: "forgetIfMatching", machineId, expectedDigest }, deadline) as boolean
  }

  #call(request: Request, parent: OperationDeadline): Promise<unknown> {
    if (this.#closed || this.#queue.length + Number(this.#active !== undefined) >= maximumPendingKeyringOperations) {
      return Promise.reject(new MachineCredentialUnavailableError())
    }
    const deadline = parent.limit(maximumKeyringOperationMs)
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        id: ++this.#nextId, request, kind: request.kind, deadline,
        cancelled: new Int32Array(new SharedArrayBuffer(4)), resolve, reject, settled: false,
        abort: () => {
          Atomics.store(entry.cancelled, 0, 1)
          this.#refuse(entry)
          const index = this.#queue.indexOf(entry)
          if (index !== -1) this.#queue.splice(index, 1)
          // Expiry bounds the caller, not the native call. Leave the active
          // slot occupied until its worker reply or actual worker exit.
        },
      }
      deadline.signal.addEventListener("abort", entry.abort, { once: true })
      if (deadline.remainingMs() === 0) { entry.abort(); return }
      this.#queue.push(entry)
      this.#pump()
    })
  }

  #pump(): void {
    if (this.#closed || this.#active) return
    const entry = this.#queue.shift()
    if (!entry) { this.#worker?.unref(); return }
    if (entry.deadline.remainingMs() === 0) { entry.abort(); this.#pump(); return }
    this.#active = entry
    try {
      if (!this.#worker) {
        this.#worker = this.#createWorker()
        this.#worker.on("message", (response: unknown) => this.#receive(response))
        this.#worker.on("error", () => this.#fail())
        this.#worker.on("exit", () => this.#fail())
      }
      this.#worker.ref()
      entry.deadline.throwIfExpired()
      // hrtime is one monotonic clock shared by this process's threads. The
      // worker checks it between native steps even if the main timer is late.
      const expiresAt = process.hrtime.bigint() + BigInt(Math.floor(entry.deadline.remainingMs() * 1_000_000))
      this.#worker.postMessage({ id: entry.id, request: entry.request, expiresAt, cancelled: entry.cancelled.buffer })
      entry.request = undefined
    } catch { this.#fail() }
  }

  #receive(value: unknown): void {
    const entry = this.#active
    if (!entry || !value || typeof value !== "object" || !("id" in value) || value.id !== entry.id) { this.#fail(); return }
    try {
      entry.deadline.throwIfExpired()
      if (!("ok" in value) || value.ok !== true || !("result" in value)) throw new MachineCredentialUnavailableError()
      const result = entry.kind === "machines" ? machineIdSchema.array().parse(value.result)
        : entry.kind === "forMachine" ? credentialSchema.optional().parse(value.result)
          : entry.kind === "repairIndex" || entry.kind === "forgetIfMatching" ? value.result : undefined
      if ((entry.kind === "repairIndex" || entry.kind === "forgetIfMatching") && typeof result !== "boolean") throw new MachineCredentialUnavailableError()
      if (!entry.settled) { this.#detach(entry); entry.resolve(result) }
    } catch { this.#refuse(entry) }
    this.#active = undefined
    this.#pump()
  }

  #detach(entry: Pending): void {
    entry.settled = true
    entry.request = undefined
    entry.deadline.signal.removeEventListener("abort", entry.abort)
    entry.deadline.clear()
  }

  #refuse(entry: Pending): void {
    if (entry.settled) return
    this.#detach(entry)
    entry.reject(new MachineCredentialUnavailableError())
  }

  #fail(): void {
    this.#closed = true
    if (this.#active) { Atomics.store(this.#active.cancelled, 0, 1); this.#refuse(this.#active) }
    for (const entry of this.#queue.splice(0)) this.#refuse(entry)
    // Do not spawn a second native writer after a fault or a late result.
  }

  async close(deadline: OperationDeadline): Promise<void> {
    this.#fail()
    if (!this.#worker) return
    this.#closing ??= this.#worker.terminate()
    const closing = this.#closing
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new MachineCredentialUnavailableError())
      deadline.signal.addEventListener("abort", abort, { once: true })
      closing.then(() => {
        try { deadline.throwIfExpired(); resolve() } catch { abort() }
      }, abort).finally(() => deadline.signal.removeEventListener("abort", abort))
      if (deadline.remainingMs() === 0) abort()
    })
  }
}
