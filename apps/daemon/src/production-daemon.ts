import { randomUUID } from "node:crypto"
import { homedir, hostname } from "node:os"
import { join, resolve } from "node:path"

import { protocolVersion } from "@getdomovoi/protocol"

import type { MachineWslFacts, RelayIdentityPin } from "@getdomovoi/protocol"

import { parseDaemonEnvironment, type DaemonEnvironment } from "./config.js"
import { loadOrCreateDaemonToken } from "./credentials.js"
import { RotatingDaemonLog } from "./daemon-logs.js"
import { loadOrCreateMachineIdentity, type MachineIdentity } from "./machine-identity.js"
import { MachineCredentialWorker, type AsyncMachineCredentials } from "./machine-credential-worker.js"
import { CliProviderProbe, type ProviderProbe } from "./providers.js"
import { claimProfile, type ProfileLease } from "./profile-lease.js"
import { createLocalOwnerSecret, writeLocalOwnerRecord, type LocalOwnerRecord } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { redactErrorDetail } from "./rpc-errors.js"
import { loadOrProvisionRelayChannel, type ProvisionedRelayChannel } from "./relay-provisioning.js"
import {
  DomovoiDaemon,
  type DaemonErrorSink,
  type DaemonServerOptions,
} from "./server.js"
import { skillTrustPath } from "./skill-signing.js"
import { loadTlsMaterial, type TlsMaterial, type TlsMaterialPaths } from "./tls-material.js"
import { wslHostFacts } from "./wsl-host.js"

export type ProductionDaemonOptions = {
  environment?: DaemonEnvironment
  homeDirectory?: string
  machineLabel?: string
  errorSink?: DaemonErrorSink
  owner?: "daemon" | "desktop"
  // Local service provenance, not a credential or a claim about arbitrary
  // supervisors. Only the CLI's parsed saved configuration supplies this.
  serviceRegistrationId?: string
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
  readonly relayIdentity?: RelayIdentityPin
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
  loadOrCreateToken(path: string, deadline: OperationDeadline): Promise<string>
  loadOrCreateIdentity(
    path: string,
    defaults: { label: string },
  ): Promise<MachineIdentity>
  loadTls(paths: TlsMaterialPaths): Promise<TlsMaterial>
  loadRelayChannel: typeof loadOrProvisionRelayChannel
  createProviderProbe(): ProviderProbe
  createMachineCredentials(): AsyncMachineCredentials
  wslFacts(environment: DaemonEnvironment): MachineWslFacts | undefined
  createDaemon(options: DaemonServerOptions): ProductionDaemonRuntime
}

