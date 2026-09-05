import { randomUUID } from "node:crypto"
import { homedir, hostname } from "node:os"
import { join, resolve } from "node:path"

import { protocolVersion } from "@getdomovoi/protocol"

import type { MachineWslFacts } from "@getdomovoi/protocol"

import { parseDaemonEnvironment, type DaemonEnvironment } from "./config.js"
import { loadOrCreateDaemonToken } from "./credentials.js"
import { loadOrCreateMachineIdentity, type MachineIdentity } from "./machine-identity.js"
import {
  MachineCredentialStore,
  type MachineCredentials,
} from "./machine-credentials.js"
import { CliProviderProbe, type ProviderProbe } from "./providers.js"
import { claimProfile, type ProfileLease } from "./profile-lease.js"
import { createLocalOwnerSecret, writeLocalOwnerRecord, type LocalOwnerRecord } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import {
  DomovoiDaemon,
  type DaemonErrorSink,
  type DaemonServerOptions,
} from "./server.js"
import { loadTlsMaterial, type TlsMaterial, type TlsMaterialPaths } from "./tls-material.js"
import { wslHostFacts } from "./wsl-host.js"

export type ProductionDaemonOptions = {
  environment?: DaemonEnvironment
  homeDirectory?: string
  machineLabel?: string
  errorSink?: DaemonErrorSink
  owner?: "daemon" | "desktop"
}

export type ProductionDaemonCredential =
  | { source: "environment" }
  | { source: "file"; path: string }

export type ProductionDaemonEndpoint = {
  host: string
  port: number
  url: string
}

export type ProductionDaemonHandle = {
  readonly host: string
  readonly requestedPort: number
  readonly authToken: string
  readonly secureTransport: boolean
  readonly credential: ProductionDaemonCredential
  start(): Promise<ProductionDaemonEndpoint>
  stop(): Promise<void>
}

// This narrow runtime type lets the factory itself be tested without exposing
// the server constructor from the package's supported or internal entry points.
export type ProductionDaemonRuntime = {
  readonly host: string
  readonly requestedPort: number
  readonly authToken: string
  start(signal?: AbortSignal): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}

export type ProductionDaemonDependencies = {
  parseEnvironment: typeof parseDaemonEnvironment
  loadOrCreateToken(path: string): Promise<string>
  loadOrCreateIdentity(
    path: string,
    defaults: { label: string },
  ): Promise<MachineIdentity>
  loadTls(paths: TlsMaterialPaths): Promise<TlsMaterial>
  createProviderProbe(): ProviderProbe
  createMachineCredentials(): MachineCredentials
  wslFacts(environment: DaemonEnvironment): MachineWslFacts | undefined
  createDaemon(options: DaemonServerOptions): ProductionDaemonRuntime
}

