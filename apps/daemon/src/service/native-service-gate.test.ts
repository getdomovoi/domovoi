import { expect, it } from "vitest"

import { nativeServiceOptIn, nativeServiceTestsEnabled, nativeServiceTestsRun } from "../test-native-service-gate.js"

// The native service tests load real launchd, systemd and Windows scheduler
// jobs into the account that runs them. These cases check only the predicate
// that decides whether they run; nothing here reaches a service manager.

it("skips the native service tests on a developer machine and says why", () => {
  const printed: string[] = []
  expect(nativeServiceTestsEnabled("launchd", {}, (line) => printed.push(line))).toBe(false)
  expect(printed).toHaveLength(1)
  expect(printed[0]).toContain("launchd")
  expect(printed[0]).toContain(`${nativeServiceOptIn}=1`)
  expect(printed[0]).toContain("CI")

  // Anything other than the exact opt-in value is not an opt-in.
  for (const value of ["", "0", "true", "yes", " 1"]) {
    expect(nativeServiceTestsEnabled("systemd", { [nativeServiceOptIn]: value }, () => undefined)).toBe(false)
  }
  for (const value of ["", "0", "false", "FALSE"]) {
    expect(nativeServiceTestsEnabled("systemd", { CI: value }, () => undefined)).toBe(false)
  }
})

it("runs the native service tests on CI or with the explicit opt-in, silently", () => {
  const printed: string[] = []
  const print = (line: string) => printed.push(line)
  expect(nativeServiceTestsEnabled("launchd", { [nativeServiceOptIn]: "1" }, print)).toBe(true)
  expect(nativeServiceTestsEnabled("launchd", { CI: "true" }, print)).toBe(true)
  expect(nativeServiceTestsEnabled("launchd", { CI: "1" }, print)).toBe(true)
  // CI wins over a stray opt-in value, so a hosted leg can never skip.
  expect(nativeServiceTestsEnabled("Windows Task Scheduler", { CI: "true", [nativeServiceOptIn]: "0" }, print)).toBe(true)
  expect(printed).toEqual([])
})

it("asks the service manager nothing when the native tests are skipped", () => {
  let probes = 0
  const answers = (available: boolean) => () => { probes += 1; return available }
  const quiet = () => undefined

  // The local run that left a test agent loaded had a manager that answered.
  // Skipped, the probe is never called, so even a read-only manager query is
  // off a developer machine.
  expect(nativeServiceTestsRun("launchd", answers(true), {}, quiet)).toBe(false)
  expect(probes).toBe(0)

  const optedIn = { [nativeServiceOptIn]: "1" }
  expect(nativeServiceTestsRun("launchd", answers(true), optedIn, quiet)).toBe(true)
  // An absent manager still skips after the opt-in, as it did before.
  expect(nativeServiceTestsRun("systemd", answers(false), optedIn, quiet)).toBe(false)
  expect(nativeServiceTestsRun("systemd", answers(true), { CI: "true" }, quiet)).toBe(true)
  // A probe that requires the manager on CI keeps failing loud.
  expect(() => nativeServiceTestsRun("launchd", () => { throw new Error("gui domain required") }, { CI: "true" }, quiet))
    .toThrow("gui domain required")
  expect(probes).toBe(3)
})
