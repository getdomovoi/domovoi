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
  // Every SIGINT counts, from the first, whatever started the shutdown and
  // whatever step it is in; a SIGTERM never does. The second one ends a wait
  // for a Claude process, at once, or as soon as the wait begins (security
  // review round 2 of #647, R2-F5).
  let interrupts = 0
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
      // Once the second SIGINT has come, during the stop, the hint is moot.
      if (interrupts < 2) hooks.writeStderr("domovoid: press Ctrl-C again to exit now.\n")
      const forced = new Promise<true>((resolve) => { forceExit = () => resolve(true) })
      if (interrupts >= 2) forceExit?.()
      const gone = Promise.all(running.map(({ exited }) => exited)).then(() => false as const)
      // Nothing else may keep the event loop alive while this waits, and an
      // exit then would release the profile lock just the same.
      const hold = setInterval(() => {}, 60_000)
      try {
        if (await Promise.race([gone, forced])) {
          const alive = hooks.runningProcesses?.() ?? running
          const pids = alive.map(({ pid }) => pid).join(", ")
          if (alive.length > 0) {
            hooks.writeStderr(
              `domovoid: exiting now. The profile lock is released while Claude ${alive.length === 1 ? "process" : "processes"} ${pids} may still be running.\n`,
            )
          }
        }
      } finally {
        clearInterval(hold)
      }
    }
    hooks.exit(failed ? 1 : 0)
  }
  target.on("SIGINT", () => {
    // Only a second SIGINT ends the wait for a Claude process; a SIGTERM
    // does not, and does not count toward it.
    interrupts += 1
    if (!shuttingDown) void shutdown()
    else if (interrupts >= 2) forceExit?.()
  })
  target.on("SIGTERM", () => void shutdown())
  target.on("unhandledRejection", (reason: unknown) => {
    hooks.writeStderr(`domovoid unhandled rejection: ${String(reason)}\n`)
  })
}
