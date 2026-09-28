export type ShutdownHooks = {
  removeEndpointFile(): Promise<void>
  stopDaemon(): Promise<void>
  exit(code: number): void
  writeStderr(text: string): void
  // The Claude processes this daemon started that have not exited yet.
  runningProcesses?(): Array<{ pid: number; session?: string; exited: Promise<void> }>
}

export function installShutdownHandlers(
  hooks: ShutdownHooks,
  target: NodeJS.Process = process,
): void {
  let shuttingDown = false
  // Set while a failed stop waits for a Claude process to exit.
  let forceExit: (() => void) | undefined
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
    // A stop that failed has kept the profile lease. Exiting would release
    // it, with the process lock, while a Claude process the stop could not
    // kill still runs, and a new daemon could then start a second writer in
    // the same worktree. So the daemon stays until each one has exited, or
    // until a second SIGINT (security review round 1 of #647, Q105).
    const running = failed ? hooks.runningProcesses?.() ?? [] : []
    if (running.length > 0) {
      for (const { pid, session } of running) {
        const named = session === undefined ? "" : ` (Claude session ${session})`
        hooks.writeStderr(
          `domovoid: Claude process ${pid}${named} is still running. The profile lock stays held until it exits.\n`,
        )
      }
      hooks.writeStderr("domovoid: press Ctrl-C again to exit now.\n")
      const forced = new Promise<true>((resolve) => { forceExit = () => resolve(true) })
      const gone = Promise.all(running.map(({ exited }) => exited)).then(() => false as const)
      if (await Promise.race([gone, forced])) {
        const alive = hooks.runningProcesses?.() ?? running
        const pids = alive.map(({ pid }) => pid).join(", ")
        if (alive.length > 0) {
          hooks.writeStderr(
            `domovoid: exiting now. The profile lock is released while Claude ${alive.length === 1 ? "process" : "processes"} ${pids} may still be running.\n`,
          )
        }
      }
    }
    hooks.exit(failed ? 1 : 0)
  }
  target.on("SIGINT", () => {
    // Only a SIGINT ends the wait for a Claude process; a SIGTERM does not.
    if (forceExit) forceExit()
    else void shutdown()
  })
  target.on("SIGTERM", () => void shutdown())
  target.on("unhandledRejection", (reason: unknown) => {
    hooks.writeStderr(`domovoid unhandled rejection: ${String(reason)}\n`)
  })
}
