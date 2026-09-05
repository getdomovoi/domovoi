import { assertDistributionName } from "./wsl-git.js"
import { runWslText, withWslDeadline, wslTimeoutMs, type WslRunner } from "./wsl-run.js"

export type DistroEndpoint = {
  host: string
  port: number
  token: string
}

export type DistroEndpointInput = {
  distribution: string
  run?: WslRunner<string>
  timeoutMs?: number
}

const endpointFile = ".domovoi/endpoint.json"

// Only one failure means there is no daemon in the distribution: the file is
// not there. An unreachable distribution, a denied read, or a wsl.exe that is
// not installed are all reported, because none of them is an answer.
function isMissingEndpointStderr(stderr: string): boolean {
  return stderr.includes(endpointFile) && /No such file or directory/i.test(stderr)
}
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])

function isMissingEndpointFile(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === "string" && isMissingEndpointStderr(stderr)
}

// The endpoint file carries the distro daemon's credential, so nothing read out
// of it is ever repeated in an error. The host is checked first: a credential
// belongs on loopback inside this machine and nowhere else.
function readEndpoint(document: unknown): DistroEndpoint {
  const record = document as Record<string, unknown>
  const host = record["host"]
  if (typeof host !== "string" || !loopbackHosts.has(host)) {
    throw new Error("the distribution's endpoint is not on loopback, so no credential is sent to it")
  }

  const port = record["port"]
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("the distribution's endpoint names no port to connect to")
  }

  const token = record["token"]
  if (typeof token !== "string" || token === "") {
    throw new Error("the distribution's endpoint carries no credential to authenticate with")
  }

  return { host, port, token }
}

// The file is read by asking the distribution to read it, never by opening it
// through the wsl share, which is the rule the rest of this work follows.
export async function readDistroEndpoint(
  input: DistroEndpointInput,
): Promise<DistroEndpoint | undefined> {
  assertDistributionName(input.distribution)
  const run = input.run ?? runWslText
  const timeoutMs = wslTimeoutMs(input.timeoutMs)
  let contents: string
  try {
    contents = await withWslDeadline(
      run("wsl.exe", [
        "-d",
        input.distribution,
        "--cd",
        "~",
        "--",
        "cat",
        endpointFile,
      ], { timeoutMs }),
      timeoutMs,
    )
  } catch (error) {
    // A distribution with no daemon has no endpoint file, which is an answer
    // rather than a failure. Everything else is a failure and is reported.
    if (isMissingEndpointFile(error)) return undefined
    throw error
  }

  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch {
    return undefined
  }
  if (typeof document !== "object" || document === null) return undefined

  return readEndpoint(document)
}
