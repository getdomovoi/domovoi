import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { ToolInventory, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function toolInventory(snapshot: WorkspaceSnapshot): ToolInventory {
  const { id, name, platform, arch, version } = snapshot.machine
  return {
    machine: { id, name, platform, arch, version },
    repository: {
      projectId: snapshot.project!.id,
      root: "~/src/acme-api",
      configDigest: `sha256:${"a".repeat(64)}`,
      trust: { state: "untrusted", reason: "not-trusted" },
    },
    providers: [{
      provider: "claude-code",
      toolServers: "read-from-files",
      omittedEntries: 0,
      files: [{ path: ".mcp.json", source: "repository-file", state: "read" }],
      entries: [{ kind: "tool-server", file: ".mcp.json", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: [], startsAtSessionStart: true, heldBack: true }],
    }],
  }
}

async function openTools() {
  const snapshot = workspaceSnapshot()
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /^Skills/ }))
  await screen.findByRole("heading", { level: 1, name: "Skills on this machine" })
  // Reading the tools waits until someone opens the tab.
  expect(sentRequests(socket, "tool.inventory")).toHaveLength(0)
  await user.click(screen.getByRole("tab", { name: "Tools" }))
  await settle()
  return { socket, snapshot, user }
}

it("reads the open machine's tool inventory when the Tools tab opens", async () => {
  const { socket, snapshot } = await openTools()

  expect(sentRequests(socket, "tool.inventory")).toHaveLength(1)
  expect(screen.getByRole("status").textContent).toBe("Reading the agents' files on the execution machine.")
  await act(async () => { respond(socket, "tool.inventory", toolInventory(snapshot)) })
  await settle()

  expect(screen.getByRole("heading", { level: 1, name: `Tools on ${snapshot.machine.name}` })).toBeTruthy()
  expect(screen.getByText("Held back until you trust this repository")).toBeTruthy()
  expect(screen.getByText("Nothing from this repository can run when a session starts.")).toBeTruthy()
})

it("names a failed read and reads again on Try again", async () => {
  const { socket, snapshot, user } = await openTools()

  await act(async () => { fail(socket, "tool.inventory", { code: -32603, message: "Internal error" }) })
  await settle()
  expect(screen.getByText("Tools could not be read")).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Try again" }))
  await settle()
  expect(sentRequests(socket, "tool.inventory")).toHaveLength(2)
  await act(async () => { respond(socket, "tool.inventory", toolInventory(snapshot)) })
  await settle()
  expect(screen.queryByText("Tools could not be read")).toBeNull()
})

it("trusts the reviewed digest as this client and reads the tools again", async () => {
  const { socket, snapshot, user } = await openTools()
  const inventory = toolInventory(snapshot)
  await act(async () => { respond(socket, "tool.inventory", inventory) })
  await settle()

  await user.click(screen.getByRole("button", { name: "Review and trust" }))
  await user.click(await screen.findByRole("button", { name: "Trust for this machine" }))
  await settle()

  const [request] = sentRequests(socket, "repository.trust")
  expect(request?.params).toEqual({ projectId: snapshot.project!.id, configDigest: inventory.repository!.configDigest, client: "web" })
  await act(async () => {
    respond(socket, "repository.trust", {
      outcome: "trusted",
      repository: {
        projectId: snapshot.project!.id,
        configDigest: inventory.repository!.configDigest,
        trust: { state: "trusted", trustedDigest: inventory.repository!.configDigest, trustedAt: "2026-09-30T10:41:00.000Z", trustedBy: { client: "web" } },
      },
    })
  })
  await settle()

  expect(sentRequests(socket, "tool.inventory")).toHaveLength(2)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("returns to the skills list from the Skills tab", async () => {
  const { user } = await openTools()

  await user.click(screen.getByRole("tab", { name: "Skills" }))
  expect(await screen.findByRole("heading", { level: 1, name: "Skills on this machine" })).toBeTruthy()
})
