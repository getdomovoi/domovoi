import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { posix, win32 } from "node:path"

import { z } from "zod"

import { DaemonConfigurationError, parseDaemonEnvironment, type DaemonEnvironment, type DaemonEnvironmentConfig } from "../config.js"
import { OperationDeadline } from "../operation-deadline.js"
import { configuredSshTunnelsSchema, tailnetHostSchema } from "../transport-config.js"
import { withinServiceDeadline } from "./deadline.js"
import { configuredProfileDirectory, profileDirectory, profileLocation, sameProfileDirectory, type ProfileLocation } from "../profile-directory.js"
import { readLocalProfileFile } from "../local-owner-record.js"
import { installedWslTask, wslInstallationSchema, type WslInstallation } from "./wsl-registration.js"

const maximumConfigurationBytes = 64 * 1_024
const pathSchema = z.string().min(1).refine((path) => posix.isAbsolute(path) || win32.isAbsolute(path))
const configurationSchema = z.object({
  version: z.literal(1),
  registrationId: z.uuid().optional(),
  wsl: wslInstallationSchema.optional(),
  serviceRuntime: z.object({ executable: pathSchema, entry: pathSchema }).strict().optional(),
  homeDirectory: pathSchema,
  profileDirectory: pathSchema.optional(),
  host: z.string(),
  port: z.number().int(),
  credentialPath: pathSchema,
  machineIdentityPath: pathSchema,
  relayIdentityPublicKey: z.string().optional(),
  relayCredentialFile: pathSchema.optional(),
  tls: z.object({ certPath: pathSchema, keyPath: pathSchema }).strict().optional(),
  advertiseHost: z.string().optional(),
  tailnetHost: tailnetHostSchema.optional(),
  sshTunnels: configuredSshTunnelsSchema.optional(),
  allowedOrigins: z.array(z.string()).optional(),
  webAppUrl: z.unknown().optional(),
  allowRemoteTransport: z.boolean(),
}).strict()

// Ruled 2026-09-24 (A): the Node executable and daemon entry the service runs,
// as Domovoi installed them, or as an update left them once the new runtime
// reported ready. An update puts back only exactly these, never what a plist,
// unit, task action or saved WSL runtime names on its own.
export type ServiceRuntimeRecord = { executable: string; entry: string }

export type ServiceConfiguration = Omit<DaemonEnvironmentConfig, "authToken"> & {
  version: 1
  registrationId?: string
  wsl?: WslInstallation
  serviceRuntime?: ServiceRuntimeRecord
  homeDirectory: string
}

