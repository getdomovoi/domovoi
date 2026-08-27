import { execFileSync } from "node:child_process"

function resolveWindowsPnpm() {
  const [executable] = execFileSync("where.exe", ["pnpm.exe"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)

  if (!executable) throw new Error("pnpm.exe is not available on PATH")
  return executable
}

export function pnpmInvocation(platform = process.platform, windowsResolver = resolveWindowsPnpm) {
  if (platform === "win32") {
    return {
      command: windowsResolver(),
      shell: false,
    }
  }

  return {
    command: "pnpm",
    shell: false,
  }
}
