import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"
import { demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { DomovoiDaemon } from "./server.js"
import { FileSkillCatalog } from "./skills.js"
import { SqliteWorkspaceStore } from "./store.js"

const content = [
  "---",
  "name: reviewed",
  "description: Reviewed instructions.",
  "domovoi:",
  "  manifest:",
  "    version: 2",
  "    capabilities: [network.connect, process.execute]",
  "    scopes:",
  "      - capability: network.connect",
  "        scope:",
  "          kind: hosts",
  "          hosts: [api.example.test]",
  "      - capability: process.execute",
  "        scope:",
  "          kind: commands",
  "          commands:",
  "            - executable: pnpm",
  "              args: [test]",
  "---",
  "",
  "# Instructions",
  "\tKeep the reviewed whitespace 🙂",
  "",
].join("\r\n")

const running = new Set<DomovoiDaemon>()
const directories: string[] = []
afterEach(async () => {
  for (const daemon of running) await daemon.stop()
  running.clear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function start(root: string, initial: WorkspaceSnapshot) {
  const store = new SqliteWorkspaceStore(join(root, "state.sqlite"), initial)
  const catalog = new FileSkillCatalog([{ path: join(root, "skills"), scope: "user", source: "domovoi" }], store.skillReviews)
  const daemon = new DomovoiDaemon({ port: 0, store, skillCatalog: catalog, errorSink: vi.fn() })
  running.add(daemon)
  const address = await daemon.start()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  await new Promise<void>((resolve) => socket.once("open", resolve))
  let nextId = 0
  const rpc = (method: string, params: Record<string, unknown>) => {
    const id = ++nextId
    return new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  expect(await rpc("system.hello", {
    authToken: daemon.authToken,
    client: "desktop",
    clientId: "reviewer",
    clientVersion: "0.0.1",
    protocolVersion,
  })).toHaveProperty("result")
  const skill = (await catalog.list())[0]!
  return {
    root, initial, store, catalog, rpc, skill,
    skillPath: join(root, "skills", "reviewed", "SKILL.md"),
    async stop() {
      socket.close()
      await daemon.stop()
      running.delete(daemon)
    },
  }
}

async function fixture(seededReview?: "current" | "other") {
  const root = await mkdtemp(join(tmpdir(), "domovoi-skill-evidence-"))
  directories.push(root)
  await mkdir(join(root, "skills", "reviewed"), { recursive: true })
  await writeFile(join(root, "skills", "reviewed", "SKILL.md"), content)
  const initial = structuredClone(demoWorkspace)
  initial.sessions = []
  initial.activeSessionId = null
  initial.thread = []
  initial.approvals = []
  initial.workingPlans = []
  initial.artifacts = []
  initial.annotations = []
  initial.skillEnablements = []
  initial.project = { ...initial.project!, path: root }
  if (seededReview) {
    const catalog = new FileSkillCatalog([{ path: join(root, "skills"), scope: "user", source: "domovoi" }])
    const skill = (await catalog.list())[0]!
    initial.skillEnablements.push({
      projectId: seededReview === "current" ? initial.project.id : "other-project",
      skillId: skill.id,
      contentDigest: skill.contentDigest,
      manifest: skill.manifest,
      enabled: true,
      reviewedAt: "2026-09-10T00:00:00.000Z",
      reviewedBy: { client: "desktop" },
    })
  }
  return start(root, initial)
}

describe("skill review evidence RPC", () => {
  it("retains the exact approved revision after the source changes and the daemon restarts", async () => {
    const first = await fixture()
    const params = { id: first.skill.id, contentDigest: first.skill.contentDigest }
    expect(await first.rpc("skill.setEnabled", { ...params, enabled: true, manifest: first.skill.manifest })).toHaveProperty("result")
    await writeFile(first.skillPath, content.replace("Keep the reviewed whitespace", "New instructions"))
    first.catalog.invalidate()
    expect((await first.catalog.read(first.skill.id)).skill.contentDigest).not.toBe(first.skill.contentDigest)
    const expected = { ...params, state: "available", content, bytes: Buffer.byteLength(content) }
    expect(await first.rpc("skill.reviewRevision", params)).toMatchObject({ result: expected })
    expect(JSON.stringify(first.store.load())).not.toContain("Keep the reviewed whitespace")
    await first.stop()
    const restarted = await start(first.root, first.initial)
    expect(await restarted.rpc("skill.reviewRevision", params)).toMatchObject({ result: expected })
  })

  it("retains manual approvals and requires an active matching review to retrieve them", async () => {
    const { store, skill, rpc } = await fixture()
    const params = { id: skill.id, contentDigest: skill.contentDigest }
    store.skillReviews.revisions.retain(skill.contentDigest, content)
    expect(await rpc("skill.reviewRevision", params)).toMatchObject({ result: { state: "unavailable", reason: "not-retained" } })
    expect(await rpc("skill.review", { ...params, decision: "trust" })).toHaveProperty("result")
    expect(await rpc("skill.reviewRevision", params)).toMatchObject({ result: { state: "available", content } })
    expect(await rpc("skill.reviewRevision", { ...params, id: "skill-000000000000" })).toMatchObject({ result: { state: "unavailable" } })
    expect(await rpc("skill.review", { ...params, decision: "revoke" })).toHaveProperty("result")
    expect(await rpc("skill.reviewRevision", params)).toMatchObject({ result: { state: "unavailable" } })
  })

  it("reports legacy review metadata without retained text as unavailable", async () => {
    const { skill, rpc } = await fixture("current")
    expect(await rpc("skill.reviewRevision", { id: skill.id, contentDigest: skill.contentDigest })).toMatchObject({
      result: { id: skill.id, contentDigest: skill.contentDigest, state: "unavailable", reason: "not-retained" },
    })
  })

  it("does not expose retained text through another project's review", async () => {
    const { store, skill, rpc } = await fixture("other")
    store.skillReviews.revisions.retain(skill.contentDigest, content)
    expect(await rpc("skill.reviewRevision", { id: skill.id, contentDigest: skill.contentDigest })).toMatchObject({ result: { state: "unavailable" } })
  })

  it("accepts reordered declarations but refuses changed scopes before recording approval", async () => {
    const { store, skill, rpc } = await fixture()
    expect(skill.manifest.version).toBe(2)
    if (skill.manifest.version !== 2) throw new Error("Expected a scoped manifest")
    const params = { id: skill.id, contentDigest: skill.contentDigest, enabled: true }
    expect(await rpc("skill.setEnabled", {
      ...params,
      manifest: { ...skill.manifest, scopes: skill.manifest.scopes.map((scope) => ({ ...scope, scope: { kind: "all" } })) },
    })).toMatchObject({ error: { code: -32602 } })
    expect(store.load().skillEnablements).toEqual([])
    expect(await rpc("skill.setEnabled", {
      ...params,
      manifest: { ...skill.manifest, capabilities: [...skill.manifest.capabilities].reverse(), scopes: [...skill.manifest.scopes].reverse() },
    })).toHaveProperty("result")
    expect(store.load().skillEnablements[0]?.manifest).toEqual(skill.manifest)
  })

  it.each(["skill.setEnabled", "skill.review"])("does not approve via %s if retaining its evidence fails", async (method) => {
    const { store, skill, rpc } = await fixture()
    vi.spyOn(store.skillReviews.revisions, "retain").mockImplementation(() => { throw new Error("disk full") })
    const params = { id: skill.id, contentDigest: skill.contentDigest }
    expect(await rpc(method, method === "skill.review" ? { ...params, decision: "trust" } : { ...params, enabled: true, manifest: skill.manifest })).toHaveProperty("error")
    expect(store.load().skillEnablements).toEqual([])
    expect(store.skillReviews.find(skill.id, skill.contentDigest)).toBeUndefined()
  })
})
