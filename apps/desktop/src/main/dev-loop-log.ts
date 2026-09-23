// An unchanged window is ambiguous: it can mean the edit applied and changed
// nothing visible, or that nothing reloaded at all. The loop removes the
// ambiguity by naming which of the two happened on every boot, so a silent
// window is always a statement rather than a guess.
//
// Renderer edits never reach here. They are reported by the renderer plugin,
// which is how the two paths stay distinguishable in one terminal. Every
// watched save prints exactly one line, so no save is ever answered by silence.
// The boot count lives in a file named by the environment, because it has to
// outlive the main process it describes.
export const devLoopStateVariable = "DOMOVOI_DEV_LOOP_STATE"
export const devLoopKindVariable = "DOMOVOI_DEV_LOOP_KIND"

export function mainBootLine(bootCount: number, kind: "fixture" | "daemon" = "fixture"): string {
  const target = kind === "daemon" ? "the real daemon" : "the fixture daemon"
  const kept = kind === "daemon" ? "Daemon state kept." : "Fixture state kept."
  return bootCount <= 1
    ? `[loop] window started against ${target}. Renderer edits apply in place; main and preload edits relaunch this window.`
    : `[loop] window relaunched (main or preload edit, boot ${bootCount}). ${kept}`
}
export function nextBootCount(previous: string | undefined): number {
  const parsed = Number.parseInt(previous ?? "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed + 1 : 1
}

// Electron quits at once when another instance holds the single-instance lock.
// Quitting is silent and the exit code is zero, which reads exactly like a
// clean shutdown, so the loop says what happened and names the window to close.
export function lockHeldLine(): string {
  return "[loop] another Domovoi window already holds the single-instance lock, so this window quit before it opened. Close the other window, then run this command again."
}

export function reportLockHeld(options: {
  environment: NodeJS.ProcessEnv
  log: (line: string) => void
}): void {
  if (!options.environment[devLoopStateVariable]) return
  options.log(lockHeldLine())
}

export function reportMainBoot(options: {
  environment: NodeJS.ProcessEnv
  readState: (path: string) => string | undefined
  writeState: (path: string, value: string) => void
  log: (line: string) => void
}): void {
  const statePath = options.environment[devLoopStateVariable]
  if (!statePath) return
  const count = nextBootCount(options.readState(statePath))
  options.writeState(statePath, String(count))
  const kind = options.environment[devLoopKindVariable] === "daemon" ? "daemon" : "fixture"
  options.log(mainBootLine(count, kind))
}
