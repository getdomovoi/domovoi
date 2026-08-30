import { describe, expect, it, vi } from "vitest"

import { DesktopStartupMetrics } from "./startup-metrics.js"

describe("DesktopStartupMetrics", () => {
  it("records bounded monotonic startup milestones and reports once", () => {
    const sink = vi.fn()
    const metrics = new DesktopStartupMetrics({
      enabled: true,
      now: () => 0,
      memoryUsage: () => ({ rss: 100 * 1_024 * 1_024 }),
      sink,
    })

    metrics.mark("app-ready", 10)
    metrics.mark("window-created", 12)
    metrics.mark("renderer-rendered", 14)
    metrics.mark("ready-to-show", 16)
    expect(sink).not.toHaveBeenCalled()
    metrics.mark("daemon-ready", 20)
    metrics.mark("daemon-ready", 21)

    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith({
      type: "domovoi.desktop.startup",
      elapsedMs: 20,
      rssMiB: 100,
      milestones: {
        "app-ready": 10,
        "window-created": 12,
        "renderer-rendered": 14,
        "ready-to-show": 16,
        "daemon-ready": 20,
      },
    })
  })

  it("does no reporting work unless explicitly enabled", () => {
    const sink = vi.fn()
    const metrics = new DesktopStartupMetrics({ enabled: false, sink })
    metrics.mark("ready-to-show")
    metrics.mark("daemon-ready")
    expect(sink).not.toHaveBeenCalled()
  })
})
