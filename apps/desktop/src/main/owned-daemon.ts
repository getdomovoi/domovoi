export interface OwnedDaemon {
  start(): Promise<unknown>
}

interface StoppableOwnedDaemon extends OwnedDaemon {
  stop(): Promise<void>
}

type OwnedDaemonAddress<T extends OwnedDaemon> = Awaited<ReturnType<T["start"]>>

interface QuitEvent {
  preventDefault(): void
}

export type OwnedDaemonErrorSink = (error: unknown) => void

export class OwnedDaemonLifecycle {
  #starting: Promise<StoppableOwnedDaemon> | undefined
  #stopping: Promise<void> | undefined
  #quitAllowed = false

  constructor(
    private readonly errorSink: OwnedDaemonErrorSink = () => {},
    private readonly stopTimeoutMs = 10_000,
  ) {}

  start<T extends StoppableOwnedDaemon>(daemon: T): Promise<OwnedDaemonAddress<T>> {
    let address!: OwnedDaemonAddress<T>
    const starting = (async () => {
      address = await daemon.start() as OwnedDaemonAddress<T>
      return daemon
    })()
    this.#starting = starting
    return starting.then(() => address)
  }

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
    let daemon: StoppableOwnedDaemon | undefined
    try {
      daemon = await this.#starting
    } catch {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(resolve, this.stopTimeoutMs)
      deadline.unref()
      void (daemon?.stop() ?? Promise.resolve()).then(() => {
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
  startDaemon: () => Promise<void>,
): Promise<void> {
  createWindow()
  await startDaemon()
}
