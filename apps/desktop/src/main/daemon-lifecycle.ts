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
    const allowQuit = (): void => {
      this.#quitAllowed = true
      quit()
    }
    void this.#stopping.then(allowQuit, (error) => {
      try {
        this.errorSink(error)
      } finally {
        allowQuit()
      }
    })
  }

  async #stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(resolve, this.releaseTimeoutMs)
      deadline.unref()
      let releasing: Promise<void>
      try {
        releasing = this.release()
      } catch (error) {
        releasing = Promise.reject(error)
      }
      void releasing.then(() => {
        clearTimeout(deadline)
        resolve()
      }, (error: unknown) => {
        clearTimeout(deadline)
        reject(error)
      })
    })
  }
}

export async function startDesktop(
  createWindow: () => void,
  acquireDaemon: () => Promise<void>,
): Promise<void> {
  createWindow()
  await acquireDaemon()
}
