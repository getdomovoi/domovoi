import { describe, expect, it } from "vitest"

import { requireTestedVersion } from "./embedded-version.js"

describe("requireTestedVersion", () => {
  const opencode = { command: "opencode", providerName: "OpenCode", line: "1.18", tested: "1.18.32" }

  it.each([["1.18.32"], ["1.18.33\n"], ["opencode 1.18.40"], ["v1.18.0"]])("accepts %j on the tested minor line", async (output) => {
    await expect(requireTestedVersion(opencode, async () => output)).resolves.toMatch(/^1\.18\.\d+$/u)
  })

  it.each([["1.19.0"], ["1.17.99"], ["2.18.32"], ["1.180.1"]])("refuses %j, naming the found and tested versions", async (output) => {
    const refusal = requireTestedVersion(opencode, async () => output)
    await expect(refusal).rejects.toThrow(output)
    await expect(refusal).rejects.toThrow("1.18.32")
    await expect(refusal).rejects.toThrow("1.18.x")
  })

  it("refuses when the version cannot be read", async () => {
    await expect(requireTestedVersion(opencode, async () => "no version here")).rejects.toThrow("could not read the version of OpenCode")
    await expect(requireTestedVersion(opencode, async () => { throw new Error("ENOENT") })).rejects.toThrow("could not read the version of OpenCode")
  })
})
