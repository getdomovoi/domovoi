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
    try {
      await hooks.removeEndpointFile()
      await hooks.stopDaemon()
      hooks.exit(0)
    } catch (error) {
      hooks.writeStderr(`domovoid shutdown failed: ${String(error)}\n`)
      hooks.exit(1)
    }
  }
  target.on("SIGINT", () => void shutdown())
  target.on("SIGTERM", () => void shutdown())
  target.on("unhandledRejection", (reason: unknown) => {
    hooks.writeStderr(`domovoid unhandled rejection: ${String(reason)}\n`)
  })
}