export const productionDaemonDependencies = {
  parseEnvironment: parseDaemonEnvironment,
  loadOrCreateToken: loadOrCreateDaemonToken,
  loadOrCreateIdentity: loadOrCreateMachineIdentity,
  loadTls: loadTlsMaterial,
  loadRelayChannel: loadOrProvisionRelayChannel,
  createProviderProbe: () => new CliProviderProbe(),
  createMachineCredentials: () => new MachineCredentialWorker(),
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
  let diagnosticLog: RotatingDaemonLog | undefined
  let published = false
  let loadingRelay: Promise<ProvisionedRelayChannel | undefined> | undefined
  let relaySettled = false
  let relayResult: ProvisionedRelayChannel | undefined
  try {
    const config = dependencies.parseEnvironment(environment, homeDirectory)
    if (options.owner === "desktop" && options.serviceRegistrationId !== undefined) throw new Error("Desktop cannot claim a service registration")
    // Validate transport before any secret or listener side effect. Store
    // construction itself writes state, so ownership precedes its constructor.
    const tls = config.tls ? await beforeDeadline(dependencies.loadTls(config.tls), deadline) : undefined
    deadline.throwIfExpired()
    lease ??= claimProfile(homeDirectory)
    const ownedLease = lease
    diagnosticLog = new RotatingDaemonLog(join(homeDirectory, ".domovoi", "logs"))
    const ownedLog = diagnosticLog
    let reportedLogFailure = false
    const errorSink: DaemonErrorSink = (entry) => {
      try { ownedLog.append(entry) } catch (error) {
        // Preserve existing error reporting if disk logging fails. Retry future
        // appends, but do not turn a full disk into an unbounded warning stream.
        if (!reportedLogFailure) {
          reportedLogFailure = true
          console.error("Daemon diagnostic file unavailable:", redactErrorDetail(error))
        }
      }
      if (options.errorSink) options.errorSink(entry)
      else console.error(entry.context, entry.detail)
    }
    const [authToken, machineIdentity] = await beforeDeadline(Promise.all([
      config.authToken
        ? Promise.resolve(config.authToken)
        : dependencies.loadOrCreateToken(config.credentialPath, deadline),
      dependencies.loadOrCreateIdentity(config.machineIdentityPath, { label: machineLabel }),
    ]), deadline)
    loadingRelay = dependencies.loadRelayChannel({
      homeDirectory, machineId: machineIdentity.id, deadline,
      ...(config.relayIdentityPublicKey !== undefined ? { identityPublicKey: config.relayIdentityPublicKey } : {}),
      ...(config.relayCredentialFile !== undefined ? { credentialFile: config.relayCredentialFile } : {}),
      warn: (message) => errorSink({ context: "Relay channel credential custody", detail: message }),
    })
    void loadingRelay.then((value) => { relayResult = value; relaySettled = true }, () => { relaySettled = true })
    const relay = await beforeDeadline(loadingRelay, deadline)
    const secret = await beforeDeadline(createLocalOwnerSecret(homeDirectory, authToken, deadline), deadline)
    deadline.throwIfExpired()
    const identity = { instanceId: randomUUID(), machineId: machineIdentity.id, protocolVersion }
    const credential: ProductionDaemonCredential = config.authToken
      ? { source: "environment" } : { source: "file", path: resolve(config.credentialPath) }
    const record: Extract<LocalOwnerRecord, { state: "starting" }> = {
      version: 1, state: "starting", ...identity, owner: options.owner ?? "daemon", credential,
      ...(options.serviceRegistrationId ? { serviceRegistrationId: options.serviceRegistrationId } : {}),
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
      ...(relay ? { relayStaticKey: relay.privateKey } : {}),
      ...(config.allowRemoteTransport ? { allowRemoteTransport: true } : {}),
      providerProbe: dependencies.createProviderProbe(),
      machineIdentity,
      ...(tls ? { tls } : {}),
      ...(config.advertiseHost ? { advertiseHost: config.advertiseHost } : {}),
      ...(config.tailnetHost ? { tailnetHost: config.tailnetHost } : {}),
      ...(config.sshTunnels ? { sshTunnels: config.sshTunnels } : {}),
      ...(wsl ? { wsl } : {}),
      machineCredentials: dependencies.createMachineCredentials(),
      statePath: join(homeDirectory, ".domovoi", "state.sqlite"),
      worktreeRoot: join(homeDirectory, ".domovoi", "worktrees"),
      skillTrustPath: skillTrustPath(homeDirectory),
      manageStateDirectoryPermissions: true,
      errorSink,
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
          ownedLog.close()
          ownedLease.release()
        })
      }
      return stopping
    }
    return {
      host: daemon.host, requestedPort: daemon.requestedPort, authToken: daemon.authToken,
      secureTransport, credential,
      ...(relay ? { relayIdentity: structuredClone(relay.identity) } : {}),
      start: () => {
        if (stopping) return Promise.reject(new Error("Daemon cannot restart after shutdown"))
        if (!starting) {
          startDeadline = ownership?.deadline ?? OperationDeadline.start(30_000)
          starting = daemon.start(startDeadline.signal).then((address) => {
            startDeadline!.throwIfExpired()
            if (stopping) throw new Error("Daemon stopped during startup")
            const reachableHost = config.advertiseHost ?? config.tailnetHost ?? address.host
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
    if (loadingRelay && !relaySettled && lease) {
      // A deadline stops waiting, not a keychain write already in flight. Keep
      // ownership until it settles so another startup cannot race publication.
      const heldLease = lease
      lease = undefined
      void loadingRelay.then((late) => late?.privateKey.fill(0), () => {})
        .finally(() => heldLease.release())
        .catch((cleanup) => console.error("Relay provisioning cleanup failed:", redactErrorDetail(cleanup)))
    }
    try {
      if (published) writeLocalOwnerRecord(homeDirectory, { version: 1, state: "none" })
    } finally {
      diagnosticLog?.close()
      lease?.release()
    }
    throw error
  } finally {
    relayResult?.privateKey.fill(0)
    if (!ownership) deadline.clear()
  }
}

export function createProductionDaemon(
  options: ProductionDaemonOptions = {},
): Promise<ProductionDaemonHandle> {
  return createProductionDaemonWithDependencies(options, productionDaemonDependencies)
}
