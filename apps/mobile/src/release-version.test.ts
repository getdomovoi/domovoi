import { expect, it, vi } from "vitest"

import appConfig from "../app.config"

vi.mock("../package.json", () => ({ version: "9.8.7-test" }))

it("uses the mobile release metadata for the native app version too", () => {
  expect(appConfig.version).toBe("9.8.7-test")
  expect(appConfig.ios.bundleIdentifier).toBe("com.getdomovoi.domovoi")
})
