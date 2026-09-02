import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { assertDistributionName } from "./wsl-git.js"

export type DistroEndpoint = {
  host: string
  port: number
  token: string
}

export type DistroEndpointInput = {
  distribution: string
  run?: (command: string, args: readonly string[]) => Promise<string>
}

const execute = promisify(execFile)
const endpointFile = ".domovoi/endpoint.json"
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])

async function readThroughWsl(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execute(command, [...args], { encoding: "utf8" })
  return stdout
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
  const run = input.run ?? readThroughWsl

  let contents: string
  try {
    contents = await run("wsl.exe", [
      "-d",
      input.distribution,
      "--cd",
      "~",
      "--",
      "cat",
      endpointFile,
    ])
  } catch {
    // A distribution with no daemon has no endpoint file, which is an answer
    // rather than a failure.
    return undefined
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
