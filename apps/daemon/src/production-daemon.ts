import { randomUUID } from "node:crypto"
import { homedir, hostname } from "node:os"
import { join, resolve } from "node:path"

import { protocolVersion } from "@getdomovoi/protocol"

import type { MachineWslFacts, RelayIdentityPin } from "@getdomovoi/protocol"

import { defaultWebDirectory, parseDaemonEnvironment, type DaemonEnvironment } from "./config.js"
import { loadWebAppBundle, type WebAppBundleLoad, type WebAppBundleOptions } from "./web-app-bundle.js"
import { loadOrCreateDaemonToken } from "./credentials.js"
import { RotatingDaemonLog } from "./daemon-logs.js"
import { loadOrCreateMachineIdentity, type MachineIdentity } from "./machine-identity.js"
import { MachineCredentialWorker, type AsyncMachineCredentials } from "./machine-credential-worker.js"
import { CliProviderProbe, runProviderCommand, type ProviderProbe } from "./providers.js"
import { resolveToolPath } from "./tool-path.js"
import { claimProfile, type ProfileLease } from "./profile-lease.js"
import { createLocalOwnerSecret, writeLocalOwnerRecord, type LocalOwnerRecord } from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { redactErrorDetail } from "./rpc-errors.js"
import { loadOrProvisionRelayChannel, type ProvisionedRelayChannel } from "./relay-provisioning.js"
import { loadDaemonRelayCarrierConfiguration } from "./relay-carrier.js"
import {
  DomovoiDaemon,
  type DaemonErrorSink,
  type DaemonServerOptions,
} from "./server.js"
import { skillTrustPath } from "./skill-signing.js"
import { profileDirectory, profileLocation } from "./profile-directory.js"
import { loadTlsMaterial, type TlsMaterial, type TlsMaterialPaths } from "./tls-material.js"
import { loadTailnetTls, readTailnetTlsMaterial } from "./tailnet-listener.js"
import { wslHostFacts } from "./wsl-host.js"
import { captureInheritedCredentials, refuseCredentialOverrides, withInheritedCredentials, withoutInheritedCredentials } from "./inherited-credentials.js"

