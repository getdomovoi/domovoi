import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  maximumPairedDeviceLabelLength,
  maximumSessionPromptCharacters,
  pairedDeviceSchema,
  rpcMethods,
  sessionUsageSchema,
  workspaceSnapshotSchema,
} from "./index.js"

describe("validation compatibility", () => {
  const deviceId = `device-${"a".repeat(32)}`
  const boundedInputs = [
    {
      name: "device pairing label",
      schema: rpcMethods["device.pair"].params,
      limit: maximumPairedDeviceLabelLength,
      input: (text: string) => ({ label: text, client: "phone" }),
      path: ["label"],
    },
    {
      name: "device rename label",
      schema: rpcMethods["device.rename"].params,
      limit: maximumPairedDeviceLabelLength,
      input: (text: string) => ({ deviceId, label: text }),
      path: ["label"],
    },
    {
      name: "session prompt",
      schema: rpcMethods["session.send"].params,
      limit: maximumSessionPromptCharacters,
      input: (text: string) => ({ sessionId: "session-1", prompt: text, client: "phone" }),
      path: ["prompt"],
    },
    {
      name: "terminal input",
      schema: rpcMethods["terminal.input"].params,
      limit: 65_536,
      input: (text: string) => ({ terminalId: "terminal-1", data: text, client: "phone", clientId: "phone-1" }),
      path: ["data"],
    },
    {
      name: "annotation reply",
      schema: rpcMethods["annotation.reply"].params,
      limit: 8_192,
      input: (text: string) => ({ annotationId: "annotation-1", body: text, client: "phone" }),
      path: ["body"],
    },
  ]

  it.each(boundedInputs)("keeps $name bounded in UTF-16 code units", ({ schema, limit, input, path }) => {
    const atLimit = "😀".repeat(limit / 2)
    const overLimit = `${atLimit}x`
    expect(atLimit.length).toBe(limit)
    expect([...overLimit]).toHaveLength(limit / 2 + 1)
    expect(overLimit.length).toBe(limit + 1)
    expect(schema.safeParse(input(atLimit)).success).toBe(true)
    const result = schema.safeParse(input(overLimit))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: "too_big", origin: "string", maximum: limit, path }),
      ])
    }
  })

  it("keeps the existing exact string length measured in the same units", () => {
    const usage = {
      sessionId: "session-1", inputTokens: 0, cachedInputTokens: 0,
      outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicros: 0,
      reportedCostTurns: 0, unavailableCostTurns: 0, byRuntime: [],
    }
    // This schema has only a length bound, not an ISO currency alphabet check.
    // Preserve its accepted set while changing the validation library.
    expect(sessionUsageSchema.safeParse({ ...usage, currency: "😀a" }).success).toBe(true)
    for (const currency of ["😀", "😀ab", "US", "USDX"]) {
      expect(sessionUsageSchema.safeParse({ ...usage, currency }).success).toBe(false)
    }
  })

  it.each([
    "2026-09-07T12:30Z",
    "2026-09-07T12:30:00Z",
    "2026-09-07T12:30:00.123Z",
    "2026-09-07T12:30+05:30",
    "2026-09-07T12:30:00-06:00",
  ])("preserves a valid offset timestamp without rewriting its bytes: %s", (pairedAt) => {
    const device = { id: deviceId, label: "phone", pairedAt, binding: { kind: "client", client: "phone" } }
    expect(pairedDeviceSchema.parse(device)).toEqual(device)
  })

  it.each([
    "2026-02-30T12:30Z",
    "2026-09-07T24:00Z",
    "2026-09-07T12:60Z",
    "2026-09-07T12:30",
    "2026-09-07T12:30Z\n",
    "2026-09-07T12:30+24:00",
  ])("still refuses an invalid timestamp: %j", (pairedAt) => {
    expect(pairedDeviceSchema.safeParse({
      id: deviceId, label: "phone", pairedAt, binding: { kind: "client", client: "phone" },
    }).success).toBe(false)
  })

  it("keeps UTC-only fields restricted to UTC at either precision", () => {
    for (const updatedAt of ["2026-09-07T12:30Z", "2026-09-07T12:30:00.000Z"]) {
      const workspace = structuredClone(demoWorkspace)
      workspace.sessions[0]!.updatedAt = updatedAt
      expect(workspaceSnapshotSchema.parse(workspace).sessions[0]!.updatedAt).toBe(updatedAt)
      workspace.sessions[0]!.updatedAt = updatedAt.replace("Z", "+00:00")
      expect(workspaceSnapshotSchema.safeParse(workspace).success).toBe(false)
    }
  })

  it("refuses strict objects with invalid refinements and keeps custom reasons readable", () => {
    const result = pairedDeviceSchema.safeParse({
      id: deviceId, label: "phone", pairedAt: "2026-09-07T12:30:00Z",
      binding: { kind: "unbound", previousRole: "unknown" },
      token: "must-not-be-described",
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ code: "unrecognized_keys", keys: ["token"] }))
    }
    const unbound = pairedDeviceSchema.safeParse({
      id: deviceId, label: "phone", pairedAt: "2026-09-07T12:30:00Z",
      binding: { kind: "unbound", previousRole: "unknown" },
    })
    expect(unbound.success).toBe(false)
    if (!unbound.success) {
      expect(unbound.error.issues).toContainEqual(expect.objectContaining({
        code: "custom", path: ["binding"], message: "An unbound legacy device must be revoked",
      }))
    }
  })

  it("reports later string checks after a length refusal", () => {
    const result = rpcMethods["device.rename"].params.safeParse({
      deviceId, label: `${"x".repeat(maximumPairedDeviceLabelLength)}\nlabel`,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: "too_big", path: ["label"] }),
        expect.objectContaining({ code: "invalid_format", path: ["label"], message: "A device label cannot contain control characters" }),
      ])
    }
  })

  it.each([
    { label: "x".repeat(maximumPairedDeviceLabelLength + 1), pairedAt: "2026-09-07T12:30:00Z", code: "too_big", path: ["label"] },
    { label: "phone", pairedAt: "2026-02-30T12:30Z", code: "invalid_format", path: ["pairedAt"] },
  ])("keeps object refinement reasons after a $code refusal", ({ label, pairedAt, code, path }) => {
    const result = pairedDeviceSchema.safeParse({
      id: deviceId, label, pairedAt,
      binding: { kind: "unbound", previousRole: "unknown" },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code, path }),
        expect.objectContaining({
          code: "custom", path: ["binding"], message: "An unbound legacy device must be revoked",
        }),
      ]))
    }
  })
})
