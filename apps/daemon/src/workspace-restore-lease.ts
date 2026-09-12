import { AsyncLocalStorage } from "node:async_hooks"
import type { PromiseWithChild } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { claimExclusiveFileLease, type FileLease } from "./file-lease.js"

const pidSchema = z.number().int().min(1).max(2_147_483_647)
const ownerSchema = z.object({
  version: z.literal(2), token: z.string().uuid(), ownerPid: pidSchema,
  descendantsUnknown: z.boolean(),
  starting: z.number().int().min(0).max(32), children: z.array(pidSchema).max(32),
})
type RestoreOwner = z.infer<typeof ownerSchema>
const currentLease = new AsyncLocalStorage<RestoreOperationLease>()

function readBounded(path: string): string {
  const handle = openSync(path, "r")
  try {
    const bytes = Buffer.alloc(4_097)
    const length = readSync(handle, bytes)
    if (length > 4_096) throw new Error("Restore owner record exceeds its size limit")
    return bytes.toString("utf8", 0, length)
  } finally { closeSync(handle) }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

export class RestoreLeaseRecoveryError extends Error {
  constructor(path: string, reason: string, cause?: unknown) {
    super(`Session worktree already exists or its restore claim is held at ${path}. ${reason}. Preserve the worktree; stop Domovoi and its supervisor before inspecting an unresolved claim.`, { cause })
    this.name = "RestoreLeaseRecoveryError"
  }
}

export class RestoreOperationLease {
  readonly #file: FileLease
  readonly #ownerPath: string
  readonly #owner: RestoreOwner
  readonly #commands = new Set<Promise<unknown>>()

  constructor(root: string, sessionId: string, token: string) {
    const claimPath = join(root, ".restore-claims", sessionId)
    this.#file = claimExclusiveFileLease(join(root, ".restore-leases", `${sessionId}.sqlite`),
      () => new RestoreLeaseRecoveryError(claimPath, "Another restore or its cleanup still holds the operation lease"))
    this.#ownerPath = join(root, ".restore-leases", `${sessionId}.json`)
    this.#owner = { version: 2, token, ownerPid: process.pid, descendantsUnknown: false, starting: 0, children: [] }
    try {
      let heldToken: string | undefined
      try { heldToken = readBounded(claimPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (heldToken !== undefined) {
        let previous: RestoreOwner
        try { previous = ownerSchema.parse(JSON.parse(readBounded(this.#ownerPath))) } catch (cause) {
          throw new RestoreLeaseRecoveryError(claimPath, "The claim has no readable recovery record; legacy and damaged claims cannot be reclaimed automatically", cause)
        }
        if (previous.token !== heldToken) throw new RestoreLeaseRecoveryError(claimPath, "The claim token does not match its recovery record")
        if (processIsAlive(previous.ownerPid)) throw new RestoreLeaseRecoveryError(claimPath, "The recorded restore owner is still alive")
        if (previous.starting !== 0) throw new RestoreLeaseRecoveryError(claimPath, "A Git launch was not fully recorded; child liveness is unknown")
        for (const pid of previous.children) {
          if (processIsAlive(pid)) throw new RestoreLeaseRecoveryError(claimPath, `Recorded Git child ${pid} is still alive`)
        }
        if (previous.descendantsUnknown || previous.children.length > 0) {
          throw new RestoreLeaseRecoveryError(claimPath, "A Git child exit was interrupted or not recorded; descendant liveness is unknown")
        }
        // PID absence covers only the launcher. An owner crash can terminate
        // it while descendants survive, so automatic recovery also requires
        // recorded settlement of every Git command.
        unlinkSync(claimPath)
      }
      this.#publish()
    } catch (error) {
      this.#file.release()
      throw error
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await currentLease.run(this, operation) } finally {
      // Promise.all rejects on the first failure, while sibling Git commands
      // can still write. Keep exclusion until every tracked child has closed.
      while (this.#commands.size > 0) await Promise.allSettled(this.#commands)
    }
  }
  release(): void { this.#file.release() }

  assertRecordedSettlement(): void {
    if (this.#owner.descendantsUnknown || this.#owner.starting !== 0 || this.#owner.children.length > 0) {
      throw new Error("Git descendant liveness is unknown; preserve the claim for inspection")
    }
  }

  command<T>(launch: () => PromiseWithChild<T>): Promise<T> {
    const pending = this.#command(launch)
    this.#commands.add(pending)
    void pending.then(() => this.#commands.delete(pending), () => this.#commands.delete(pending))
    return pending
  }

  async #command<T>(launch: () => PromiseWithChild<T>): Promise<T> {
    if (this.#owner.descendantsUnknown) throw new Error("Git descendant liveness is unknown after an interrupted command")
    if (this.#owner.starting + this.#owner.children.length >= 32) throw new Error("Too many restore subprocesses")
    this.#owner.starting++
    this.#publish()
    let pending: PromiseWithChild<T> | undefined
    let closed: Promise<void> | undefined
    let pid: number | undefined
    let outcome: { value: T } | { error: unknown }
    try {
      pending = launch()
      // execFile can reject on abort before its child closes. Keep both the
      // operation lease and durable child identity until actual settlement.
      closed = new Promise<void>((resolve) => pending!.child.once("close", (_code, signal) => {
        if (signal || pending!.child.killed) this.#owner.descendantsUnknown = true
        resolve()
      }))
      pid = pending.child.pid
      this.#owner.starting--
      if (pid !== undefined) this.#owner.children.push(pidSchema.parse(pid))
      this.#publish()
      outcome = { value: await pending }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") this.#owner.descendantsUnknown = true
      outcome = { error }
    }
    // Observe a spawn rejection even if publishing its PID failed first.
    await pending?.catch(() => undefined)
    await closed
    if (!pending) this.#owner.starting--
    if (pid !== undefined) this.#owner.children = this.#owner.children.filter((child) => child !== pid)
    let recordFailure: { error: unknown } | undefined
    try { this.#publish() } catch (error) { recordFailure = { error } }
    if (recordFailure) {
      if ("error" in outcome) throw new AggregateError([outcome.error, recordFailure.error], "Restore command and exit recording failed", { cause: outcome.error })
      throw recordFailure.error
    }
    if ("error" in outcome) throw outcome.error
    return outcome.value
  }

  #publish(): void {
    mkdirSync(dirname(this.#ownerPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.#ownerPath}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.#owner), { flag: "wx", mode: 0o600, flush: true })
    renameSync(temporary, this.#ownerPath)
  }
}

export function trackRestoreCommand<T>(launch: () => PromiseWithChild<T>): Promise<T> {
  return currentLease.getStore()?.command(launch) ?? launch()
}
