import { expect, it } from "vitest"

import { activityMeta, type ToolActivity } from "./turn-activity"

function call(id: string, extra: Partial<ToolActivity> = {}): ToolActivity {
  return { id, name: "command", ...extra }
}

it("counts the tools and the distinct files a turn touched", () => {
  const items = [
    call("a", { files: ["src/a.ts", "src/b.ts"] }),
    call("b", { files: ["src/b.ts"] }),
    call("c"),
  ]

  expect(activityMeta(items, false)).toBe("3 tools · 2 files")
})

it("names the tool still running", () => {
  const items = [call("a", { files: ["src/a.ts"] }), call("b", { outcome: "running", argument: "pnpm vitest" })]

  expect(activityMeta(items, true)).toBe("2 tools · 1 file · running pnpm vitest")
})

it("reports failures once the turn has stopped", () => {
  const items = [call("a", { failed: true }), call("b")]

  expect(activityMeta(items, false)).toBe("2 tools · 1 failure")
})

it("says nothing before the first tool call", () => {
  expect(activityMeta([], true)).toBeUndefined()
})
