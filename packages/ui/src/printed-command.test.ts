import { describe, expect, it } from "vitest"

import { parseCommandLinkResult, printedCommand, type CommandLinkView } from "./printed-command"

// The preload passes the main process's answer through unchecked, so the
// renderer reads only the shape it knows.
describe("command link answers", () => {
  it("reads a report, an unavailable one with its launchers, and a refusal", () => {
    const report = { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "domovoid", launcher: "/A/daemon-runtime/bin/domovoid", state: "absent" }] }
    expect(parseCommandLinkResult({ report })).toEqual({ report })
    expect(parseCommandLinkResult({ report, refused: "~/.local/bin/domovoi is not a link Domovoi made, so it was left as it is." }))
      .toEqual({ report, refused: "~/.local/bin/domovoi is not a link Domovoi made, so it was left as it is." })
    const unavailable = { available: false, reason: "r", launchers: [{ name: "domovoi", launcher: "/A/daemon-runtime/bin/domovoi" }] }
    expect(parseCommandLinkResult({ report: unavailable })).toEqual({ report: unavailable })
  })

  it.each([
    ["nothing", undefined],
    ["no report", {}],
    ["an unknown command", { report: { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "rm", launcher: "/x", state: "absent" }] } }],
    ["an unknown state", { report: { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "domovoid", launcher: "/x", state: "maybe" }] } }],
    ["a relative launcher", { report: { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "domovoid", launcher: "x/domovoid", state: "absent" }] } }],
    ["another directory", { report: { available: true, directory: "/etc", onPath: false, commands: [] } }],
    ["an unavailable report without a reason", { report: { available: false } }],
    ["a refusal that is not text", { report: { available: false, reason: "r" }, refused: 5 }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseCommandLinkResult(value)).toThrow("Desktop returned an invalid command link answer")
  })
})

const launcher = "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/bin/domovoid"
const view = (state: "linked" | "absent" | "stale" | "other", onPath = false): CommandLinkView => ({
  available: true,
  directory: "~/.local/bin",
  onPath,
  commands: [{ name: "domovoid", launcher, state }],
})

// Review P3-5 (Q336 A): a printed command runs as printed. With the link,
// the short name where ~/.local/bin is on PATH, else the link's full path;
// without it, the launcher the app ships, by its full path.
describe("printed commands", () => {
  it("prints the plain name where nothing is known, as the web does", () => {
    expect(printedCommand("domovoid service install")).toBe("domovoid service install")
  })

  it("uses the link where there is one", () => {
    expect(printedCommand("domovoid service install", view("linked", true))).toBe("domovoid service install")
    expect(printedCommand("domovoid service install", view("linked"))).toBe("~/.local/bin/domovoid service install")
  })

  it("prints the shipped launcher by its full path where no link exists", () => {
    for (const state of ["absent", "stale", "other"] as const) {
      expect(printedCommand("domovoid pair --client phone", view(state))).toBe(`${launcher} pair --client phone`)
    }
    expect(printedCommand("domovoid service status", { available: false, reason: "~/.local/bin is a link to another directory, so Domovoi does not read or write there.", launchers: [{ name: "domovoid", launcher }] }))
      .toBe(`${launcher} service status`)
  })

  it("quotes a launcher path a shell would split", () => {
    const spaced = "/Users/dana/My Apps/Domovoi.app/Contents/Resources/daemon-runtime/bin/domovoid"
    expect(printedCommand("domovoid service install", { available: false, reason: "r", launchers: [{ name: "domovoid", launcher: spaced }] }))
      .toBe(`'${spaced}' service install`)
    expect(printedCommand("domovoid service install", { available: false, reason: "r", launchers: [{ name: "domovoid", launcher: "/tmp/it's/domovoid" }] }))
      .toBe(`'/tmp/it'\\''s/domovoid' service install`)
  })

  it("leaves a command alone when the app ships no launcher for it", () => {
    expect(printedCommand("domovoi pair", view("absent"))).toBe("domovoi pair")
    expect(printedCommand("domovoid service install", { available: false, reason: "Domovoi links no commands on Windows." })).toBe("domovoid service install")
  })
})
