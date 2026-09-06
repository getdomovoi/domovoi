import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"

import { daemonWaitTimeoutMs, waitForDaemon } from "./test-wait-for.js"

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

  it("requires every direct vi.waitFor in the daemon suite to name a positive timeout", async () => {
    const offenders: string[] = []
    const entries = await readdir(import.meta.dirname, { recursive: true })
    for (const entry of entries.filter((path) => path.endsWith(".test.ts"))) {
      const path = join(import.meta.dirname, entry)
      const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest)
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
