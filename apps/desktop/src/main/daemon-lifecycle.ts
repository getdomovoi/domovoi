import { desktopDaemonBudgets } from "./desktop-daemon.js"

interface QuitEvent {
  preventDefault(): void
}

export type DesktopDaemonErrorSink = (error: unknown) => void

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
    const deadline = new Promise<void>((resolve) => { setTimeout(resolve, this.releaseTimeoutMs).unref() })
    await Promise.race([this.release(), deadline])
  }
}

export async function startDesktop(
  createWindow: () => void,
  acquireDaemon: () => Promise<void>,
): Promise<void> {
  createWindow()
  await acquireDaemon()
}
