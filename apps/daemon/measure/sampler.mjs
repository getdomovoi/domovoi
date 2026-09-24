import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"

const run = promisify(execFile)
const stop = process.argv[2]
const intervalMs = Number(process.argv[3] ?? 5_000)
const now = () => Number(process.hrtime.bigint() / 1_000_000n)
const census = [
  "$p = Get-Process",
  "$top = ($p | Sort-Object CPU -Descending | Select-Object -First 6 | ForEach-Object { \"$($_.Name):$($_.Id):$([int]$_.CPU)\" }) -join ','",
  "$count = @{}; foreach ($name in 'node','git','sh','bash','powershell','pwsh','WmiPrvSE','MsMpEng','conhost') { $count[$name] = @($p | Where-Object Name -eq $name).Count }",
  "ConvertTo-Json -Compress -InputObject @{ total = $p.Count; count = $count; top = $top }",
].join("; ")
const cim = '$ErrorActionPreference = "Stop"; $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId | Select-Object ProcessId, ParentProcessId); $rows.Count'

while (!existsSync(stop)) {
  const at = new Date().toISOString()
  let begin = now()
  let facts
  try { facts = JSON.parse((await run("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", census], { windowsHide: true, timeout: 120_000 })).stdout) } catch (error) { facts = { error: String(error).slice(0, 120) } }
  const censusMs = now() - begin
  begin = now()
  let rows
  try { rows = Number((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cim], { windowsHide: true, timeout: 120_000 })).stdout.trim()) } catch (error) { rows = String(error).slice(0, 120) }
  const cimMs = now() - begin
  begin = now()
  try { await run("git", ["--version"], { windowsHide: true, timeout: 120_000 }) } catch {}
  const gitMs = now() - begin
  console.log(`SAMPLE ${at} ${JSON.stringify({ censusMs, cimMs, gitMs, rows, ...facts })}`)
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
}
