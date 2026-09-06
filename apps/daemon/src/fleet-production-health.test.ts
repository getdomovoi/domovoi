import { join } from "node:path"

import {
  fleetEnrollResultSchema, fleetMachineHealth, fleetSnapshotSchema, protocolCompatibility, protocolVersion, rpcMethods,
  transferRefusalMessage, workspaceSnapshotSchema,
} from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { fleetProductionHarness, git, remote, sessionAgent, type FleetDaemon } from "./test-fleet-production.js"
import { waitForDaemon } from "./test-wait-for.js"

const { cleanup, scratch, repository, machine, enroll } = fleetProductionHarness()
afterEach(cleanup)

// Through 0.x only the patch may differ, so one minor step is another release.
function releaseAt(minorOffset: number) {
  const [major, minor] = protocolVersion.split(".").map(Number)
  return `${major}.${minor! + minorOffset}.0`
}

async function row(source: FleetDaemon, id: string) {
  return remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), id)
}

async function idleSession(source: FleetDaemon, target?: FleetDaemon) {
  const sourceRepository = await repository("source")
  if (target) {
    const targetRepository = join(await scratch(), "target")
    await git(sourceRepository, ["clone", "--no-local", sourceRepository, targetRepository])
    await git(targetRepository, ["config", "core.autocrlf", "false"])
    await target.root.ok("project.open", { path: targetRepository, client: "cli" })
  }
  await source.root.ok("project.open", { path: sourceRepository, client: "cli" })
  const created = workspaceSnapshotSchema.parse(await source.root.ok("session.create", {
    title: "Fleet health session", client: "cli",
    runtime: { provider: "claude-code", model: "claude-opus-5", reasoning: "high", permissionMode: "build", auto: false },
  }))
  return created.sessions[0]!.id
}

async function transferPreview(source: FleetDaemon, sessionId: string, targetMachineId: string) {
  return rpcMethods["session.transferPreview"].result.parse(await source.root.ok("session.transferPreview", {
    sessionId, targetMachineId, method: "git-bundle", initiatedByClient: "cli",
  }))
}

async function restart(target: FleetDaemon, running: Pick<FleetDaemon, "root" | "handle">, version?: string) {
  running.root.socket.close()
  await running.handle.stop()
  return target.start({ port: target.address.port, ...(version ? { protocolVersion: version } : {}) })
}

describe("production fleet version health", () => {
  it("grades a peer that moved to a newer protocol as version-mismatch and refuses to move a session there", async () => {
    const source = await machine("source studio", sessionAgent)
    const target = await machine("target studio")
    const sessionId = await idleSession(source)
    await enroll(source, target)
    expect(await row(source, target.id)).toMatchObject({ health: "healthy", protocolVersion })

    const newer = releaseAt(1)
    const ahead = await restart(target, target, newer)
    await waitForDaemon(async () => expect((await row(source, target.id)).health).toBe("version-mismatch"))
    const graded = await row(source, target.id)
    // The refusal is not an authenticated descriptor, so the published facts
    // stay the last ones the peer authored.
    expect(graded.protocolVersion).toBe(protocolVersion)
    // The remote is the newer side, so the operator updates Domovoi here. The
    // same reading the protocol grades from and the machine selector copies.
    expect(protocolCompatibility(newer, protocolVersion)).toBe("machine-ahead")
    expect(fleetMachineHealth({
      heartbeat: graded.heartbeat.state, connection: "connected", protocolVersion: newer, clientProtocolVersion: protocolVersion,
    })).toBe(graded.health)
    expect(await transferPreview(source, sessionId, target.id)).toMatchObject({ allowed: false, reason: "target-version-mismatch" })
    expect(transferRefusalMessage["target-version-mismatch"]).toContain("newer Domovoi")

    // Pairing again cannot bridge the gap either: the peer refuses the claim
    // on the wire before the code is spent.
    const issued = await ahead.root.ok("device.issueCode", {}) as { code: string }
    expect(fleetEnrollResultSchema.parse(await source.root.ok("fleet.enroll", {
      endpoint: target.address.url, code: issued.code, sourceDeviceLabel: "source studio", expectedMachineId: target.id, client: "cli",
    }))).toEqual({ outcome: "refused", reason: "protocol-mismatch" })
    expect((await row(source, target.id)).health).toBe("version-mismatch")
  })

  it("grades a peer below this protocol as upgrade-required, refuses the move, and recovers on upgrade without re-pairing", async () => {
    const source = await machine("source studio", sessionAgent)
    const target = await machine("target studio")
    const sessionId = await idleSession(source, target)
    await enroll(source, target)
    const credential = source.credentials.forMachine(target.id)
    expect(credential).toBeDefined()
    const pairedDevices = (await target.root.ok("device.list", {}) as { devices: Array<{ id: string }> }).devices.map((device) => device.id)
    expect(pairedDevices).toHaveLength(1)

    const older = releaseAt(-1)
    const behind = await restart(target, target, older)
    await waitForDaemon(async () => expect((await row(source, target.id)).health).toBe("upgrade-required"))
    const graded = await row(source, target.id)
    expect(protocolCompatibility(older, protocolVersion)).toBe("machine-behind")
    expect(fleetMachineHealth({
      heartbeat: graded.heartbeat.state, connection: "connected", protocolVersion: older, clientProtocolVersion: protocolVersion,
    })).toBe(graded.health)
    expect(await transferPreview(source, sessionId, target.id)).toMatchObject({ allowed: false, reason: "target-upgrade-required" })
    expect(transferRefusalMessage["target-upgrade-required"]).toContain("older Domovoi")

    // The upgrade keeps the identity, state and paired credential; only the
    // release changes. The next heartbeat is enough to bring the row back.
    const upgraded = await restart(target, behind)
    await waitForDaemon(async () => {
      const recovered = await row(source, target.id)
      expect(recovered).toMatchObject({ health: "healthy", protocolVersion })
      expect(Date.parse(recovered.heartbeat.lastSeenAt)).toBeGreaterThan(Date.parse(graded.heartbeat.lastSeenAt))
    })
    expect(source.credentials.forMachine(target.id)).toBe(credential)
    const devices = (await upgraded.root.ok("device.list", {}) as { devices: Array<{ id: string; revokedAt?: string }> }).devices
    expect(devices.map((device) => device.id)).toEqual(pairedDevices)
    expect(devices.every((device) => device.revokedAt === undefined)).toBe(true)
    const afterUpgrade = await transferPreview(source, sessionId, target.id)
    expect(afterUpgrade.allowed ? "allowed" : afterUpgrade.reason).toBe("allowed")
  })
})
