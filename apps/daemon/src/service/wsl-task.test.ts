import { describe, expect, it } from "vitest"

import { windowsTaskData } from "./windows-task-test-support.js"
import { wslTaskPlan } from "./wsl-task.js"

const input = {
  name: "Domovoi WSL test",
  registrationId: "08a1f2da-12e3-4b2c-9e4f-0123456789ab",
  distribution: "Ubuntu-test's-distro",
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
    expect(body).toContain("$action.Path = $actionPath")
    expect(windowsTaskData(body, "$actionPath")).toBe("C:\\Windows\\System32\\wsl.exe")
    const actionArguments = windowsTaskData(body, "$actionArguments")
    expect(actionArguments).toContain("--distribution Ubuntu-test's-distro --user alice --exec \"/opt/domovoi/bin/node\"")
    expect(actionArguments).toContain("\"/home/alice/repo $HOME/daemon.js\"")
    expect(body).not.toContain("Start-Process")
    expect(body).not.toContain("cmd.exe")
    expect(body).not.toContain("sh -c")
  })

  it("keeps WSL prefix tokens bare and quotes only the exec tail", () => {
    const plan = wslTaskPlan(input)
    expect(plan.action).toEqual({ path: input.wsl,
      arguments: '--distribution Ubuntu-test\'s-distro --user alice --exec "/opt/domovoi/bin/node" '
        + '"/home/alice/repo $HOME/daemon.js" "--service-config" "/home/alice/.domovoi/service.json"' })
    expect(script(plan.register.args)).toContain("$action.Arguments = $actionArguments")
    expect(windowsTaskData(script(plan.register.args), "$actionArguments")).toBe(plan.action.arguments)
  })

  it("leaves retries to the guest loop without a runtime or battery stop", () => {
    const body = script(wslTaskPlan(input).register.args)
    expect(body).not.toContain("$definition.Settings.RestartInterval =")
    expect(body).toContain("$definition.Settings.RestartCount = 0")
    expect(body).toContain("$definition.Settings.ExecutionTimeLimit = 'PT0S'")
    expect(body).toContain("$definition.Settings.MultipleInstances = 2")
    expect(body).toContain("$definition.Settings.DisallowStartIfOnBatteries = $false")
    expect(body).toContain("$definition.Settings.StopIfGoingOnBatteries = $false")
  })

  it("binds every subsequent command to this registration and exact action", () => {
    const plan = wslTaskPlan(input)
    for (const command of [plan.start, plan.disable, plan.inspect, plan.removal.stop, plan.removal.inspect, plan.removal.remove]) {
      const body = script(command.args)
      expect(windowsTaskData(body, "$taskSource")).toBe("domovoi-wsl:08a1f2da-12e3-4b2c-9e4f-0123456789ab")
      expect(body).toContain("$task.Definition.Actions.Count -ne 1")
      expect(body).toContain("$action.Arguments -cne")
      expect(body).toContain("$taskUserSid.Equals($currentUserSid)")
      expect(body).toContain("HResult -eq -2147024894")
      expect(body).toContain("throw")
    }
    expect(script(plan.disable.args)).toContain("$task.Enabled = $false")
    expect(script(plan.disable.args)).not.toContain("$task.Stop(0)")
    expect(script(plan.removal.remove.args)).toContain("if ([int]$task.State -ne 1)")
  })

  it.each([
    { term: "Source", condition: "$task.Definition.RegistrationInfo.Source -cne $taskSource" },
    { term: "UserId", condition: "-not $taskUserSid.Equals($currentUserSid)" },
    { term: "LogonType", condition: "[int]$task.Definition.Principal.LogonType -ne 3" },
    { term: "RunLevel", condition: "[int]$task.Definition.Principal.RunLevel -ne 0" },
    { term: "action count", condition: "$task.Definition.Actions.Count -ne 1" },
    { term: "action type", condition: "[int]$action.Type -ne 0" },
    { term: "action path", condition: "$action.Path -cne $actionPath" },
    { term: "action args", condition: "$action.Arguments -cne" },
  ])("names $term in its own refusal before any task mutation", ({ term, condition }) => {
    const plan = wslTaskPlan(input)
    for (const command of [plan.start, plan.disable, plan.inspect, plan.removal.stop, plan.removal.inspect, plan.removal.remove]) {
      const body = script(command.args)
      const lines = body.split("\n")
      const guard = lines.find((line) => line.startsWith("if (" + condition))
      expect(guard).toBeDefined()
      expect(guard).toContain("throw 'WSL task ownership mismatch: " + term + "'")
      expect(guard).not.toContain(" -or ")
      for (const mutation of ["$task.Run(", "$task.Enabled =", "$task.Stop(", "$folder.DeleteTask("]) {
        if (body.includes(mutation)) expect(body.indexOf(guard!)).toBeLessThan(body.indexOf(mutation))
      }
    }
  })

  it("quotes literal Windows argv without shell expansion or trailing-backslash loss", () => {
    const body = script(wslTaskPlan({ ...input, args: ["a\"b", "tail\\", "'$(touch nope)"] }).register.args)
    expect(windowsTaskData(body, "$actionArguments")).toContain("\"a\\\"b\" \"tail\\\\\" \"'$(touch nope)\"")
  })

  // PowerShell ends a single-quoted string at ’ ‘ ‚ ‛ as well as at the ASCII
  // apostrophe, so doubling only the apostrophe let a smart quote end it.
  it("passes the name, distribution, user and guest paths with smart quotes only as UTF-8 base64 data", () => {
    const target = { ...input, name: "Domovoi WSL ’ test", distribution: "Ubuntu’;throw‘x", linuxUser: "o’neil‚‛",
      executable: "/opt/o’neil/node", args: ["/home/o’neil/daemon.js", "‘$(touch nope)’"], wsl: "C:\\Users\\O’Neil\\wsl.exe" }
    const plan = wslTaskPlan(target)
    expect(plan.action.arguments).toBe("--distribution Ubuntu’;throw‘x --user o’neil‚‛ --exec \"/opt/o’neil/node\" "
      + "\"/home/o’neil/daemon.js\" \"‘$(touch nope)’\"")
    for (const command of [plan.register, plan.start, plan.disable, plan.inspect, plan.removal.stop, plan.removal.remove]) {
      const body = script(command.args)
      expect(windowsTaskData(body, "$name")).toBe(target.name)
      expect(windowsTaskData(body, "$taskSource")).toBe("domovoi-wsl:" + target.registrationId)
      expect(windowsTaskData(body, "$actionPath")).toBe(target.wsl)
      expect(windowsTaskData(body, "$actionArguments")).toBe(plan.action.arguments)
      expect(body).not.toMatch(/[‘’‚‛]/u)
      expect(body).not.toContain("throw‘x")
    }
  })

  it("bounds the encoded PowerShell command as well as the guest argv", () => {
    expect(() => wslTaskPlan({ ...input, args: ["x".repeat(10_000)] }))
      .toThrow("Encoded WSL task command exceeds")
  })

  it.each(["distribution", "linuxUser"] as const)("refuses quotes or whitespace in the raw %s token", (field) => {
    for (const value of ['bad"name', "bad name", "bad\tname", "bad\nname", "bad\u00a0name", "name --exec /bin/false"]) {
      expect(() => wslTaskPlan({ ...input, [field]: value }), value).toThrow()
    }
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