export const productionDaemonDependencies = {
  parseEnvironment: parseDaemonEnvironment,
  loadOrCreateToken: loadOrCreateDaemonToken,
  loadOrCreateIdentity: loadOrCreateMachineIdentity,
  loadTls: loadTlsMaterial,
  createProviderProbe: () => new CliProviderProbe(),
  createMachineCredentials: () => new MachineCredentialStore(),
  wslFacts: (environment) => wslHostFacts({ environment }),
  createDaemon: (options) => new DomovoiDaemon(options),
} satisfies ProductionDaemonDependencies

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export async function createProductionDaemonWithDependencies(
  options: ProductionDaemonOptions,
  dependencies: ProductionDaemonDependencies,
  ownership?: { lease: ProfileLease; deadline: OperationDeadline },
): Promise<ProductionDaemonHandle> {
  const deadline = ownership?.deadline ?? OperationDeadline.start(30_000)
  const environment = options.environment ?? process.env
  const homeDirectory = resolve(options.homeDirectory ?? homedir())
  const machineLabel = options.machineLabel ?? hostname()
  let lease = ownership?.lease
  let published = false
  try {
    const config = dependencies.parseEnvironment(environment, homeDirectory)
    // Validate transport before any secret or listener side effect. Store
    // construction itself writes state, so ownership precedes its constructor.
    const tls = config.tls ? await beforeDeadline(dependencies.loadTls(config.tls), deadline) : undefined
    deadline.throwIfExpired()
    lease ??= claimProfile(homeDirectory)
    const ownedLease = lease
    const [authToken, machineIdentity] = await beforeDeadline(Promise.all([
      config.authToken
        ? Promise.resolve(config.authToken)
        : dependencies.loadOrCreateToken(config.credentialPath),
      dependencies.loadOrCreateIdentity(config.machineIdentityPath, { label: machineLabel }),
    ]), deadline)
    const secret = await beforeDeadline(createLocalOwnerSecret(homeDirectory, authToken), deadline)
    deadline.throwIfExpired()
    const identity = { instanceId: randomUUID(), machineId: machineIdentity.id, protocolVersion }
    const credential: ProductionDaemonCredential = config.authToken
      ? { source: "environment" } : { source: "file", path: resolve(config.credentialPath) }
    const record: Extract<LocalOwnerRecord, { state: "starting" }> = {
      version: 1, state: "starting", ...identity, owner: options.owner ?? "daemon", credential,
      ...(config.tls ? { certificatePath: resolve(config.tls.certPath) } : {}),
    }
    writeLocalOwnerRecord(homeDirectory, record)
    published = true
    deadline.throwIfExpired()
    const wsl = dependencies.wslFacts(environment)
    const daemon = dependencies.createDaemon({
      localOwner: { secret, identity },
      host: config.host,
      port: config.port,
      ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
      authToken,
      ...(config.allowRemoteTransport ? { allowRemoteTransport: true } : {}),
      providerProbe: dependencies.createProviderProbe(),
      machineIdentity,
      ...(tls ? { tls } : {}),
      ...(config.advertiseHost ? { advertiseHost: config.advertiseHost } : {}),
      ...(wsl ? { wsl } : {}),
      machineCredentials: dependencies.createMachineCredentials(),
      statePath: join(homeDirectory, ".domovoi", "state.sqlite"),
      worktreeRoot: join(homeDirectory, ".domovoi", "worktrees"),
      manageStateDirectoryPermissions: true,
      ...(options.errorSink ? { errorSink: options.errorSink } : {}),
    })
    const secureTransport = tls !== undefined
    let starting: Promise<ProductionDaemonEndpoint> | undefined
    let startDeadline: OperationDeadline | undefined
    let stopping: Promise<void> | undefined
    const shutdown = (): Promise<void> => {
      if (!stopping) {
        writeLocalOwnerRecord(homeDirectory, { ...record, state: "stopping" })
        // A late start must settle before closing its stores. A hung or failed
        // stop retains the lease. Expiring a caller never authorizes a writer.
        stopping = Promise.resolve(starting).catch(() => {}).then(() => daemon.stop()).then(() => {
          writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" })
          ownedLease.release()
        })
      }
      return stopping
    }
    return {
      host: daemon.host, requestedPort: daemon.requestedPort, authToken: daemon.authToken,
      secureTransport, credential,
      start: () => {
        if (stopping) return Promise.reject(new Error("Daemon cannot restart after shutdown"))
        if (!starting) {
          startDeadline = ownership?.deadline ?? OperationDeadline.start(30_000)
          starting = daemon.start(startDeadline.signal).then((address) => {
            startDeadline!.throwIfExpired()
            if (stopping) throw new Error("Daemon stopped during startup")
            const reachableHost = config.advertiseHost ?? address.host
            const endpoint = { ...address, url: `${secureTransport ? "wss" : "ws"}://${urlHost(reachableHost)}:${address.port}/rpc` }
            writeLocalOwnerRecord(homeDirectory, { ...record, state: "ready", url: endpoint.url })
            return endpoint
          })
        }
        return beforeDeadline(starting, startDeadline!).catch((error: unknown) => {
          void shutdown().catch(() => {})
          throw error
        }).finally(() => { if (!ownership) startDeadline!.clear() })
      },
      stop: async () => {
        const stopDeadline = OperationDeadline.start(30_000)
        try { await beforeDeadline(shutdown(), stopDeadline) } finally { stopDeadline.clear() }
      },
    }
  } catch (error) {
    try {
      if (published) writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" })
    } finally { lease?.release() }
    throw error
  } finally {
    if (!ownership) deadline.clear()
  }
}

export function createProductionDaemon(
  options: ProductionDaemonOptions = {},
): Promise<ProductionDaemonHandle> {
  return createProductionDaemonWithDependencies(options, productionDaemonDependencies)
}
