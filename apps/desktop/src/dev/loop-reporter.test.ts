import { describe, expect, it } from "vitest"

import { changeLine, classifyChange, devLoopReporter } from "./loop-reporter.js"

type FakeServer = {
  watcher: { on: (event: string, listener: (file: string) => void) => void }
  hot: { send: (payload: unknown) => void }
}

function fakeServer(): { server: FakeServer; change: (file: string) => void } {
  let onChange: (file: string) => void = () => {}
  const server: FakeServer = {
    watcher: {
      on: (event, listener) => {
        if (event === "change") onChange = listener
      },
    },
    hot: { send: () => {} },
  }
  return { server, change: (file) => onChange(file) }
}

describe("the development loop reload report", () => {
  // The bug this exists for: the in-place line claimed the window state was
  // kept, while Vite had given up on Fast Refresh and reloaded the page. A
  // half-true line is worse than a missing one.
  it("reports the reload when Fast Refresh cannot apply a renderer save", () => {
    const lines: string[] = []
    const { server, change } = fakeServer()
    const plugin = devLoopReporter({ root: "/repo", log: (line) => lines.push(line) })
    ;(plugin.configureServer as (s: unknown) => void)(server)

    change("/repo/packages/ui/src/thread.tsx")
    server.hot.send({ type: "full-reload", path: "/src/main.tsx" })

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("renderer updated: packages/ui/src/thread.tsx")
    expect(lines[1]).toContain("packages/ui/src/thread.tsx")
    expect(lines[1]).toContain("the renderer reloaded")
    expect(lines[1]).toContain("Fixture state kept")
  })

  it("says nothing extra when Fast Refresh applies the save", () => {
    const lines: string[] = []
    const { server, change } = fakeServer()
    const plugin = devLoopReporter({ root: "/repo", log: (line) => lines.push(line) })
    ;(plugin.configureServer as (s: unknown) => void)(server)

    change("/repo/packages/ui/src/thread.tsx")
    server.hot.send({ type: "update", updates: [] })

    expect(lines).toHaveLength(1)
  })

  it("never claims the window state survived a save it only promised to apply", () => {
    expect(changeLine("packages/ui/src/thread.tsx")).not.toContain("Window and fixture state kept")
  })
})

describe("the development loop change report", () => {
  it("calls a renderer save an in-place update", () => {
    expect(classifyChange("packages/ui/src/app-bar.tsx")).toBe("renderer")
    expect(changeLine("packages/ui/src/app-bar.tsx")).toContain("renderer updated")
    expect(changeLine("apps/desktop/src/renderer/src/main.tsx")).toContain("Fixture state kept")
  })

  // The bug this file exists for: a main-process save printed the in-place line
  // and the window never relaunched, so the terminal claimed state was kept
  // when nothing had happened at all.
  it("calls a main or preload save a relaunch, never an in-place update", () => {
    for (const path of ["apps/desktop/src/main/index.ts", "apps/desktop/src/preload/index.ts"]) {
      expect(classifyChange(path)).toBe("relaunch")
      expect(changeLine(path)).toContain("The window relaunches now")
      expect(changeLine(path)).not.toContain("in place")
      expect(changeLine(path)).not.toContain("state kept")
    }
  })

  it("stays silent only where no window change is expected", () => {
    for (const path of ["docs/working-rules.md", "SHIP-PLAN.md", "../outside-the-repo.ts"]) {
      expect(classifyChange(path)).toBe("none")
      expect(changeLine(path)).toBeNull()
    }
  })

  it("stays silent for tests, including tests inside a reporting directory", () => {
    expect(classifyChange("packages/ui/src/app-bar.dom.test.tsx")).toBe("none")
    expect(classifyChange("apps/desktop/src/main/dev-fixture-seam.test.ts")).toBe("none")
  })

  it("never produces zero lines for a source save under a watched directory", () => {
    const watched = [
      "packages/ui/src/thread.tsx",
      "apps/desktop/src/renderer/src/main.tsx",
      "apps/desktop/src/main/index.ts",
      "apps/desktop/src/preload/desktop-bridge.ts",
      "apps/desktop/src/dev/loop-reporter.ts",
    ]
    for (const path of watched) expect(changeLine(path)).not.toBeNull()
  })
})
