import type { AcquireLocalDaemonOptions, LocalDaemonHandle } from "@getdomovoi/daemon"

import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

export type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

export type DesktopDaemonSeam = (options: AcquireLocalDaemonOptions) => Promise<LocalDaemonHandle>

export type DesktopDaemonOptions = Omit<AcquireLocalDaemonOptions, "mode" | "timeoutMs">

export type DesktopDaemonBudgets = {
  readonly acquireMs: number
  readonly releaseMs: number
}

// Acquiring covers the profile lease, the owner record, and either a daemon
// start or a verified attachment, so it gets the same 30 seconds the daemon
// gives its own start. Releasing at quit keeps the desktop's 10 second bound.
export const desktopDaemonBudgets: DesktopDaemonBudgets = { acquireMs: 30_000, releaseMs: 10_000 }

function describeAcquisition(handle: LocalDaemonHandle): DesktopDaemonAcquisition {
  if (handle.kind === "owned") return { kind: "owned", url: handle.endpoint.url, token: handle.endpoint.token }
  if (handle.kind === "attached") {
    return { kind: "attached", owner: handle.owner, url: handle.endpoint.url, token: handle.endpoint.token }
  }
  return { kind: "refused", reason: handle.reason, message: handle.message }
}

// Desktop asks the seam to start or attach exactly once. Every acquisition
// after that rereads the owner record in attach-only mode, so a restart gap
// or a refusal can never turn into a second daemon owned by this app. The
// main process, the renderer's request, and the quit handler all share the
// acquisition that is current, so racing callers never produce two.
export class DesktopDaemon {
  #attempt: Promise<LocalDaemonHandle> | undefined
  #handle: LocalDaemonHandle | undefined
  #releasing: Promise<void> | undefined

  constructor(
    private readonly seam: DesktopDaemonSeam,
    private readonly options: () => DesktopDaemonOptions,
    private readonly budgets: DesktopDaemonBudgets = desktopDaemonBudgets,
  ) {}

  acquire(): Promise<DesktopDaemonAcquisition> {
    if (this.#releasing) return Promise.reject(new Error("Desktop is quitting"))
    if (!this.#attempt) return this.#acquireWith("start-or-attach")
    if (this.#handle?.kind === "refused") return this.#acquireWith("attach-only")
    return this.#attempt.then(describeAcquisition)
  }

  reacquire(): Promise<DesktopDaemonAcquisition> {
    if (this.#releasing) return Promise.reject(new Error("Desktop is quitting"))
    if (!this.#attempt) return this.#acquireWith("start-or-attach")
    if (!this.#handle || this.#handle.kind === "owned") return this.#attempt.then(describeAcquisition)
    return this.#acquireWith("attach-only")
  }

  release(): Promise<void> {
    this.#releasing ??= this.#release()
    return this.#releasing
  }

  #acquireWith(mode: AcquireLocalDaemonOptions["mode"]): Promise<DesktopDaemonAcquisition> {
    const previous = this.#handle
    this.#handle = undefined
    let attempt: Promise<LocalDaemonHandle>
    try {
      attempt = Promise.resolve(this.seam({ ...this.options(), mode, timeoutMs: this.budgets.acquireMs }))
    } catch (error) {
      attempt = Promise.reject(error)
    }
    this.#attempt = attempt
    const settle = (handle?: LocalDaemonHandle): void => {
      if (previous?.kind === "attached") previous.detach()
      if (handle) this.#handle = handle
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

  async #release(): Promise<void> {
    if (!this.#attempt) return
    let handle: LocalDaemonHandle
    try {
      handle = await this.#attempt
    } catch {
      return
    }
    if (handle.kind === "owned") await handle.stop()
    else if (handle.kind === "attached") handle.detach()
  }
}
