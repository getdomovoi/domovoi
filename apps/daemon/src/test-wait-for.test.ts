import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  daemonWaitTimeoutMs, fixtureStartupTimeoutMs, productionRpcTimeoutMs, waitForDaemon, waitForFixtureStartup,
} from "./test-wait-for.js"

afterEach(() => vi.restoreAllMocks())

describe("daemon assertion waits", () => {
  it.each([
    ["win32", 10_000],
    ["linux", 3_000],
    ["darwin", 3_000],
  ] as const)("bounds %s observations at %i ms", (platform, timeout) => {
    expect(daemonWaitTimeoutMs(platform)).toBe(timeout)
  })

  it("passes the finite platform budget to Vitest instead of its idle-machine default", async () => {
    const wait = vi.spyOn(vi, "waitFor").mockResolvedValue("observed")
    const assertion = () => "observed"

    await expect(waitForDaemon(assertion)).resolves.toBe("observed")
    expect(wait).toHaveBeenCalledWith(assertion, {
      timeout: daemonWaitTimeoutMs(process.platform),
    })
  })

  it("keeps the assertion failure when an observation expires", async () => {
    const failure = new Error("expected the session to finish")
    vi.spyOn(vi, "waitFor").mockRejectedValue(failure)

    await expect(waitForDaemon(() => {})).rejects.toBe(failure)
  })

  it.each([
    ["win32", 25_000],
    ["linux", 10_000],
    ["darwin", 10_000],
  ] as const)("gives a spawned %s fixture longer to start than an observation", (platform, timeout) => {
    expect(fixtureStartupTimeoutMs(platform)).toBe(timeout)
    expect(timeout).toBeGreaterThan(daemonWaitTimeoutMs(platform))
  })

  it("clears the worst passing Windows run measured in CI by more than twice", () => {
    expect(fixtureStartupTimeoutMs("win32")).toBeGreaterThan(2 * 8_103)
  })

  it("exceeds the twenty second Windows budget that expired twice on one job", () => {
    expect(fixtureStartupTimeoutMs("win32")).toBeGreaterThan(20_000)
  })

  it.each([
    ["win32", 25_000],
    ["linux", 10_000],
    ["darwin", 10_000],
  ] as const)("gives one production harness call on %s longer than a spawned fixture start", (platform, timeout) => {
    expect(productionRpcTimeoutMs(platform)).toBe(timeout)
    expect(timeout).toBeGreaterThanOrEqual(fixtureStartupTimeoutMs(platform))
  })

  // Every passing Windows run answered inside the fixed ten seconds this budget
  // replaced, so ten seconds is the ceiling on the worst passing call.
  it("clears the ceiling on the worst passing Windows call by two and a half times", () => {
    expect(productionRpcTimeoutMs("win32")).toBeGreaterThanOrEqual(2.5 * 10_000)
  })

  it("names the budget when a fixture never starts and keeps the assertion as the cause", async () => {
    const failure = new Error("The daemon fixture has not printed its address yet")
    vi.spyOn(vi, "waitFor").mockRejectedValue(failure)

    await expect(waitForFixtureStartup("The keyring fixture", () => {})).rejects.toThrow(
      `The keyring fixture did not start within its ${fixtureStartupTimeoutMs(process.platform)}ms startup budget`,
    )
    await expect(waitForFixtureStartup("The keyring fixture", () => {})).rejects.toMatchObject({ cause: failure })
  })

  // A fixture that has exited cannot become ready, so waiting out the budget
  // only replaces what it printed with "did not start".
  it("stops at once when the fixture can no longer start, and says what it printed", async () => {
    const outcome = await Promise.race([
      waitForFixtureStartup("The service fixture", () => { throw new Error("The owner record is not ready") }, {
        output: () => "stderr: DOMOVOI_PORT must be an integer from 0 through 65535",
        stopped: () => "exited with code 1",
      }).then(() => "started", (error: unknown) => error),
      new Promise((resolve) => setTimeout(resolve, 1_000, "still waiting")),
    ])

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain("The service fixture stopped before it started: exited with code 1")
    expect((outcome as Error).message).toContain("DOMOVOI_PORT must be an integer from 0 through 65535")
  })

  it("prints what the fixture wrote when its startup budget expires", async () => {
    const failure = new Error("The owner record is not ready")
    vi.spyOn(vi, "waitFor").mockRejectedValue(failure)
    const waiting = waitForFixtureStartup("The service fixture", () => {}, {
      output: () => "stderr: EPERM: operation not permitted, rename",
      stopped: () => undefined,
    })

    await expect(waiting).rejects.toThrow(
      `The service fixture did not start within its ${fixtureStartupTimeoutMs(process.platform)}ms startup budget`,
    )
    await expect(waiting).rejects.toThrow("EPERM: operation not permitted, rename")
    await expect(waiting).rejects.toMatchObject({ cause: failure })
  })

  it("keeps waiting through output the fixture recovers from", async () => {
    let polls = 0
    const printed = "Error: Fleet lifecycle recovery will retry"

    await expect(waitForFixtureStartup("The service fixture", () => {
      polls += 1
      if (polls < 3) throw new Error("The owner record is not ready")
      return "ready"
    }, { output: () => printed, stopped: () => undefined })).resolves.toBe("ready")
    expect(polls).toBe(3)
  })

  it("requires every direct vi.waitFor in the daemon suite to name a positive timeout", async () => {
    const offenders: string[] = []
    const entries = await readdir(import.meta.dirname, { recursive: true })
    for (const entry of entries.filter((path) => path.endsWith(".test.ts"))) {
      const path = join(import.meta.dirname, entry)
      const text = await readFile(path, "utf8")
      // Parsing every file under coverage outgrew the 5 s Linux budget. A call
      // named waitFor needs the whole word in the text, or a \u escape that
      // spells it, so any other file cannot hold an offender and skips the parse.
      if (/\bwaitFor\b/.test(text) === false && text.includes("\\u") === false) continue
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest)
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(source) === "vi"
          && node.expression.name.text === "waitFor"
        ) {
          const options = node.arguments[1]
          const timeout = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((property) => (
              ts.isPropertyAssignment(property) && property.name.getText(source) === "timeout"
            ))
            : undefined
          const value = timeout && ts.isPropertyAssignment(timeout) ? timeout.initializer : options
          if (
            value === undefined
            || ts.isNumericLiteral(value) === false
            || Number.isFinite(Number(value.text)) === false
            || Number(value.text) <= 0
          ) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
            offenders.push(`${entry.replaceAll("\\", "/")}:${line}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }

    expect(offenders).toEqual([])
  })
})
