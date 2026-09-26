// Harmless, finite process owned only by the native Task Scheduler test. Its
// lifetime exceeds the test budget, so natural exit cannot prove removal.
import { existsSync, writeFileSync } from "node:fs"

// Run as Domovoi's task runs its entry, `<entry> --service-config <path>`, the
// ready file sits beside that configuration; otherwise it is the argument.
const ready = process.argv[2] === "--service-config" ? `${process.argv[3]}.ready` : process.argv[2]
writeFileSync(ready, String(process.pid), { flag: "wx" })
const lifetime = setTimeout(() => { clearInterval(stop); process.exitCode = 1 }, 120_000)
// An independent, private cleanup path lets a red removal test stop its own
// orphan without killing an unrelated process which later reuses the PID.
const stop = setInterval(() => {
  if (existsSync(`${ready}.stop`)) { clearInterval(stop); clearTimeout(lifetime) }
}, 100)
