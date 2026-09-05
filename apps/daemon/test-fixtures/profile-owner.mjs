import { createProductionDaemon } from "../dist/public.js"

// The parent deliberately kills this real owner without graceful cleanup.
// This watchdog bounds even an abandoned test process.
const watchdog = setTimeout(() => process.exit(1), 30_000)
try {
  await createProductionDaemon({ environment: {}, homeDirectory: process.argv[2] })
  // The application may discard its handle while the runtime remains alive.
  // A collected wrapper must not grant another process the profile.
  setImmediate(() => {
    globalThis.gc()
    setImmediate(() => process.send({ state: "owned" }))
  })
} catch {
  clearTimeout(watchdog)
  process.exit(1)
}
