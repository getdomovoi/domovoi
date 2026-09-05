import { createProductionDaemonWithDependencies, productionDaemonDependencies } from "../src/production-daemon.ts"

// No daemon constructor substitution. Port zero is the same narrow test
// tuning as the two-daemon fleet harness; no fixed user port is reserved.
const daemon = await createProductionDaemonWithDependencies({
  environment: { DOMOVOI_AUTH_TOKEN: "k".repeat(43) }, homeDirectory: process.argv[2],
}, {
  ...productionDaemonDependencies,
  createProviderProbe: () => ({ inspect: async () => [] }),
  createDaemon: (options) => productionDaemonDependencies.createDaemon({ ...options, port: 0 }),
})
const watchdog = setTimeout(() => process.exit(1), 60_000)
process.once("SIGTERM", () => {
  // A failed stop keeps the watchdog: whatever it left open must not outlive
  // the harness budget, and the exit status must say the stop failed.
  daemon.stop().then(() => { clearTimeout(watchdog) }, (error) => {
    process.stderr.write(`keyring fixture stop failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
})
const address = await daemon.start()
process.stdout.write(`${JSON.stringify({ url: address.url })}\n`)
