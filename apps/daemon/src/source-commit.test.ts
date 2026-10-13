import { afterEach, expect, it, vi } from "vitest"
import * as daemon from "./public.js"

afterEach(() => vi.unstubAllGlobals())

it("exposes the loaded runtime's build commit to desktop consumers", () => {
  vi.stubGlobal("__BUILD_SOURCE_COMMIT__", "a".repeat(40))
  expect(Reflect.get(daemon, "builtSourceCommit")?.()).toBe("a".repeat(40))
})

it.each([undefined, null, "", "abc1234", "g".repeat(40)])("reports unknown runtime metadata for %s", (commit) => {
  vi.stubGlobal("__BUILD_SOURCE_COMMIT__", commit)
  expect(typeof Reflect.get(daemon, "builtSourceCommit")).toBe("function")
  expect(Reflect.get(daemon, "builtSourceCommit")()).toBeUndefined()
})
