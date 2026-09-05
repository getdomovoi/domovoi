import {
  assertDistributionName,
  classifyWslFailure,
  firstSaid,
  runWslText,
  withWslDeadline,
  WslError,
  wslSeconds,
  wslTimeoutMs,
  type WslCallFailure,
  type WslRunner,
} from "./wsl-run.js"

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

// Only stderr is read for the reason: stdout is the file, and the file is a
// credential.
function readFailure(distribution: string, failure: WslCallFailure, timeoutMs: number): WslError {
  switch (failure.kind) {
    case "absent":
      return new WslError(
        "absent",
        `WSL is not installed on this machine (${failure.detail}), so nothing inside ${distribution} can be asked.`,
      )
    case "denied":
      return new WslError(
        "denied",
        `${distribution} would not read its endpoint file: ${failure.detail}. Check who owns ~/${endpointFile} inside ${distribution} and try again.`,
      )
    case "timed-out":
      return new WslError(
        "timed-out",
        `wsl.exe did not answer within ${wslSeconds(timeoutMs)} when asked to read the endpoint file in ${distribution}, so whether a daemon runs there is unknown. Check "wsl.exe --status" and try again.`,
      )
    case "unavailable":
      return new WslError(
        "unavailable",
        `${distribution} could not be asked for its endpoint file: ${failure.detail}. Check that "wsl.exe -d ${distribution}" starts and try again.`,
      )
  }
}

// A file that is not an endpoint is not a missing daemon: a daemon may well be
// running behind a file that was cut short. Nothing read from it is repeated.
function corruptEndpoint(distribution: string): WslError {
  return new WslError(
    "corrupt",
    `the endpoint file in ${distribution} is not one a daemon published, so whether a daemon runs there is unknown. Restart domovoid inside ${distribution} so it publishes a fresh one.`,
  )
}

// The endpoint file carries the distro daemon's credential, so nothing read out
// of it is ever repeated in an error. The host is checked first: a credential
// belongs on loopback inside this machine and nowhere else.
function readEndpoint(document: Record<string, unknown>): DistroEndpoint {
  const host = document["host"]
  if (typeof host !== "string" || !loopbackHosts.has(host)) {
    throw new WslError("corrupt", "the distribution's endpoint is not on loopback, so no credential is sent to it")
  }

  const port = document["port"]
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new WslError("corrupt", "the distribution's endpoint names no port to connect to")
  }

  const token = document["token"]
  if (typeof token !== "string" || token === "") {
    throw new WslError("corrupt", "the distribution's endpoint carries no credential to authenticate with")
  }

  return { host, port, token }
}

// The file is read by asking the distribution to read it, never by opening it
// through the wsl share, which is the rule the rest of this work follows.
export async function readDistroEndpoint(
  input: DistroEndpointInput,
): Promise<DistroEndpoint | undefined> {
  const distribution = assertDistributionName(input.distribution)
  const run = input.run ?? runWslText
  const timeoutMs = wslTimeoutMs(input.timeoutMs)
  let contents: string
  try {
    contents = await withWslDeadline(
      run("wsl.exe", [
        "-d",
        distribution,
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
    const failure = error as { stderr?: unknown }
    throw readFailure(distribution, classifyWslFailure(error, firstSaid(failure.stderr)), timeoutMs)
  }

  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch {
    throw corruptEndpoint(distribution)
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw corruptEndpoint(distribution)
  }

  return readEndpoint(document as Record<string, unknown>)
}
