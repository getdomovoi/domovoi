import { expect, it } from "vitest"

import { domovoidServiceWords } from "./install.js"
import { lingerInstallLine, type LingerInstallOutcome } from "./linger.js"

it("exports the default service command vocabulary", () => {
  expect(domovoidServiceWords).toEqual({
    install: "domovoid service install", status: "domovoid service status", remove: "domovoid service remove",
    profileRecover: "domovoid profile recover --confirm-no-supervisor",
  })
})

it.each<LingerInstallOutcome>([
  { kind: "enabled" }, { kind: "kept" }, { kind: "already-on" }, { kind: "failed", detail: "Access denied" },
])("uses supplied words and retains the default for lingering $kind", (outcome) => {
  const original = lingerInstallLine(outcome, { user: "dl" })
  expect(original.text).toContain("domovoid service remove")
  expect(lingerInstallLine(outcome, { user: "dl" }, {
    install: "custom install", status: "custom status", remove: "custom remove", profileRecover: "custom recover",
  })).toEqual({ ...original, text: original.text.replace("domovoid service remove", "custom remove") })
})
