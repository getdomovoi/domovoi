import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])

function loopbackUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error("The real-daemon development URL is not a valid WebSocket URL")
  }
  if (url.protocol !== "ws:" || url.username || url.password || !loopbackHosts.has(url.hostname)) {
    throw new Error("The real-daemon development URL must be an unauthenticated loopback ws:// URL")
  }
  return url.href
}

function discoveredUrl(document) {
  let endpoint
  try {
    endpoint = JSON.parse(document)
  } catch {
    throw new Error("~/.domovoi/endpoint.json is not valid JSON")
  }
  const host = endpoint && typeof endpoint === "object" ? endpoint.host : undefined
  const port = endpoint && typeof endpoint === "object" ? endpoint.port : undefined
  if (typeof host !== "string" || !loopbackHosts.has(host === "::1" ? "[::1]" : host)) {
    throw new Error("~/.domovoi/endpoint.json does not name a loopback daemon")
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("~/.domovoi/endpoint.json does not name a valid daemon port")
  }
  const urlHost = host === "::1" ? "[::1]" : host
  return `ws://${urlHost}:${port}/rpc`
}

export function realDevEndpoint({
  homeDirectory,
  environment,
  readFile = readFileSync,
}) {
  const configuredProfile = environment.DOMOVOI_PROFILE_DIR
  if (configuredProfile && !isAbsolute(configuredProfile)) {
    throw new Error("DOMOVOI_PROFILE_DIR must be absolute for the real-daemon development loop")
  }
  const profileDirectory = configuredProfile || join(homeDirectory, ".domovoi")
  const token = readFile(join(profileDirectory, "daemon.token"), "utf8").trim()
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("~/.domovoi/daemon.token is not a valid Domovoi daemon credential")
  }
  let endpointDocument
  if (!environment.DOMOVOI_DEV_DAEMON_URL) {
    const endpointPath = join(profileDirectory, "endpoint.json")
    try {
      endpointDocument = readFile(endpointPath, "utf8")
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(
          `No running daemon published ${endpointPath}. Start it in another terminal with `
          + "`pnpm --filter @getdomovoi/daemon start`, then rerun this command. "
          + "For a separate profile, set the same absolute DOMOVOI_PROFILE_DIR on both commands "
          + "and set DOMOVOI_PORT=0 when starting the daemon.",
        )
      }
      throw error
    }
  }
  const url = environment.DOMOVOI_DEV_DAEMON_URL
    ? loopbackUrl(environment.DOMOVOI_DEV_DAEMON_URL)
    : discoveredUrl(endpointDocument)
  return { url, token }
}
