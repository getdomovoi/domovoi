import type { ClientKind, TransportCandidate } from "@getdomovoi/protocol"

import { DomovoiClient } from "./client.js"
import { dialTransport } from "./transport-dial.js"

type MachineClientOptions = {
  reconnectDelayMs?: number
  requestTimeoutMs?: number
  clientId?: string
}

type ClientFactory = (
  url: string,
  kind: ClientKind,
  options: MachineClientOptions & { authToken: string },
) => DomovoiClient

export type ConnectedMachineClient = {
  client: DomovoiClient
  transport: TransportCandidate
}

export async function connectMachineClient(input: {
  candidates: TransportCandidate[]
  credential: string
  kind: ClientKind
  options?: MachineClientOptions
  relayAvailable?: boolean
  createClient?: ClientFactory
}): Promise<ConnectedMachineClient> {
  const createClient: ClientFactory = input.createClient
    ?? ((url, kind, options) => new DomovoiClient(url, kind, options))

  const dialed = await dialTransport<DomovoiClient>({
    candidates: input.candidates,
    credential: input.credential,
    ...(input.relayAvailable === undefined ? {} : { relayAvailable: input.relayAvailable }),
    connect: async ({ endpoint, credential }) => {
      const client = createClient(endpoint, input.kind, {
        ...input.options,
        authToken: credential,
      })
      try {
        await client.connect()
      } catch (error) {
        // A half-open socket to a machine that refused us is still a socket, so
        // it is closed before the next candidate is tried.
        client.disconnect()
        throw error
      }
      return client
    },
  })

  return { client: dialed.connection, transport: dialed.transport }
}
