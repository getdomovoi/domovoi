import { demoWorkspace, serviceHandoffRefusal, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { readLocalServiceHandoffRefusal } from "./local-service-handoff.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

const daemons: DomovoiDaemon[] = []

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

async function daemonWith(workspace: WorkspaceSnapshot) {
  const daemon = new DomovoiDaemon({ port: 0, store: new SqliteWorkspaceStore(":memory:", workspace), agents: {} })
  daemons.push(daemon)
  const address = await daemon.start()
  return { url: `ws://${address.host}:${address.port}/rpc`, token: daemon.authToken }
}

function quiet(): WorkspaceSnapshot {
  const next = structuredClone(demoWorkspace)
  for (const session of next.sessions) { delete (session as { activeTurnId?: string }).activeTurnId; session.state = "idle" }
  next.approvals = []
  return next
}

describe("the desktop's own check before a service handoff", () => {
  it("reads the daemon's workspace and finds nothing in flight", async () => {
    const endpoint = await daemonWith(quiet())
    await expect(readLocalServiceHandoffRefusal({ endpoint, timeoutMs: 5_000 })).resolves.toBeUndefined()
  })

  it("names a waiting gate from the daemon's own workspace, as the renderer would", async () => {
    const workspace = quiet()
    const session = workspace.sessions[0]!
    workspace.approvals = [{ ...demoWorkspace.approvals[0]!, sessionId: session.id }]
    const endpoint = await daemonWith(workspace)
    const refusal = await readLocalServiceHandoffRefusal({ endpoint, timeoutMs: 5_000 })
    expect(refusal).toBe(serviceHandoffRefusal(workspace))
    expect(refusal).toContain("1 gate is waiting")
  })

  it("throws when the daemon cannot be read, rather than allowing the handoff", async () => {
    const endpoint = await daemonWith(quiet())
    await expect(readLocalServiceHandoffRefusal({ endpoint: { ...endpoint, token: "x".repeat(43) }, timeoutMs: 5_000 })).rejects.toThrow()
    await expect(readLocalServiceHandoffRefusal({ endpoint: { url: "http://127.0.0.1:1/rpc", token: endpoint.token }, timeoutMs: 5_000 })).rejects.toThrow()
  })
})
