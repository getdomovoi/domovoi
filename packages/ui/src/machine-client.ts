import type { ClientKind, TransportCandidate } from "@getdomovoi/protocol"

import { DomovoiClient, type DomovoiClientBudgets } from "./client.js"
import { DeadlineExceededError, describeTarget, type Deadline } from "./deadline.js"
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
// candidates share one deadline. Each route gets an equal share of the time
// remaining for the eligible routes still to try, covering open and hello.
// Fast failures leave more for later routes; a silent one cannot take it all.
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
    connect: async ({ endpoint, credential, remainingCandidates }) => {
      const remaining = input.deadline.remainingMs()
      if (remaining === 0) {
        throw new DeadlineExceededError("route setup", describeTarget(endpoint), input.deadline.budgetMs)
      }
      const attempt = input.deadline.limit(Math.max(1, remaining / remainingCandidates))
      let client: DomovoiClient | undefined
      try {
        if (attempt.remainingMs() === 0) {
          throw new DeadlineExceededError("route setup", describeTarget(endpoint), attempt.budgetMs)
        }
        client = createClient(endpoint, input.kind, {
          ...input.options,
          budgets: input.budgets,
          authToken: credential,
        })
        await client.connect(attempt)
        // A busy event loop can settle hello before running an expired timer.
        if (attempt.remainingMs() === 0) {
          throw new DeadlineExceededError("route setup", describeTarget(endpoint), attempt.budgetMs)
        }
        return client
      } catch (error) {
        // A half-open socket to a machine that refused us is still a socket, so
        // it is closed before the next candidate is tried.
        client?.disconnect()
        throw error
      } finally {
        attempt.clear()
      }
    },
  })

  return { client: dialed.connection, transport: dialed.transport }
}
