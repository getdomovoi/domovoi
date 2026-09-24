type StartupFailure = {
  error: unknown
  logPath: string
  append: (logPath: string, text: string) => void
  now?: () => Date
}

function logStartupFailure(options: StartupFailure, text: string): void {
  try {
    options.append(options.logPath, `${(options.now?.() ?? new Date()).toISOString()} startup failed: ${text}\n`)
  } catch {
    // A log destination that cannot be written must not hide the original error.
  }
}

export function recordStartupFailure(options: StartupFailure): string {
  logStartupFailure(options, String(options.error))
  return `The local daemon did not start.\n\n${String(options.error)}\n\nDetails: ${options.logPath}`
}

// Approved 2026-09-23 (#577): the runtime this app ships is missing or does
// not load. The loader's message names the path and what is missing.
export function recordDaemonRuntimeFailure(options: StartupFailure): string {
  const text = options.error instanceof Error ? options.error.message : String(options.error)
  logStartupFailure(options, text)
  return `The daemon runtime this app ships could not be loaded.\n\n${text}\n\nReinstall Domovoi to restore it. Details: ${options.logPath}`
}

export function daemonErrorLogSink(
  logPath: string,
  append: (logPath: string, text: string) => void,
): (entry: { context: string; detail: string }) => void {
  return (entry) => {
    try {
      append(logPath, `${new Date().toISOString()} ${entry.context}: ${entry.detail}\n`)
    } catch {
      // Errors while logging daemon errors must not reach the Electron main loop.
    }
  }
}
