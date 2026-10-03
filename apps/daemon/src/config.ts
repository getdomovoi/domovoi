import { isIPv4, isIPv6 } from "node:net"
import { isAbsolute, join, posix, win32 } from "node:path"

import { credentialSchema, maximumWebAppUrlLength, webAppUrlSchema } from "@getdomovoi/protocol"
import { relayIdentityPublicKeyIsValid } from "@getdomovoi/protocol/relay-admission"

import { configuredSshTunnelsSchema, isLoopbackHost, maximumSshConfigurationBytes, tailnetHostSchema, type ConfiguredSshTunnel } from "./transport-config.js"
import { configuredProfileDirectory } from "./profile-directory.js"

export type DaemonEnvironment = Readonly<Record<string, string | undefined>>

export type DaemonTlsMaterial = {
  certPath: string
  keyPath: string
}

// TailnetReach (Q404 A): a second listener, TLS only, bound to this machine's
// Tailscale address beside the loopback one. It shares the loopback listener's
// port and every authentication rule of a non-loopback listener.
export type DaemonTailnetListener = {
  address: string
  tls: DaemonTlsMaterial
}

export type DaemonEnvironmentConfig = {
  profileDirectory?: string
  host: string
  port: number
  tls?: DaemonTlsMaterial
  tailnetListener?: DaemonTailnetListener
  advertiseHost?: string
  tailnetHost?: string
  sshTunnels?: ConfiguredSshTunnel[]
  credentialPath: string
  machineIdentityPath: string
  relayIdentityPublicKey?: string
  relayCredentialFile?: string
  authToken?: string
  allowedOrigins?: string[]
  webAppUrl?: string
  allowRemoteTransport: boolean
}

export class DaemonConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DaemonConfigurationError"
  }
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])

export function parseDaemonEnvironment(
  environment: DaemonEnvironment,
  homeDirectory: string,
): DaemonEnvironmentConfig {
  const profileDirectory = configuredProfileDirectory(environment.DOMOVOI_PROFILE_DIR, homeDirectory)
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
    profileDirectory,
  )
  const machineIdentityPath = parseStatePath(
    environment.DOMOVOI_MACHINE_IDENTITY_PATH,
    "DOMOVOI_MACHINE_IDENTITY_PATH",
    join(profileDirectory, "machine.json"),
  )
  const advertiseHost = environment.DOMOVOI_ADVERTISE_HOST === undefined
    ? undefined
    : parseStatePath(environment.DOMOVOI_ADVERTISE_HOST, "DOMOVOI_ADVERTISE_HOST", "")
  const authToken = parseAuthToken(environment.DOMOVOI_AUTH_TOKEN)
  const allowedOrigins = parseAllowedOrigins(environment.DOMOVOI_ALLOWED_ORIGINS)
  const webAppUrl = parseWebAppUrl(environment.DOMOVOI_WEB_APP_URL)
  const tailnetListener = parseTailnetListener(environment, host, allowRemoteTransport)
  const tailnetHost = environment.DOMOVOI_TAILNET_HOST
  // The name is advertised for an encrypted listener off this machine: the
  // main one, or the tailnet listener beside a loopback one.
  if (tailnetHost !== undefined && (!tailnetHostSchema.safeParse(tailnetHost).success
    || (!tailnetListener && (!tls || isLoopbackHost(host))))) {
    throw new DaemonConfigurationError("DOMOVOI_TAILNET_HOST requires a routable host without a port or URL components and a non-loopback TLS listener")
  }
  const sshTunnels = parseSshTunnels(environment.DOMOVOI_SSH_TUNNELS)
  const relayIdentityPublicKey = environment.DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY
  if (relayIdentityPublicKey !== undefined && !relayIdentityPublicKeyIsValid(relayIdentityPublicKey)) {
    throw new DaemonConfigurationError("DOMOVOI_RELAY_IDENTITY_PUBLIC_KEY must be a canonical base64url Ed25519 public key from an off-machine signer")
  }
  const relayCredentialFile = environment.DOMOVOI_RELAY_CREDENTIAL_FILE
  if (relayCredentialFile !== undefined && (relayCredentialFile.length > 4_096 || !isAbsolute(relayCredentialFile) || /[\0\r\n]/u.test(relayCredentialFile))) {
    throw new DaemonConfigurationError("DOMOVOI_RELAY_CREDENTIAL_FILE must be an explicit absolute file path")
  }

  return {
    profileDirectory,
    host,
    port,
    ...(tls ? { tls } : {}),
    ...(tailnetListener ? { tailnetListener } : {}),
    ...(advertiseHost ? { advertiseHost } : {}),
    ...(tailnetHost !== undefined ? { tailnetHost } : {}),
    ...(sshTunnels !== undefined ? { sshTunnels } : {}),
    credentialPath,
    machineIdentityPath,
    ...(relayIdentityPublicKey !== undefined ? { relayIdentityPublicKey } : {}),
    ...(relayCredentialFile !== undefined ? { relayCredentialFile } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    ...(webAppUrl !== undefined ? { webAppUrl } : {}),
    allowRemoteTransport,
  }
}

