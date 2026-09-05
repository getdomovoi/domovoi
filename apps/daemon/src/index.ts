#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { homedir, hostname, userInfo } from "node:os"

import { createProductionDaemon } from "./public.js"
import { loadOrCreateDaemonToken } from "./credentials.js"
import { runPairCommand } from "./pair-command.js"
import { runFleetKeychainCommand } from "./fleet-keychain-command.js"
import { MachineCredentialStore } from "./machine-credentials.js"
import { runOpenCommand } from "./open-command.js"
import { publishEndpointFile, removeEndpointFile } from "./endpoint-file.js"
import { installShutdownHandlers } from "./shutdown.js"
import type { OpenTarget } from "./wsl-open-target.js"
import { connectionForTarget } from "./open-connection.js"
import { readDistroEndpoint } from "./wsl-endpoint.js"
import { listWslDistributions } from "./wsl-list.js"
import { protocolVersion, type DeviceIssueCodeResult } from "@getdomovoi/protocol"
import { parseDaemonEnvironment } from "./config.js"
import { ProviderSecretManager } from "./provider-secrets.js"
import { readHiddenSecret, runProviderSecretCommand } from "./secret-command.js"
import { nodeServiceEffects, runServiceCommand } from "./service/install.js"
import { readServiceConfiguration, serviceEnvironment, type ServiceConfiguration } from "./service/configuration.js"

async function greetCli(socket: import("ws").WebSocket): Promise<void> {
  const requestId = 1
  await new Promise<void>((resolve, reject) => {
    const settle = (finish: () => void) => {
      socket.off("message", receive)
      socket.off("close", closed)
      socket.off("error", failed)
      finish()
    }
    const receive = (data: { toString(): string }) => {
      const message = JSON.parse(data.toString()) as {
        id?: number
        error?: { message?: string }
      }
      if (message.id !== requestId) return
      settle(() => {
        if (message.error) reject(new Error(message.error.message ?? "Daemon refused the CLI connection"))
        else resolve()
      })
    }
    const closed = () => settle(() => reject(new Error("Daemon connection closed")))
    const failed = (error: Error) => settle(() => reject(error))
    socket.on("message", receive)
    socket.once("close", closed)
    socket.once("error", failed)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "system.hello",
      params: { client: "cli", clientVersion: "0.0.1", protocolVersion },
    }))
  })
}

async function requestPairingCode(
  config: { host: string; port: number; tls?: unknown },
  token: string,
): Promise<DeviceIssueCodeResult> {
  const { WebSocket } = await import("ws")
  const scheme = config.tls ? "wss" : "ws"
  const socket = new WebSocket(`${scheme}://${config.host}:${config.port}/rpc`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const requestId = 2
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await greetCli(socket)
    const result = await new Promise<DeviceIssueCodeResult>((resolve, reject) => {
      // The daemon broadcasts notifications on the same socket, so only the
      // reply carrying this request's id may settle it, and a socket that
      // closes first must reject rather than leave the caller waiting.
      const receive = (data: { toString(): string }) => {
        const message = JSON.parse(data.toString()) as {
          id?: number
          result?: DeviceIssueCodeResult
          error?: { message?: string }
        }
        if (message.id !== requestId) return
        socket.off("message", receive)
        if (message.result) resolve(message.result)
        else reject(new Error(message.error?.message ?? "Daemon refused the pairing request"))
      }
      socket.on("message", receive)
      socket.once("close", () => reject(new Error("Daemon connection closed")))
      socket.once("error", reject)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "device.issueCode",
        params: {},
      }))
    })
    return result
  } finally {
    socket.close()
  }
}

const projectOpenTimeoutMs = 15_000
const loopbackListeners = new Set(["127.0.0.1", "::1", "localhost"])

function isLoopbackListener(host: string): boolean {
  return loopbackListeners.has(host)
}

async function requestProjectOpen(
  config: { host: string; port: number; tls?: unknown },
  token: string,
  path: string,
): Promise<void> {
  const { WebSocket } = await import("ws")
  const scheme = config.tls ? "wss" : "ws"
  const socket = new WebSocket(`${scheme}://${config.host}:${config.port}/rpc`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const requestId = 2
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await greetCli(socket)
    await new Promise<void>((resolve, reject) => {
      // A daemon that accepts the socket and then says nothing would otherwise
      // hold this open forever, so the wait is bounded and every listener is
      // removed before the socket is closed in the finally block.
      const timer = setTimeout(() => {
        settle(() => reject(new Error("Daemon did not answer in time")))
      }, projectOpenTimeoutMs)
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        socket.off("message", receive)
        socket.off("close", closed)
        socket.off("error", failed)
        finish()
      }
      const receive = (data: { toString(): string }) => {
        const message = JSON.parse(data.toString()) as {
          id?: number
          result?: unknown
          error?: { message?: string }
        }
        if (message.id !== requestId) return
        settle(() => {
          if (message.error) reject(new Error(message.error.message ?? "Daemon refused to open the project"))
          else resolve()
        })
      }
      const closed = () => settle(() => reject(new Error("Daemon connection closed")))
      const failed = (error: Error) => settle(() => reject(error))
      socket.on("message", receive)
      socket.once("close", closed)
      socket.once("error", failed)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "project.open",
        params: { path, client: "cli" },
      }))
    })
  } finally {
    socket.close()
  }
}

