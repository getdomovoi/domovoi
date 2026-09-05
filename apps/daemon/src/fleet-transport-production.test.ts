import { execFile } from "node:child_process"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { fleetSnapshotSchema, rpcMethods, workspaceSnapshotSchema } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { machineCredentialDigest } from "./machine-credentials.js"
import { OperationDeadline } from "./operation-deadline.js"
import { withinServiceDeadline } from "./service/deadline.js"
import { fleetProductionHarness, git, persistedRegistry, remote, sessionAgent } from "./test-fleet-production.js"
import { waitForDaemon } from "./test-wait-for.js"

const { cleanup, scratch, repository, machine, enroll } = fleetProductionHarness()
afterEach(cleanup)

describe("production transport producers", () => {
  it("publishes a configured tailnet endpoint through the real TLS listener with its actual port", async () => {
    const deadline = OperationDeadline.start(30_000)
    try {
      const folder = await withinServiceDeadline(deadline, scratch)
      const certPath = join(folder, "cert.pem")
      const keyPath = join(folder, "key.pem")
      const configPath = join(folder, "openssl.cnf")
      await withinServiceDeadline(deadline, () => writeFile(configPath,
        "[req]\ndistinguished_name=dn\nx509_extensions=names\n[dn]\n[names]\nsubjectAltName=DNS:localhost\n"))
      await withinServiceDeadline(deadline, () => promisify(execFile)("openssl", [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
        "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
        "-config", configPath,
      ], { signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()) }))
      await withinServiceDeadline(deadline, () => chmod(keyPath, 0o600))
      const ca = await withinServiceDeadline(deadline, () => readFile(certPath))
      const daemon = await withinServiceDeadline(deadline, () => machine("TLS studio", undefined, {
        environment: { DOMOVOI_HOST: "0.0.0.0", DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
          DOMOVOI_TLS_CERT_PATH: certPath, DOMOVOI_TLS_KEY_PATH: keyPath,
          DOMOVOI_ADVERTISE_HOST: "localhost", DOMOVOI_TAILNET_HOST: "studio.tailnet.example" },
        clientOptions: { ca },
      }))
      const facts = remote(fleetSnapshotSchema.parse(await withinServiceDeadline(deadline, () => daemon.root.ok("fleet.list", {}))), daemon.id)
      expect(daemon.address.url).toBe(`wss://localhost:${daemon.address.port}/rpc`)
      expect(facts.transports).toEqual([
        { kind: "local", endpoint: `wss://localhost:${daemon.address.port}/rpc`, authenticated: true },
        { kind: "tailnet", endpoint: `wss://studio.tailnet.example:${daemon.address.port}/rpc`, authenticated: true },
      ])
    } finally { deadline.clear() }
  }, 30_000)

  it.each(["transfer", "forgetting"] as const)("uses only source-configured SSH endpoints for an eligible peer: %s", async (scenario) => {
    const source = await machine("source studio", sessionAgent)
    const target = await machine("target studio")
    const sourceRepository = await repository("source")
    const targetRepository = join(await scratch(), "target")
    await git(sourceRepository, ["clone", "--no-local", sourceRepository, targetRepository])
    await target.root.ok("project.open", { path: targetRepository, client: "cli" })
    await source.root.ok("project.open", { path: sourceRepository, client: "cli" })
    const created = workspaceSnapshotSchema.parse(await source.root.ok("session.create", {
      title: "SSH route session", client: "cli", runtime: { provider: "claude-code", model: "claude-opus-5",
        reasoning: "high", permissionMode: "build", auto: false },
    }))
    await enroll(source, target)
    source.root.socket.close()
    await source.handle.stop()
    const credential = source.credentials.forMachine(target.id)!
    const digest = machineCredentialDigest(target.id, credential)
    // Both real daemons run on loopback. The target socket stands in for an
    // operator-maintained SSH forward; no SSH encryption claim is tested here.
    // Port zero is never a bound listener. Make the formerly verified direct
    // route unusable without a racy reserve-and-close port fixture.
    const unreachable = "ws://127.0.0.1:0/rpc"
    persistedRegistry(source.homeDirectory, (registry) => {
      const entry = registry.enrolled().find((row) => row.facts.id === target.id)!
      registry.refreshAuthenticated({ ...entry.facts,
        verifiedRoute: { endpoint: unreachable, lastAuthenticatedAt: entry.facts.verifiedRoute!.lastAuthenticatedAt },
      }, digest, Date.now())
      if (scenario === "forgetting") registry.stageForget(target.id, digest, Date.now())
    })
    if (scenario === "forgetting") {
      vi.spyOn(source.credentials, "forget").mockImplementation(() => { throw new Error("keychain removal blocked") })
    }
    const restarted = await source.start({ environment: {
      DOMOVOI_SSH_TUNNELS: JSON.stringify([{ machineId: target.id, endpoint: target.address.url }]),
    } })
    const request = { sessionId: created.sessions[0]!.id, targetMachineId: target.id,
      method: "git-bundle" as const, initiatedByClient: "cli" as const }
    if (scenario === "forgetting") {
      expect(await restarted.root.ok("session.transferPreview", request)).toMatchObject({ allowed: false, reason: "target-unreachable" })
      expect(fleetSnapshotSchema.parse(await restarted.root.ok("fleet.list", {})).entries)
        .toContainEqual(expect.objectContaining({ kind: "pending", machineId: target.id, operation: "forget" }))
      return
    }
    await waitForDaemon(async () => {
      const facts = remote(fleetSnapshotSchema.parse(await restarted.root.ok("fleet.list", {})), target.id)
      expect(facts.health).toBe("healthy")
      expect(facts.verifiedRoute?.endpoint).toBe(unreachable)
    })
    const preview = rpcMethods["session.transferPreview"].result.parse(await restarted.root.ok("session.transferPreview", request))
    expect(preview.allowed, JSON.stringify(preview)).toBe(true)
    if (!preview.allowed) throw new Error(preview.reason)
    expect(await restarted.root.ok("session.transfer", { ...request,
      contractVersion: preview.contractVersion, intentDigest: preview.intentDigest,
    })).toMatchObject({ outcome: "succeeded" })
    const arrived = workspaceSnapshotSchema.parse(await target.root.ok("workspace.get", {}))
    expect(arrived.sessions).toContainEqual(expect.objectContaining({ id: request.sessionId, state: "idle" }))
    restarted.root.socket.close()
    await restarted.handle.stop()
    const removed = await source.start()
    await waitForDaemon(async () => {
      const facts = remote(fleetSnapshotSchema.parse(await removed.root.ok("fleet.list", {})), target.id)
      expect(facts.health).toBe("reconnecting")
      expect(facts.verifiedRoute?.endpoint).toBe(unreachable)
    })
  }, 30_000)
})
