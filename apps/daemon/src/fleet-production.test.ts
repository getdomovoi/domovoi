import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  daemonAuthenticationErrorCode, devicePairResultSchema,
  fleetSnapshotSchema, fleetSnapshotOverflowSchema, fleetSnapshotOverflowErrorCode, maximumFleetEntries, protocolVersion, rpcMethods, workspaceSnapshotSchema,
} from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { machineCredentialDigest } from "./machine-credentials.js"
import { fleetProductionHarness, git, persistedRegistry, remote, sessionAgent } from "./test-fleet-production.js"

const { cleanup, scratch, repository, connect, machine, enroll } = fleetProductionHarness()
afterEach(cleanup)

describe("production fleet assembly", () => {
  it("explicitly refuses all rows on legacy index overflow, including the omitted count and a local recovery command", async () => {
    const source = await machine("source studio")
    for (let index = 0; index < 512; index += 1) {
      source.credentials.save(`machine-${index.toString(16).padStart(32, "0")}`, "n".repeat(43))
    }
    const reply = await source.root.call("fleet.list", {})
    expect(reply.result).toBeUndefined()
    expect(reply.error?.code).toBe(fleetSnapshotOverflowErrorCode)
    expect(fleetSnapshotOverflowSchema.parse(reply.error?.data)).toEqual({
      kind: "fleet-overflow", limit: 512, totalEntries: 513, entriesNotShown: 513,
    })
    expect(reply.error?.message).toContain("domovoid fleet-keychain list")
    expect(JSON.stringify(reply)).not.toContain("n".repeat(43))
  })

  it("delivers a deliberate fleet change to a client but not fresh machine or unauthed observers", async () => {
    const source = await machine("source studio")
    const target = await machine("target studio")
    const paired = devicePairResultSchema.parse(await source.root.ok("device.pair", { label: "paired observer", client: "cli" }))
    const machineCode = await source.root.ok("device.issueCode", {}) as { code: string }
    const pairedClient = await connect(source.address.url)
    await pairedClient.ok("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: paired.token })
    const observer = await connect(source.address.url)
    const machinePair = devicePairResultSchema.parse(await observer.ok("device.claim", {
      code: machineCode.code, label: "observer", machineId: `machine-${"e".repeat(32)}`, protocolVersion,
    }))
    await observer.ok("system.hello", { client: "machine", clientVersion: "0.0.1", protocolVersion, authToken: machinePair.token })

    // Paired client authority is not local root enrollment authority.
    expect((await pairedClient.call("fleet.enroll", { endpoint: target.address.url, code: "hearth-quiet-ember-42", sourceDeviceLabel: "paired observer", client: "cli" })).error?.code)
      .toBe(daemonAuthenticationErrorCode)
    expect((await pairedClient.call("fleet.forget", { machineId: target.id, client: "cli" })).error?.code)
      .toBe(daemonAuthenticationErrorCode)

    // Open the unauthenticated observer only at the event under test. It must
    // not spend its authentication budget waiting for restart/health polling.
    const unauthed = await connect(source.address.url)
    pairedClient.notifications.length = 0
    observer.notifications.length = 0
    await enroll(source, target)
    // Replies on each socket drain preceding broadcasts. The positive witness
    // pins a real enrollment broadcast, not an absence during an idle interval.
    await pairedClient.ok("workspace.get", {})
    await observer.ok("fleet.heartbeat", {})
    expect((await unauthed.call("workspace.get", {})).error?.code).toBe(daemonAuthenticationErrorCode)
    expect(pairedClient.notifications.some((notice) => notice.method === "fleet.changed"
      && fleetSnapshotSchema.parse(notice.params).entries.some((entry) => entry.kind === "machine" && entry.machine.id === target.id))).toBe(true)
    expect(observer.notifications.filter((notice) => notice.method === "fleet.changed")).toEqual([])
    expect(unauthed.notifications.filter((notice) => notice.method === "fleet.changed")).toEqual([])
  })

  it("refreshes an enrolled peer after restart and revocation", async () => {
    const source = await machine("source studio")
    const target = await machine("target studio")
    await enroll(source, target)
    const before = remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id)
    target.root.socket.close()
    await target.handle.stop()
    await vi.waitFor(async () => {
      expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id).health).toBe("reconnecting")
    }, { timeout: 3_000 })
    const failed = remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id)
    expect(Date.parse(failed.heartbeat.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(before.heartbeat.lastSeenAt))
    // Failure and mere relisting must never become fresh contact.
    expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id).heartbeat.lastSeenAt)
      .toBe(failed.heartbeat.lastSeenAt)
    const identityPath = join(target.homeDirectory, ".domovoi", "machine.json")
    const identity = JSON.parse(await readFile(identityPath, "utf8")) as { id: string; label: string }
    await writeFile(identityPath, JSON.stringify({ ...identity, label: "target renamed" }))
    const restarted = await target.start({ port: target.address.port })
    const selfFacts = remote(fleetSnapshotSchema.parse(await restarted.root.ok("fleet.list", {})), target.id)
    await vi.waitFor(async () => {
      const refreshed = remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id)
      expect(refreshed).toMatchObject({ label: "target renamed", health: "healthy" })
      expect(refreshed.transports).toEqual(selfFacts.transports)
      expect(refreshed.verifiedRoute?.endpoint).toBe(target.address.url)
      expect(Date.parse(refreshed.heartbeat.lastSeenAt)).toBeGreaterThan(Date.parse(failed.heartbeat.lastSeenAt))
    }, { timeout: 3_000 })
    const deviceList = await restarted.root.ok("device.list", {}) as { devices: Array<{ id: string }> }
    await restarted.root.ok("device.revoke", { deviceId: deviceList.devices[0]!.id, client: "cli" })
    await vi.waitFor(async () => {
      expect(remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), target.id).health).toBe("pairing-required")
    }, { timeout: 3_000 })
  })

  it.each(["normal", "overflow", "forgetting"] as const)("checks real transfer eligibility independently of fleet display: %s", async (scenario) => {
    const source = await machine("source studio", sessionAgent)
    const target = await machine("target studio")
    const sourceRepository = await repository("source")
    const targetRepository = join(await scratch(), "target")
    await git(sourceRepository, ["clone", "--no-local", sourceRepository, targetRepository])
    await git(targetRepository, ["config", "core.autocrlf", "false"])
    await target.root.ok("project.open", { path: targetRepository, client: "cli" })
    await source.root.ok("project.open", { path: sourceRepository, client: "cli" })
    const created = workspaceSnapshotSchema.parse(await source.root.ok("session.create", {
      title: "Fleet assembly session", client: "cli", runtime: { provider: "claude-code", model: "claude-opus-5", reasoning: "high", permissionMode: "build", auto: true },
    }))
    const session = created.sessions[0]!
    await writeFile(join(session.workspacePath!, "work.txt"), "uncommitted work travels\n")
    await source.root.ok("plan.edit", {
      sessionId: session.id, basedOnStructureRevision: 0, baseSteps: [], draftSteps: [{ text: "Check the transferred work" }], client: "cli",
    })
    const plan = workspaceSnapshotSchema.parse(await source.root.ok("workspace.get", {}))
    await enroll(source, target)
    if (scenario !== "normal") {
      for (let index = 0; index < maximumFleetEntries; index += 1) {
        source.credentials.save(`machine-${index.toString(16).padStart(32, "0")}`, "n".repeat(43))
      }
      expect((await source.root.call("fleet.list", {})).error?.code).toBe(fleetSnapshotOverflowErrorCode)
    }
    if (scenario === "forgetting") {
      // Retain both the known row and usable key while the lifecycle operation
      // is pending. A raw facts lookup would wrongly dial this peer again.
      vi.spyOn(source.credentials, "forget").mockImplementation(() => { throw new Error("keychain removal blocked") })
      const credential = source.credentials.forMachine(target.id)
      if (credential === undefined) throw new Error("Enrollment retained no credential")
      persistedRegistry(source.homeDirectory, (registry) => registry.stageForget(target.id, machineCredentialDigest(target.id, credential), Date.now()))
    }
    const request = { sessionId: session.id, targetMachineId: target.id, method: "git-bundle" as const, initiatedByClient: "cli" as const }
    const preview = rpcMethods["session.transferPreview"].result.parse(await source.root.ok("session.transferPreview", request))
    if (scenario === "forgetting") {
      expect(preview).toMatchObject({ allowed: false, reason: "target-unreachable" })
      expect(persistedRegistry(source.homeDirectory, (registry) => registry.pendingOperations()))
        .toContainEqual(expect.objectContaining({ machineId: target.id, kind: "forget" }))
      return
    }
    expect(preview.allowed).toBe(true)
    if (!preview.allowed) throw new Error(`Transfer preview refused: ${preview.reason}`)
    const moved = rpcMethods["session.transfer"].result.parse(await source.root.ok("session.transfer", {
      ...request, contractVersion: preview.contractVersion, intentDigest: preview.intentDigest,
    }))
    expect(moved.outcome).toBe("succeeded")
    if (moved.outcome !== "succeeded") throw new Error(`Transfer did not finish: ${JSON.stringify(moved)}`)
    expect(await readFile(join(moved.workspacePath, "work.txt"), "utf8")).toBe("uncommitted work travels\n")
    const arrived = workspaceSnapshotSchema.parse(await target.root.ok("workspace.get", {}))
    expect(arrived.sessions).toContainEqual(expect.objectContaining({ id: session.id, state: "idle", runtime: { ...session.runtime, auto: false },
      ownershipGeneration: moved.ownershipGeneration, transferredFrom: expect.objectContaining({ sourceMachineId: source.id, transferId: moved.transferId }) }))
    expect(arrived.workingPlans[0]?.steps).toEqual(plan.workingPlans[0]?.steps)
    expect(arrived.thread).toEqual(expect.arrayContaining(created.thread))
    const sourceAfter = workspaceSnapshotSchema.parse(await source.root.ok("workspace.get", {}))
    expect(sourceAfter.sessions[0]?.state).toBe("transferred")
    expect(await readFile(join(session.workspacePath!, "work.txt"), "utf8")).toBe("uncommitted work travels\n")
    expect((await source.root.call("session.send", { sessionId: session.id, prompt: "must not run", client: "cli" })).error).toBeDefined()
  }, 30_000)
})
