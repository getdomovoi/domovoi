import { describe, expect, it } from "vitest"

import {
  PublicRpcError,
  internalRpcErrorMessage,
  redactErrorDetail,
} from "./rpc-errors.js"

describe("RPC errors", () => {
  it("keeps declared public errors stable", () => {
    const error = new PublicRpcError(-32603, "Agent setup timed out")

    expect(error.code).toBe(-32603)
    expect(error.message).toBe("Agent setup timed out")
  })

  it("redacts credentials from bounded internal diagnostics", () => {
    const detail = redactErrorDetail(new Error([
      "provider request failed",
      "Authorization: Bearer super-secret-bearer-token",
      '\"Authorization\": \"Bearer json-secret-token\"',
      "api_key=sk-proj-secret-value",
      "password: hunter2",
      "credentials=shared-credential",
      "https://admin:remote-password@example.test/api",
      "x".repeat(8_000),
    ].join("\n")))

    expect(detail).toContain("provider request failed")
    expect(detail).toContain("[REDACTED]")
    expect(detail).not.toContain("super-secret-bearer-token")
    expect(detail).not.toContain("json-secret-token")
    expect(detail).not.toContain("sk-proj-secret-value")
    expect(detail).not.toContain("hunter2")
    expect(detail).not.toContain("shared-credential")
    expect(detail).not.toContain("remote-password")
    expect(detail.length).toBeLessThanOrEqual(4_096)
  })

  it("includes bounded and redacted causes and aggregate children", () => {
    const cause = new Error("database refused token=nested-cause-secret")
    cause.stack = "Error: database refused token=nested-cause-secret"
    const aggregateChildren = Array.from({ length: 12 }, (_, index) => {
      const child = new Error(`worker-${index} password=aggregate-secret-${index}`)
      child.stack = `Error: worker-${index} password=aggregate-secret-${index}`
      return child
    })
    const aggregate = new AggregateError(aggregateChildren, "workers failed", { cause })
    aggregate.stack = "AggregateError: workers failed"

    const detail = redactErrorDetail(aggregate)

    expect(detail).toContain("Caused by: Error: database refused token=[REDACTED]")
    expect(detail).toContain("Aggregate error 1: Error: worker-0 password=[REDACTED]")
    expect(detail).toContain("4 additional aggregate errors omitted")
    expect(detail).not.toContain("nested-cause-secret")
    expect(detail).not.toContain("aggregate-secret")
    expect(detail).not.toContain("worker-8")
    expect(detail.length).toBeLessThanOrEqual(4_096)
  })

  it("bounds oversized and cyclic diagnostics", () => {
    const oversized = new Error(`oversized ${"x".repeat(1_000_000)}`)
    oversized.stack = `Error: oversized ${"x".repeat(1_000_000)}`
    const cyclic = new Error("cyclic cause")
    cyclic.stack = "Error: cyclic cause"
    cyclic.cause = cyclic

    const oversizedDetail = redactErrorDetail(oversized)
    const cyclicDetail = redactErrorDetail(cyclic)

    expect(oversizedDetail).toContain("Error: oversized")
    expect(oversizedDetail.length).toBeLessThanOrEqual(4_096)
    expect(cyclicDetail).toContain("Caused by: [Circular error]")
  })

  it("uses one public message for undeclared internal failures", () => {
    expect(internalRpcErrorMessage).toBe("Internal daemon error")
  })
})
