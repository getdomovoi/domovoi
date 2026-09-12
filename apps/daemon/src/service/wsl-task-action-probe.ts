import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { OperationDeadline } from "../operation-deadline.js"
import { wslText } from "../wsl-run.js"
import { withinServiceDeadline } from "./deadline.js"
import type { WslTaskPlan } from "./wsl-task.js"

type Execute = (file: string, args: readonly string[], options: {
  windowsVerbatimArguments: true; windowsHide: true; encoding: "buffer"
  timeout: number; maxBuffer: number; killSignal: "SIGKILL"; signal: AbortSignal
}) => Promise<{ stdout: Buffer; stderr: Buffer }>

// Control probe only. The scheduled action still invokes wsl.exe directly.
// Bypass Node's argv quoting to exercise the exact task argument serializer.
export async function captureWslTaskAction(action: WslTaskPlan["action"], deadline: OperationDeadline,
  execute: Execute = promisify(execFile)): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await withinServiceDeadline(deadline, () => execute(action.path, [action.arguments], {
      windowsVerbatimArguments: true, windowsHide: true, encoding: "buffer",
      timeout: Math.max(1, Math.ceil(deadline.remainingMs())), maxBuffer: 65_536, killSignal: "SIGKILL", signal: deadline.signal,
    }))
    return { code: 0, stdout: wslText(result.stdout), stderr: wslText(result.stderr) }
  } catch (error) {
    // Only an observed nonzero exit has a numeric result. Cancellation, spawn
    // errors, signals and output truncation remain failures to observe it.
    if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number"
      || !Number.isInteger(error.code) || error.code <= 0 || error.code > 0xffff_ffff
      || !("signal" in error) || error.signal !== null
      || !("stdout" in error) || !Buffer.isBuffer(error.stdout)
      || !("stderr" in error) || !Buffer.isBuffer(error.stderr)) throw error
    return { code: error.code, stdout: wslText(error.stdout), stderr: wslText(error.stderr) }
  }
}
