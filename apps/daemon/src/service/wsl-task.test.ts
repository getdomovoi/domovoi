import { describe, expect, it } from "vitest"

import { wslTaskPlan } from "./wsl-task.js"

const input = {
  name: "Domovoi WSL test",
  registrationId: "08a1f2da-12e3-4b2c-9e4f-0123456789ab",
  distribution: "Ubuntu test's distro",
  linuxUser: "alice",
  executable: "/opt/domovoi/bin/node",
  args: ["/home/alice/repo $HOME/daemon.js", "--service-config", "/home/alice/.domovoi/service.json"],
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  wsl: "C:\\Windows\\System32\\wsl.exe",
}

const script = (args: readonly string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le")

describe("Windows supervision of a WSL daemon", () => {
  it("registers only an interactive user logon trigger and owns no distro configuration", () => {
    const plan = wslTaskPlan(input)
    const body = script(plan.register.args)
    expect(body).toContain("$definition.Triggers.Create(9)")
    expect(body).toContain("$trigger.UserId = $ownerSid")
    expect(body).toContain("$definition.Principal.UserId = $ownerSid")
    expect(body).toContain("$definition.Principal.LogonType = 3")
    expect(body).toContain("$definition.Principal.RunLevel = 0")
    expect(body).toContain("$folder.RegisterTaskDefinition($name, $definition, 2, $ownerSid, $null, 3, $null)")
    expect(body).not.toContain("Create(8)")
    expect(body).not.toContain("wsl.conf")
    expect(body).not.toContain("systemctl")
    expect(body).not.toContain("S4U")
  })

  it("keeps wsl.exe in the action with an explicit guest user and executable", () => {
    const plan = wslTaskPlan(input)
    const body = script(plan.register.args)
    expect(body).toContain("$action.Path = 'C:\\Windows\\System32\\wsl.exe'")
    expect(body).toContain("\"--distribution\" \"Ubuntu test''s distro\" \"--user\" \"alice\" \"--exec\" \"/opt/domovoi/bin/node\"")
    expect(body).toContain("\"/home/alice/repo $HOME/daemon.js\"")
    expect(body).not.toContain("Start-Process")
    expect(body).not.toContain("cmd.exe")
    expect(body).not.toContain("sh -c")
  })

  it("sets bounded crash retries without a runtime or battery stop", () => {
    const body = script(wslTaskPlan(input).register.args)
    expect(body).toContain("$definition.Settings.RestartInterval = 'PT1M'")
    expect(body).toContain("$definition.Settings.RestartCount = 3")
    expect(body).toContain("$definition.Settings.ExecutionTimeLimit = 'PT0S'")
    expect(body).toContain("$definition.Settings.MultipleInstances = 2")
    expect(body).toContain("$definition.Settings.DisallowStartIfOnBatteries = $false")
    expect(body).toContain("$definition.Settings.StopIfGoingOnBatteries = $false")
  })

  it("binds every subsequent command to this registration and exact action", () => {
    const plan = wslTaskPlan(input)
    for (const command of [plan.start, plan.disable, plan.inspect, plan.removal.stop, plan.removal.inspect, plan.removal.remove]) {
      const body = script(command.args)
      expect(body).toContain("domovoi-wsl:08a1f2da-12e3-4b2c-9e4f-0123456789ab")
      expect(body).toContain("$task.Definition.Actions.Count -ne 1")
      expect(body).toContain("$action.Arguments -cne")
      expect(body).toContain("$task.Definition.Principal.UserId -cne $ownerSid")
      expect(body).toContain("HResult -eq -2147024894")
      expect(body).toContain("throw")
    }
    expect(script(plan.disable.args)).toContain("$task.Enabled = $false")
    expect(script(plan.disable.args)).not.toContain("$task.Stop(0)")
    expect(script(plan.removal.remove.args)).toContain("if ([int]$task.State -ne 1)")
  })

  it("quotes literal Windows argv without shell expansion or trailing-backslash loss", () => {
    const body = script(wslTaskPlan({ ...input, args: ["a\"b", "tail\\", "'$(touch nope)"] }).register.args)
    expect(body).toContain("\"a\\\"b\" \"tail\\\\\" \"''$(touch nope)\"")
  })

  it("bounds the encoded PowerShell command as well as the guest argv", () => {
    expect(() => wslTaskPlan({ ...input, args: ["x".repeat(10_000)] }))
      .toThrow("Encoded WSL task command exceeds")
  })

  it.each([
    { name: "../operator" },
    { name: "task\\child" },
    { registrationId: "not-an-id" },
    { distribution: "" },
    { distribution: "bad\nname" },
    { linuxUser: "" },
    { executable: "node" },
    { powershell: "powershell.exe" },
    { wsl: "wsl.exe" },
    { args: ["bad\0arg"] },
    { args: ["x".repeat(32_768)] },
  ])("refuses an unsafe or unbounded target before registration: %j", (invalid) => {
    expect(() => wslTaskPlan({ ...input, ...invalid })).toThrow()
  })
})
