import { describe, expect, it } from "vitest"
import { rpcMethods } from "./rpc.js"

const identity = { id: "skill-111111111111", contentDigest: `sha256:${"a".repeat(64)}` }

describe("reviewed skill revision retrieval", () => {
  it("exposes a digest-addressed read instead of adding document bytes to snapshots", () => {
    expect(rpcMethods["skill.reviewRevision"].params.parse(identity)).toEqual(identity)
    expect(rpcMethods["skill.reviewRevision"].result.parse({ ...identity, state: "available", content: "exact\r\ntext\n", bytes: 12 })).toMatchObject({ content: "exact\r\ntext\n", bytes: 12 })
  })

  it("represents absent history as unavailable without content or a zero change count", () => {
    const missing = { ...identity, state: "unavailable", reason: "not-retained" }
    expect(rpcMethods["skill.reviewRevision"].result.parse(missing)).toEqual(missing)
    expect(rpcMethods["skill.reviewRevision"].result.safeParse({ ...missing, content: "", changedLines: 0 }).success).toBe(false)
  })

  it("bounds document bytes and validates the byte count", () => {
    const schema = rpcMethods["skill.reviewRevision"].result
    expect(schema.safeParse({ ...identity, state: "available", content: "🙂", bytes: 4 }).success).toBe(true)
    expect(schema.safeParse({ ...identity, state: "available", content: "🙂", bytes: 2 }).success).toBe(false)
    expect(schema.safeParse({ ...identity, state: "available", content: "x".repeat(128 * 1_024 + 1), bytes: 128 * 1_024 + 1 }).success).toBe(false)
  })
})
