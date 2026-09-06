// Harmless, finite process owned only by the native systemd user unit test.
// Its lifetime exceeds the test budget, so natural exit cannot prove removal.
// It exits zero on every path so Restart=on-failure never revives it.
import { existsSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

if (process.argv[2] !== "--service-config") throw new Error("the unit did not pass the saved service configuration")
const ready = join(dirname(process.argv[3]), "ready")
writeFileSync(ready, String(process.pid))
const lifetime = setTimeout(() => { clearInterval(stop) }, 120_000)
// An independent, private stop path lets a red removal test end its own unit
// process without killing an unrelated process which later reuses the PID.
const stop = setInterval(() => {
  if (existsSync(`${ready}.stop`)) { clearInterval(stop); clearTimeout(lifetime) }
}, 100)
