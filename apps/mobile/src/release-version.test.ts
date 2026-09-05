import { expect, it, vi } from "vitest"

const release = vi.hoisted(() => ({ version: "9.8.7-test" }))
vi.mock("../package.json", () => release)

it.each(["9.8.7", "9.8.7-test", "9.8.7+build.12"])("derives a numeric native version from release %s", async (version) => {
  release.version = version
  vi.resetModules()
  const appConfig = (await import("../app.config")).default
  expect(appConfig.version).toBe("9.8.7")
  expect(appConfig.ios.bundleIdentifier).toBe("com.getdomovoi.domovoi")
})

it("refuses release metadata without a numeric native version", async () => {
  release.version = "invalid"
  vi.resetModules()
  await expect(import("../app.config")).rejects.toThrow("Mobile package version must start with major.minor.patch")
})
