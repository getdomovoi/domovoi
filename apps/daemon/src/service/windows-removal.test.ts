import { describe, expect, it, vi } from "vitest"

import { removeService, runServiceCommand, type ServiceEffects } from "./install.js"

// Model the OS boundary, not a mock which assumes unregistering kills a task.
// Microsoft's /delete contract explicitly leaves running programs alone.
function taskManager() {
  const task = { registered: true, enabled: true, running: true }
  const effects: ServiceEffects = {
    write: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    run: vi.fn(async (command, args) => {
      expect(command).toBe("schtasks")
      expect(args).toEqual(["/delete", "/tn", "Domovoi daemon", "/f"])
      task.registered = false
    }),
    capture: vi.fn(async (command, args) => {
      expect(command).toBe("powershell.exe")
      expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (script.includes("$task.Enabled = $false")) task.enabled = false
      if (script.includes("$task.Stop(0)")) task.running = false
      if (script.includes("$folder.DeleteTask(")) {
        expect(task, "the registration must survive until every instance stopped").toMatchObject({ enabled: false, running: false })
        task.registered = false
        return { code: 0, stdout: "domovoi-task:deleted\r\n" }
      }
      return { code: 0, stdout: `domovoi-task:${task.registered ? task.running ? 4 : task.enabled ? 3 : 1 : "missing"}\r\n` }
    }),
  }
  return { task, effects }
}

describe("Windows service removal", () => {
  it("stops the live task before unregistering it and deleting its configuration", async () => {
    const { task, effects } = taskManager()
    vi.mocked(effects.remove).mockImplementation(async () => {
      expect(task).toEqual({ registered: false, enabled: false, running: false })
    })

    await removeService({ platform: "win32", home: "C:\\Users\\dl" }, effects)

    expect(task).toEqual({ registered: false, enabled: false, running: false })
    expect(effects.remove).toHaveBeenCalledOnce()
  })

  it("does not tell the CLI user a running daemon was removed", async () => {
    const { task, effects } = taskManager()
    const stdout = vi.fn()
    const stderr = vi.fn()
    expect(await runServiceCommand(["service", "remove"], {
      ...effects, platform: "win32", execPath: "C:\\Domovoi\\domovoid.exe", home: "C:\\Users\\dl", stdout, stderr,
    })).toBe(0)
    expect(stderr).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledWith("Removed the Domovoi daemon service Domovoi daemon\n")
    expect(task.running, "a success message must mean the supervised daemon stopped").toBe(false)
  })
})
