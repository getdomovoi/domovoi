import { describe, expect, it } from "vitest"
import { protocolVersion } from "./schema.js"

import {
  clientAccessSchema,
  deviceClaimParamsSchema,
  deviceCurrentResultSchema,
  deviceIssueCodeParamsSchema,
  deviceIssueCodeResultSchema,
  webAppUrlSchema,
  deviceLabelMismatchSchema,
  devicePairParamsSchema,
  devicePairResultSchema,
  deviceRenameParamsSchema,
  deviceRenameResultSchema,
  deviceRevokeParamsSchema,
  deviceRotateParamsSchema,
  devicesResultSchema,
  maximumPairedDeviceLabelLength,
  pairedDeviceSchema,
} from "./devices.js"

const device = {
  id: `device-${"a".repeat(32)}`,
  label: "studio-ipad",
  pairedAt: "2026-08-31T12:00:00.000Z",
  binding: { kind: "client" as const, client: "phone" as const, clientAccess: "full" as const },
}

describe("pairedDeviceSchema", () => {
  it("defaults existing client credential bindings to full access", () => {
    expect(clientAccessSchema.options).toEqual(["full", "watching"])
    const legacy = { ...device, binding: { kind: "client" as const, client: "phone" as const } }
    expect(pairedDeviceSchema.parse(legacy).binding).toEqual({
      kind: "client", client: "phone", clientAccess: "full",
    })
    expect(pairedDeviceSchema.parse({
      ...device,
      binding: { ...device.binding, clientAccess: "watching" },
    }).binding).toEqual({ kind: "client", client: "phone", clientAccess: "watching" })
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
    expect(devicePairParamsSchema.parse({
      label: "watcher", client: "desktop", targetClient: "web", clientAccess: "watching",
    }).clientAccess).toBe("watching")
  })

  it("binds issued client codes to an access level", () => {
    expect(deviceIssueCodeParamsSchema.parse({ targetClient: "phone" }))
      .toEqual({ targetClient: "phone" })
    expect(deviceIssueCodeParamsSchema.parse({ targetClient: "phone", clientAccess: "watching" }).clientAccess)
      .toBe("watching")
  })

  it("issues a code with the address a device dials, or the problem that leaves none", () => {
    const issued = { code: "hearth-quiet-ember-42", expiresAt: "2026-08-31T12:03:00.000Z" }
    const tailnet = { url: "wss://djs-macbook-pro-1.raptor-pompano.ts.net:47831/rpc", label: "djs-macbook-pro-1.raptor-pompano.ts.net", loopback: false }
    expect(deviceIssueCodeResultSchema.parse({ ...issued, pairingAddress: tailnet })).toEqual({ ...issued, pairingAddress: tailnet })
    const loopback = { url: "ws://127.0.0.1:47831/rpc", loopback: true }
    expect(deviceIssueCodeResultSchema.parse({ ...issued, pairingAddress: loopback })).toEqual({ ...issued, pairingAddress: loopback })
    const problem = { problem: "This daemon serves no certificate, so a device has no address it can verify." }
    expect(deviceIssueCodeResultSchema.parse({ ...issued, pairingAddress: problem })).toEqual({ ...issued, pairingAddress: problem })
    // An address a device cannot verify is refused at the schema, as the
    // payload refuses it: plaintext is loopback only.
    expect(deviceIssueCodeResultSchema.safeParse({ ...issued, pairingAddress: { url: "ws://100.80.185.103:47831/rpc", loopback: false } }).success).toBe(false)
    expect(deviceIssueCodeResultSchema.safeParse({ ...issued, pairingAddress: { url: "wss://a.example.ts.net:47831/rpc" } }).success).toBe(false)
    expect(deviceIssueCodeResultSchema.safeParse({ ...issued, pairingAddress: { problem: "" } }).success).toBe(false)
    expect(deviceIssueCodeResultSchema.safeParse(issued).success).toBe(false)
  })

  it("names the web app address a code can be opened at, when the daemon has one", () => {
    const issued = {
      code: "hearth-quiet-ember-42",
      expiresAt: "2026-08-31T12:03:00.000Z",
      pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true },
    }
    expect(deviceIssueCodeResultSchema.parse(issued)).toEqual(issued)
    for (const webAppUrl of ["https://app.domovoi.dev/connect", "http://localhost:5173/", "https://studio.tailnet.example/"]) {
      expect(deviceIssueCodeResultSchema.parse({ ...issued, webAppUrl })).toEqual({ ...issued, webAppUrl })
      expect(webAppUrlSchema.parse(webAppUrl)).toBe(webAppUrl)
    }
    for (const webAppUrl of [
      "", "/connect", "app.domovoi.dev", "ftp://app.domovoi.dev/", "javascript:alert(1)",
      "https://person:secret@app.domovoi.dev/", "https://app.domovoi.dev/#code",
      `https://app.domovoi.dev/${"a".repeat(2_048)}`,
    ]) {
      expect(webAppUrlSchema.safeParse(webAppUrl).success, webAppUrl).toBe(false)
      expect(deviceIssueCodeResultSchema.safeParse({ ...issued, webAppUrl }).success, webAppUrl).toBe(false)
    }
  })

  it("reports client access from the authenticated device", () => {
    const current = {
      kind: "client",
      machineId: `machine-${"b".repeat(32)}`,
      deviceId: device.id,
      client: "phone",
      clientAccess: "watching",
    }
    expect(deviceCurrentResultSchema.parse(current)).toEqual(current)
    const { clientAccess: _clientAccess, ...legacy } = current
    expect(deviceCurrentResultSchema.parse(legacy)).toMatchObject({
      kind: "client", clientAccess: "full",
    })
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
      protocolVersion,
    }
    expect(deviceClaimParamsSchema.parse(claim)).toEqual(claim)
    const { machineId: _machineId, ...unbound } = claim
    expect(deviceClaimParamsSchema.safeParse(unbound).success).toBe(false)
  })

  it("requires a protocol version before a claim can spend a pairing code", () => {
    expect(deviceClaimParamsSchema.safeParse({
      code: "hearth-quiet-ember-42",
      label: "studio-mac",
      machineId: `machine-${"a".repeat(32)}`,
    }).success).toBe(false)
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

describe("deviceRenameParamsSchema", () => {
  it("carries only the device identity and its new label", () => {
    expect(deviceRenameParamsSchema.parse({ deviceId: device.id, label: "  kitchen-ipad  " }))
      .toEqual({ deviceId: device.id, label: "kitchen-ipad" })
    expect(deviceRenameParamsSchema.safeParse({
      deviceId: device.id,
      label: "kitchen-ipad",
      client: "web",
    }).success).toBe(false)
    expect(deviceRenameParamsSchema.safeParse({
      deviceId: device.id,
      label: "kitchen-ipad",
      binding: { kind: "client", client: "phone" },
    }).success).toBe(false)
    expect(deviceRenameParamsSchema.safeParse({ deviceId: "ipad", label: "kitchen-ipad" }).success)
      .toBe(false)
  })

  it("bounds the label and refuses control characters", () => {
    expect(deviceRenameParamsSchema.parse({
      deviceId: device.id,
      label: "n".repeat(maximumPairedDeviceLabelLength),
    }).label).toBe("n".repeat(maximumPairedDeviceLabelLength))
    for (const label of ["", "   ", "n".repeat(maximumPairedDeviceLabelLength + 1), "kitchen\u0000ipad", "line\nbreak"]) {
      expect(deviceRenameParamsSchema.safeParse({ deviceId: device.id, label }).success).toBe(false)
    }
  })

  it("carries an optional expected label as a precondition", () => {
    expect(deviceRenameParamsSchema.parse({ deviceId: device.id, label: "studio-ipad", expectedLabel: " kitchen-ipad " }))
      .toEqual({ deviceId: device.id, label: "studio-ipad", expectedLabel: "kitchen-ipad" })
    for (const expectedLabel of ["", "   ", "n".repeat(maximumPairedDeviceLabelLength + 1)]) {
      expect(deviceRenameParamsSchema.safeParse({ deviceId: device.id, label: "studio-ipad", expectedLabel }).success)
        .toBe(false)
    }
  })
})

describe("deviceLabelMismatchSchema", () => {
  it("carries the current device and nothing else", () => {
    const mismatch = { kind: "device-label-mismatch", device }
    expect(deviceLabelMismatchSchema.parse(mismatch)).toEqual(mismatch)
    expect(deviceLabelMismatchSchema.safeParse({ ...mismatch, token: "secret" }).success).toBe(false)
    expect(deviceLabelMismatchSchema.safeParse({ ...mismatch, expectedLabel: "kitchen-ipad" }).success).toBe(false)
    expect(deviceLabelMismatchSchema.safeParse({ device }).success).toBe(false)
  })
})

describe("deviceRenameResultSchema", () => {
  it("returns the renamed device without any credential", () => {
    expect(deviceRenameResultSchema.parse({ device })).toEqual({ device })
    expect(deviceRenameResultSchema.safeParse({ device, token: "secret" }).success).toBe(false)
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
