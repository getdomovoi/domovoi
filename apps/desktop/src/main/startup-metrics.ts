type StartupMilestone = "app-ready" | "window-created" | "renderer-rendered" | "ready-to-show" | "daemon-ready"

type StartupReport = {
  type: "domovoi.desktop.startup"
  elapsedMs: number
  rssMiB: number
  milestones: Partial<Record<StartupMilestone, number>>
}

type StartupMetricsOptions = {
  enabled: boolean
  now?: () => number
  memoryUsage?: () => { rss: number }
  sink?: (report: StartupReport) => void
}

export class DesktopStartupMetrics {
  readonly #enabled: boolean
  readonly #now: () => number
  readonly #memoryUsage: () => { rss: number }
  readonly #sink: (report: StartupReport) => void
  readonly #startedAt: number
  readonly #milestones = new Map<StartupMilestone, number>()
  #reported = false

  constructor(options: StartupMetricsOptions) {
    this.#enabled = options.enabled
    this.#now = options.now ?? (() => performance.now())
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
    this.#sink = options.sink ?? ((report) => console.info(JSON.stringify(report)))
    this.#startedAt = this.#now()
  }

  mark(milestone: StartupMilestone, now = this.#now()): void {
    if (!this.#enabled || this.#reported || this.#milestones.has(milestone)) return
    this.#milestones.set(milestone, Math.max(0, now - this.#startedAt))
    if (!this.#milestones.has("ready-to-show") || !this.#milestones.has("daemon-ready")) return
    this.#reported = true
    this.#sink({
      type: "domovoi.desktop.startup",
      elapsedMs: Math.max(...this.#milestones.values()),
      rssMiB: this.#memoryUsage().rss / (1_024 * 1_024),
      milestones: Object.fromEntries(this.#milestones),
    })
  }
}
