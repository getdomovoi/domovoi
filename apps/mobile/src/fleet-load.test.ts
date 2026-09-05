import type { FleetEntry } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { fleetLoader, type FleetSink } from "./fleet-load"

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

function harness() {
  const state: { fleet: FleetEntry[] | undefined, loading: boolean, problem: string } = {
    fleet: undefined,
    loading: false,
    problem: "",
  }
  const sink: FleetSink = {
    setFleet: (fleet) => { state.fleet = fleet },
    setLoading: (loading) => { state.loading = loading },
    setProblem: (problem) => { state.problem = problem },
  }
  const requests: Deferred[] = []
  const call = () => {
    const request = deferred()
    requests.push(request)
    return request.promise
  }
  return { state, requests, loader: fleetLoader(sink), call }
}

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

  it("answers a request started after an invalidation", async () => {
    const { state, requests, loader, call } = harness()

    loader.invalidate()
    const load = loader.load(call)
    requests[0]?.resolve({ entries })
    await load

    expect(state).toEqual({ fleet: entries, loading: false, problem: "" })
  })
})
