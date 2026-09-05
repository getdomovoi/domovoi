import { fleetSnapshotSchema, type FleetEntry } from "@getdomovoi/protocol"

import { fleetProblem } from "./fleet-problem"

export type FleetCall = (method: string, params: unknown) => Promise<unknown>

export type FleetSink = {
  setFleet: (fleet: FleetEntry[] | undefined) => void
  setLoading: (loading: boolean) => void
  setProblem: (problem: string) => void
}

export function fleetLoader(sink: FleetSink) {
  return {
    async load(call: FleetCall): Promise<void> {
      sink.setLoading(true)
      sink.setProblem("")
      try {
        // fleet.list takes no parameters; the daemon knows the client from hello.
        const result = await call("fleet.list", {})
        sink.setFleet(fleetSnapshotSchema.parse(result).entries)
      } catch (cause) {
        // A withheld list is not an empty one, so what was read before is dropped
        // rather than left up beside a notice that says the daemon returned nothing.
        sink.setFleet(undefined)
        sink.setProblem(fleetProblem(cause))
      } finally {
        sink.setLoading(false)
      }
    },
  }
}
