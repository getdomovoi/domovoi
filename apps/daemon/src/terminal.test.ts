import { describe, expect, it } from "vitest"

import { NodePtyTerminalService, shellForPlatform } from "./terminal"

describe("shellForPlatform", () => {
  it("uses COMSPEC for native Windows terminals", () => {
    expect(shellForPlatform("win32", {
      COMSPEC: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      SHELL: "/bin/zsh",
    })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(shellForPlatform("win32", {})).toBe("powershell.exe")
  })

  it("uses the configured Unix shell with a portable fallback", () => {
    expect(shellForPlatform("linux", { SHELL: "/bin/fish" })).toBe("/bin/fish")
    expect(shellForPlatform("darwin", {})).toBe("/bin/sh")
  })

  it("starts the native PTY and streams shell output", async () => {
    const terminal = new NodePtyTerminalService().spawn({
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    let output = ""
    const data = terminal.onData((chunk) => { output += chunk })
    try {
      terminal.write(process.platform === "win32"
        ? "echo DOMOVOI_PTY_READY\r"
        : "printf 'DOMOVOI_PTY_READY\\n'\r")
      await expect.poll(() => output, { timeout: 5_000 }).toContain("DOMOVOI_PTY_READY")
    } finally {
      data.dispose()
      terminal.kill()
    }
  })
})
