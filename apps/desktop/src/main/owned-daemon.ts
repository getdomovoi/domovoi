export interface OwnedDaemon {
  start(): Promise<unknown>
}

interface StoppableOwnedDaemon extends OwnedDaemon {
  stop(): Promise<void>
}

interface QuitEvent {
  preventDefault(): void
}

export class OwnedDaemonLifecycle {
  #starting: Promise<StoppableOwnedDaemon> | undefined
  #stopping: Promise<void> | undefined
  #quitAllowed = false

  start<T extends StoppableOwnedDaemon>(daemon: T): Promise<T> {
    const starting = startOwnedDaemon(daemon)
    this.#starting = starting
    return starting
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
    void this.#stopping.then(allowQuit, allowQuit)
  }

  async #stop(): Promise<void> {
    let daemon: StoppableOwnedDaemon | undefined
    try {
      daemon = await this.#starting
    } catch {
      return
    }
    await daemon?.stop()
  }
}

export async function startOwnedDaemon<T extends OwnedDaemon>(daemon: T): Promise<T> {
  await daemon.start()
  return daemon
}

export async function startDesktop(
  createWindow: () => void,
  startDaemon: () => Promise<void>,
): Promise<void> {
  createWindow()
  await startDaemon()
}
