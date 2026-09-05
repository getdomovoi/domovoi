import type { DistroEndpoint } from "./wsl-endpoint.js"
import type { OpenTarget } from "./wsl-open-target.js"

export type OpenConnection = {
  host: string
  port: number
  token: string
  tls?: boolean
}

export type OpenConnectionDependencies = {
  local: () => Promise<OpenConnection>
  endpoint: (distribution: string) => Promise<DistroEndpoint | undefined>
}

// Work inside a distribution belongs to the daemon running there, and that
// daemon has its own credential. This machine's credential is never read for
// it, let alone sent, and a distribution with no daemon is named plainly
// without repeating anything the endpoint file carried.
export async function connectionForTarget(
  target: OpenTarget,
  dependencies: OpenConnectionDependencies,
): Promise<OpenConnection> {
  if (target.kind === "windows") return await dependencies.local()

  const endpoint = await dependencies.endpoint(target.distribution)
  if (!endpoint) {
    throw new Error(
      `no daemon is running in ${target.distribution}. Start one with "wsl.exe -d ${target.distribution} -- domovoid" and try again.`,
    )
  }
  // A distro daemon is reached over loopback, which readDistroEndpoint has
  // already insisted on, so there is no tls listener to carry here.
  return { host: endpoint.host, port: endpoint.port, token: endpoint.token }
}
