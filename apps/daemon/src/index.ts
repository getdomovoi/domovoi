#!/usr/bin/env node
import { DomovoiDaemon } from "./server.js"

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
})

const address = await daemon.start()
process.stdout.write(`domovoid listening on ws://${address.host}:${address.port}/rpc\n`)

const shutdown = async () => {
  await daemon.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
