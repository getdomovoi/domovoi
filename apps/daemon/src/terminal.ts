import { platform } from "node:os"

import { spawn, type IPty } from "node-pty"

export type TerminalSpawnOptions = {
  cwd: string
  cols: number
  rows: number
}

export type TerminalProcess = Pick<IPty, "kill" | "onData" | "onExit" | "process" | "resize" | "write">
  & Partial<Pick<IPty, "pause" | "resume">>

export interface TerminalService {
  spawn(options: TerminalSpawnOptions): TerminalProcess
}

export function shellForPlatform(
  targetPlatform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (targetPlatform === "win32") return environment.COMSPEC ?? "powershell.exe"
  return environment.SHELL ?? "/bin/sh"
}

export class NodePtyTerminalService implements TerminalService {
  spawn(options: TerminalSpawnOptions): TerminalProcess {
    const targetPlatform = platform()
    const shell = shellForPlatform(targetPlatform, process.env)
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" }
    if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) {
      // GUI and service launches can omit the locale. macOS ships en_US.UTF-8;
      // Linux uses C.UTF-8 (supported by modern glibc and musl) without choosing
      // a regional language. Keep this fallback local to shells, not harnesses.
      if (targetPlatform === "darwin") env.LANG = "en_US.UTF-8"
      else if (targetPlatform === "linux") env.LANG = "C.UTF-8"
    }
    return spawn(shell, [], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env,
      ...(targetPlatform === "win32" ? { useConpty: true } : {}),
    })
  }
}
