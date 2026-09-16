import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { decodePairingPayload, protocolVersion } from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import type { WorkspaceService } from "./workspace.js"
import { DomovoiClient } from "../../../packages/ui/src/client.js"

const running: DomovoiDaemon[] = []
const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))
const machineId = `machine-${"a".repeat(32)}`

function testAuthToken(label: string): string {
  return createHash("sha256").update(label).digest("base64url")
}

const workspaceService = {
  inspect: async (path: string) => ({
    root: path,
    name: "project",
    branch: "main",
    head: "a".repeat(40),
  }),
  createSessionWorkspace: async () => ({
    path: "/unused",
    branch: "unused",
    baseCommit: "a".repeat(40),
  }),
  removeSessionWorkspace: async () => {},
  checkpoint: async () => ({ commit: "a".repeat(40), changedFiles: [] }),
  restore: async () => ({
    restoredCommit: "a".repeat(40),
    recoveryCommit: "a".repeat(40),
  }),
} satisfies WorkspaceService

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  vi.restoreAllMocks()
})

async function startDaemon(): Promise<DomovoiDaemon> {
  const daemon = new DomovoiDaemon({
    port: 0,
    statePath: ":memory:",
    authToken: testAuthToken("cli-identity-seam"),
    workspaceService,
    machineIdentity: { id: machineId, label: "CLI seam" },
  })
  running.push(daemon)
  await daemon.start()
  return daemon
}

async function runCli(daemon: DomovoiDaemon, args: readonly string[]) {
  const address = daemon.address!
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", new URL("../test-fixtures/release-version.mjs", import.meta.url).href,
      cliPath, ...args,
    ], {
      env: {
        ...process.env,
        // Node 22 reports node:sqlite as experimental on CI. Keep stderr as a
        // strict CLI failure channel without coupling this seam to that runtime
        // warning, which is unrelated to the bytes sent over the socket.
        NODE_NO_WARNINGS: "1",
        DOMOVOI_HOST: address.host,
        DOMOVOI_PORT: String(address.port),
        DOMOVOI_AUTH_TOKEN: daemon.authToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`domovoid ${args.join(" ")} did not exit`))
    }, 5_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (data: string) => { stdout += data })
    child.stderr.on("data", (data: string) => { stderr += data })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

async function redeem(url: string, code: string, label: string): Promise<Record<string, unknown>> {
  const socket = new WebSocket(url)
  try {
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("redeem deadline expired")), 5_000)
      socket.once("message", (data) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(data)) as Record<string, unknown>)
      })
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "device.redeemCode", params: { code, label, protocolVersion } }))
    })
  } finally { socket.terminate() }
}

describe("domovoid CLI connection identity", () => {
  it("shows a code through the binary that a device spends for a credential it can connect with", async () => {
    const daemon = await startDaemon()
    const result = await runCli(daemon, ["pair", "--client", "desktop", "--label", "Operator desktop"])
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })

    // Nothing a person can read off the screen is a credential: the drawn
    // symbol and the typed line both carry the same single-use code.
    const drawn = /domovoi-pair:1:[A-Za-z0-9_-]+/u.exec(result.stdout)?.[0]
    expect(drawn).toBeDefined()
    const payload = decodePairingPayload(drawn!)
    const pasted = /Paste this on the device:\n(domovoi-pair:1:[A-Za-z0-9_-]+)/u.exec(result.stdout)?.[1]
    expect(pasted).toBe(drawn)
    expect(result.stdout).not.toContain(daemon.authToken)
    expect(result.stdout).toContain("It works once, and only for a desktop.")
    // This daemon answers on loopback, so the code says so rather than
    // pretending a phone elsewhere could dial it.
    expect(result.stdout).toContain("which only this machine can reach")
    expect(payload.url).toBe(`ws://${daemon.address!.host}:${daemon.address!.port}/rpc`)

    const redeemed = await redeem(payload.url, payload.code, "Operator desktop")
    const token = (redeemed.result as { token: string }).token
    const deviceId = (redeemed.result as { device: { id: string } }).device.id

    const client = new DomovoiClient(payload.url, "desktop", {
      budgets: { connectMs: 5_000, requestMs: 5_000 }, authToken: token,
      admission: { machineId, deviceId },
    })
    try {
      await client.connect()
      expect(await client.request("device.current", {})).toEqual({
        kind: "client", machineId, deviceId, client: "desktop",
      })
    } finally { client.disconnect() }

    // The same code a second time pairs nothing.
    const again = await redeem(payload.url, payload.code, "another desktop")
    expect(again).toHaveProperty("error")
  }, 20_000)

  it("pairs through a real daemon socket", async () => {
    const received = vi.spyOn(WebSocket.prototype, "emit")
    const result = await runCli(await startDaemon(), ["pair"])

    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toContain("Pairing code:")
    expect(result.stdout).toContain("Enter it on the machine you are pairing from.")
    expect(received.mock.calls.some(([event, bytes]) => event === "message"
      && JSON.parse(String(bytes)).params?.clientVersion === "9.8.7-test")).toBe(true)
  })

  it("opens a project through a real daemon socket", async () => {
    const received = vi.spyOn(WebSocket.prototype, "emit")
    const result = await runCli(await startDaemon(), ["open", "/code/project"])

    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toBe("Opened /code/project\n")
    expect(received.mock.calls.some(([event, bytes]) => event === "message"
      && JSON.parse(String(bytes)).params?.clientVersion === "9.8.7-test")).toBe(true)
  })
})
