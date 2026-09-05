import { fleetSnapshotSchema, type FleetEntry } from "@getdomovoi/protocol"

import { fleetProblem } from "./fleet-problem"

export type FleetCall = (method: string, params: unknown) => Promise<unknown>

export type FleetSink = {
  setFleet: (fleet: FleetEntry[] | undefined) => void
  setLoading: (loading: boolean) => void
  setProblem: (problem: string) => void
}

// Reopening the tab while an earlier list is still out starts a second request
// on the same connection, and the two can answer in either order. Only the
// newest request may write, so an older answer that arrives late, whatever it
// says, changes nothing. A disconnect, a new daemon and an unmount each retire
// every request that is out, because an answer from before any of them
// describes a connection that no longer exists.
export function fleetLoader(sink: FleetSink) {
  let generation = 0
  return {
    async load(call: FleetCall): Promise<void> {
      generation += 1
      const mine = generation
      const current = () => mine === generation
      sink.setLoading(true)
      sink.setProblem("")
      try {
        // fleet.list takes no parameters; the daemon knows the client from hello.
        const result = await call("fleet.list", {})
        if (!current()) return
        sink.setFleet(fleetSnapshotSchema.parse(result).entries)
      } catch (cause) {
        if (!current()) return
        // A withheld list is not an empty one, so what was read before is dropped
        // rather than left up beside a notice that says the daemon returned nothing.
        sink.setFleet(undefined)
        sink.setProblem(fleetProblem(cause))
      } finally {
        if (current()) sink.setLoading(false)
      }
    },
    invalidate(): void {
      generation += 1
    },
  }
}
