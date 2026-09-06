import { desktopDaemonBudgets } from "./desktop-daemon.js"

interface QuitEvent {
  preventDefault(): void
}

export type DesktopDaemonErrorSink = (error: unknown) => void

// Quitting cannot wait for a release that will not settle, so the bound wins the
// race. A bounded quit is still a failed shutdown: report it instead of letting
// the process exit as though the daemon had been released.
export class DesktopDaemonReleaseTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `The local daemon release was still pending after ${timeoutMs} ms, ` +
      "so Domovoi quit without observing the daemon stop",
    )
    this.name = "DesktopDaemonReleaseTimeoutError"
  }
}

export class DesktopDaemonLifecycle {
  #stopping: Promise<void> | undefined
  #quitAllowed = false

  constructor(
    private readonly release: () => Promise<void>,
    private readonly errorSink: DesktopDaemonErrorSink = () => {},
    private readonly releaseTimeoutMs = desktopDaemonBudgets.releaseMs,
  ) {}

  beforeQuit(event: QuitEvent, quit: () => void): void {
    if (this.#quitAllowed) return
    event.preventDefault()
    if (this.#stopping) return
    this.#stopping = this.#stop()
      .catch((error: unknown) => { this.errorSink(error) })
      .catch(() => {})
      .finally(() => {
        this.#quitAllowed = true
        quit()
      })
  }

  async #stop(): Promise<void> {
    let expiry: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      expiry = setTimeout(
        () => { reject(new DesktopDaemonReleaseTimeoutError(this.releaseTimeoutMs)) },
        this.releaseTimeoutMs,
      )
      expiry.unref()
    })
    try {
      await Promise.race([this.release(), deadline])
    } finally {
      clearTimeout(expiry)
    }
  }
}

export async function startDesktop(
  createWindow: () => void,
  acquireDaemon: () => Promise<void>,
): Promise<void> {
  createWindow()
  await acquireDaemon()
}