// Only these settings cross from the installing shell into the supervisor.
// Paths to secrets are configuration, never the secret contents themselves.
// Do not spread the manager's environment here: it must not change admission
// or silently select a different identity when the service restarts.
export function serviceEnvironment(config: ServiceConfiguration): DaemonEnvironment {
  return {
    DOMOVOI_HOST: config.host,
    DOMOVOI_PROFILE_DIR: config.profileDirectory ?? profileDirectory(config.homeDirectory,
      win32.isAbsolute(config.homeDirectory) && !posix.isAbsolute(config.homeDirectory) ? "win32" : "linux"),
    DOMOVOI_PORT: String(config.port),
    DOMOVOI_CREDENTIAL_PATH: config.credentialPath,
    DOMOVOI_MACHINE_IDENTITY_PATH: config.machineIdentityPath,
    ...(config.relayIdentityPublicKey !== undefined ? { DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY: config.relayIdentityPublicKey } : {}),
    ...(config.relayCredentialFile !== undefined ? { DOMOVOI_RELAY_CREDENTIAL_FILE: config.relayCredentialFile } : {}),
    DOMOVOI_ALLOW_REMOTE_TRANSPORT: config.allowRemoteTransport ? "1" : "0",
    ...(config.tls ? {
      DOMOVOI_TLS_CERT_PATH: config.tls.certPath,
      DOMOVOI_TLS_KEY_PATH: config.tls.keyPath,
    } : {}),
    ...(config.advertiseHost !== undefined ? { DOMOVOI_ADVERTISE_HOST: config.advertiseHost } : {}),
    ...(config.tailnetHost !== undefined ? { DOMOVOI_TAILNET_HOST: config.tailnetHost } : {}),
    ...(config.sshTunnels !== undefined ? { DOMOVOI_SSH_TUNNELS: JSON.stringify(config.sshTunnels) } : {}),
    ...(config.allowedOrigins !== undefined ? { DOMOVOI_ALLOWED_ORIGINS: config.allowedOrigins.join(",") } : {}),
    ...(config.webAppUrl !== undefined ? { DOMOVOI_WEB_APP_URL: config.webAppUrl } : {}),
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
  const config = parseDaemonEnvironment({ ...environment,
    DOMOVOI_PROFILE_DIR: environment.DOMOVOI_PROFILE_DIR ?? paths.join(options.homeDirectory, ".domovoi"),
  }, options.homeDirectory)
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
  return (platform === "win32" ? win32 : posix).join(profileDirectory(home, platform), "service.json")
}

export function serviceRegistrationBlocksProfile(home: string, profile: ProfileLocation): boolean {
  const path = serviceConfigurationPath(home, process.platform)
  if (!existsSync(path)) return false
  try {
    const config = parseServiceConfiguration(readLocalProfileFile(path, maximumConfigurationBytes))
    return sameProfileDirectory(profileLocation(config.homeDirectory, config.profileDirectory), profile)
  } catch {
    return true
  }
}

// A saved address of the wrong type is a refused daemon setting, like a
// refused string, not a malformed file.
function webAppUrlSetting(value: unknown): string | undefined {
  if (value === undefined || typeof value === "string") return value
  throw new DaemonConfigurationError("DOMOVOI_WEB_APP_URL must be a string")
}

// Security review of #577 (P1): the turn check and the fence reach only the
// caller's own daemon, so a service change binds the service only when it
// runs that daemon's profile. The caller's profile is its environment's
// DOMOVOI_PROFILE_DIR, read as the daemon reads it.
export function callerProfile(environment: DaemonEnvironment, homeDirectory: string): ProfileLocation {
  return profileLocation(homeDirectory, configuredProfileDirectory(environment.DOMOVOI_PROFILE_DIR, homeDirectory))
}

// Copy approved by fetzy on 2026-09-26.
export class ServiceProfileMismatchError extends Error {
  constructor(readonly app: string, readonly service: string) {
    super(`This app's daemon uses the profile at ${app}, and the login service uses the profile at ${service}.`)
    this.name = "ServiceProfileMismatchError"
  }
}

// Security review round 3 of #577 (P1, P2): a registered service whose saved
// configuration is missing, unreadable or malformed runs a profile nothing
// names. A service change for a caller's profile refuses it rather than take
// it for the caller's. Copy pending fetzy's approval.
export class ServiceProfileUnknownError extends Error {
  constructor(reason: string) {
    super(`${reason} Nothing was changed.`)
    this.name = "ServiceProfileUnknownError"
  }
}

export function registeredWithoutConfiguration(definitionPath: string): ServiceProfileUnknownError {
  return new ServiceProfileUnknownError(`A login service is registered at ${definitionPath}, but its saved configuration is missing, so the profile it runs is not known.`)
}

// The saved service's profile against the caller's. None saved matches: an
// install writes the caller's profile (the desktop passes it), an update finds
// nothing to update, and a removal finds no Domovoi service to stop.
export function assertServiceProfile(saved: ProfileLocation | undefined, caller: ProfileLocation): void {
  if (saved !== undefined && !sameProfileDirectory(saved, caller)) throw new ServiceProfileMismatchError(profileDirectory(caller), profileDirectory(saved))
}

// Round 2 (P2): only a service.json that is not there counts as none saved.
// One that cannot be reached or read throws, so it is never taken for none.
function savedServiceProfile(home: string): ProfileLocation | undefined {
  let text: string
  try {
    text = readLocalProfileFile(serviceConfigurationPath(home, process.platform), maximumConfigurationBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const config = parseServiceConfiguration(text)
  return profileLocation(config.homeDirectory, config.profileDirectory)
}

// The desktop's early check, before its turn check and fence: both profile
// directories when the saved service runs another profile than the caller's.
// The service calls check again under the service-operation lease. Reads only.
export function serviceProfileMismatch(input: { environment: NodeJS.ProcessEnv; homeDirectory: string }): { app: string; service: string } | undefined {
  try {
    assertServiceProfile(savedServiceProfile(input.homeDirectory), callerProfile(input.environment, input.homeDirectory))
    return undefined
  } catch (error) {
    if (error instanceof ServiceProfileMismatchError) return { app: error.app, service: error.service }
    throw error
  }
}

export function parseServiceConfiguration(text: string): ServiceConfiguration {
  try {
    if (Buffer.byteLength(text, "utf8") > maximumConfigurationBytes) throw new Error("oversized")
    const { tls, advertiseHost, tailnetHost, sshTunnels, allowedOrigins, webAppUrl: savedWebAppUrl, registrationId, relayIdentityPublicKey, relayCredentialFile, profileDirectory, wsl, serviceRuntime, ...required } = configurationSchema.parse(JSON.parse(text))
    const webAppUrl = webAppUrlSetting(savedWebAppUrl)
    const config: ServiceConfiguration = {
      ...required,
      ...(wsl !== undefined ? { wsl } : {}),
      ...(serviceRuntime !== undefined ? { serviceRuntime } : {}),
      ...(profileDirectory !== undefined ? { profileDirectory } : {}),
      ...(relayIdentityPublicKey !== undefined ? { relayIdentityPublicKey } : {}),
      ...(relayCredentialFile !== undefined ? { relayCredentialFile } : {}),
      ...(registrationId !== undefined ? { registrationId } : {}),
      ...(tls !== undefined ? { tls } : {}),
      ...(advertiseHost !== undefined ? { advertiseHost } : {}),
      ...(tailnetHost !== undefined ? { tailnetHost } : {}),
      ...(sshTunnels !== undefined ? { sshTunnels } : {}),
      ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
      ...(webAppUrl !== undefined ? { webAppUrl } : {}),
    }
    // Reuse the production listener and origin checks, including required TLS.
    parseDaemonEnvironment(serviceEnvironment(config), config.homeDirectory)
    if (wsl) {
      if (!registrationId || !posix.isAbsolute(config.homeDirectory)) throw new Error("Invalid WSL registration")
      installedWslTask(wsl, registrationId, serviceConfigurationPath(config.homeDirectory, "linux"))
    }
    return config
  } catch (error) {
    // No parser diagnostics that could echo unexpected secret-bearing fields. A
    // setting the daemon refuses keeps its type, without its message or cause.
    const message = "Invalid service configuration. Reinstall with valid non-secret daemon settings."
    throw error instanceof DaemonConfigurationError ? new DaemonConfigurationError(message) : new Error(message)
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
    // The parser already replaced any refused value with a fixed message.
    const message = `Could not load service configuration at ${path}. Reinstall the service before restarting.`
    throw error instanceof DaemonConfigurationError
      ? new DaemonConfigurationError(message, { cause: error })
      : new Error(message, { cause: error })
  } finally {
    deadline.clear()
  }
}
