import { describe, expect, it } from "vitest"

import { isLoginServiceRuntimeVersion, loginServiceAgentLabel, loginServiceHomePaths, loginServiceTaskName, loginServiceUnitFile } from "./login-service.js"

describe("login service names", () => {
  it("names the files and task the daemon installer writes", () => {
    expect(loginServiceHomePaths).toEqual({
      linux: ".config/systemd/user/domovoid.service",
      darwin: "Library/LaunchAgents/sh.domovoi.domovoid.plist",
    })
    expect(loginServiceUnitFile).toBe("domovoid.service")
    expect(loginServiceAgentLabel).toBe("sh.domovoi.domovoid")
    expect(loginServiceTaskName).toBe("Domovoi daemon")
  })
})

// Security review round 8 of #577 (P3): the desktop publishes a runtime copy
// only under such a version, and the daemon reads a version back only from one.
describe("isLoginServiceRuntimeVersion", () => {
  it("accepts a release version that is one directory name", () => {
    for (const version of ["0.9.2", "0.10.0-rc.1", "1.2.3+build.7", "1.2.3-alpha-1.x", `1.2.3-${"a".repeat(58)}`]) {
      expect(isLoginServiceRuntimeVersion(version), version).toBe(true)
    }
  })

  it("refuses anything else, however close", () => {
    for (const version of ["", "0.9", "01.2.3", "0.9.2-..", "0.9.2-", "0.9.2+", "0.9.2-a..b", "..", "0.9.2/x", "0.9.2\\x", " 0.9.2", "0.9.2\n", `1.2.3-${"a".repeat(59)}`]) {
      expect(isLoginServiceRuntimeVersion(version), JSON.stringify(version)).toBe(false)
    }
  })
})
