import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, type ProviderModel } from "@getdomovoi/protocol"

import {
  appendPlanDelta,
  artifactAccessMatches,
  canServeArtifacts,
  frameAncestorsFor,
  DomovoiDaemon,
  hostAuthorityMatches,
  signArtifactAccess,
} from "./server.js"
import type { AgentAdapter, AgentEvent } from "./codex.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { SkillCatalog } from "./skills.js"
import type { WorkspaceService } from "./workspace.js"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []

const codexModels = () => [{
  provider: "codex" as const,
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  description: "Coding model",
  supportedReasoningEfforts: ["none", "medium", "high", "xhigh", "max"],
  defaultReasoningEffort: "xhigh",
  isDefault: true,
}]

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("DomovoiDaemon", () => {
  it("migrates turn-scoped plan artifacts into one session plan", () => {
    const artifacts = [
      {
        id: "plan-session-a-turn-1",
        sessionId: "session-a",
        title: "Working plan",
        type: "plan" as const,
        revision: 1,
        mimeType: "text/markdown",
        content: "1. Inspect.\n",
      },
      {
        id: "preview-a",
        sessionId: "session-a",
        title: "Preview",
        type: "preview" as const,
        revision: 1,
      },
      {
        id: "plan-session-a-turn-2",
        sessionId: "session-a",
        title: "Working plan",
        type: "plan" as const,
        revision: 2,
        mimeType: "text/markdown",
        content: "2. Implement.\n",
      },
    ]

    const annotations = [{
      id: "annotation-a",
      sessionId: "session-a",
      artifactId: "plan-session-a-turn-2",
      anchor: { textQuote: "Implement" },
      body: "Keep this step.",
      status: "open" as const,
      origin: "desktop" as const,
      thread: [],
      createdAt: "2026-08-26T20:00:00.000Z",
      updatedAt: "2026-08-26T20:00:00.000Z",
    }]

    expect(appendPlanDelta(artifacts, annotations, "session-a", "3. Verify.")).toMatchObject({
      id: "plan-session-a",
      revision: 4,
      content: "1. Inspect.\n2. Implement.\n3. Verify.",
    })
    expect(artifacts.filter((artifact) => artifact.type === "plan")).toHaveLength(1)
    expect(artifacts.find((artifact) => artifact.id === "preview-a")).toBeDefined()
    expect(annotations[0]!.artifactId).toBe("plan-session-a")
  })

  it("requires signed access for preview documents outside loopback", () => {
    expect(canServeArtifacts("127.0.0.1")).toBe(true)
    expect(canServeArtifacts("::1")).toBe(true)
    expect(canServeArtifacts("100.64.0.10")).toBe(false)
    expect(canServeArtifacts("100.64.0.10", true)).toBe(true)
    expect(canServeArtifacts("0.0.0.0")).toBe(false)
  })

  it("scopes artifact access to id, bridge channel, and expiry", () => {
    const signature = signArtifactAccess(
      "artifact-secret",
      "preview-1",
      "preview_channel_123456",
      1_800_000_000,
    )
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-1",
      "preview_channel_123456",
      1_800_000_000,
      signature,
      1_799_999_999,
    )).toBe(true)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-2",
      "preview_channel_123456",
      1_800_000_000,
      signature,
      1_799_999_999,
    )).toBe(false)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-1",
      "preview_channel_changed",
      1_800_000_000,
      signature,
      1_799_999_999,
    )).toBe(false)
    expect(artifactAccessMatches(
      "artifact-secret",
      "preview-1",
      "preview_channel_123456",
      1_800_000_000,
      signature,
      1_800_000_001,
    )).toBe(false)
  })

  it("limits preview embedding to configured browser origins", () => {
    expect(frameAncestorsFor([
      "https://app.domovoi.sh",
      "http://localhost:5178",
      "file://",
      "javascript:alert(1)",
      "not a URL",
    ])).toBe("https://app.domovoi.sh http://localhost:5178 file:")
  })

  it("normalizes loopback Host authorities without widening them", () => {
    expect(hostAuthorityMatches("[::1]:47831", "::1", 47831)).toBe(true)
    expect(hostAuthorityMatches("localhost:47831", "::1", 47831)).toBe(true)
    expect(hostAuthorityMatches("127.0.0.1:47831", "127.0.0.1", 47831)).toBe(true)
    expect(hostAuthorityMatches("localhost:47832", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("attacker.example:47831", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1", "127.0.0.1", 80)).toBe(true)
    expect(hostAuthorityMatches("localhost", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("user@127.0.0.1:47831", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1:47831/path", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1:47831?query", "127.0.0.1", 47831)).toBe(false)
    expect(hostAuthorityMatches("127.0.0.1:47831#fragment", "127.0.0.1", 47831)).toBe(false)
  })

  it("refuses an unauthenticated non-loopback listener", () => {
    expect(() => new DomovoiDaemon({
      host: "0.0.0.0",
      port: 0,
      statePath: ":memory:",
    })).toThrow("Non-loopback listeners require explicit protected-transport opt-in")
    expect(() => new DomovoiDaemon({
      host: "0.0.0.0",
      port: 0,
      statePath: ":memory:",
      allowRemoteTransport: true,
    })).toThrow("A daemon token is required outside loopback")
  })

  it("serves remote previews only with a signed capability", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-remote-artifact-"))
    scratchDirectories.push(scratch)
    await writeFile(join(scratch, "preview.html"), "<h1>Remote preview</h1>")
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    session.workspacePath = scratch
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === "artifact-preview")!
    artifact.path = "preview.html"
    artifact.mimeType = "text/html"
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      host: "0.0.0.0",
      port: 0,
      allowRemoteTransport: true,
      authToken: "remote-daemon-token",
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }
    await rpc("system.hello", {
      client: "web",
      clientVersion: "0.0.1",
      authToken: "remote-daemon-token",
    })
    const accessResponse = await rpc("artifact.authorize", {
      artifactId: artifact.id,
      client: "web",
    })
    const access = accessResponse.result as { expiresAt: number; signature: string }
    const baseUrl = `http://${address.host}:${address.port}/artifacts/${artifact.id}`

    expect((await fetch(baseUrl)).status).toBe(404)
    const authorized = await fetch(
      `${baseUrl}?expires=${access.expiresAt}&signature=${access.signature}`,
    )
    expect(authorized.status).toBe(200)
    await expect(authorized.text()).resolves.toBe("<h1>Remote preview</h1>")
    expect((await fetch(
      `${baseUrl}?expires=${access.expiresAt}&signature=${"x".repeat(43)}`,
    )).status).toBe(404)
    socket.close()
  })

  it("requires the configured token before serving daemon state", async () => {
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", demoWorkspace),
      authToken: "correct-horse-battery-staple",
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const unauthenticated = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const unauthenticatedMessages: Array<Record<string, unknown>> = []
    unauthenticated.on("message", (data) => {
      unauthenticatedMessages.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await new Promise<void>((resolve, reject) => {
      unauthenticated.once("open", resolve)
      unauthenticated.once("error", reject)
    })
    const rpc = (id: number, method: string, params: Record<string, unknown>) => {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await expect(rpc(1, "workspace.get", {})).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication required" },
    })
    await expect(rpc(2, "system.hello", {
      client: "web",
      clientVersion: "0.0.1",
      authToken: "wrong-token",
    })).resolves.toMatchObject({
      error: { code: -32001, message: "Daemon authentication failed" },
    })
    await expect(rpc(3, "system.hello", {
      client: "web",
      clientVersion: "0.0.1",
      authToken: "correct-horse-battery-staple",
    })).resolves.toMatchObject({ result: { machine: { id: expect.any(String) } } })
    await expect(rpc(4, "workspace.get", {})).resolves.toMatchObject({
      result: { project: { id: "project-acme-api" } },
    })
    await expect(rpc(5, "session.activate", {
      sessionId: "session-audit",
      client: "web",
    })).resolves.toMatchObject({ result: { activeSessionId: "session-audit" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(unauthenticatedMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "workspace.changed" }),
    ]))

    const pipelined = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      pipelined.once("open", resolve)
      pipelined.once("error", reject)
    })
    const pipelinedResponses = new Map<number, Record<string, unknown>>()
    const receivedBoth = new Promise<void>((resolve) => {
      pipelined.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown> & { id?: number }
        if (message.id === 6 || message.id === 7) pipelinedResponses.set(message.id, message)
        if (pipelinedResponses.size === 2) resolve()
      })
    })
    pipelined.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "system.hello",
      params: {
        client: "web",
        clientVersion: "0.0.1",
        authToken: "correct-horse-battery-staple",
      },
    }))
    pipelined.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "runtime.models",
      params: { provider: "codex", client: "web" },
    }))
    await receivedBoth
    expect(pipelinedResponses.get(6)).toHaveProperty("result")
    expect(pipelinedResponses.get(7)).toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    pipelined.close()

    const attacker = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      attacker.once("open", resolve)
      attacker.once("error", reject)
    })
    const rejected = new Promise<{ code: number; reason: string }>((resolve) => {
      attacker.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    for (const id of [8, 9, 10]) {
      attacker.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "system.hello",
        params: { client: "web", clientVersion: "0.0.1", authToken: "wrong-token" },
      }))
    }
    await expect(rejected).resolves.toEqual({ code: 1008, reason: "authentication failed" })
    unauthenticated.close()
    socket.close()
  })

  it("closes sockets that never authenticate", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      authToken: "correct-horse-battery-staple",
      authTimeoutMs: 10,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    })

    await expect(closed).resolves.toEqual({ code: 1008, reason: "authentication timeout" })
  })

  it("interrupts scoped and global turns and records who paused them", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.sessions[0]!.state = "active"
    snapshot.sessions[0]!.runtime.provider = "codex"
    snapshot.sessions[0]!.providerThreadId = "thread-billing"
    snapshot.sessions[0]!.activeTurnId = "turn-billing"
    snapshot.sessions[1]!.providerThreadId = "thread-onboarding"
    snapshot.sessions[1]!.activeTurnId = "turn-onboarding"
    snapshot.sessions[2]!.state = "active"
    snapshot.sessions[2]!.runtime.provider = "codex"
    snapshot.sessions[2]!.providerThreadId = "thread-audit"
    snapshot.sessions[2]!.activeTurnId = "turn-audit"
    const agentListeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async (threadId: string) => {
        if (threadId === "thread-audit") await new Promise<void>(() => {})
      }),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
      agentTimeoutMs: 10,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.pause",
      params: { sessionId: "session-billing", client: "phone" },
    }))

    await expect(response).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-billing", state: "idle" }),
          expect.objectContaining({ id: "session-onboarding", state: "active" }),
        ]),
        approvals: [],
        thread: expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session-billing",
            kind: "system",
            body: "Paused by phone.",
          }),
        ]),
      },
    })
    expect(agent.interruptTurn).toHaveBeenCalledOnce()
    expect(agent.interruptTurn).toHaveBeenCalledWith("thread-billing", "turn-billing")

    const globalResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 2) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "system.pauseAll",
      params: { client: "tablet" },
    }))
    await expect(globalResponse).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-onboarding", state: "idle" }),
          expect.objectContaining({
            id: "session-audit",
            state: "active",
            activeTurnId: "turn-audit",
          }),
        ]),
        thread: expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session-onboarding",
            kind: "system",
            body: "Paused by tablet.",
          }),
          expect.objectContaining({
            sessionId: "session-audit",
            kind: "system",
            body: "Pause failed for tablet.",
            detail: "Agent interrupt timed out",
          }),
        ]),
      },
    })
    expect(agent.interruptTurn).toHaveBeenCalledTimes(3)
    expect(agent.interruptTurn).toHaveBeenCalledWith("thread-onboarding", "turn-onboarding")
    expect(agent.interruptTurn).toHaveBeenCalledWith("thread-audit", "turn-audit")

    for (const listener of agentListeners) {
      listener({
        type: "approval-requested",
        requestId: 99,
        threadId: "thread-billing",
        turnId: "turn-billing",
        command: "pnpm deploy",
      })
    }
    const afterLateApproval = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 3) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "workspace.get", params: {} }))
    await expect(afterLateApproval).resolves.toMatchObject({ result: { approvals: [] } })
    socket.close()
  })

  it("serves an empty initial workspace over JSON-RPC", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "system.hello",
            params: { client: "desktop", clientVersion: "0.0.1" },
          }),
        )
      })
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        project: null,
        sessions: [],
        activeSessionId: null,
      },
    })

    const rejectedSession = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 2) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.create",
      params: {
        title: "Should not start",
        runtime: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoning: "medium",
          permissionMode: "ask",
          auto: false,
        },
        client: "desktop",
      },
    }))
    await expect(rejectedSession).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "Open a valid Git repository with project.open before creating a session",
      },
    })
    socket.close()
  })

  it("lists daemon-discovered skills with their provenance", async () => {
    const skillCatalog = {
      list: vi.fn(async () => [{
        id: "skill-4d6f4d6f4d6f",
        name: "repo-audit",
        description: "Audit a repository and render a ranked report.",
        path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
        scope: "user" as const,
        source: "agents" as const,
      }]),
    } satisfies SkillCatalog
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      skillCatalog,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "skill.list",
        params: {},
      })))
      socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    })

    expect(response).toMatchObject({
      result: [expect.objectContaining({
        name: "repo-audit",
        scope: "user",
        source: "agents",
      })],
    })
    expect(skillCatalog.list).toHaveBeenCalledOnce()
    socket.close()
  })

  it("publishes provider readiness discovered on the execution machine", async () => {
    const providerProbe = {
      inspect: vi.fn(async () => [
        { id: "claude-code", command: "claude", status: "ready" as const, version: "2.1.247" },
        { id: "opencode", command: "opencode", status: "missing" as const },
      ]),
    }
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      providerProbe,
    })
    running.push(daemon)
    const address = await daemon.start()
    await vi.waitFor(() => expect(providerProbe.inspect).toHaveBeenCalledOnce())
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "workspace.get",
        params: {},
      })))
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })

    expect(response).toMatchObject({
      result: {
        machine: {
          providers: [
            { id: "claude-code", command: "claude", status: "ready", version: "2.1.247", sessionCapable: true },
            { id: "opencode", command: "opencode", status: "missing", sessionCapable: true },
          ],
        },
      },
    })
    socket.close()
  })

  it("records a project-scoped rule for standing approval", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", demoWorkspace),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const approvalResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: {
        approvalId: "approval-migrate",
        decision: "always-project",
        client: "desktop",
      },
    }))

    await expect(approvalResponse).resolves.toMatchObject({
      result: {
        approvals: [],
        approvalRules: [
          expect.objectContaining({
            projectId: "project-acme-api",
            operation: "Apply a production database migration",
            command: "pnpm prisma migrate deploy",
            createdBy: "desktop",
          }),
        ],
        thread: expect.arrayContaining([
          expect.objectContaining({
            kind: "receipt",
            decision: "always-project",
            checkpoint: "ckpt_7f21",
            client: "desktop",
          }),
        ]),
      },
    })
    socket.close()
  })

  it("activates an existing session and rejects unknown sessions", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", demoWorkspace),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    const responseFor = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
    })

    const activated = responseFor(1)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.activate",
      params: { sessionId: "session-audit", client: "desktop" },
    }))
    await expect(activated).resolves.toMatchObject({
      result: { activeSessionId: "session-audit" },
    })

    const rejected = responseFor(2)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.activate",
      params: { sessionId: "session-missing", client: "desktop" },
    }))
    await expect(rejected).resolves.toMatchObject({
      error: { code: -32602, message: "Session does not exist" },
    })
    socket.close()
  })

  it("creates, replies to, and resolves anchored annotations", async () => {
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", demoWorkspace),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    const created = await rpc("annotation.create", {
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      variantId: "variant-c",
      anchor: { textQuote: "Replay operations" },
      body: "Keep the progress visible.",
      client: "tablet",
    })
    const annotations = (created.result as { annotations: Array<{ id: string }> }).annotations
    const annotationId = annotations.at(-1)!.id
    expect(annotations.at(-1)).toMatchObject({
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      origin: "tablet",
      status: "open",
      thread: [],
    })

    const replied = await rpc("annotation.reply", {
      annotationId,
      body: "Updated in revision four.",
      client: "desktop",
    })
    expect(replied).toMatchObject({
      result: {
        annotations: expect.arrayContaining([expect.objectContaining({
          id: annotationId,
          thread: [expect.objectContaining({
            body: "Updated in revision four.",
            origin: "desktop",
          })],
        })]),
      },
    })

    const resolved = await rpc("annotation.setStatus", {
      annotationId,
      status: "resolved",
      client: "phone",
    })
    expect(resolved).toMatchObject({
      result: {
        annotations: expect.arrayContaining([expect.objectContaining({
          id: annotationId,
          status: "resolved",
          statusChangedBy: "phone",
        })]),
      },
    })
    socket.close()
  })

  it("sends unresolved annotations with the next agent turn", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    session.runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build",
      auto: false,
    }
    session.workspacePath = "/worktrees/session-billing"
    session.providerThreadId = "provider-thread-billing"
    snapshot.annotations[1]!.status = "resolved"
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "provider-thread-unused"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async (_input: Parameters<AgentAdapter["startTurn"]>[0]) => "provider-turn-review"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      agent,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.send",
      params: {
        sessionId: "session-billing",
        prompt: "Revise the migration plan.",
        client: "desktop",
      },
    }))

    await expect(response).resolves.toMatchObject({ result: { activeSessionId: "session-billing" } })
    expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "provider-thread-billing",
      prompt: expect.stringContaining('"annotationId":"annotation-migration-machine"'),
    }))
    expect(agent.startTurn.mock.calls[0]![0].prompt).not.toContain("annotation-replay-copy")
    socket.close()
  })

  it("shares slow agent initialization across timed-out model requests", async () => {
    let finishConnect: (() => void) | undefined
    let finishModels: (() => void) | undefined
    const models = codexModels()
    const agent = {
      connect: vi.fn(() => new Promise<void>((resolve) => { finishConnect = resolve })),
      listModels: vi.fn(() => new Promise<typeof models>((resolve) => {
        finishModels = () => resolve(models)
      })),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agent,
      agentTimeoutMs: 500,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const rpc = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "runtime.models",
        params: { provider: "codex", client: "desktop" },
      }))
    })

    await expect(rpc(1)).resolves.toMatchObject({ error: { message: "Agent setup timed out" } })
    const second = rpc(2)
    expect(agent.connect).toHaveBeenCalledOnce()
    finishConnect!()
    await vi.waitFor(
      () => expect(agent.listModels).toHaveBeenCalledOnce(),
      { interval: 1, timeout: 100 },
    )
    const third = rpc(3)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agent.listModels).toHaveBeenCalledOnce()
    finishModels!()
    await expect(second).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    await expect(third).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    socket.close()
  })

  it("retries model discovery after an empty catalog", async () => {
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue(codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", agent })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const rpc = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "runtime.models",
        params: { provider: "codex", client: "desktop" },
      }))
    })

    await expect(rpc(1)).resolves.toMatchObject({ result: [] })
    await expect(rpc(2)).resolves.toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol" })],
    })
    expect(agent.listModels).toHaveBeenCalledTimes(2)
    socket.close()
  })

  it("rejects browser connections from an untrusted origin", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    running.push(daemon)
    const address = await daemon.start()

    const status = await new Promise<number | undefined>((resolve) => {
      const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
        origin: "https://malicious.example",
      })
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode))
      socket.once("error", () => resolve(undefined))
    })

    expect(status).toBe(401)
  })

  it("rejects an unexplained denial and records a supplied explanation", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.activeSessionId = "session-onboarding"
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })

    const nextResponse = (id: number) => new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== id) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
    })

    const invalidResponse = nextResponse(1)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: { approvalId: "approval-migrate", decision: "deny-explain", client: "web" },
    }))
    await expect(invalidResponse).resolves.toMatchObject({
      error: { code: -32602, message: "Method parameters are invalid" },
    })

    const explainedResponse = nextResponse(2)
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "approval.resolve",
      params: {
        approvalId: "approval-migrate",
        decision: "deny-explain",
        client: "web",
        explanation: "Run this against staging before production.",
      },
    }))
    await expect(explainedResponse).resolves.toMatchObject({
      result: {
        approvals: [],
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-billing", state: "idle" }),
          expect.objectContaining({ id: "session-onboarding", state: "active" }),
        ]),
        thread: expect.arrayContaining([
          expect.objectContaining({
            kind: "receipt",
            decision: "deny-explain",
            explanation: "Run this against staging before production.",
            client: "web",
          }),
        ]),
      },
    })
    socket.close()
  })

  it("restores JSON-RPC mutations after a daemon restart", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-daemon-"))
    scratchDirectories.push(scratch)
    const statePath = join(scratch, "state.sqlite")
    const initial = structuredClone(demoWorkspace)
    const restoredSession = initial.sessions.find((session) => session.id === "session-billing")!
    restoredSession.runtime.provider = "codex"
    restoredSession.runtime.model = "gpt-5.6-sol"
    restoredSession.workspacePath = "/worktrees/session-billing"
    restoredSession.providerThreadId = "provider-thread-restored"
    const persistedAgent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "unused-turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const first = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(statePath, initial),
      agent: persistedAgent,
    })
    running.push(first)
    const firstAddress = await first.start()
    const firstSocket = new WebSocket(`ws://${firstAddress.host}:${firstAddress.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      firstSocket.once("open", resolve)
      firstSocket.once("error", reject)
    })
    const mutation = new Promise<void>((resolve) => {
      firstSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 1) resolve()
      })
    })
    firstSocket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.setRuntime",
      params: {
        sessionId: "session-billing",
        runtime: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoning: "medium",
          permissionMode: "plan",
          auto: false,
        },
        client: "desktop",
      },
    }))
    await mutation
    firstSocket.close()
    await first.stop()
    running.splice(running.indexOf(first), 1)

    const resumedAgent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "unused-thread"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn-after-restart"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const second = new DomovoiDaemon({ port: 0, statePath, agent: resumedAgent })
    running.push(second)
    const secondAddress = await second.start()
    const secondSocket = new WebSocket(`ws://${secondAddress.host}:${secondAddress.port}/rpc`)
    const restored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      secondSocket.once("error", reject)
      secondSocket.once("open", () => {
        secondSocket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "system.hello",
          params: { client: "desktop", clientVersion: "0.0.1" },
        }))
      })
      secondSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 2) resolve(message as Record<string, unknown>)
      })
    })

    expect(restored).toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({
            id: "session-billing",
            runtime: expect.objectContaining({
              provider: "codex",
              model: "gpt-5.6-sol",
              permissionMode: "plan",
            }),
          }),
        ]),
      },
    })
    const continued = new Promise<Record<string, unknown>>((resolve) => {
      secondSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 3) resolve(message as Record<string, unknown>)
      })
    })
    secondSocket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session.send",
      params: {
        sessionId: "session-billing",
        prompt: "Continue after restart",
        client: "desktop",
      },
    }))
    await expect(continued).resolves.toMatchObject({
      result: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "session-billing", activeTurnId: "turn-after-restart" }),
        ]),
      },
    })
    expect(resumedAgent.resumeThread).toHaveBeenCalledOnce()
    expect(resumedAgent.resumeThread).toHaveBeenCalledWith({
      threadId: "provider-thread-restored",
      cwd: "/worktrees/session-billing",
      runtime: expect.objectContaining({
        provider: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "plan",
      }),
    })
    expect(resumedAgent.resumeThread.mock.invocationCallOrder[0]).toBeLessThan(
      resumedAgent.startTurn.mock.invocationCallOrder[0]!,
    )
    secondSocket.close()
  })

  it("orchestrates a local project, Codex turn, approval, and checkpoint", async () => {
    const agentListeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn()
        .mockImplementationOnce(() => new Promise<string>(() => {}))
        .mockResolvedValue("provider-thread-1"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "provider-turn-1"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(async () => ({
        root: "/code/domovoi",
        name: "domovoi",
        branch: "main",
        head: "a".repeat(40),
      })),
      createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "a".repeat(40),
      })),
      removeSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ commit: "b".repeat(40), changedFiles: ["src/app.ts"] })),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agents: { codex: agent },
      workspaceService,
      agentTimeoutMs: 100,
      modelCacheTtlMs: 0,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    const listedModels = await rpc("runtime.models", {
      provider: "codex",
      client: "desktop",
    })
    expect(listedModels).toMatchObject({
      result: [expect.objectContaining({ id: "gpt-5.6-sol", provider: "codex" })],
    })
    await rpc("runtime.models", { provider: "codex", client: "desktop" })
    expect(agent.listModels).toHaveBeenCalledTimes(2)

    const opened = await rpc("project.open", { path: "/code/domovoi", client: "desktop" })
    expect(opened).toMatchObject({
      result: { project: { name: "domovoi", path: "/code/domovoi", branch: "main" } },
    })

    const runtime = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      permissionMode: "build",
      auto: false,
    }
    const timedOut = await rpc("session.create", {
      title: "Timeout setup",
      runtime,
      client: "desktop",
    })
    expect(timedOut).toMatchObject({ error: { code: -32603, message: "Agent setup timed out" } })
    expect(workspaceService.removeSessionWorkspace).toHaveBeenCalledOnce()

    const created = await rpc("session.create", {
      title: "Build persistence",
      runtime: { ...runtime, model: "default" },
      client: "desktop",
    })
    const createdResult = created.result as { activeSessionId: string; sessions: Array<{ id: string }> }
    const sessionId = createdResult.activeSessionId
    expect(createdResult.sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        workspacePath: `/worktrees/${sessionId}`,
        providerThreadId: "provider-thread-1",
      }),
    ])
    expect(agent.startThread).toHaveBeenCalledWith({
      cwd: `/worktrees/${sessionId}`,
      runtime,
    })

    await rpc("session.send", {
      sessionId,
      prompt: "Run the tests",
      client: "desktop",
    })
    expect(agent.startTurn).toHaveBeenCalledWith({
      threadId: "provider-thread-1",
      cwd: `/worktrees/${sessionId}`,
      prompt: "Run the tests",
      runtime,
    })

    await rpc("session.send", {
      sessionId,
      prompt: "Focus on the failing test first",
      client: "desktop",
    })
    expect(agent.startTurn).toHaveBeenCalledOnce()
    expect(agent.steerTurn).toHaveBeenCalledWith(
      "provider-thread-1",
      "provider-turn-1",
      "Focus on the failing test first",
    )

    for (const listener of agentListeners) {
      listener({
        type: "text-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "Tests are green.",
      })
      listener({
        type: "plan-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "1. Inspect the failing test.\n",
      })
      listener({
        type: "plan-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "2. Fix the implementation.",
      })
      listener({
        type: "plan-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "\n3. Verify the next turn.",
      })
      listener({
        type: "approval-requested",
        requestId: 71,
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        itemId: "command-1",
        command: "pnpm build",
        cwd: `/worktrees/${sessionId}`,
        reason: "Build the project",
      })
    }
    const streamed = await rpc("workspace.get", {})
    expect(streamed).toMatchObject({
      result: {
        thread: expect.arrayContaining([
          expect.objectContaining({ kind: "assistant", body: "Tests are green." }),
        ]),
        artifacts: [expect.objectContaining({
          sessionId,
          type: "plan",
          revision: 3,
          mimeType: "text/markdown",
          content: "1. Inspect the failing test.\n2. Fix the implementation.\n3. Verify the next turn.",
        })],
        approvals: [expect.objectContaining({ providerRequestId: 71, command: "pnpm build" })],
      },
    })

    const approvalId = (streamed.result as { approvals: Array<{ id: string }> }).approvals[0]!.id
    await rpc("approval.resolve", {
      approvalId,
      decision: "allow-once",
      client: "desktop",
    })
    expect(agent.resolveApproval).toHaveBeenCalledWith(71, "allow-once")

    const checkpointed = await rpc("checkpoint.create", {
      sessionId,
      label: "after-tests",
      client: "desktop",
    })
    expect(checkpointed).toMatchObject({
      result: {
        thread: expect.arrayContaining([
          expect.objectContaining({ kind: "checkpoint", label: expect.stringContaining("after-tests") }),
        ]),
      },
    })

    const unsupportedRuntime = await rpc("session.setRuntime", {
      sessionId,
      runtime: { ...runtime, provider: "claude-code", model: "sonnet-4.6" },
      client: "desktop",
    })
    expect(unsupportedRuntime).toMatchObject({
      error: { code: -32602, message: "Stop the active turn before changing providers" },
    })

    const unsupportedReasoning = await rpc("session.setRuntime", {
      sessionId,
      runtime: { ...runtime, reasoning: "impossible" },
      client: "desktop",
    })
    expect(unsupportedReasoning).toMatchObject({
      error: {
        code: -32602,
        message: "Reasoning effort is not supported by the selected model",
      },
    })

    for (const listener of agentListeners) {
      listener({
        type: "turn-completed",
        params: {
          threadId: "provider-thread-1",
          turnId: "provider-turn-1",
          turn: { id: "provider-turn-1", status: "completed" },
        },
      })
    }
    await rpc("workspace.get", {})

    let resolveLateTurn: ((turnId: string) => void) | undefined
    agent.startTurn.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveLateTurn = resolve }),
    )
    const lateTurn = rpc("session.send", {
      sessionId,
      prompt: "Continue after project switch",
      client: "desktop",
    })
    await vi.waitFor(() => expect(agent.startTurn).toHaveBeenCalledTimes(2))
    const reopening = rpc("project.open", { path: "/code/domovoi", client: "desktop" })
    expect(agent.stopThread).not.toHaveBeenCalled()
    resolveLateTurn!("late-turn")
    await expect(lateTurn).resolves.toMatchObject({
      result: {
        thread: expect.arrayContaining([
          expect.objectContaining({ kind: "user", body: "Continue after project switch" }),
        ]),
      },
    })
    const reopened = await reopening
    expect(reopened).toMatchObject({ result: { activeSessionId: null, sessions: [] } })
    expect(agent.stopThread).toHaveBeenCalledWith("provider-thread-1")
    expect(workspaceService.removeSessionWorkspace).toHaveBeenCalledWith(`/worktrees/${sessionId}`)
    socket.close()
  })

  it("routes model discovery and sessions through the requested provider adapter", async () => {
    const makeAgent = (models: ProviderModel[], threadId: string) => ({
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => models),
      startThread: vi.fn(async () => threadId),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "turn"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter)
    const codex = makeAgent(codexModels(), "codex-thread")
    const claude = makeAgent([{
      ...codexModels()[0]!,
      provider: "claude-code",
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
    }], "claude-thread")
    const workspaceService = {
      inspect: vi.fn(async () => ({
        root: "/code/domovoi",
        name: "domovoi",
        branch: "main",
        head: "a".repeat(40),
      })),
      createSessionWorkspace: vi.fn(async (_path: string, sessionId: string) => ({
        path: `/worktrees/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: "a".repeat(40),
      })),
      removeSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ commit: "b".repeat(40), changedFiles: [] })),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agents: { codex, "claude-code": claude },
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await expect(rpc("runtime.models", {
      provider: "claude-code",
      client: "desktop",
    })).resolves.toMatchObject({
      result: [expect.objectContaining({ provider: "claude-code", id: "claude-sonnet-4-6" })],
    })
    await expect(rpc("runtime.models", {
      provider: "opencode",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Agent provider opencode is unavailable" },
    })
    await rpc("project.open", { path: "/code/domovoi", client: "desktop" })
    const created = await rpc("session.create", {
      title: "Claude session",
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        reasoning: "medium",
        permissionMode: "plan",
        auto: false,
      },
      client: "desktop",
    })
    const sessionId = (created.result as { activeSessionId: string }).activeSessionId

    expect(claude.connect).toHaveBeenCalledOnce()
    expect(claude.listModels).toHaveBeenCalledOnce()
    expect(claude.startThread).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({ provider: "claude-code" }),
    }))
    expect(codex.connect).not.toHaveBeenCalled()
    expect(codex.startThread).not.toHaveBeenCalled()

    const handedOff = await rpc("session.setRuntime", {
      sessionId,
      runtime: {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "high",
        permissionMode: "build",
        auto: false,
      },
      client: "desktop",
    })
    expect(handedOff).toMatchObject({
      result: {
        sessions: [expect.objectContaining({
          id: sessionId,
          providerThreadId: "codex-thread",
          runtime: expect.objectContaining({ provider: "codex", model: "gpt-5.6-sol" }),
        })],
        thread: expect.arrayContaining([expect.objectContaining({
          kind: "system",
          body: "Handed off claude-code / claude-sonnet-4-6 to codex / gpt-5.6-sol.",
        })]),
      },
    })
    expect(workspaceService.checkpoint).toHaveBeenCalledWith(
      `/worktrees/${sessionId}`,
      "before provider handoff",
    )
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: `/worktrees/${sessionId}`,
      runtime: expect.objectContaining({ provider: "codex" }),
    }))
    expect(claude.stopThread).toHaveBeenCalledWith("claude-thread")

    await rpc("session.send", { sessionId, prompt: "Inspect the repository", client: "desktop" })
    expect(codex.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "codex-thread",
      prompt: expect.stringMatching(/<domovoi_handoff_context>[\s\S]*Inspect the repository/),
      runtime: expect.objectContaining({ provider: "codex" }),
    }))
    expect(claude.startTurn).not.toHaveBeenCalled()

    await expect(rpc("session.setRuntime", {
      sessionId,
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        reasoning: "medium",
        permissionMode: "plan",
        auto: false,
      },
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Stop the active turn before changing providers" },
    })
    expect(claude.startThread).toHaveBeenCalledOnce()
  })

  it("serves agent-created HTML only from the active session worktree", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-artifact-"))
    scratchDirectories.push(scratch)
    const worktree = join(scratch, "worktree")
    await mkdir(worktree)
    await writeFile(join(worktree, "preview.html"), "<h1>Domovoi preview</h1>")
    await writeFile(join(worktree, "safe.html"), "<h1>Safe preview</h1>")
    await writeFile(join(scratch, "outside.html"), "<h1>Escaped preview</h1>")
    await symlink(join(worktree, "safe.html"), join(worktree, "linked.html"))

    const agentListeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      listModels: vi.fn(async () => codexModels()),
      startThread: vi.fn(async () => "provider-thread-preview"),
      resumeThread: vi.fn(async () => {}),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "provider-turn-preview"),
      steerTurn: vi.fn(async () => {}),
      interruptTurn: vi.fn(async () => {}),
      resolveApproval: vi.fn(),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      }),
      close: vi.fn(async () => {}),
    } satisfies AgentAdapter
    const workspaceService = {
      inspect: vi.fn(async () => ({
        root: scratch,
        name: "domovoi",
        branch: "main",
        head: "a".repeat(40),
      })),
      createSessionWorkspace: vi.fn(async () => ({
        path: worktree,
        branch: "domovoi/preview",
        baseCommit: "a".repeat(40),
      })),
      removeSessionWorkspace: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ commit: "b".repeat(40), changedFiles: [] })),
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      statePath: ":memory:",
      agent,
      workspaceService,
    })
    running.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    let requestId = 0
    const rpc = (method: string, params: Record<string, unknown>) => {
      const id = ++requestId
      const response = new Promise<Record<string, unknown>>((resolve) => {
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as { id?: number }
          if (message.id !== id) return
          socket.off("message", receive)
          resolve(message as Record<string, unknown>)
        }
        socket.on("message", receive)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return response
    }

    await rpc("project.open", { path: scratch, client: "desktop" })
    const created = await rpc("session.create", {
      title: "Preview the plan",
      runtime: {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        permissionMode: "build",
        auto: false,
      },
      client: "desktop",
    })
    const sessionId = (created.result as { activeSessionId: string }).activeSessionId

    for (const listener of agentListeners) {
      listener({
        type: "item",
        phase: "completed",
        params: {
          threadId: "provider-thread-preview",
          item: {
            id: "file-change-preview",
            type: "fileChange",
            changes: [
              { path: "preview.html", kind: "update" },
              { path: "linked.html", kind: "update" },
              { path: join(scratch, "outside.html"), kind: "update" },
            ],
          },
        },
      })
    }

    const snapshot = await rpc("workspace.get", {})
    const artifact = (snapshot.result as {
      artifacts: Array<{ id: string; sessionId: string; type: string }>
    }).artifacts.find((candidate) => candidate.type === "preview")
    expect(artifact).toMatchObject({ sessionId, type: "preview" })
    expect((snapshot.result as { artifacts: unknown[] }).artifacts).toHaveLength(2)

    const accessResponse = await rpc("artifact.authorize", {
      artifactId: artifact!.id,
      bridgeChannel: "preview_channel_123456",
      client: "desktop",
    })
    const access = accessResponse.result as {
      artifactId: string
      bridgeChannel: string
      expiresAt: number
      signature: string
    }
    expect(access).toMatchObject({
      artifactId: artifact!.id,
      bridgeChannel: "preview_channel_123456",
    })
    expect(access.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000))
    expect(access.signature).toMatch(/^[A-Za-z0-9_-]{43}$/)

    await expect(rpc("artifact.authorize", {
      artifactId: "missing-preview",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Preview artifact does not exist" },
    })

    const preview = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(artifact!.id)}`,
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-security-policy")).toContain("default-src 'none'")
    await expect(preview.text()).resolves.toBe("<h1>Domovoi preview</h1>")

    const bridgedPreview = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(artifact!.id)}?bridge=preview_channel_123456&parentOrigin=http%3A%2F%2F127.0.0.1%3A5178`,
    )
    const bridgedContent = await bridgedPreview.text()
    expect(bridgedContent).toContain("domovoi.preview.selection")
    expect(bridgedContent).toContain("preview_channel_123456")
    expect(bridgedContent).toContain(artifact!.id)

    const signedPreview = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(access.artifactId)}?bridge=${access.bridgeChannel}&parentOrigin=http%3A%2F%2F127.0.0.1%3A5178&expires=${access.expiresAt}&signature=${access.signature}`,
    )
    expect(signedPreview.status).toBe(200)
    expect(await signedPreview.text()).toContain("domovoi.preview.selection")

    const invalidBridge = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(artifact!.id)}?bridge=short`,
    )
    await expect(invalidBridge.text()).resolves.toBe("<h1>Domovoi preview</h1>")

    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({
        host: address.host,
        port: address.port,
        path: `/artifacts/${encodeURIComponent(artifact!.id)}`,
        headers: { Host: "malicious.example" },
      }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      request.once("error", reject)
      request.end()
    })
    expect(rebindingStatus).toBe(404)

    const linkedArtifact = (snapshot.result as {
      artifacts: Array<{ id: string; title: string }>
    }).artifacts.find((candidate) => candidate.title === "linked.html")!
    await unlink(join(worktree, "linked.html"))
    await symlink(join(scratch, "outside.html"), join(worktree, "linked.html"))
    const symlinkEscape = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(linkedArtifact.id)}`,
    )
    expect(symlinkEscape.status).toBe(404)

    const escaped = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent("../preview")}`,
    )
    expect(escaped.status).toBe(404)
    socket.close()
  })
})
