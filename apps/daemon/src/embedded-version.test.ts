import { describe, expect, it } from "vitest"

import { requireTestedVersion } from "./embedded-version.js"

// Security review round 5 of #687 (P2): only the exact releases that passed
// the live contract start, and the answer must be one bare version line, as
// `opencode --version` and `kilo --version` print it ("1.18.33\n").
describe("requireTestedVersion", () => {
  const opencode = { command: "opencode", providerName: "OpenCode", tested: ["1.18.32", "1.18.33"] }
  const kilo = { command: "kilo", providerName: "Kilo", tested: ["7.8.1"] }

  it.each([["1.18.32"], ["1.18.33\n"], ["  1.18.33  \n"]])("accepts %j, a tested release", async (output) => {
    await expect(requireTestedVersion(opencode, async () => output)).resolves.toBe(output.trim())
  })

  it("accepts Kilo 7.8.1 and refuses 7.8.2", async () => {
    await expect(requireTestedVersion(kilo, async () => "7.8.1\n")).resolves.toBe("7.8.1")
    await expect(requireTestedVersion(kilo, async () => "7.8.2\n")).rejects.toThrow("Kilo 7.8.2 is not a release Domovoi was tested with")
  })

  it.each([["1.18.34"], ["1.18.31"], ["1.18.0"], ["1.19.0"], ["2.18.33"]])("refuses %j, naming the found and tested versions", async (output) => {
    const refusal = requireTestedVersion(opencode, async () => output)
    await expect(refusal).rejects.toThrow(`OpenCode ${output} is not a release Domovoi was tested with`)
    await expect(refusal).rejects.toThrow("OpenCode 1.18.32 and 1.18.33")
  })

  it.each([
    ["Update available: 1.18.33\n1.19.0"],
    ["1.18.33\n1.19.0"],
    ["opencode 1.18.33"],
    ["v1.18.33"],
    ["1.18.33-beta"],
    ["no version here"],
    [""],
  ])("refuses %j, which is not one bare version line", async (output) => {
    const refusal = requireTestedVersion(opencode, async () => output)
    await expect(refusal).rejects.toThrow("could not read the version of OpenCode")
    await expect(refusal).rejects.toThrow("OpenCode 1.18.32 and 1.18.33")
  })

  it("refuses when the version cannot be read", async () => {
    await expect(requireTestedVersion(opencode, async () => { throw new Error("ENOENT") })).rejects.toThrow("could not read the version of OpenCode")
  })
})
