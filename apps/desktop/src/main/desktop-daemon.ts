import type { AcquireLocalDaemonOptions, LocalDaemonHandle } from "@getdomovoi/daemon"

import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

export type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

export type DesktopDaemonSeam = (options: AcquireLocalDaemonOptions) => Promise<LocalDaemonHandle>

export type DesktopDaemonOptions = Omit<AcquireLocalDaemonOptions, "mode" | "timeoutMs">

export type DesktopDaemonBudgets = {
  readonly acquireMs: number
  readonly releaseMs: number
}

// Acquiring gets the 30 seconds the daemon gives its own start; releasing at
// quit keeps the desktop's 10 second bound.
export const desktopDaemonBudgets: DesktopDaemonBudgets = { acquireMs: 30_000, releaseMs: 10_000 }

type AttachedHandle = Extract<LocalDaemonHandle, { kind: "attached" }>

function describeAcquisition(handle: LocalDaemonHandle): DesktopDaemonAcquisition {
  if (handle.kind === "refused") return { kind: "refused", reason: handle.reason, message: handle.message }
  const { url, token } = handle.endpoint
  return handle.kind === "owned" ? { kind: "owned", url, token } : { kind: "attached", owner: handle.owner, url, token }
}

// One start-or-attach per process; everything after rereads the owner record
// in attach-only mode, so no gap, refusal, or failure starts a second daemon.
// Racing callers share the current acquisition. An attachment the owner closes
// triggers one bounded attach-only acquisition, handed to the next reconnect.
export class DesktopDaemon {
  #attempt: Promise<LocalDaemonHandle> | undefined
  #handle: LocalDaemonHandle | undefined
  #failed = false
  #fresh = false
  readonly #detached = new WeakSet<AttachedHandle>()
  #releasing: Promise<void> | undefined

  constructor(
    private readonly seam: DesktopDaemonSeam,
    private readonly options: () => DesktopDaemonOptions,
    private readonly budgets: DesktopDaemonBudgets = desktopDaemonBudgets,
  ) {}

  acquire(): Promise<DesktopDaemonAcquisition> {
    return this.#serve(false)
  }

  reacquire(): Promise<DesktopDaemonAcquisition> {
    return this.#serve(true)
  }

  release(): Promise<void> {
    this.#releasing ??= this.#release()
    return this.#releasing
  }

  current(): DesktopDaemonAcquisition | undefined {
    return this.#handle ? describeAcquisition(this.#handle) : undefined
  }

  #serve(reconnect: boolean): Promise<DesktopDaemonAcquisition> {
    if (this.#releasing) return Promise.reject(new Error("Desktop is quitting"))
    if (this.#attempt) return this.#attempt.then(describeAcquisition)
    const handle = this.#handle
    if (!handle) return this.#acquireWith(this.#failed ? "attach-only" : "start-or-attach", false)
    if (handle.kind === "owned" || this.#fresh || (handle.kind === "attached" && !reconnect)) {
      this.#fresh = false
      return Promise.resolve(describeAcquisition(handle))
    }
    return this.#acquireWith("attach-only", false)
  }

  #acquireWith(mode: AcquireLocalDaemonOptions["mode"], publish: boolean): Promise<DesktopDaemonAcquisition> {
    const previous = this.#handle
    this.#fresh = false
    const attempt = new Promise<LocalDaemonHandle>((resolve) => {
      resolve(this.seam({ ...this.options(), mode, timeoutMs: this.budgets.acquireMs }))
    })
    this.#attempt = attempt
    const settle = (handle?: LocalDaemonHandle): void => {
      this.#attempt = undefined
      this.#handle = handle
      this.#failed = !handle
      this.#fresh = publish && Boolean(handle)
      if (previous?.kind === "attached") this.#detach(previous)
      if (handle?.kind === "attached") void handle.closed.then(() => this.#closed(handle))
    }
    return attempt.then(
      (handle) => {
        settle(handle)
        return describeAcquisition(handle)
      },
      (error: unknown) => {
        settle()
        throw error
      },
    )
  }

  #detach(handle: AttachedHandle): void {
    this.#detached.add(handle)
    handle.detach()
  }

  #closed(handle: AttachedHandle): void {
    if (this.#detached.has(handle) || this.#releasing || this.#attempt || this.#handle !== handle) return
    void this.#acquireWith("attach-only", true).catch(() => {})
  }

  async #release(): Promise<void> {
    await this.#attempt?.catch(() => {})
    const handle = this.#handle
    if (handle?.kind === "owned") await handle.stop()
    else if (handle?.kind === "attached") this.#detach(handle)
  }
}
