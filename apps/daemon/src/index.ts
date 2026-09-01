#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"

import { DomovoiDaemon } from "./server.js"
import { CliProviderProbe } from "./providers.js"
import { loadOrCreateDaemonToken } from "./credentials.js"
import { loadOrCreateMachineIdentity } from "./machine-identity.js"
import { loadTlsMaterial } from "./tls-material.js"
import { parseDaemonEnvironment } from "./config.js"
import { ProviderSecretManager } from "./provider-secrets.js"
import { readHiddenSecret, runProviderSecretCommand } from "./secret-command.js"

const help = `Usage: domovoid [options]
       domovoid secret status
       domovoid secret set <anthropic|openai|openrouter>
       domovoid secret delete <anthropic|openai|openrouter>

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version

Environment:
  DOMOVOI_HOST                    Listener host (default: 127.0.0.1)
  DOMOVOI_PORT                    Listener port (default: 47831)
  DOMOVOI_AUTH_TOKEN              Bearer token for daemon requests
  DOMOVOI_CREDENTIAL_PATH         Credential file (default: ~/.domovoi/daemon.token)
  DOMOVOI_MACHINE_IDENTITY_PATH   Machine identity file (default: ~/.domovoi/machine.json)
  DOMOVOI_ALLOWED_ORIGINS         Comma-separated trusted browser origins
  DOMOVOI_ALLOW_REMOTE_TRANSPORT  Set to 1 to permit non-loopback listeners
  DOMOVOI_TLS_CERT_PATH           TLS certificate chain, required off loopback
  DOMOVOI_TLS_KEY_PATH            TLS private key, required off loopback
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
  if (args[0] === "secret") {
    process.exitCode = await runProviderSecretCommand(args, {
      manager: new ProviderSecretManager(),
      readSecret: () => readHiddenSecret(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    })
    return
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown argument: ${args.join(" ")}\n`)
    process.exitCode = 1
    return
  }

  const config = parseDaemonEnvironment(process.env, homedir())
  const authToken = config.authToken
    ?? await loadOrCreateDaemonToken(config.credentialPath)
  const machineIdentity = await loadOrCreateMachineIdentity(config.machineIdentityPath, {
    label: hostname(),
  })
  const tls = config.tls ? await loadTlsMaterial(config.tls) : undefined
  const daemon = new DomovoiDaemon({
    host: config.host,
    port: config.port,
    ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
    authToken,
    ...(config.allowRemoteTransport ? { allowRemoteTransport: true } : {}),
    providerProbe: new CliProviderProbe(),
    machineIdentity,
    ...(tls ? { tls } : {}),
  })

  const address = await daemon.start()
  process.stdout.write(
    `domovoid listening on ${tls ? "wss" : "ws"}://${address.host}:${address.port}/rpc\n`,
  )
  if (!config.authToken) {
    process.stdout.write(`domovoid credential stored at ${config.credentialPath}\n`)
  }

  const shutdown = async () => {
    await daemon.stop()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

await main()
