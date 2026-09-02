import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type PublishEndpointInput = {
  home: string
  host: string
  port: number
  token: string
}

export type PublishedEndpoint = {
  host: string
  port: number
  token: string
}

const directoryName = ".domovoi"
const fileName = "endpoint.json"
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])

export function endpointFilePath(home: string): string {
  return join(home, directoryName, fileName)
}

// The endpoint file exists so a daemon on the other side of the WSL boundary can
// be found without reading anything across the share. It carries this daemon's
// credential, so it is only ever written for a loopback listener, only ever
// readable by the user who owns it, and nothing in it is repeated in an error.
export async function publishEndpointFile(input: PublishEndpointInput): Promise<string> {
  if (!loopbackHosts.has(input.host)) {
    throw new Error("an endpoint is published only for a loopback listener, so no credential leaves the machine")
  }
  if (input.token === "") {
    throw new Error("an endpoint with no credential would authenticate nothing")
  }

  const directory = join(input.home, directoryName)
  await mkdir(directory, { recursive: true })
  if (process.platform !== "win32") await chmod(directory, 0o700)

  // A reader on the other side of the boundary runs `cat`, which would happily
  // read a file mid-write. The endpoint is written beside its destination and
  // renamed over it, so a reader sees one whole endpoint or the other.
  const path = endpointFilePath(input.home)
  const staging = `${path}.${process.pid}.partial`
  const document = { host: input.host, port: input.port, token: input.token }
  try {
    await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== "win32") await chmod(staging, 0o600)
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
  return path
}

// A stopped daemon is not reachable, so its endpoint should not be advertised.
// Only the endpoint this daemon published is removed: with nothing published
// there is nothing to take away, and a file holding someone else's endpoint is
// left exactly where it is.
export async function removeEndpointFile(
  home: string,
  published?: PublishedEndpoint,
): Promise<void> {
  if (!published) return

  const path = endpointFilePath(home)
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch {
    return
  }

  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch {
    return
  }
  if (typeof document !== "object" || document === null) return

  const record = document as Record<string, unknown>
  if (
    record["host"] !== published.host
    || record["port"] !== published.port
    || record["token"] !== published.token
  ) return

  await rm(path, { force: true })
}
