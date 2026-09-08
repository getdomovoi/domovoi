import type { ClientKind } from "@getdomovoi/protocol"

import { daemonSessionFrom, isDaemonCredential, type DaemonSession } from "./credential"

export type PairingClient = {
  connect(): Promise<unknown>
  request(method: "device.pair", params: { label: string; client: ClientKind }): Promise<unknown>
  disconnect(): void
}

export type PairingClientFactory = (input: {
  url: string
  client: ClientKind
  bearer: string
}) => PairingClient

export const daemonCredentialShapeMessage =
  "A daemon credential is one 43 character line. Copy the whole line from ~/.domovoi/daemon.token on the execution machine."

// The pasted credential is the daemon's root bearer: it authenticates every
// client and cannot be withdrawn on its own. It is spent once, here, to enrol
// this browser as its own paired device, and only that device credential is
// handed back for the tab to keep.
export async function pairBrowserDevice(input: {
  url: string
  client: ClientKind
  bearer: string
  label: string
  createClient: PairingClientFactory
}): Promise<DaemonSession> {
  if (!isDaemonCredential(input.bearer)) throw new Error(daemonCredentialShapeMessage)
  const client = input.createClient({ url: input.url, client: input.client, bearer: input.bearer })
  try {
    await client.connect()
    return daemonSessionFrom(
      await client.request("device.pair", { label: input.label, client: input.client }),
    )
  } finally {
    client.disconnect()
  }
}
