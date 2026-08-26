import WebSocket from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"

const running: DomovoiDaemon[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
})

describe("DomovoiDaemon", () => {
  it("serves the initial workspace over JSON-RPC", async () => {
    const daemon = new DomovoiDaemon({ port: 0 })
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
    const daemon = new DomovoiDaemon({ port: 0 })
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
    const daemon = new DomovoiDaemon({ port: 0 })
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
})
