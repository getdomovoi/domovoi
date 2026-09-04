import { homedir, hostname } from "node:os"
import { join } from "node:path"

import { parseDaemonEnvironment, type DaemonEnvironment } from "./config.js"
import { loadOrCreateDaemonToken } from "./credentials.js"
import { loadOrCreateMachineIdentity, type MachineIdentity } from "./machine-identity.js"
import {
  MachineCredentialStore,
  type MachineCredentials,
} from "./machine-credentials.js"
import { CliProviderProbe, type ProviderProbe } from "./providers.js"
import {
  DomovoiDaemon,
  type DaemonErrorSink,
  type DaemonServerOptions,
} from "./server.js"
import { loadTlsMaterial, type TlsMaterial, type TlsMaterialPaths } from "./tls-material.js"

export type ProductionDaemonOptions = {
  environment?: DaemonEnvironment
  homeDirectory?: string
  machineLabel?: string
  errorSink?: DaemonErrorSink
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
  start(): Promise<{ host: string; port: number }>
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
  createDaemon(options: DaemonServerOptions): ProductionDaemonRuntime
}

export const productionDaemonDependencies = {
  parseEnvironment: parseDaemonEnvironment,
  loadOrCreateToken: loadOrCreateDaemonToken,
  loadOrCreateIdentity: loadOrCreateMachineIdentity,
  loadTls: loadTlsMaterial,
  createProviderProbe: () => new CliProviderProbe(),
  createMachineCredentials: () => new MachineCredentialStore(),
  createDaemon: (options) => new DomovoiDaemon(options),
} satisfies ProductionDaemonDependencies

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export async function createProductionDaemonWithDependencies(
  options: ProductionDaemonOptions,
  dependencies: ProductionDaemonDependencies,
): Promise<ProductionDaemonHandle> {
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const machineLabel = options.machineLabel ?? hostname()
  const config = dependencies.parseEnvironment(environment, homeDirectory)

  // Validate and load transport protection before creating credentials or a
  // server. A rejected remote listener must have no socket or secret side effect.
  const tls = config.tls ? await dependencies.loadTls(config.tls) : undefined
  const [authToken, machineIdentity] = await Promise.all([
    config.authToken
      ? Promise.resolve(config.authToken)
      : dependencies.loadOrCreateToken(config.credentialPath),
    dependencies.loadOrCreateIdentity(config.machineIdentityPath, { label: machineLabel }),
  ])
  const stateDirectory = join(homeDirectory, ".domovoi")
  const daemon = dependencies.createDaemon({
    host: config.host,
    port: config.port,
    ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
    authToken,
    ...(config.allowRemoteTransport ? { allowRemoteTransport: true } : {}),
    providerProbe: dependencies.createProviderProbe(),
    machineIdentity,
    ...(tls ? { tls } : {}),
    ...(config.advertiseHost ? { advertiseHost: config.advertiseHost } : {}),
    machineCredentials: dependencies.createMachineCredentials(),
    statePath: join(stateDirectory, "state.sqlite"),
    worktreeRoot: join(stateDirectory, "worktrees"),
    manageStateDirectoryPermissions: true,
    ...(options.errorSink ? { errorSink: options.errorSink } : {}),
  })
  const secureTransport = tls !== undefined

  return {
    host: daemon.host,
    requestedPort: daemon.requestedPort,
    authToken: daemon.authToken,
    secureTransport,
    credential: config.authToken
      ? { source: "environment" }
      : { source: "file", path: config.credentialPath },
    start: async () => {
      const address = await daemon.start()
      const reachableHost = config.advertiseHost ?? address.host
      return {
        ...address,
        url: `${secureTransport ? "wss" : "ws"}://${urlHost(reachableHost)}:${address.port}/rpc`,
      }
    },
    stop: () => daemon.stop(),
  }
}

export function createProductionDaemon(
  options: ProductionDaemonOptions = {},
): Promise<ProductionDaemonHandle> {
  return createProductionDaemonWithDependencies(options, productionDaemonDependencies)
}
