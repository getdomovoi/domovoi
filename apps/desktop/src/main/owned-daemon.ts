export interface OwnedDaemon {
  start(): Promise<unknown>
}

export async function startOwnedDaemon<T extends OwnedDaemon>(daemon: T): Promise<T> {
  await daemon.start()
  return daemon
}
