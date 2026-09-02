import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type PublishEndpointInput = {
  home: string
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

  const path = endpointFilePath(input.home)
  const document = { host: input.host, port: input.port, token: input.token }
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== "win32") await chmod(path, 0o600)
  return path
}

// A stopped daemon is not reachable, so its endpoint should not be advertised.
// A file this daemon did not write is left where it is rather than removed on
// the strength of its name.
export async function removeEndpointFile(home: string): Promise<void> {
  const path = endpointFilePath(home)
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch {
    return
  }

  try {
    const document: unknown = JSON.parse(contents)
    if (typeof document !== "object" || document === null) return
    const record = document as Record<string, unknown>
    if (typeof record["host"] !== "string" || typeof record["port"] !== "number") return
  } catch {
    return
  }
  await rm(path, { force: true })
}
