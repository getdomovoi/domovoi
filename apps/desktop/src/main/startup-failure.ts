export function recordStartupFailure(options: {
  error: unknown
  logPath: string
  append: (logPath: string, text: string) => void
  now?: () => Date
}): string {
  const line = `${(options.now?.() ?? new Date()).toISOString()} startup failed: ${String(options.error)}\n`
  try {
    options.append(options.logPath, line)
  } catch {
    // A log destination that cannot be written must not hide the original error.
  }
  return `The local daemon did not start.\n\n${String(options.error)}\n\nDetails: ${options.logPath}`
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
