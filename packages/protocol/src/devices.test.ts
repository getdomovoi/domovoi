import { describe, expect, it } from "vitest"

import {
  deviceClaimParamsSchema,
  devicePairParamsSchema,
  devicePairResultSchema,
  deviceRevokeParamsSchema,
  deviceRotateParamsSchema,
  devicesResultSchema,
  pairedDeviceSchema,
} from "./devices.js"

const device = {
  id: `device-${"a".repeat(32)}`,
  label: "studio-ipad",
  pairedAt: "2026-08-31T12:00:00.000Z",
  binding: { kind: "client" as const, client: "phone" as const },
}

describe("pairedDeviceSchema", () => {
  it("describes a paired device", () => {
    expect(pairedDeviceSchema.parse(device)).toEqual(device)
  })

  it("carries the optional contact and revocation times", () => {
    const seen = {
      ...device,
      lastSeenAt: "2026-08-31T12:30:00.000Z",
      revokedAt: "2026-08-31T13:00:00.000Z",
    }
    expect(pairedDeviceSchema.parse(seen)).toEqual(seen)
  })

  it("explains a credential revoked by the identity-binding migration", () => {
    const migrated = {
      id: device.id,
      label: device.label,
      pairedAt: device.pairedAt,
      binding: { kind: "unbound" as const, previousRole: "unknown" as const },
      revokedAt: "2026-09-04T00:00:00.000Z",
      revocationReason: "legacy-unbound-credential",
    }

    expect(pairedDeviceSchema.parse(migrated)).toEqual(migrated)
    expect(pairedDeviceSchema.safeParse({
      ...device,
      revocationReason: "legacy-unbound-credential",
    }).success).toBe(false)
  })

  it("preserves a client credential retired before client-kind binding", () => {
    const migrated = {
      id: device.id,
      label: device.label,
      pairedAt: device.pairedAt,
      binding: { kind: "unbound" as const, previousRole: "client" as const },
      revokedAt: "2026-09-04T00:00:00.000Z",
      revocationReason: "legacy-unbound-client-kind",
    }

    expect(pairedDeviceSchema.parse(migrated)).toEqual(migrated)
  })

  it("requires migration reasons to match an inactive unbound role", () => {
    const revokedAt = "2026-09-04T00:00:00.000Z"
    expect(pairedDeviceSchema.safeParse({
      ...device,
      revokedAt,
      revocationReason: "legacy-unbound-client-kind",
    }).success).toBe(false)
    expect(pairedDeviceSchema.safeParse({
      ...device,
      binding: { kind: "unbound", previousRole: "client" },
    }).success).toBe(false)
    expect(pairedDeviceSchema.safeParse({
      ...device,
      binding: { kind: "unbound", previousRole: "client" },
      revokedAt,
      revocationReason: "legacy-unbound-credential",
    }).success).toBe(false)
    expect(pairedDeviceSchema.safeParse({
      ...device,
      binding: { kind: "unbound", previousRole: "unknown" },
      revokedAt,
      revocationReason: "legacy-unbound-client-kind",
    }).success).toBe(false)
  })

  it("describes a machine credential with its bound machine identity", () => {
    const machine = {
      ...device,
      binding: { kind: "machine" as const, machineId: `machine-${"b".repeat(32)}` },
    }
    expect(pairedDeviceSchema.parse(machine)).toEqual(machine)
    expect(pairedDeviceSchema.safeParse({
      ...machine,
      binding: { kind: "machine" },
    }).success).toBe(false)
  })

  it("rejects an identifier that is not a device identity", () => {
    expect(pairedDeviceSchema.safeParse({ ...device, id: "ipad" }).success).toBe(false)
  })

  it("refuses to describe a credential", () => {
    expect(pairedDeviceSchema.safeParse({ ...device, token: "secret" }).success).toBe(false)
    expect(pairedDeviceSchema.safeParse({ ...device, tokenHash: "secret" }).success).toBe(false)
  })
})

describe("devicePairParamsSchema", () => {
  it("requires a bounded label and the requesting client", () => {
    expect(devicePairParamsSchema.parse({ label: "studio-ipad", client: "desktop" }))
      .toEqual({ label: "studio-ipad", client: "desktop" })
    expect(devicePairParamsSchema.safeParse({ label: "  ", client: "desktop" }).success).toBe(false)
    expect(devicePairParamsSchema.safeParse({
      label: "n".repeat(129),
      client: "desktop",
    }).success).toBe(false)
    expect(devicePairParamsSchema.safeParse({ label: "studio-ipad" }).success).toBe(false)
  })
})

describe("devicePairResultSchema", () => {
  it("returns the device beside its one-time credential", () => {
    const paired = { device, token: "n".repeat(43) }
    expect(devicePairResultSchema.parse(paired)).toEqual(paired)
  })

  it("rejects a credential that is not the issued shape", () => {
    expect(devicePairResultSchema.safeParse({ device, token: "short" }).success).toBe(false)
  })
})

describe("deviceClaimParamsSchema", () => {
  it("binds a claimed credential to the source machine", () => {
    const claim = {
      code: "hearth-quiet-ember-42",
      label: "studio-mac",
      machineId: `machine-${"a".repeat(32)}`,
    }
    expect(deviceClaimParamsSchema.parse(claim)).toEqual(claim)
    const { machineId: _machineId, ...unbound } = claim
    expect(deviceClaimParamsSchema.safeParse(unbound).success).toBe(false)
  })
})

describe("deviceRevokeParamsSchema and deviceRotateParamsSchema", () => {
  it("require a device identity and the requesting client", () => {
    const params = { deviceId: device.id, client: "web" }
    expect(deviceRevokeParamsSchema.parse(params)).toEqual(params)
    expect(deviceRotateParamsSchema.parse(params)).toEqual(params)
    expect(deviceRevokeParamsSchema.safeParse({ deviceId: "ipad", client: "web" }).success)
      .toBe(false)
  })
})

describe("devicesResultSchema", () => {
  it("lists paired devices without any credential", () => {
    expect(devicesResultSchema.parse({ devices: [device] }).devices).toEqual([device])
    expect(devicesResultSchema.safeParse({
      devices: [{ ...device, token: "secret" }],
    }).success).toBe(false)
  })
})