export type ProductionDaemonOptions = {
  environment?: DaemonEnvironment
  // Settings added on top of the environment for this daemon only. A caller
  // that passes process.env with overrides, rather than a copy of it, keeps the
  // inherited bearer across acquisitions: a copy is read as given. Overrides
  // may not set DOMOVOI_AUTH_TOKEN, DOMOVOI_CREDENTIAL_PATH or
  // DOMOVOI_RELAY_CREDENTIAL_FILE; the acquisition throws if they do.
  environmentOverrides?: Readonly<Record<string, string>>
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

// What became of the web app bundle at startup (S3.2 plan section 1.4), for
// the owner's startup output. directory is the configured or default folder.
export type ProductionWebAppStatus =
  | { state: "loaded"; directory: string; version: string; protocolVersion: string }
  | { state: "absent"; directory: string }
  | { state: "invalid"; directory: string; reason: string; path?: string }
  | { state: "incompatible"; directory: string; bundleProtocolVersion: string; daemonProtocolVersion: string }
  | { state: "timed-out"; directory: string; seconds: number }

// Codex review round 1 (Major): the bundle has its own bound inside the
// startup deadline, as the tailnet certificate does, so a stalled read (a
// hung network mount, say) costs the web app only, never the listeners. The
// read itself cannot be cancelled and finishes or fails unseen.
export const defaultWebAppLoadTimeoutMs = 10_000

export type ProductionDaemonHandle = {
  readonly host: string
  readonly requestedPort: number
  readonly authToken: string
  readonly secureTransport: boolean
  readonly credential: ProductionDaemonCredential
  readonly webApp: ProductionWebAppStatus
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
  // The tailnet certificate and key, read without following a link
  // (tailnet-listener.ts readTailnetTlsMaterial).
  readTailnetTls(paths: TlsMaterialPaths): Promise<TlsMaterial>
  // The tailnet certificate's own bound; tests shorten it.
  tailnetTlsTimeoutMs?: number
  loadWebApp(options: WebAppBundleOptions): Promise<WebAppBundleLoad>
  // The bundle's own bound; tests shorten it.
  webAppLoadTimeoutMs?: number
  loadRelayChannel: typeof loadOrProvisionRelayChannel
  resolveToolPath: typeof resolveToolPath
  createProviderProbe(toolPath: string | undefined): ProviderProbe
  createMachineCredentials(): AsyncMachineCredentials
  wslFacts(environment: DaemonEnvironment): MachineWslFacts | undefined
  createDaemon(options: DaemonServerOptions): ProductionDaemonRuntime
}

export const productionDaemonDependencies = {
  parseEnvironment: parseDaemonEnvironment,
  loadOrCreateToken: loadOrCreateDaemonToken,
  loadOrCreateIdentity: loadOrCreateMachineIdentity,
  loadTls: loadTlsMaterial,
  readTailnetTls: readTailnetTlsMaterial,
  loadWebApp: loadWebAppBundle,
  loadRelayChannel: loadOrProvisionRelayChannel,
  resolveToolPath,
  createProviderProbe: (toolPath) => new CliProviderProbe(runProviderCommand, { path: toolPath }),
  createMachineCredentials: () => new MachineCredentialWorker(),
  wslFacts: (environment) => wslHostFacts({ environment }),
  createDaemon: (options) => new DomovoiDaemon(options),
} satisfies ProductionDaemonDependencies

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

function webAppStatus(directory: string, load: WebAppBundleLoad): ProductionWebAppStatus {
  switch (load.state) {
    case "loaded": return { state: "loaded", directory, version: load.version, protocolVersion: load.protocolVersion }
    case "absent": return { state: "absent", directory }
    case "invalid": return { state: "invalid", directory, reason: load.reason, ...(load.path === undefined ? {} : { path: load.path }) }
    case "incompatible": return { state: "incompatible", directory, bundleProtocolVersion: load.bundleProtocolVersion, daemonProtocolVersion: load.daemonProtocolVersion }
  }
}

function invalidDetail(status: Extract<ProductionWebAppStatus, { state: "invalid" }>): string {
  return status.path === undefined ? status.reason : `${status.reason}: ${status.path}`
}

// The startup line beside "domovoid listening on" (S3.2 plan section 1.4).
// It names the directory: only the machine's owner reads this output.
export function describeWebApp(status: ProductionWebAppStatus): string {
  switch (status.state) {
    case "loaded": return `domovoid web app served from ${status.directory} (web ${status.version}, protocol ${status.protocolVersion})`
    case "absent": return `domovoid web app not served: none is installed at ${status.directory}`
    case "invalid": return `domovoid web app not served: it failed its checks (${invalidDetail(status)}) at ${status.directory}`
    case "incompatible": return `domovoid web app not served: it is for protocol ${status.bundleProtocolVersion} and this daemon speaks ${status.daemonProtocolVersion} at ${status.directory}`
    case "timed-out": return `domovoid web app not served: it was not read within ${status.seconds} seconds at ${status.directory}`
  }
}

// Loads the bundle within its own bound. A loader that throws or does not
// settle in time leaves the daemon serving the state page.
async function loadWebAppWithin(
  load: ProductionDaemonDependencies["loadWebApp"],
  options: WebAppBundleOptions,
  timeoutMs: number,
): Promise<{ load: WebAppBundleLoad; timedOut: boolean }> {
  const refused = (): WebAppBundleLoad => Object.freeze({ state: "invalid", root: options.root, reason: "root-unreadable" })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ load: WebAppBundleLoad; timedOut: boolean }>((settle) => {
    timer = setTimeout(() => settle({ load: refused(), timedOut: true }), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([load(options).then((loaded) => ({ load: loaded, timedOut: false }), () => ({ load: refused(), timedOut: false })), late])
  } finally {
    clearTimeout(timer)
  }
}

export async function createProductionDaemonWithDependencies(
  options: ProductionDaemonOptions,
  dependencies: ProductionDaemonDependencies,
  ownership?: { lease: ProfileLease; deadline: OperationDeadline },
): Promise<ProductionDaemonHandle> {
  // First, before anything can throw: the inherited bearer leaves process.env.
  captureInheritedCredentials(() => options.homeDirectory)
  refuseCredentialOverrides(options.environmentOverrides)
  const deadline = ownership?.deadline ?? OperationDeadline.start(30_000)
  const homeDirectory = resolve(options.homeDirectory ?? homedir())
  const settings = withInheritedCredentials(options.environment ?? process.env, homeDirectory, options.environmentOverrides)
  const environment = withoutInheritedCredentials({ ...(options.environment ?? process.env), ...options.environmentOverrides })
  const machineLabel = options.machineLabel ?? hostname()
  let profile = profileLocation(homeDirectory)
  let lease = ownership?.lease
  let diagnosticLog: RotatingDaemonLog | undefined
  let published = false
  let loadingRelay: Promise<ProvisionedRelayChannel | undefined> | undefined
  let relaySettled = false
  let relayResult: ProvisionedRelayChannel | undefined
  try {
    const config = dependencies.parseEnvironment(settings, homeDirectory)
    profile = profileLocation(homeDirectory, config.profileDirectory)
    if (options.owner === "desktop" && options.serviceRegistrationId !== undefined) throw new Error("Desktop cannot claim a service registration")
    // Validate transport before any secret or listener side effect. Store
    // construction itself writes state, so ownership precedes its constructor.
    const tls = config.tls ? await beforeDeadline(dependencies.loadTls(config.tls), deadline) : undefined
    // TailnetReach (Q404 A): unlike the main listener's, a certificate that
    // cannot be read refuses only the tailnet listener. The daemon still
    // starts on loopback, which the desktop and the CLI attach on, and says
    // why. Only regular files that are not links are read, within their own
    // bound.
    const tailnetListener = config.tailnetListener ? {
      address: config.tailnetListener.address,
      tls: await beforeDeadline(loadTailnetTls(dependencies.readTailnetTls, config.tailnetListener.tls, dependencies.tailnetTlsTimeoutMs), deadline),
    } : undefined
    // S3.2 plan section 1.3: the web app is loaded once, before any listener
    // exists, and never read from disk again. A bundle that fails a check
    // leaves the daemon serving the state page, never failing to start.
    // A service's settings carry only DOMOVOI_ variables, so XDG_DATA_HOME and
    // LOCALAPPDATA come from the process the supervisor started when the
    // settings do not name them.
    const webDirectory = config.webDirectory ?? defaultWebDirectory(process.platform, homeDirectory, { ...process.env, ...settings })
    const webAppTimeoutMs = dependencies.webAppLoadTimeoutMs ?? defaultWebAppLoadTimeoutMs
    const { load: webApp, timedOut } = await beforeDeadline(loadWebAppWithin(dependencies.loadWebApp,
      { root: webDirectory, profileDirectory: profileDirectory(profile) }, webAppTimeoutMs), deadline)
    const webAppState: ProductionWebAppStatus = timedOut
      ? { state: "timed-out", directory: webDirectory, seconds: webAppTimeoutMs / 1_000 }
      : webAppStatus(webDirectory, webApp)
    deadline.throwIfExpired()
    lease ??= claimProfile(profile)
    const ownedLease = lease
    const relayCarrier = loadDaemonRelayCarrierConfiguration(profileDirectory(profile))
    diagnosticLog = new RotatingDaemonLog(join(profileDirectory(profile), "logs"))
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
    // The daemon log is the owner's, so it names the folder and the file.
    if (webAppState.state === "invalid") {
      errorSink({ context: "Domovoi did not serve the web app", detail: `${invalidDetail(webAppState)} in ${webDirectory}` })
    } else if (webAppState.state === "incompatible") {
      errorSink({ context: "Domovoi did not serve the web app", detail: `the bundle is for protocol ${webAppState.bundleProtocolVersion} and this daemon speaks ${webAppState.daemonProtocolVersion}, in ${webDirectory}` })
    } else if (webAppState.state === "timed-out") {
      errorSink({ context: "Domovoi did not serve the web app", detail: `the bundle was not read within ${webAppState.seconds} seconds, in ${webDirectory}` })
    }
    const [authToken, machineIdentity] = await beforeDeadline(Promise.all([
      config.authToken
        ? Promise.resolve(config.authToken)
        : dependencies.loadOrCreateToken(config.credentialPath, deadline),
      dependencies.loadOrCreateIdentity(config.machineIdentityPath, { label: machineLabel }),
    ]), deadline)
    loadingRelay = dependencies.loadRelayChannel({
      homeDirectory: profile, machineId: machineIdentity.id, deadline,
      ...(config.relayIdentityPublicKey !== undefined ? { identityPublicKey: config.relayIdentityPublicKey } : {}),
      ...(config.relayCredentialFile !== undefined ? { credentialFile: config.relayCredentialFile } : {}),
      warn: (message) => errorSink({ context: "Relay channel credential custody", detail: message }),
    })
    void loadingRelay.then((value) => { relayResult = value; relaySettled = true }, () => { relaySettled = true })
    const relay = await beforeDeadline(loadingRelay, deadline)
    const secret = await beforeDeadline(createLocalOwnerSecret(profile, authToken, deadline), deadline)
    deadline.throwIfExpired()
    const identity = { instanceId: randomUUID(), machineId: machineIdentity.id, protocolVersion }
    const credential: ProductionDaemonCredential = config.authToken
      ? { source: "environment" } : { source: "file", path: resolve(config.credentialPath) }
    const record: Extract<LocalOwnerRecord, { state: "starting" }> = {
      version: 1, state: "starting", ...identity, owner: options.owner ?? "daemon", credential,
      ...(options.serviceRegistrationId ? { serviceRegistrationId: options.serviceRegistrationId } : {}),
      ...(config.tls ? { certificatePath: resolve(config.tls.certPath) } : {}),
    }
    writeLocalOwnerRecord(profile, record)
    published = true
    deadline.throwIfExpired()
    const wsl = dependencies.wslFacts(environment)
    // Resolved before any harness is spawned. node-pty shells and the harness
    // adapters spawn with process.env, so the process PATH is the one written
    // back, whatever environment record configured the daemon.
    const toolPath = await dependencies.resolveToolPath({
      environment,
      platform: process.platform,
      profileDirectory: profileDirectory(profile),
      run: runProviderCommand,
    })
    process.env.PATH = toolPath.path
    const daemon = dependencies.createDaemon({
      updates: { homeDirectory: profile, lease: ownedLease },
      localOwner: { secret, identity },
      host: config.host,
      port: config.port,
      ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
      ...(config.webAppUrl ? { webAppUrl: config.webAppUrl } : {}),
      webApp,
      authToken,
      ...(relayCarrier ? { relayCarrier } : {}),
      ...(relay ? { relayStaticKey: relay.privateKey,
        relayRecovery: { identity: relay.identity, ...(relay.successor ? { successor: relay.successor } : {}) },
      } : {}),
      ...(config.allowRemoteTransport ? { allowRemoteTransport: true } : {}),
      providerProbe: dependencies.createProviderProbe(toolPath.path),
      machineIdentity,
      ...(tls ? { tls } : {}),
      ...(tailnetListener ? { tailnetListener } : {}),
      ...(config.advertiseHost ? { advertiseHost: config.advertiseHost } : {}),
      ...(config.tailnetHost ? { tailnetHost: config.tailnetHost } : {}),
      ...(config.sshTunnels ? { sshTunnels: config.sshTunnels } : {}),
      ...(wsl ? { wsl } : {}),
      machineCredentials: dependencies.createMachineCredentials(),
      statePath: join(profileDirectory(profile), "state.sqlite"),
      worktreeRoot: join(profileDirectory(profile), "worktrees"),
      profileDirectory: profileDirectory(profile),
      skillTrustPath: skillTrustPath(profile),
      manageStateDirectoryPermissions: true,
      errorSink,
    })
    const secureTransport = tls !== undefined
    let starting: Promise<ProductionDaemonEndpoint> | undefined
    let startDeadline: OperationDeadline | undefined
    let stopping: Promise<void> | undefined
    const shutdown = (): Promise<void> => {
      if (!stopping) {
        writeLocalOwnerRecord(profile, { ...record, state: "stopping" })
        // A late start must settle before closing its stores. A hung or failed
        // stop retains the lease. Expiring a caller never authorizes a writer.
        stopping = Promise.resolve(starting).catch(() => {}).then(() => daemon.stop()).then(() => {
          writeLocalOwnerRecord(profile, { version: 1, state: "none" })
          ownedLog.close()
          ownedLease.release()
        })
      }
      return stopping
    }
    return {
      host: daemon.host, requestedPort: daemon.requestedPort, authToken: daemon.authToken,
      secureTransport, credential, webApp: webAppState,
      ...(relay ? { relayIdentity: structuredClone(relay.identity) } : {}),
      start: () => {
        if (stopping) return Promise.reject(new Error("Daemon cannot restart after shutdown"))
        if (!starting) {
          startDeadline = ownership?.deadline ?? OperationDeadline.start(30_000)
          starting = daemon.start(startDeadline.signal).then((address) => {
            startDeadline!.throwIfExpired()
            if (stopping) throw new Error("Daemon stopped during startup")
            // With the tailnet listener on, the tailnet name belongs to that
            // listener; the endpoint published here stays the loopback one.
            const reachableHost = config.advertiseHost ?? (config.tailnetListener ? undefined : config.tailnetHost) ?? address.host
            const endpoint = { ...address, url: `${secureTransport ? "wss" : "ws"}://${urlHost(reachableHost)}:${address.port}/rpc` }
            writeLocalOwnerRecord(profile, { ...record, state: "ready", url: endpoint.url })
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
      if (published) writeLocalOwnerRecord(profile, { version: 1, state: "none" })
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
