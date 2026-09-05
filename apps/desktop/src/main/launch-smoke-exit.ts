import { desktopDaemonBudgets } from "./desktop-daemon.js"

// A renderer failure can arrive while successful verification is releasing
// the daemon. Failure stays sticky, and every exit shares one bounded release.
export class LaunchSmokeExit {
  #result: 0 | 1 = 0
  #finishing: Promise<void> | undefined

  constructor(
    private readonly release: () => Promise<void>,
    private readonly exit: (code: 0 | 1) => void,
    private readonly report: (error: unknown) => void,
    private readonly timeoutMs = desktopDaemonBudgets.releaseMs,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new Error("Desktop smoke release budget must be a positive bounded integer")
    }
  }

  finish(code: 0 | 1): Promise<void> {
    if (code === 1) this.#result = 1
    this.#finishing ??= this.#finish()
    return this.#finishing
  }

  async #finish(): Promise<void> {
    const expiresAt = performance.now() + this.timeoutMs
    const timeoutError = new Error(`Desktop smoke daemon release timed out after ${this.timeoutMs}ms`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), this.timeoutMs)
      })
      await Promise.race([deadline, Promise.resolve().then(this.release)])
      if (performance.now() >= expiresAt) throw timeoutError
    } catch (error) {
      this.#result = 1
      try { this.report(error) } catch { /* A failed log must not prevent the failure exit. */ }
    } finally {
      clearTimeout(timer)
    }
    this.exit(this.#result)
  }
}