function parseSshTunnels(value: string | undefined): ConfiguredSshTunnel[] | undefined {
  if (value === undefined) return undefined
  try {
    if (Buffer.byteLength(value, "utf8") > maximumSshConfigurationBytes) throw new Error("oversized")
    return configuredSshTunnelsSchema.parse(JSON.parse(value))
  } catch {
    // Do not echo malformed URLs, which might contain credentials.
    throw new DaemonConfigurationError("DOMOVOI_SSH_TUNNELS must be at most 32 KiB of JSON with up to 128 unique {machineId, endpoint} entries using credential-free loopback WebSocket endpoints")
  }
}

function parseWebAppUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // The value is not echoed: a mistyped URL can carry credentials.
  if (!webAppUrlSchema.safeParse(value).success) {
    throw new DaemonConfigurationError(`DOMOVOI_WEB_APP_URL must be an absolute http or https URL without whitespace, control characters, credentials or a fragment, at most ${maximumWebAppUrlLength} characters`)
  }
  return value
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

const tailnetVariables = "DOMOVOI_TAILNET_ADDRESS, DOMOVOI_TAILNET_TLS_CERT_PATH and DOMOVOI_TAILNET_TLS_KEY_PATH"

function parseTailnetListener(
  environment: DaemonEnvironment,
  host: string,
  allowRemoteTransport: boolean,
): DaemonTailnetListener | undefined {
  const address = environment.DOMOVOI_TAILNET_ADDRESS
  const certPath = environment.DOMOVOI_TAILNET_TLS_CERT_PATH
  const keyPath = environment.DOMOVOI_TAILNET_TLS_KEY_PATH
  if (address === undefined && certPath === undefined && keyPath === undefined) return undefined
  if (address === undefined || certPath === undefined || keyPath === undefined) {
    throw new DaemonConfigurationError(`${tailnetVariables} must be set together`)
  }
  if (!isTailscaleAddress(address)) {
    throw new DaemonConfigurationError("DOMOVOI_TAILNET_ADDRESS must be this machine's Tailscale address: an IPv4 address in 100.64.0.0/10 or an IPv6 address in fd7a:115c:a1e0::/48, with no port or brackets")
  }
  // Either platform's form: a saved service configuration is checked on the
  // machine that reads it, which may not be the one it runs on.
  if (![certPath, keyPath].every((path) => path.length <= 4_096 && (posix.isAbsolute(path) || win32.isAbsolute(path))
    && path.trim() === path && !/[\0\r\n]/u.test(path))) {
    throw new DaemonConfigurationError("DOMOVOI_TAILNET_TLS_CERT_PATH and DOMOVOI_TAILNET_TLS_KEY_PATH must be absolute file paths")
  }
  // The same opt-in every listener that leaves this machine needs.
  if (!allowRemoteTransport) {
    throw new DaemonConfigurationError("DOMOVOI_TAILNET_ADDRESS requires DOMOVOI_ALLOW_REMOTE_TRANSPORT=1")
  }
  if (!loopbackHosts.has(host)) {
    throw new DaemonConfigurationError("DOMOVOI_TAILNET_ADDRESS adds a listener beside a loopback DOMOVOI_HOST; unset it, or set DOMOVOI_HOST to 127.0.0.1")
  }
  return { address, tls: { certPath, keyPath } }
}

// Tailscale assigns each node one address from 100.64.0.0/10 and one from
// fd7a:115c:a1e0::/48. Only those are accepted, so a mistyped setting cannot
// put the listener on a LAN or public address.
function isTailscaleAddress(address: string): boolean {
  if (isIPv4(address)) {
    const [first, second] = address.split(".").map(Number)
    return first === 100 && second !== undefined && second >= 64 && second <= 127
  }
  if (!isIPv6(address)) return false
  const groups = expandIPv6(address)
  return groups !== undefined && groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0
}

function expandIPv6(address: string): number[] | undefined {
  if (address.includes(".") || address.includes("%")) return undefined
  const [head = "", tail] = address.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined
  return [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right].map((group) => Number.parseInt(group, 16))
}

function parseCredentialPath(value: string | undefined, homeDirectory: string, profile = join(homeDirectory, ".domovoi")): string {
  return parseStatePath(
    value,
    "DOMOVOI_CREDENTIAL_PATH",
    join(profile, "daemon.token"),
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
  if (value === "file://" || value === "domovoi-app://desktop") return value
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
