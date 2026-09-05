import { join } from "node:path"

import { credentialSchema } from "@getdomovoi/protocol"

export type DaemonEnvironment = Readonly<Record<string, string | undefined>>

export type DaemonTlsMaterial = {
  certPath: string
  keyPath: string
}

export type DaemonEnvironmentConfig = {
  host: string
  port: number
  tls?: DaemonTlsMaterial
  advertiseHost?: string
  credentialPath: string
  machineIdentityPath: string
  authToken?: string
  allowedOrigins?: string[]
  allowRemoteTransport: boolean
}

export class DaemonConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DaemonConfigurationError"
  }
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])

export function parseDaemonEnvironment(
  environment: DaemonEnvironment,
  homeDirectory: string,
): DaemonEnvironmentConfig {
  const host = parseHost(environment.DOMOVOI_HOST)
  const port = parsePort(environment.DOMOVOI_PORT)
  const allowRemoteTransport = parseRemoteTransport(environment.DOMOVOI_ALLOW_REMOTE_TRANSPORT)
  if (!loopbackHosts.has(host) && !allowRemoteTransport) {
    throw new DaemonConfigurationError(
      "Non-loopback DOMOVOI_HOST requires DOMOVOI_ALLOW_REMOTE_TRANSPORT=1",
    )
  }

  const tls = parseTlsMaterial(environment)
  // A listener that leaves this machine must be encrypted. Loopback may stay
  // plaintext because nothing it carries reaches a network.
  if (!loopbackHosts.has(host) && !tls) {
    throw new DaemonConfigurationError(
      `Non-loopback DOMOVOI_HOST requires TLS for ${host}: set DOMOVOI_TLS_CERT_PATH and DOMOVOI_TLS_KEY_PATH`,
    )
  }

  const credentialPath = parseCredentialPath(
    environment.DOMOVOI_CREDENTIAL_PATH,
    homeDirectory,
  )
  const machineIdentityPath = parseStatePath(
    environment.DOMOVOI_MACHINE_IDENTITY_PATH,
    "DOMOVOI_MACHINE_IDENTITY_PATH",
    join(homeDirectory, ".domovoi", "machine.json"),
  )
  const advertiseHost = environment.DOMOVOI_ADVERTISE_HOST === undefined
    ? undefined
    : parseStatePath(environment.DOMOVOI_ADVERTISE_HOST, "DOMOVOI_ADVERTISE_HOST", "")
  const authToken = parseAuthToken(environment.DOMOVOI_AUTH_TOKEN)
  const allowedOrigins = parseAllowedOrigins(environment.DOMOVOI_ALLOWED_ORIGINS)

  return {
    host,
    port,
    ...(tls ? { tls } : {}),
    ...(advertiseHost ? { advertiseHost } : {}),
    credentialPath,
    machineIdentityPath,
    ...(authToken !== undefined ? { authToken } : {}),
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    allowRemoteTransport,
  }
}

function parseHost(value: string | undefined): string {
  if (value === undefined) return "127.0.0.1"
  if (!value || value.trim() !== value || /[\s/]/u.test(value)) {
    throw new DaemonConfigurationError("DOMOVOI_HOST must be a non-empty host name or address")
  }
  return value
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 47831
  if (value === "0") return 0
  if (!/^[1-9]\d{0,4}$/u.test(value)) {
    throw new DaemonConfigurationError("DOMOVOI_PORT must be an integer from 0 through 65535")
  }
  const port = Number(value)
  if (port > 65_535) {
    throw new DaemonConfigurationError("DOMOVOI_PORT must be an integer from 0 through 65535")
  }
  return port
}

function parseRemoteTransport(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false
  if (value === "1") return true
  throw new DaemonConfigurationError("DOMOVOI_ALLOW_REMOTE_TRANSPORT must be 0 or 1")
}

function parseTlsMaterial(
  environment: DaemonEnvironment,
): DaemonTlsMaterial | undefined {
  const certPath = environment.DOMOVOI_TLS_CERT_PATH
  const keyPath = environment.DOMOVOI_TLS_KEY_PATH
  if (certPath === undefined && keyPath === undefined) return undefined
  if (certPath === undefined || keyPath === undefined) {
    throw new DaemonConfigurationError(
      "DOMOVOI_TLS_CERT_PATH and DOMOVOI_TLS_KEY_PATH must be set together",
    )
  }
  return {
    certPath: parseStatePath(certPath, "DOMOVOI_TLS_CERT_PATH", ""),
    keyPath: parseStatePath(keyPath, "DOMOVOI_TLS_KEY_PATH", ""),
  }
}

function parseCredentialPath(value: string | undefined, homeDirectory: string): string {
  return parseStatePath(
    value,
    "DOMOVOI_CREDENTIAL_PATH",
    join(homeDirectory, ".domovoi", "daemon.token"),
  )
}

function parseStatePath(
  value: string | undefined,
  variable: string,
  fallback: string,
): string {
  if (value === undefined) return fallback
  const path = value.trim()
  if (!path) {
    throw new DaemonConfigurationError(`${variable} cannot be empty`)
  }
  return path
}

function parseAuthToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!credentialSchema.safeParse(value).success) {
    throw new DaemonConfigurationError(
      "DOMOVOI_AUTH_TOKEN must be a 43-character base64url credential",
    )
  }
  return value
}

function parseAllowedOrigins(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const candidates = value.split(",").map((origin) => origin.trim())
  if (candidates.some((origin) => !origin)) {
    throw new DaemonConfigurationError("DOMOVOI_ALLOWED_ORIGINS contains an empty origin")
  }
  const origins = candidates.map(normalizeOrigin)
  return [...new Set(origins)]
}

function normalizeOrigin(value: string): string {
  if (value === "file://") return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DaemonConfigurationError("DOMOVOI_ALLOWED_ORIGINS contains an invalid origin")
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new DaemonConfigurationError("DOMOVOI_ALLOWED_ORIGINS contains an invalid origin")
  }
  return url.origin
}
