import { describe, expect, it } from "vitest"

import {
  notificationMethods,
  phoneAndTabletRpcMethods,
  protocolVersion,
  rpcMethodAuthorizations,
  rpcMethodMutations,
  rpcMethods,
  terminalOwnerSchema,
  terminalOwnershipNotificationSchema,
  terminalWatchParamsSchema,
} from "./index.js"

const identity = { client: "desktop", clientId: "desktop-owner" } as const
const terminalId = "terminal-1"
const claimedAt = "2026-10-08T12:00:00.000Z"

describe("terminal claim state contracts", () => {
  it("adds release as control of live process state, outside handheld access", () => {
    expect(protocolVersion).toBe("0.8.0")
    expect(rpcMethodAuthorizations).toHaveProperty("terminal.release", "control")
    expect(rpcMethodMutations).toHaveProperty("terminal.release", "read-only")
    expect([...phoneAndTabletRpcMethods]).not.toContain("terminal.release")
    expect(rpcMethods["terminal.release"].params.parse({ terminalId, ...identity })).toEqual({ terminalId, ...identity })
    expect(rpcMethods["terminal.release"].params.safeParse({ terminalId }).success).toBe(false)
    const result = { terminalId, owner: identity, claimHeld: false }
    expect(rpcMethods["terminal.release"].result.parse(result)).toEqual(result)
  })

  it("keeps older owners and validates an optional claim date-time", () => {
    expect(terminalOwnerSchema.parse(identity)).toEqual(identity)
    expect(terminalOwnerSchema.parse({ ...identity, claimedAt })).toEqual({ ...identity, claimedAt })
    for (const invalid of ["yesterday", "2026-10-08", 123, null]) {
      expect(terminalOwnerSchema.safeParse({ ...identity, claimedAt: invalid }).success).toBe(false)
    }
  })

  it("does not let terminal params supply claim time", () => {
    for (const [method, extra] of [
      ["terminal.create", { sessionId: "session-1", cols: 80, rows: 24 }],
      ["terminal.claim", {}], ["terminal.release", {}],
      ["terminal.input", { data: "ls\r" }],
      ["terminal.resize", { cols: 80, rows: 24 }], ["terminal.close", {}],
    ] as const) {
      expect(rpcMethods[method].params.parse({ terminalId, ...identity, ...extra, claimedAt })).not.toHaveProperty("claimedAt")
    }
  })

  it("accepts old ownership notifications and optional boolean claim state", () => {
    const old = { terminalId, owner: identity }
    for (const schema of [terminalOwnershipNotificationSchema, rpcMethods["terminal.claim"].result]) {
      expect(schema.parse(old)).toEqual(old)
      for (const claimHeld of [true, false]) expect(schema.parse({ ...old, claimHeld })).toEqual({ ...old, claimHeld })
      for (const claimHeld of [0, "false", null]) expect(schema.safeParse({ ...old, claimHeld }).success).toBe(false)
    }
  })

  it("opts into resize with true only and keeps watch params strict", () => {
    expect(terminalWatchParamsSchema.parse({ terminalId })).toEqual({ terminalId })
    expect(terminalWatchParamsSchema.parse({ terminalId, followResize: true })).toEqual({ terminalId, followResize: true })
    for (const followResize of [false, 1, "true", null]) {
      expect(terminalWatchParamsSchema.safeParse({ terminalId, followResize }).success).toBe(false)
    }
    expect(terminalWatchParamsSchema.safeParse({ terminalId, followResize: true, clientId: "spoof" }).success).toBe(false)
  })

  it("registers a strict dimension-bounded resized notification", () => {
    const schema = notificationMethods["terminal.resized"]
    for (const dimension of [2, 1_000]) {
      const notice = { terminalId, cols: dimension, rows: dimension }
      expect(schema.parse(notice)).toEqual(notice)
    }
    for (const dimension of [1, 1_001, 2.5, "80", null]) {
      expect(schema.safeParse({ terminalId, cols: dimension, rows: 24 }).success).toBe(false)
      expect(schema.safeParse({ terminalId, cols: 80, rows: dimension }).success).toBe(false)
    }
    for (const notice of [{ cols: 80, rows: 24 }, { terminalId, cols: 80 }, { terminalId: "", cols: 80, rows: 24 }, { terminalId, cols: 80, rows: 24, extra: true }]) {
      expect(schema.safeParse(notice).success).toBe(false)
    }
  })
})
