import { describe, expect, it } from "vitest"

import { launchdPlist, launchdPlistProgram, systemdUnit, systemdUnitProgram } from "./units.js"

const execPath = "/opt/domovoi/bin/domovoid"

describe("systemdUnit", () => {
  it("supervises the daemon as a user service", () => {
    const unit = systemdUnit({ execPath })
    expect(unit).toMatch(/^\[Unit\]$/m)
    expect(unit).toMatch(/^ExecStart=\/opt\/domovoi\/bin\/domovoid$/m)
    expect(unit).toMatch(/^Restart=on-failure$/m)
    expect(unit).toMatch(/^RestartSec=5$/m)
    expect(unit).toMatch(/^WantedBy=default\.target$/m)
  })

  it("never asks systemd to run the daemon as root", () => {
    const unit = systemdUnit({ execPath })
    expect(unit).not.toMatch(/^User=root$/m)
    expect(unit).not.toMatch(/WantedBy=multi-user\.target/)
  })

  it("names the installed configuration as one argument", () => {
    expect(systemdUnit({ execPath, args: ["--service-config", "/home/Jean Doe/.domovoi/service.json"] }))
      .toContain(' --service-config "/home/Jean Doe/.domovoi/service.json"')
  })

  it("passes literal paths through systemd expansion", () => {
    expect(systemdUnit({ execPath, args: ["/home/$NAME%h/back\\slash's.json"] }))
      .toContain('"/home/$$NAME%%h/back\\\\slash\'s.json"')
  })

  it("quotes an exec path that systemd would otherwise split into command items", () => {
    expect(systemdUnit({ execPath: "/opt/Domovoi Suite/domovoid" }))
      .toMatch(/^ExecStart="\/opt\/Domovoi Suite\/domovoid"$/m)
  })

  it.each(["domovoid", "./domovoid", ""])("refuses the unpinned exec path %j", (candidate) => {
    expect(() => systemdUnit({ execPath: candidate })).toThrow(/absolute/)
  })

  it.each([
    "/opt/domovoi\nExecStart=/bin/sh",
    "/opt/domovoi\"x",
    "/opt/domovoi\u0000x",
  ])("refuses an exec path that would break out of the unit: %j", (candidate) => {
    expect(() => systemdUnit({ execPath: candidate })).toThrow(/cannot contain/)
  })
})

describe("launchdPlist", () => {
  it("keeps the daemon running", () => {
    const plist = launchdPlist({ execPath })
    expect(plist).toMatch(/<key>Label<\/key>\s*<string>sh\.domovoi\.domovoid<\/string>/)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<string>\/opt\/domovoi\/bin\/domovoid<\/string>/)
  })

  it("restarts only when the daemon failed", () => {
    expect(launchdPlist({ execPath })).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    )
  })

  it("escapes a value that would otherwise close the plist markup", () => {
    expect(launchdPlist({ execPath, args: ["a<b&c"] }))
      .toMatch(/<string>a&lt;b&amp;c<\/string>/)
  })

  it("keeps a spaced path as one program argument", () => {
    expect(launchdPlist({ execPath: "/opt/Domovoi Suite/domovoid" }))
      .toMatch(/<string>\/opt\/Domovoi Suite\/domovoid<\/string>/)
  })
})

// An update puts back only a file these writers would have written, so each
// must read its own output back, however its values were escaped.
describe("reading back a service file", () => {
  const tricky = { execPath: "/opt/Domovoi Suite/node", args: ["/home/$NAME%h/back\\slash's a<b&c.js", "--service-config", "/home/Jean Doe/.domovoi/service.json"] }

  it("recovers the program and arguments of a file each writer wrote", () => {
    expect(systemdUnitProgram(systemdUnit(tricky))).toEqual(tricky)
    expect(launchdPlistProgram(launchdPlist(tricky))).toEqual(tricky)
  })

  it("recovers nothing from a file either writer would not have written", () => {
    expect(systemdUnitProgram(systemdUnit(tricky).replace("[Service]\n", "[Service]\nExecStartPre=/bin/sh\n"))).toBeUndefined()
    expect(systemdUnitProgram(systemdUnit(tricky).replace("%%h", "%h"))).toBeUndefined()
    expect(systemdUnitProgram("")).toBeUndefined()
    expect(launchdPlistProgram(launchdPlist(tricky).replace("sh.domovoi.domovoid", "com.example.other"))).toBeUndefined()
    expect(launchdPlistProgram(launchdPlist(tricky).replace("&amp;", "&"))).toBeUndefined()
    expect(launchdPlistProgram("")).toBeUndefined()
  })
})

describe("both unit writers", () => {
  it.each(["", "\nExecStart=/bin/sh", '"/bin/sh"', "\u0000"])(
    "refuses an argument that could break out of the service file: %j",
    (argument) => {
      expect(() => systemdUnit({ execPath, args: [argument] })).toThrow(/service argument/)
      expect(() => launchdPlist({ execPath, args: [argument] })).toThrow(/service argument/)
    },
  )
})
