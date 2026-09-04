// A daemon that accepts a request and never answers leaves the caller waiting
// forever, and a half-open connection on a phone can stay half-open for minutes
// before the socket notices. The wait has to end on its own.
export const defaultRequestTimeoutMs = 30_000

export class DaemonTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number

  constructor(method: string, timeoutMs: number) {
    super(`${method} got no answer in ${Math.round(timeoutMs / 1000)} seconds`)
    this.name = "DaemonTimeoutError"
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

// A turn is started by the daemon and answered as soon as it has started, not
// when it finishes, so no ordinary call is long-running. A transfer is the
// exception and the phone does not offer one.
export function requestTimeoutMs(method: string): number {
  return method === "workspace.get" ? 15_000 : defaultRequestTimeoutMs
}
