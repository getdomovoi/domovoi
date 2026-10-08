import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { userInfo } from "node:os"
import { expect, it } from "vitest"

import { createServiceConfiguration } from "./configuration.js"
import { servicePlan } from "./install.js"
import { windowsSchtasksPath } from "./windows-task.js"

// Microsoft's schtasks reference says a /tr value "must not exceed 262
// characters"; schtasks itself refuses one over 261. This runs the real
// schtasks with the installer's own /create arguments under a task name of
// its own, so the limit servicePlan checks is the one Windows applies. Each
// task it may have made is deleted afterwards, whatever the outcome.
it.runIf(process.platform === "win32")("schtasks accepts the installer's 261 character command and refuses 262", () => {
  // As in install.test.ts: with this home and runtime, a 168-character entry
  // makes the command exactly 261. Nothing is written under this home.
  const home = "C:\\Users\\dl"
  const runtime = "C:\\Program Files\\nodejs\\node.exe"
  const entry = (length: number) => `C:\\${"a".repeat(length - 17)}\\dist\\index.js`
  const plan = servicePlan({
    platform: "win32", home, user: userInfo().username, execPath: entry(168), runtime,
    configuration: createServiceConfiguration({}, { platform: "win32", homeDirectory: home, workingDirectory: home }),
  })
  const create = plan.commands.find(({ args }) => args[0] === "/create")!
  const fits = create.args[create.args.indexOf("/tr") + 1]!
  expect(fits).toHaveLength(261)
  const over = fits.replace(entry(168), entry(169))
  expect(over).toHaveLength(262)

  const names: string[] = []
  // Stdin is closed so a password prompt fails at once instead of waiting.
  const schtasks = (args: string[]) => spawnSync(windowsSchtasksPath(), args, { input: "", encoding: "utf8", timeout: 30_000, windowsHide: true })
  const register = (command: string) => {
    const name = `Domovoi-command-length-test-${randomUUID()}`
    names.push(name)
    // The installer's arguments with this test's name and command, and no /f,
    // so nothing already registered is replaced.
    const args = create.args.filter((arg) => arg !== "/f")
      .map((arg, index, all) => all[index - 1] === "/tn" ? name : all[index - 1] === "/tr" ? command : arg)
    return { name, result: schtasks(args) }
  }
  try {
    const accepted = register(fits)
    expect(accepted.result.status, `${accepted.result.stdout}${accepted.result.stderr}`).toBe(0)
    expect(schtasks(["/query", "/tn", accepted.name]).status).toBe(0)

    const refused = register(over)
    expect(refused.result.status).not.toBe(0)
    expect(`${refused.result.stdout}${refused.result.stderr}`).toMatch(/\/TR.*261/i)
    expect(schtasks(["/query", "/tn", refused.name]).status).not.toBe(0)
  } finally {
    for (const name of names) schtasks(["/delete", "/tn", name, "/f"])
  }
})
