import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import WebSocket from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DomovoiDaemon } from "./server.js"
import type { AgentAdapter, AgentEvent } from "./codex.js"
import type { WorkspaceService } from "./workspace.js"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("DomovoiDaemon", () => {
  it("serves the initial workspace over JSON-RPC", async () => {
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
      result: { activeSessionId: "session-billing" },
    })

    const approvalResponse = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id === 2) resolve(message as Record<string, unknown>)
      })
    })
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "approval.resolve",
        params: { approvalId: "approval-migrate", decision: "always-project", client: "desktop" },
      }),
    )

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
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
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
    const first = new DomovoiDaemon({ port: 0, statePath })
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

    const second = new DomovoiDaemon({ port: 0, statePath })
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
    secondSocket.close()
  })

  it("orchestrates a local project, Codex turn, approval, and checkpoint", async () => {
    const agentListeners = new Set<(event: AgentEvent) => void>()
    const agent = {
      connect: vi.fn(async () => {}),
      startThread: vi.fn()
        .mockImplementationOnce(() => new Promise<string>(() => {}))
        .mockResolvedValue("provider-thread-1"),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "provider-turn-1"),
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
      agent,
      workspaceService,
      agentTimeoutMs: 100,
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
      runtime,
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

    for (const listener of agentListeners) {
      listener({
        type: "text-delta",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        delta: "Tests are green.",
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
      error: { code: -32602, message: "Only the Codex provider is available" },
    })

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
      startThread: vi.fn(async () => "provider-thread-preview"),
      stopThread: vi.fn(async () => {}),
      startTurn: vi.fn(async () => "provider-turn-preview"),
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

    const preview = await fetch(
      `http://${address.host}:${address.port}/artifacts/${encodeURIComponent(artifact!.id)}`,
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-security-policy")).toContain("default-src 'none'")
    await expect(preview.text()).resolves.toBe("<h1>Domovoi preview</h1>")

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
