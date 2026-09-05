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
process.once("SIGTERM", () => { void daemon.stop().finally(() => { clearTimeout(watchdog) }) })
const address = await daemon.start()
process.stdout.write(`${JSON.stringify({ url: address.url })}\n`)
