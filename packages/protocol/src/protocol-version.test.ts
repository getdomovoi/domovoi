import { expect, it } from "vitest"

import {
  demoWorkspace, deviceClaimParamsSchema, deviceConfirmClaimParamsSchema,
  fleetMachineDescriptorSchema, helloParamsSchema, protocolCompatibility,
  protocolMismatchSchema, protocolVersion, systemHelloResultSchema, workspaceSnapshotSchema,
} from "./index.js"

const machineId = `machine-${"a".repeat(32)}`
const versionReaders = [
  ["hello", (version: string) => helloParamsSchema.safeParse({ client: "cli", clientVersion: "test", protocolVersion: version })],
  ["claim", (version: string) => deviceClaimParamsSchema.safeParse({ code: "one-two-three-42", label: "laptop", machineId, protocolVersion: version })],
  ["confirmation", (version: string) => deviceConfirmClaimParamsSchema.safeParse({ authToken: "a".repeat(43), machineId, protocolVersion: version })],
  ["descriptor", (version: string) => fleetMachineDescriptorSchema.safeParse({
    id: machineId, label: "laptop", platform: "linux", arch: "x64", version: "1.2.3", capabilities: [], transports: [], protocolVersion: version,
  })],
  ["refusal", (version: string) => protocolMismatchSchema.safeParse({
    kind: "protocol-mismatch", daemonProtocolVersion: version, clientProtocolVersion: "0.0.0", compatibility: "machine-ahead",
  })],
] as const

it.each([
  ["snapshot", workspaceSnapshotSchema], ["hello result", systemHelloResultSchema],
] as const)("accepts compatible patches in the %s without rewriting the reported version", (_name, schema) => {
  const remoteVersion = protocolVersion.replace(/\d+$/, "1")
  expect(protocolCompatibility(protocolVersion, remoteVersion)).toBe("compatible")
  const parsed = schema.safeParse({ ...demoWorkspace, protocolVersion: remoteVersion })
  expect(parsed.success).toBe(true)
  if (parsed.success) expect(parsed.data.protocolVersion).toBe(remoteVersion)
})

it("keeps payload validation when a compatible patch is accepted", () => {
  const remoteVersion = protocolVersion.replace(/\d+$/, "1")
  expect(systemHelloResultSchema.safeParse({ ...demoWorkspace, protocolVersion: remoteVersion, sessions: "not sessions" }).success).toBe(false)
  for (const version of ["0.5.0", "0.7.0", "1.2.0"]) {
    expect(workspaceSnapshotSchema.safeParse({ ...demoWorkspace, protocolVersion: version }).success).toBe(false)
  }
})

it.each(versionReaders)("bounds the %s version at 64 characters", (_name, read) => {
  expect(read("1".repeat(60) + ".0.0").success).toBe(true)
  expect(read("1".repeat(61) + ".0.0").success).toBe(false)
})

it.each(versionReaders)("refuses noncanonical %s versions", (_name, read) => {
  for (const version of ["01.0.0", "1.00.0", "1.0.00", "1.2", "1.2.3-extra", "1.2.3\n"]) {
    expect(read(version).success, version).toBe(false)
  }
})

it("compares major and minor components without floating point rounding", () => {
  for (const [older, newer] of [
    ["9007199254740992.0.0", "9007199254740993.0.0"],
    ["0.9007199254740992.0", "0.9007199254740993.0"],
  ] as const) {
    expect(protocolCompatibility(older, newer)).toBe("machine-behind")
    expect(protocolCompatibility(newer, older)).toBe("machine-ahead")
    expect(protocolMismatchSchema.safeParse({ kind: "protocol-mismatch", daemonProtocolVersion: newer,
      clientProtocolVersion: older, compatibility: "machine-ahead" }).success).toBe(true)
  }
})

it("refuses malformed comparison inputs instead of assigning them a compatibility", () => {
  for (const version of ["01.2.3", "1".repeat(61) + ".0.0", "1.2.3\n"]) {
    expect(() => protocolCompatibility(version, "1.2.3")).toThrow("Protocol version is malformed")
  }
})
