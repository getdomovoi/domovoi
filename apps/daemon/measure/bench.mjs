import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const label = process.argv[2] ?? "idle"
const rounds = Number(process.argv[3] ?? 5)
const now = () => Number(process.hrtime.bigint() / 1_000_000n)
const cases = [
  ["git --version", "git", ["--version"]],
  ["node -e 0", process.execPath, ["-e", "0"]],
  ["powershell exit", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]],
  ["powershell cim all", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    '$ErrorActionPreference = "Stop"; $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId | Select-Object ProcessId, ParentProcessId); ConvertTo-Json -InputObject $rows -Compress']],
  ["powershell cim filtered", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = "Stop"; Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${process.pid}" -Property ProcessId, ParentProcessId | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress`]],
  ["pwsh exit", "pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]],
  ["pwsh get-process parent", "pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${process.pid}).Parent.Id`]],
]
for (const [name, command, args] of cases) {
  const times = []
  let failure
  for (let index = 0; index < rounds; index += 1) {
    const begin = now()
    try { await run(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }) } catch (error) { failure = String(error).slice(0, 160) }
    times.push(now() - begin)
  }
  console.log(`BENCH ${label} ${JSON.stringify({ name, times, failure })}`)
}
