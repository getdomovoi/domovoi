// Harmless, finite process owned only by the native Task Scheduler test. Its
// lifetime exceeds the test budget, so natural exit cannot prove removal.
import { existsSync, writeFileSync } from "node:fs"

writeFileSync(process.argv[2], String(process.pid), { flag: "wx" })
const lifetime = setTimeout(() => { clearInterval(stop); process.exitCode = 1 }, 120_000)
// An independent, private cleanup path lets a red removal test stop its own
// orphan without killing an unrelated process which later reuses the PID.
const stop = setInterval(() => {
  if (existsSync(`${process.argv[2]}.stop`)) { clearInterval(stop); clearTimeout(lifetime) }
}, 100)
