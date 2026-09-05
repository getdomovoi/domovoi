import { readFile } from "node:fs/promises"
import { posix, win32 } from "node:path"

import { z } from "zod"

import { parseDaemonEnvironment, type DaemonEnvironment, type DaemonEnvironmentConfig } from "../config.js"
import { OperationDeadline } from "../operation-deadline.js"
import { configuredSshTunnelsSchema, tailnetHostSchema } from "../transport-config.js"
import { withinServiceDeadline } from "./deadline.js"

const maximumConfigurationBytes = 64 * 1_024
const pathSchema = z.string().min(1).refine((path) => posix.isAbsolute(path) || win32.isAbsolute(path))
const configurationSchema = z.object({
  version: z.literal(1),
  homeDirectory: pathSchema,
  host: z.string(),
  port: z.number().int(),
  credentialPath: pathSchema,
  machineIdentityPath: pathSchema,
  tls: z.object({ certPath: pathSchema, keyPath: pathSchema }).strict().optional(),
  advertiseHost: z.string().optional(),
  tailnetHost: tailnetHostSchema.optional(),
  sshTunnels: configuredSshTunnelsSchema.optional(),
  allowedOrigins: z.array(z.string()).optional(),
  allowRemoteTransport: z.boolean(),
}).strict()

export type ServiceConfiguration = Omit<DaemonEnvironmentConfig, "authToken"> & {
  version: 1
  homeDirectory: string
}

// Only these settings cross from the installing shell into the supervisor.
// Paths to secrets are configuration, never the secret contents themselves.
// Do not spread the manager's environment here: it must not change admission
// or silently select a different identity when the service restarts.
export function serviceEnvironment(config: ServiceConfiguration): DaemonEnvironment {
  return {
    DOMOVOI_HOST: config.host,
    DOMOVOI_PORT: String(config.port),
    DOMOVOI_CREDENTIAL_PATH: config.credentialPath,
    DOMOVOI_MACHINE_IDENTITY_PATH: config.machineIdentityPath,
    DOMOVOI_ALLOW_REMOTE_TRANSPORT: config.allowRemoteTransport ? "1" : "0",
    ...(config.tls ? {
      DOMOVOI_TLS_CERT_PATH: config.tls.certPath,
      DOMOVOI_TLS_KEY_PATH: config.tls.keyPath,
    } : {}),
    ...(config.advertiseHost !== undefined ? { DOMOVOI_ADVERTISE_HOST: config.advertiseHost } : {}),
    ...(config.tailnetHost !== undefined ? { DOMOVOI_TAILNET_HOST: config.tailnetHost } : {}),
    ...(config.sshTunnels !== undefined ? { DOMOVOI_SSH_TUNNELS: JSON.stringify(config.sshTunnels) } : {}),
    ...(config.allowedOrigins !== undefined ? { DOMOVOI_ALLOWED_ORIGINS: config.allowedOrigins.join(",") } : {}),
  }
}

export function createServiceConfiguration(environment: DaemonEnvironment, options: {
  homeDirectory: string
  workingDirectory: string
  platform: string
}): ServiceConfiguration {
  if (environment.DOMOVOI_AUTH_TOKEN !== undefined) {
    throw new Error("Service installation cannot retain DOMOVOI_AUTH_TOKEN. Configure a private DOMOVOI_CREDENTIAL_PATH, unset DOMOVOI_AUTH_TOKEN, then install again. No credential was changed.")
  }
  const paths = options.platform === "win32" ? win32 : posix
  if (!paths.isAbsolute(options.homeDirectory) || !paths.isAbsolute(options.workingDirectory)) {
    throw new Error("Service installation requires absolute home and working directories")
  }
  const config = parseDaemonEnvironment(environment, options.homeDirectory)
  const absolute = (path: string) => paths.resolve(options.workingDirectory, path)
  const { authToken: _authToken, ...settings } = config
  return {
    ...settings,
    version: 1,
    homeDirectory: options.homeDirectory,
    credentialPath: absolute(config.credentialPath),
    machineIdentityPath: absolute(config.machineIdentityPath),
    ...(config.tls ? { tls: { certPath: absolute(config.tls.certPath), keyPath: absolute(config.tls.keyPath) } } : {}),
  }
}

export function serviceConfigurationPath(home: string, platform: string): string {
  return (platform === "win32" ? win32 : posix).join(home, ".domovoi", "service.json")
}

export function parseServiceConfiguration(text: string): ServiceConfiguration {
  try {
    if (Buffer.byteLength(text, "utf8") > maximumConfigurationBytes) throw new Error("oversized")
    const { tls, advertiseHost, tailnetHost, sshTunnels, allowedOrigins, ...required } = configurationSchema.parse(JSON.parse(text))
    const config: ServiceConfiguration = {
      ...required,
      ...(tls !== undefined ? { tls } : {}),
      ...(advertiseHost !== undefined ? { advertiseHost } : {}),
      ...(tailnetHost !== undefined ? { tailnetHost } : {}),
      ...(sshTunnels !== undefined ? { sshTunnels } : {}),
      ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    }
    // Reuse the production listener and origin checks, including required TLS.
    parseDaemonEnvironment(serviceEnvironment(config), config.homeDirectory)
    return config
  } catch {
    // No parser diagnostics that could echo unexpected secret-bearing fields.
    throw new Error("Invalid service configuration. Reinstall with valid non-secret daemon settings.")
  }
}

export function serializeServiceConfiguration(config: ServiceConfiguration): string {
  const text = `${JSON.stringify(config, null, 2)}\n`
  parseServiceConfiguration(text)
  return text
}

export async function readServiceConfiguration(path: string): Promise<ServiceConfiguration> {
  const deadline = OperationDeadline.start(5_000)
  try {
    const text = await withinServiceDeadline(deadline, () => readFile(path, { encoding: "utf8", signal: deadline.signal }))
    return parseServiceConfiguration(text)
  } catch (error) {
    throw new Error(`Could not load service configuration at ${path}. Reinstall the service before restarting.`, { cause: error })
  } finally {
    deadline.clear()
  }
}
