import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { windowsTaskRegistrationCommand } from "./windows-task.js"

beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows") })
afterEach(() => { vi.unstubAllEnvs() })

it("round-trips untrusted registration values only through UTF-8 base64 data", () => {
  const value = "O’Neil‘'$(expression)\"`日本語🌲"
  const user = `user-${value}`
  const action = { path: `"C:\\${value}\\node.exe"`, arguments: `--value ${value}` }
  const command = windowsTaskRegistrationCommand("Domovoi daemon", user, action)
  const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le")
  for (const [property, expected] of Object.entries({
    "$action.Path": action.path, "$action.Arguments": action.arguments,
    "$definition.Principal.UserId": user, "$trigger.UserId": user, "$user": user,
  })) {
    const line = script.split("\n").find((line) => line.startsWith(`${property} = `))
    const encoded = / = \[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\)$/.exec(line ?? "")?.[1]
    expect(encoded, property).toBeDefined()
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(expected)
    expect(script).not.toContain(expected)
  }
  expect(script).not.toContain(value)
  expect(script).toContain("$name = 'Domovoi daemon'")
  expect(script).toContain("$folder.RegisterTaskDefinition($name, $definition, 6, $user, $null, 3, $null)")
})

it.each(["'", "‘", "’", "‚", "‛"])("rejects a task name containing %s", (quote) => {
  expect(() => windowsTaskRegistrationCommand(`Domovoi${quote}daemon`, "dl", { path: "node.exe", arguments: "" })).toThrow(/name/i)
})
