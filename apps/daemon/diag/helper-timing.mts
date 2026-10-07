// T38 diagnostic only. Times the Windows job helper's inspect query, which
// compiles its C# with Add-Type on every spawn, against a bare PowerShell start.
import { spawnSync } from "node:child_process"
import { windowsJobCommand } from "../src/service/windows-job.ts"
import { windowsPowerShellPath } from "../src/service/windows-task.ts"

const label = process.argv[2] ?? "run"
const count = Number(process.argv[3] ?? "10")
const command = windowsJobCommand()
for (let i = 0; i < count; ++i) {
  let start = performance.now()
  const bare = spawnSync(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 60_000, windowsHide: true })
  const bareMs = Math.round(performance.now() - start)
  start = performance.now()
  const helper = spawnSync(command.command, command.args, { input: JSON.stringify({ mode: "inspect", pids: [process.pid] }) + "\n", encoding: "utf8", timeout: 60_000, windowsHide: true })
  const helperMs = Math.round(performance.now() - start)
  console.log(JSON.stringify({ label, i, bareMs, helperMs, helperStatus: helper.status, helperError: helper.error?.message, stderr: helper.stderr.slice(0, 600) }))
}
