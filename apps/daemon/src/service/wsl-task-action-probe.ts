import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { OperationDeadline } from "../operation-deadline.js"
import { wslText } from "../wsl-run.js"
import { withinServiceDeadline } from "./deadline.js"
import { wslTaskPlan, type WslTaskPlan, type WslTaskTarget } from "./wsl-task.js"

type Execute = (file: string, args: readonly string[], options: {
  windowsVerbatimArguments: true; windowsHide: true; encoding: "buffer"
  timeout: number; maxBuffer: number; killSignal: "SIGKILL"; signal: AbortSignal
}) => Promise<{ stdout: Buffer; stderr: Buffer }>

// Build the native fixture's short-lived /usr/bin/env control through the same
// validator as the daemon action. Portable tests must exercise this exact input.
export function wslTaskActionProbe(target: WslTaskTarget, input: {
  runtime: string
  environment: readonly string[]
  files: readonly { path: string; executable: boolean }[]
}) {
  // The legacy negative control deliberately falls back to a shell. Keep its
  // fixture identifiers literal-safe; the real planner accepts a wider set.
  if (!/^[A-Za-z0-9_-]+$/.test(target.distribution) || !/^[A-Za-z0-9_-]+$/.test(target.linuxUser)) {
    throw new Error("WSL launch controls require plain fixture prefix tokens")
  }
  const script = [
    "const fs = require('node:fs'), os = require('node:os');",
    "const files = JSON.parse(process.argv[1]).map(({ path, executable }) => {",
    "  try { fs.accessSync(path, executable ? fs.constants.X_OK : fs.constants.R_OK); return { path, realPath: fs.realpathSync(path), state: 'accessible' }; }",
    "  catch (error) { return { path, state: 'error', code: String(error.code) }; }",
    "});",
    "process.stdout.write(JSON.stringify({ executable: process.execPath, uid: process.getuid(), user: os.userInfo().username, argv: process.argv.slice(2), home: process.env.HOME, path: process.env.PATH, distribution: process.env.WSL_DISTRO_NAME, files }));",
  ].join(" ")
  const argv = [JSON.stringify(input.files), ...target.args, "space value", 'a"b', "tail\\", "$HOME", "$(printf domovoi-shell-expanded)"]
  const probe = wslTaskPlan({ ...target, args: [...input.environment, input.runtime, "-e", script, "--", ...argv] })
  const prefix = ["--distribution", target.distribution, "--user", target.linuxUser, "--exec"]
  const bare = prefix.join(" ") + " "
  if (!probe.action.arguments.startsWith(bare)) throw new Error("WSL launch control has an unexpected serialized prefix")
  const tail = probe.action.arguments.slice(bare.length)
  // Deliberate negative controls retain the old broken prefix. No variant is
  // registered as a task; the real action always comes from wslTaskPlan.
  const variants = [
    { name: "registered-prefix", action: probe.action },
    { name: "legacy-quoted-prefix", action: { path: probe.action.path,
      arguments: prefix.map((value) => '"' + value + '"').join(" ") + " " + tail } },
    { name: "quoted-prefix-values", action: { path: probe.action.path,
      arguments: '--distribution "' + target.distribution + '" --user "' + target.linuxUser + '" --exec ' + tail } },
  ]
  return { script, argv, action: probe.action, variants }
}

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
