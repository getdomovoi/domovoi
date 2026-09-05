import { execFile } from "node:child_process"
import { promisify } from "node:util"

export type WslRunner<Output extends string | Buffer> = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<Output>

const execute = promisify(execFile)

// wsl.exe talks to a service that can be starting, stopping, or wedged, and a
// call that never comes back would hold up whatever asked for it.
export const defaultWslTimeoutMs = 10_000

// Every wsl.exe call is an argument list handed to the process directly, so
// a distribution name or a path is never re-read by a shell.
export async function runWslText(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<string> {
  const { stdout } = await execute(command, [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  })
  return stdout
}

export async function runWslBytes(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<Buffer> {
  const { stdout } = await execute(command, [...args], {
    encoding: "buffer",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  })
  return stdout
}

// A timeout of zero or less would leave the child with no deadline at all,
// which is the opposite of what asking for one means.
export function wslTimeoutMs(requested: number | undefined): number {
  return requested !== undefined && Number.isFinite(requested) && requested > 0
    ? requested
    : defaultWslTimeoutMs
}

export function withWslDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wsl.exe did not answer in time")), timeoutMs)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
