import { DatabaseSync } from "node:sqlite"
import * as crypto from "node:crypto"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { SqliteDeviceRegistry } from "./device-registry.js"
import { PairingCodeService, pairingCodeTtlMs } from "./pairing-codes.js"

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  return { ...actual, createHash: vi.fn(actual.createHash), timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

// Security review r1 P3: matchingPairing attributes a protocol-mismatch
// refusal to the code it carried. It hashes and compares once whatever state
// the open code is in, so its own cost does not say whether a code is live.

const start = 1_000

function service() {
  return new PairingCodeService(new SqliteDeviceRegistry(new DatabaseSync(":memory:")))
}

describe("matchingPairing", () => {
  beforeEach(() => {
    vi.mocked(crypto.createHash).mockClear()
    vi.mocked(crypto.timingSafeEqual).mockClear()
  })

  function work(match: () => unknown) {
    vi.mocked(crypto.createHash).mockClear()
    vi.mocked(crypto.timingSafeEqual).mockClear()
    match()
    return { hashes: vi.mocked(crypto.createHash).mock.calls.length, compares: vi.mocked(crypto.timingSafeEqual).mock.calls.length }
  }

  it("does the same work for a live, wrong, expired, spent or absent code", () => {
    const none = service()
    const live = service()
    const issued = live.issue(start, "phone")
    const spent = service()
    const spentCode = spent.issue(start, "phone")
    spent.redeem(spentCode.code, { label: "phone" }, start)

    const states = {
      live: () => expect(live.matchingPairing(issued.code, start)).toBe(issued.pairingId),
      wrong: () => expect(live.matchingPairing("wrong-wrong-wrong-11", start)).toBeUndefined(),
      expired: () => expect(live.matchingPairing(issued.code, start + pairingCodeTtlMs)).toBeUndefined(),
      spent: () => expect(spent.matchingPairing(spentCode.code, start)).toBeUndefined(),
      absent: () => expect(none.matchingPairing(issued.code, start)).toBeUndefined(),
    }
    const costs = Object.fromEntries(Object.entries(states).map(([state, match]) => [state, work(match)]))
    for (const cost of Object.values(costs)) expect(cost).toEqual({ hashes: 1, compares: 1 })
  })
})
