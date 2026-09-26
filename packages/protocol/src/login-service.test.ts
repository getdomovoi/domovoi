import { describe, expect, it } from "vitest"

import { loginServiceAgentLabel, loginServiceHomePaths, loginServiceTaskName, loginServiceUnitFile } from "./login-service.js"

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
