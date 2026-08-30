export interface OwnedDaemon {
  start(): Promise<unknown>
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
