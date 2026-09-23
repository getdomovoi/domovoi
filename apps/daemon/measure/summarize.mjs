import { readFileSync } from "node:fs"

for (const file of process.argv.slice(2)) {
  let text
  try { text = readFileSync(file, "utf8") } catch { continue }
  console.log(`======== ${file}`)
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)
  let context = ""
  for (const line of lines) {
    if (line.startsWith("stdout | ") || line.startsWith("stderr | ")) { context = line.slice(9, 200); continue }
    const interesting = /MEASURE |RPCTIME |BENCH |"phase":|Test Files|Tests {2}|Duration|×|FAIL|timed out/.test(line)
      || (/ ✓ /.test(line) && /(\d{4,})ms$/.test(line))
    if (!interesting) continue
    const relevant = /fleet-production|workspace-recovery|workspace\.test|bounds claim/.test(context + line)
      || /BENCH |Test Files|Tests {2}|Duration|×|FAIL|timed out/.test(line) || / ✓ /.test(line)
    if (!relevant) continue
    console.log(`${line.slice(0, 700)}${/RPCTIME|"phase"/.test(line) ? `   [${context.slice(-70)}]` : ""}`)
  }
}