async function openWorkspace(target: OpenTarget): Promise<void> {
  // Work inside a distribution is opened by the daemon running there, using
  // that daemon's own credential, so nothing is read across the share and this
  // machine's credential never travels into a distribution.
  const connection = await connectionForTarget(target, {
    local: async () => {
      const config = parseDaemonEnvironment(process.env, homedir())
      return {
        host: config.host,
        port: config.port,
        token: config.authToken ?? await loadOrCreateDaemonToken(config.credentialPath),
        ...(config.tls ? { tls: true } : {}),
      }
    },
    endpoint: (distribution) => readDistroEndpoint({ distribution }),
  })
  await requestProjectOpen(connection, connection.token, target.path)
}

const help = `Usage: domovoid [options]
       domovoid pair
       domovoid fleet-keychain list
       domovoid fleet-keychain forget <machine-id> --confirm-daemon-stopped
       domovoid open [path]
       domovoid secret status
       domovoid secret set <anthropic|openai|openrouter>
       domovoid secret delete <anthropic|openai|openrouter>
       domovoid service install
       domovoid service status
       domovoid service remove

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
  --service-config <path>  Run with the installed non-secret service configuration

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
  DOMOVOI_ADVERTISE_HOST          Name an encrypted listener is reachable by
  DOMOVOI_TAILNET_HOST            Explicit tailnet host for a non-loopback TLS listener
  DOMOVOI_SSH_TUNNELS             JSON list of source-local {machineId, endpoint} forwards
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
  if (args[0] === "fleet-keychain") {
    // Exceptional local recovery, not enrollment or an unversioned RPC path.
    // The user must stop the daemon before removing an indexed credential.
    process.exitCode = runFleetKeychainCommand(args, {
      credentials: new MachineCredentialStore(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    })
    return
  }
  if (args[0] === "service") {
    // The service runs as the user who asked for it, so the plan is built from
    // this process's own identity rather than anything a caller passes in.
    const { uid, username } = userInfo()
    process.exitCode = await runServiceCommand(args, {
      ...nodeServiceEffects(),
      platform: process.platform,
      execPath: process.argv[1] ?? process.execPath,
      runtime: process.execPath,
      home: homedir(),
      uid,
      user: username,
      environment: process.env,
      workingDirectory: process.cwd(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    })
    return
  }
  if (args[0] === "open") {
    // The configuration is read and a credential is created only once a target
    // has been resolved, so a refused path never creates one.
    process.exitCode = await runOpenCommand(args, {
      cwd: () => process.cwd(),
      distributions: () => listWslDistributions(),
      open: (target) => openWorkspace(target),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    })
    return
  }
  if (args[0] === "pair") {
    const config = parseDaemonEnvironment(process.env, homedir())
    const token = config.authToken ?? await loadOrCreateDaemonToken(config.credentialPath)
    process.exitCode = await runPairCommand(args, {
      issue: () => requestPairingCode(config, token),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    })
    return
  }
  let serviceConfig: ServiceConfiguration | undefined
  if (args.length === 2 && args[0] === "--service-config") {
    try {
      serviceConfig = await readServiceConfiguration(args[1]!)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
      return
    }
  } else if (args.length > 0) {
    process.stderr.write(`Unknown argument: ${args.join(" ")}\n`)
    process.exitCode = 1
    return
  }

  const daemon = await createProductionDaemon({
    environment: serviceConfig ? serviceEnvironment(serviceConfig) : process.env,
    homeDirectory: serviceConfig?.homeDirectory ?? homedir(),
    machineLabel: hostname(),
  })

  const address = await daemon.start()
  process.stdout.write(`domovoid listening on ${address.url}\n`)
  if (daemon.credential.source === "file") {
    process.stdout.write(`domovoid credential stored at ${daemon.credential.path}\n`)
  }

  // A daemon inside a WSL distribution is found by its endpoint file, which is
  // why it is published only once the listener is actually up, and taken away
  // when it stops.
  const published = isLoopbackListener(address.host)
    ? { host: address.host, port: address.port, token: daemon.authToken }
    : undefined
  const daemonHome = serviceConfig?.homeDirectory ?? homedir()
  if (published) await publishEndpointFile({ home: daemonHome, ...published })

  installShutdownHandlers({
    removeEndpointFile: () => removeEndpointFile(daemonHome, published),
    stopDaemon: () => daemon.stop(),
    exit: (code) => process.exit(code),
    writeStderr: (text) => process.stderr.write(text),
  })
}

await main()
