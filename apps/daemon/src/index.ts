#!/usr/bin/env node
import { readFileSync } from "node:fs"

import { DomovoiDaemon } from "./server.js"
import { CliProviderProbe } from "./providers.js"

const help = `Usage: domovoid [options]

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version

Environment:
  DOMOVOI_HOST                    Listener host (default: 127.0.0.1)
  DOMOVOI_PORT                    Listener port (default: 47831)
  DOMOVOI_AUTH_TOKEN              Bearer token for daemon requests
  DOMOVOI_ALLOWED_ORIGINS         Comma-separated trusted browser origins
  DOMOVOI_ALLOW_REMOTE_TRANSPORT  Set to 1 to permit non-loopback listeners
`

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) {
    process.stdout.write(help)
    return
  }
  if (args.length === 1 && ["-v", "--version"].includes(args[0]!)) {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }
    process.stdout.write(`${manifest.version}\n`)
    return
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown argument: ${args.join(" ")}\n`)
    process.exitCode = 1
    return
  }

  const host = process.env.DOMOVOI_HOST ?? "127.0.0.1"
  const port = Number.parseInt(process.env.DOMOVOI_PORT ?? "47831", 10)
  const allowedOrigins = process.env.DOMOVOI_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim())
  const authToken = process.env.DOMOVOI_AUTH_TOKEN
  const allowRemoteTransport = process.env.DOMOVOI_ALLOW_REMOTE_TRANSPORT === "1"
  const daemon = new DomovoiDaemon({
    host,
    port,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    ...(authToken ? { authToken } : {}),
    ...(allowRemoteTransport ? { allowRemoteTransport } : {}),
    providerProbe: new CliProviderProbe(),
  })

  const address = await daemon.start()
  process.stdout.write(`domovoid listening on ws://${address.host}:${address.port}/rpc\n`)

  const shutdown = async () => {
    await daemon.stop()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

await main()
