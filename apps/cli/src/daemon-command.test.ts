import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { DaemonCommandUnavailableError, loadDaemonCommand, siblingDaemonCommand, type DaemonCommandModule } from "./daemon-command.js"

const module: DaemonCommandModule = { runDaemonCommand: async () => 0 }

function missing(specifier: string, kind: "package" | "module" = "package"): Error {
  const message = kind === "package"
    ? `Cannot find package '${specifier}' imported from /runtime/cli/dist/index.js`
    : `Cannot find module '${specifier}' imported from /runtime/cli/dist/index.js`
  return Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" })
}

describe("loadDaemonCommand", () => {
  it("runs the installed @getdomovoi/daemon package and never looks beside the CLI", async () => {
    const fromPath = vi.fn()
    await expect(loadDaemonCommand({ fromPackage: async () => module, fromPath })).resolves.toBe(module)
    expect(fromPath).not.toHaveBeenCalled()
  })

  // Q31 A: the desktop runtime ships the CLI without its own daemon copy,
  // beside the runtime's daemon. Only that one fixed path is tried.
  it("loads the daemon beside the CLI's own dist only when the package is absent", async () => {
    const fromPath = vi.fn(async () => module)
    await expect(loadDaemonCommand({ fromPackage: async () => { throw missing("@getdomovoi/daemon") }, fromPath })).resolves.toBe(module)
    expect(fromPath.mock.calls).toEqual([[siblingDaemonCommand]])
  })

  it("is the daemon's dist in the same runtime: <runtime>/daemon/dist/daemon-command.js beside <runtime>/cli/dist", () => {
    expect(new URL("../../daemon/dist/daemon-command.js", "file:///runtime/cli/dist/index.js").href).toBe("file:///runtime/daemon/dist/daemon-command.js")
    expect(siblingDaemonCommand.href.endsWith("/daemon/dist/daemon-command.js")).toBe(true)
  })

  it("does not fall back when the package is there but fails to load", async () => {
    const broken = new SyntaxError("Unexpected token")
    const fromPath = vi.fn()
    await expect(loadDaemonCommand({ fromPackage: async () => { throw broken }, fromPath })).rejects.toBe(broken)
    // A missing file inside a present package is not an absent package.
    await expect(loadDaemonCommand({ fromPackage: async () => { throw missing("/lib/node_modules/@getdomovoi/daemon/dist/daemon-command.js", "module") }, fromPath }))
      .rejects.toThrow(/Cannot find module/)
    // Another package missing is that package's failure, not this one's.
    await expect(loadDaemonCommand({ fromPackage: async () => { throw missing("@getdomovoi/daemon-extra") }, fromPath })).rejects.toThrow(/daemon-extra/)
    expect(fromPath).not.toHaveBeenCalled()
  })

  it("refuses in plain words when neither the package nor the sibling is there", async () => {
    const result = loadDaemonCommand({
      fromPackage: async () => { throw missing("@getdomovoi/daemon") },
      fromPath: async () => { throw missing(fileURLToPath(siblingDaemonCommand), "module") },
    })
    await expect(result).rejects.toBeInstanceOf(DaemonCommandUnavailableError)
    await expect(result).rejects.toThrow("This domovoi has no @getdomovoi/daemon package, which runs domovoi daemon. Reinstall @getdomovoi/cli, which installs it.")
  })

  it("passes on a sibling that is there but fails to load, a missing part of it included", async () => {
    const broken = new SyntaxError("Unexpected token")
    const absent = async () => { throw missing("@getdomovoi/daemon") }
    await expect(loadDaemonCommand({ fromPackage: absent, fromPath: async () => { throw broken } })).rejects.toBe(broken)
    await expect(loadDaemonCommand({ fromPackage: absent, fromPath: async () => { throw missing(fileURLToPath(new URL("chunk-abc.js", siblingDaemonCommand)), "module") } }))
      .rejects.toThrow(/chunk-abc\.js/)
  })
})
