import { randomUUID } from "node:crypto"
import type { FleetClientRouteResult } from "@getdomovoi/protocol"

export type DesktopFleetRoute = FleetClientRouteResult extends infer R
  ? R extends { outcome: "ready" } ? R & { ticket: string } : R : never

const deny = "default-src 'none'; connect-src 'none'"
const ticketLifetimeMs = 30_000
const maximumTickets = 128

function exactOrigin(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    if (url.username || url.password || /[\s*[\]]/u.test(url.host)) return undefined
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return undefined
    return url.origin
  } catch { return undefined }
}

// A ticket authorizes one worker response, not a renderer-authored URL. The
// worker gets only this origin in its own CSP; the main document is unchanged.
export class FleetOriginAdmission {
  readonly #tickets = new Map<string, { machineId: string; origin: string; expires: number }>()
  readonly #generation = new Map<string, { pending: number }>()
  #pending = 0

  constructor(
    private readonly verify: (machineId: string, budgetMs: number) => Promise<FleetClientRouteResult>,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(machineId: string, budgetMs: number): Promise<DesktopFleetRoute> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(machineId)) return { outcome: "refused", reason: "not-enrolled" }
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { outcome: "refused", reason: "route-timeout" }
    const budget = Math.min(budgetMs, 30_000)
    const expires = this.now() + budget
    if (this.#pending >= maximumTickets) {
      return { outcome: "refused", reason: "client-route-unavailable" }
    }
    const generation = this.#generation.get(machineId) ?? { pending: 0 }
    generation.pending += 1
    this.#pending += 1
    this.#generation.set(machineId, generation)
    try {
      let result: FleetClientRouteResult
      try { result = await this.verify(machineId, budget) }
      catch { return { outcome: "refused", reason: "client-route-unavailable" } }
      if (this.now() >= expires) return { outcome: "refused", reason: "route-timeout" }
      if (this.#generation.get(machineId) !== generation) return { outcome: "refused", reason: "not-enrolled" }
      if (result.outcome === "refused") return result
      if (result.machineId !== machineId) return { outcome: "refused", reason: "identity-mismatch" }
      const origin = exactOrigin(result.transport.endpoint)
      if (!origin) return { outcome: "refused", reason: "client-route-unavailable" }
      for (const [id, entry] of this.#tickets) if (entry.expires <= this.now()) this.#tickets.delete(id)
      if (this.#tickets.size >= maximumTickets) return { outcome: "refused", reason: "client-route-unavailable" }
      const ticket = randomUUID()
      this.#tickets.set(ticket, { machineId, origin, expires: this.now() + ticketLifetimeMs })
      return { ...result, ticket }
    } finally {
      this.#pending -= 1
      generation.pending -= 1
      // Records protect live checks only. A refusal cannot strand capacity,
      // and its cleanup cannot invalidate a sibling or a newer generation.
      if (generation.pending === 0 && this.#generation.get(machineId) === generation) this.#generation.delete(machineId)
    }
  }

  consume(ticket: string): string {
    const entry = this.#tickets.get(ticket)
    this.#tickets.delete(ticket)
    return entry && entry.expires > this.now() ? `default-src 'none'; connect-src ${entry.origin}` : deny
  }

  forget(machineId: string): void {
    this.#generation.delete(machineId)
    for (const [id, entry] of this.#tickets) if (entry.machineId === machineId) this.#tickets.delete(id)
  }

  clear(): void { this.#generation.clear(); this.#tickets.clear() }
}
