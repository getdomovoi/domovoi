import { fleetSnapshotSchema, type FleetEntry, type FleetSnapshot, type RpcParams } from "@getdomovoi/protocol"

import { fleetProblem } from "./fleet-problem"

export type FleetCall = (method: "fleet.list", params: RpcParams<"fleet.list">) => Promise<unknown>

// The fleet as one snapshot gave it, with how far the daemon's clock was ahead
// of this phone's when that snapshot arrived. A heartbeat's time is the
// daemon's, so its age is measured on the daemon's clock (fleetNow): a phone
// whose clock is off would otherwise show a machine heard from seconds ago as
// silent for hours. The offset stays with the entries it came with, so a later
// snapshot never measures an earlier one's heartbeats. A daemon from before
// daemonTime sends none, and the phone's own clock is used, as before.
export type HeldFleet = { entries: FleetEntry[], daemonTimeOffsetMs: number }

export type FleetSink = {
  setFleet: (fleet: HeldFleet | undefined) => void
  setLoading: (loading: boolean) => void
  setProblem: (problem: string) => void
}

function heldFleet(snapshot: FleetSnapshot, receivedAt: number): HeldFleet {
  return {
    entries: snapshot.entries,
    daemonTimeOffsetMs: snapshot.daemonTime === undefined ? 0 : Date.parse(snapshot.daemonTime) - receivedAt,
  }
}

// The daemon's time now, by the phone's clock and the held fleet's offset.
// This measures heartbeat ages only; an approval's wait is measured on the
// phone's own clock.
export function fleetNow(fleet: HeldFleet | undefined, now: number): number {
  return now + (fleet?.daemonTimeOffsetMs ?? 0)
}

// Reopening the tab while an earlier list is still out starts a second request
// on the same connection, and the two can answer in either order. Only the
// newest request may write, so an older answer that arrives late, whatever it
// says, changes nothing. A disconnect, a new daemon and an unmount each retire
// every request that is out, because an answer from before any of them
// describes a connection that no longer exists. The clock is the phone's, read
// when an answer arrives.
export function fleetLoader(sink: FleetSink, clock: () => number = Date.now) {
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
        sink.setFleet(heldFleet(fleetSnapshotSchema.parse(result), clock()))
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
    // The daemon pushes the whole fleet whenever it changes, and that push
    // describes the fleet later than any request already out. Taking it retires
    // those, so an answer describing the fleet before the change cannot land on
    // top of the one describing it after. A list the daemon sent unasked also
    // settles a refusal recorded before it.
    accept(snapshot: FleetSnapshot): void {
      generation += 1
      sink.setFleet(heldFleet(snapshot, clock()))
      sink.setLoading(false)
      sink.setProblem("")
    },
    invalidate(): void {
      generation += 1
    },
  }
}
