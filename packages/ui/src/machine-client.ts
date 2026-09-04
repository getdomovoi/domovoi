import type { ClientKind, TransportCandidate } from "@getdomovoi/protocol"

import { DomovoiClient, type DomovoiClientBudgets } from "./client.js"
import type { Deadline } from "./deadline.js"
import { dialTransport } from "./transport-dial.js"

type MachineClientOptions = {
  reconnectDelayMs?: number
  clientId?: string
}

type ClientFactory = (
  url: string,
  kind: ClientKind,
  options: MachineClientOptions & { authToken: string; budgets: DomovoiClientBudgets },
) => DomovoiClient

export type ConnectedMachineClient = {
  client: DomovoiClient
  transport: TransportCandidate
}

// Dialing several transports is one connection from the caller's side, so the
// candidates share one deadline: a slow first route leaves the next only what
// remains, and once it has run out no further route is tried.
export async function connectMachineClient(input: {
  candidates: TransportCandidate[]
  credential: string
  kind: ClientKind
  budgets: DomovoiClientBudgets
  deadline: Deadline
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
      if (input.deadline.expired) throw new Error("The connection deadline has passed")
      const client = createClient(endpoint, input.kind, {
        ...input.options,
        budgets: input.budgets,
        authToken: credential,
      })
      try {
        await client.connect(input.deadline)
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
