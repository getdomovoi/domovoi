import type { FleetEntry } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { fleetLoader, fleetNow, type FleetSink, type HeldFleet } from "./fleet-load"

const entries: FleetEntry[] = [{ kind: "unenrolled", machineId: `machine-${"a".repeat(32)}` }]

type Deferred = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (cause: unknown) => void
}

function deferred(): Deferred {
  let resolve: Deferred["resolve"] = () => {}
  let reject: Deferred["reject"] = () => {}
  const promise = new Promise<unknown>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

// The phone's clock in these tests: two hours behind the daemon's.
const phoneNow = Date.parse("2026-10-10T10:00:00.000Z")
const daemonTime = "2026-10-10T12:00:00.000Z"
const twoHoursMs = 2 * 60 * 60 * 1_000

function harness() {
  const state: { fleet: FleetEntry[] | undefined, loading: boolean, problem: string } = {
    fleet: undefined,
    loading: false,
    problem: "",
  }
  const held: { fleet: HeldFleet | undefined } = { fleet: undefined }
  const sink: FleetSink = {
    setFleet: (fleet) => {
      held.fleet = fleet
      state.fleet = fleet?.entries
    },
    setLoading: (loading) => { state.loading = loading },
    setProblem: (problem) => { state.problem = problem },
  }
  const requests: Deferred[] = []
  const call = () => {
    const request = deferred()
    requests.push(request)
    return request.promise
  }
  return { state, held, requests, loader: fleetLoader(sink, () => phoneNow), call }
}

// #781: heartbeat times are the daemon's, so a heartbeat's age is measured on
// the daemon's clock. The offset is taken when a snapshot arrives and kept
// with that snapshot's entries, never with a later one's.
describe("fleetLoader and the daemon's clock", () => {
  it("keeps how far the daemon's clock was from the phone's with the list it answered", async () => {
    const { held, requests, loader, call } = harness()
    const load = loader.load(call)
    requests[0]?.resolve({ entries, daemonTime })
    await load
    expect(held.fleet).toEqual({ entries, daemonTimeOffsetMs: twoHoursMs })
    expect(fleetNow(held.fleet, phoneNow)).toBe(Date.parse(daemonTime))
  })

  it("keeps the offset of a pushed fleet with that fleet", () => {
    const { held, loader } = harness()
    loader.accept({ entries, daemonTime: "2026-10-10T09:59:00.000Z" })
    expect(held.fleet).toEqual({ entries, daemonTimeOffsetMs: -60_000 })
  })

  // A daemon from before daemonTime: the phone's own clock, as before.
  it("measures on the phone's clock when the daemon sends no time", async () => {
    const { held, requests, loader, call } = harness()
    const load = loader.load(call)
    requests[0]?.resolve({ entries })
    await load
    expect(held.fleet).toEqual({ entries, daemonTimeOffsetMs: 0 })
    loader.accept({ entries })
    expect(held.fleet).toEqual({ entries, daemonTimeOffsetMs: 0 })
    expect(fleetNow(held.fleet, phoneNow)).toBe(phoneNow)
    expect(fleetNow(undefined, phoneNow)).toBe(phoneNow)
  })
})

describe("fleetLoader", () => {
  it("keeps the newer answer when an older request fails after it", async () => {
    const { state, requests, loader, call } = harness()

    const first = loader.load(call)
    const second = loader.load(call)
    requests[1]?.resolve({ entries })
    await second
    expect(state).toEqual({ fleet: entries, loading: false, problem: "" })

    requests[0]?.reject(new Error("The daemon closed the connection"))
    await first

    expect(state).toEqual({ fleet: entries, loading: false, problem: "" })
  })

  it("keeps the newer failure when an older request succeeds after it", async () => {
    const { state, requests, loader, call } = harness()

    const first = loader.load(call)
    const second = loader.load(call)
    requests[1]?.reject(new Error("fleet.list got no answer in 30 seconds"))
    await second
    expect(state).toEqual({ fleet: undefined, loading: false, problem: "fleet.list got no answer in 30 seconds" })

    requests[0]?.resolve({ entries })
    await first

    expect(state).toEqual({ fleet: undefined, loading: false, problem: "fleet.list got no answer in 30 seconds" })
  })

  it("stays loading while the newest request is still out", async () => {
    const { state, requests, loader, call } = harness()

    const first = loader.load(call)
    void loader.load(call)
    requests[0]?.resolve({ entries })
    await first

    expect(state).toEqual({ fleet: undefined, loading: true, problem: "" })
  })

  it("lets nothing from before a disconnect or an unmount write state", async () => {
    const { state, requests, loader, call } = harness()

    const first = loader.load(call)
    const second = loader.load(call)
    loader.invalidate()
    requests[1]?.resolve({ entries })
    requests[0]?.reject(new Error("The daemon closed the connection"))
    await Promise.all([first, second])

    expect(state).toEqual({ fleet: undefined, loading: true, problem: "" })
  })

  it("takes a pushed fleet and retires the request that was already out", async () => {
    const { state, requests, loader, call } = harness()
    const pushed: FleetEntry[] = [{ kind: "unenrolled", machineId: `machine-${"b".repeat(32)}` }]

    const load = loader.load(call)
    loader.accept({ entries: pushed })
    expect(state).toEqual({ fleet: pushed, loading: false, problem: "" })

    // The request went out before the change, so its answer describes the fleet
    // as it was and must not land on top of the one that describes it now.
    requests[0]?.resolve({ entries })
    await load

    expect(state).toEqual({ fleet: pushed, loading: false, problem: "" })
  })

  it("settles a refusal recorded before the daemon pushed a list", async () => {
    const { state, requests, loader, call } = harness()
    const pushed: FleetEntry[] = [{ kind: "unenrolled", machineId: `machine-${"b".repeat(32)}` }]

    const load = loader.load(call)
    requests[0]?.reject(new Error("The daemon withheld the fleet list"))
    await load
    expect(state.problem).toBe("The daemon withheld the fleet list")

    loader.accept({ entries: pushed })

    expect(state).toEqual({ fleet: pushed, loading: false, problem: "" })
  })

  it("answers a request started after an invalidation", async () => {
    const { state, requests, loader, call } = harness()

    loader.invalidate()
    const load = loader.load(call)
    requests[0]?.resolve({ entries })
    await load

    expect(state).toEqual({ fleet: entries, loading: false, problem: "" })
  })
})
