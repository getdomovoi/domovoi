import type { WslDistribution } from "./wsl-distributions.js"
import { readDistroEndpoint, type DistroEndpoint } from "./wsl-endpoint.js"
import { listWslDistributions } from "./wsl-list.js"
import { WslError, type WslFailureKind } from "./wsl-run.js"

export type WslDaemonPresence = "present" | "absent" | "unknown"

export type WslMachineFact = {
  distribution: string
  version: number
  state: "running" | "stopped"
  default: boolean
  daemon: WslDaemonPresence
  endpoint?: string
  failure?: WslFailureKind
}

export type WslDiscoveryInput = {
  platform?: NodeJS.Platform
  distributions?: () => Promise<readonly WslDistribution[]>
  endpoint?: (distribution: string) => Promise<DistroEndpoint | undefined>
}

// WSL 2 forwards a distribution's loopback listener to the Windows loopback,
// so the endpoint a Windows dialer uses is the same port on this machine.
// The credential the endpoint file carries is not part of the fact.
export function wslDaemonEndpointUrl(endpoint: { host: string; port: number }): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host
  return `ws://${host}:${endpoint.port}/rpc`
}

async function daemonInside(
  distribution: WslDistribution,
  endpoint: NonNullable<WslDiscoveryInput["endpoint"]>,
): Promise<Pick<WslMachineFact, "daemon" | "endpoint" | "failure">> {
  // A stopped distribution runs nothing, so it has no daemon, and asking it
  // would start it on the strength of a listing.
  if (distribution.state === "Stopped") return { daemon: "absent" }
  try {
    const published = await endpoint(distribution.name)
    return published
      ? { daemon: "present", endpoint: wslDaemonEndpointUrl(published) }
      : { daemon: "absent" }
  } catch (error) {
    // Not answering is not the same as answering that there is no daemon,
    // and why it did not answer is kept, since each reason has its own remedy.
    return { daemon: "unknown", failure: error instanceof WslError ? error.kind : "unavailable" }
  }
}

// The listing is not caught here: a wsl.exe that could not list anything is
// reported as what it was, not as a machine with no distribution.
export async function discoverWslMachines(input: WslDiscoveryInput = {}): Promise<WslMachineFact[]> {
  const platform = input.platform ?? process.platform
  if (platform !== "win32") return []

  const distributions = await (input.distributions ?? listWslDistributions)()
  const endpoint = input.endpoint ?? ((distribution: string) => readDistroEndpoint({ distribution }))
  // Each running distribution is asked at once, so the deadlines run together
  // rather than one after another.
  return Promise.all(distributions.map(async (distribution) => ({
    distribution: distribution.name,
    version: distribution.version,
    state: distribution.state === "Running" ? "running" as const : "stopped" as const,
    default: distribution.default,
    ...await daemonInside(distribution, endpoint),
  })))
}
