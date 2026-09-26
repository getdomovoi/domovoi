// Approved 2026-09-23 (#577): the runtime this app ships is missing or does
// not load. The loader's message names the path and what is missing. Loaded
// only on that failure, so none of it counts toward the startup bundle (owner
// ruling 2026-09-26, B). It logs as recordStartupFailure does, in its own code,
// so no startup code moves into a chunk shared with it.
export function recordDaemonRuntimeFailure(options: {
  error: unknown
  logPath: string
  append: (logPath: string, text: string) => void
  now?: () => Date
}): string {
  const text = options.error instanceof Error ? options.error.message : String(options.error)
  try {
    options.append(options.logPath, `${(options.now?.() ?? new Date()).toISOString()} startup failed: ${text}\n`)
  } catch {
    // A log destination that cannot be written must not hide the original error.
  }
  return `The daemon runtime this app ships could not be loaded.\n\n${text}\n\nReinstall Domovoi to restore it. Details: ${options.logPath}`
}
