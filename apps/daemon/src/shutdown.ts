export type ShutdownHooks = {
  removeEndpointFile(): Promise<void>
  stopDaemon(): Promise<void>
  exit(code: number): void
  writeStderr(text: string): void
}

export function installShutdownHandlers(
  hooks: ShutdownHooks,
  target: NodeJS.Process = process,
): void {
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // Each step runs whatever the one before it did: the daemon's stop saves
    // a running emergency stop's state, so a failed removal must not skip it.
    let failed = false
    for (const step of [() => hooks.removeEndpointFile(), () => hooks.stopDaemon()]) {
      try {
        await step()
      } catch (error) {
        failed = true
        hooks.writeStderr(`domovoid shutdown failed: ${String(error)}\n`)
      }
    }
    hooks.exit(failed ? 1 : 0)
  }
  target.on("SIGINT", () => void shutdown())
  target.on("SIGTERM", () => void shutdown())
  target.on("unhandledRejection", (reason: unknown) => {
    hooks.writeStderr(`domovoid unhandled rejection: ${String(reason)}\n`)
  })
}
