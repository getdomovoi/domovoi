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
    const shell = shellForPlatform(platform(), process.env)
    return spawn(shell, [], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: { ...process.env, TERM: "xterm-256color" },
      ...(platform() === "win32" ? { useConpty: true } : {}),
    })
  }
}
