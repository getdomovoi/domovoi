import type { AcquireLocalDaemonOptions, LocalDaemonHandle } from "@getdomovoi/daemon"

import type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"
import { rendererEndpointUrl } from "./renderer-security.js"

export type { DesktopDaemonAcquisition } from "../shared/daemon-acquisition.js"

export type DesktopDaemonSeam = (options: AcquireLocalDaemonOptions) => Promise<LocalDaemonHandle>

export type DesktopDaemonOptions = Omit<AcquireLocalDaemonOptions, "mode" | "timeoutMs">

export type DesktopDaemonBudgets = {
  readonly acquireMs: number
  readonly releaseMs: number
}

// The daemon's own 30 second start budget and the desktop's 10 second quit bound.
export const desktopDaemonBudgets: DesktopDaemonBudgets = { acquireMs: 30_000, releaseMs: 10_000 }

type AttachedHandle = Extract<LocalDaemonHandle, { kind: "attached" }>

function describeAcquisition(handle: LocalDaemonHandle): DesktopDaemonAcquisition {
  if (handle.kind === "refused") return { kind: "refused", reason: handle.reason, message: handle.message }
  const url = rendererEndpointUrl(handle.endpoint.url)
  const { token } = handle.endpoint
  return handle.kind === "owned" ? { kind: "owned", url, token } : { kind: "attached", owner: handle.owner, url, token }
}

// One start-or-attach per process, attach-only after that, so nothing starts a
// second daemon. A closed attachment triggers one re-attach for the next reconnect.
export class DesktopDaemon {
  #attempt: Promise<LocalDaemonHandle> | undefined
  #handle: LocalDaemonHandle | undefined
  #failed = false
  #fresh = false
  readonly #detached = new WeakSet<AttachedHandle>()
  #releasing: Promise<void> | undefined
  // Set while the login service takes over the profile or gives it back.
  // Acquisitions wait for it to end, so a renderer reconnect between the stop
  // and the attach cannot start an in-app daemon beside the service.
  #handoff: { ended: Promise<void>; end: () => void } | undefined

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
    this.endHandoff()
    return this.#releasing
  }

  beginHandoff(): void {
    if (this.#handoff) return
    let end!: () => void
    const ended = new Promise<void>((resolve) => { end = resolve })
    this.#handoff = { ended, end }
  }

  endHandoff(): void {
    const handoff = this.#handoff
    this.#handoff = undefined
    handoff?.end()
  }

  current(): DesktopDaemonAcquisition | undefined {
    return this.#handle ? describeAcquisition(this.#handle) : undefined
  }

  // The J24 handoff (2026-09-23). The service installer calls this once its
  // checks pass: the app stops the daemon it owns so the service can claim
  // the profile. An attached daemon is not this app's to stop.
  async stopOwned(): Promise<void> {
    await this.#attempt?.catch(() => {})
    const handle = this.#handle
    if (handle?.kind !== "owned") return
    this.beginHandoff()
    this.#handle = undefined
    this.#failed = false
    this.#fresh = false
    await handle.stop()
  }

  // After the service is installed: attach to it, and publish the endpoint so
  // the renderer's next reconnect reads it.
  attachOnly(): Promise<DesktopDaemonAcquisition> {
    if (this.#releasing) return Promise.reject(new Error("Desktop is quitting"))
    if (this.#attempt) return this.#attempt.then(describeAcquisition)
    return this.#acquireWith("attach-only", true)
  }

  // A handoff that failed after the stop, or a removed service, leaves the
  // profile free: start the app's own daemon again rather than sit on a
  // refusal. An attachment to the removed service is dropped first; the
  // profile lock still decides, so this never starts a second daemon.
  async restart(): Promise<DesktopDaemonAcquisition> {
    if (this.#releasing) throw new Error("Desktop is quitting")
    await this.#attempt?.catch(() => {})
    const handle = this.#handle
    if (handle?.kind === "owned") return describeAcquisition(handle)
    if (handle?.kind === "attached") {
      this.#handle = undefined
      this.#detach(handle)
    }
    return this.#acquireWith("start-or-attach", true)
  }

  #serve(reconnect: boolean): Promise<DesktopDaemonAcquisition> {
    if (this.#releasing) return Promise.reject(new Error("Desktop is quitting"))
    if (this.#handoff) return this.#handoff.ended.then(() => this.#serve(reconnect))
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
    if (this.#detached.has(handle) || this.#releasing || this.#handoff || this.#attempt || this.#handle !== handle) return
    void this.#acquireWith("attach-only", true).catch(() => {})
  }

  async #release(): Promise<void> {
    await this.#attempt?.catch(() => {})
    const handle = this.#handle
    if (handle?.kind === "owned") await handle.stop()
    else if (handle?.kind === "attached") this.#detach(handle)
  }
}
