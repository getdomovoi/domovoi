import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { terminalIdForSession } from "./terminal-id"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// The shell is where a view's props come from. Each test here renders the
// whole WorkspaceShell, so it fails when the view can do a thing but the shell
// never hands it what it needs.

let harness: FakeWebSocketHarness
beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

type Hello = ReturnType<typeof workspaceSnapshot>

async function openWorkspace(snapshot: Hello, props: Parameters<typeof WorkspaceShell>[0] = {}) {
  render(<WorkspaceShell {...props} />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  return socket
}

function withThreadItem(item: Record<string, unknown>): Hello {
  const snapshot = workspaceSnapshot()
  return workspaceSnapshot({
    approvals: [],
    thread: [
      ...snapshot.thread,
      { sessionId: snapshot.activeSessionId, createdAt: "2026-10-08T09:00:00.000Z", ...item },
    ],
  } as Partial<Hello>)
}

const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.getAttribute("aria-label")

// Q346 A: a browser downloads the export to the device it runs on, so the line
// under Export this query cannot say it writes a file on the machine.
describe("the audit log's export line", () => {
  it("says a browser saves the file to this device", async () => {
    await openWorkspace(workspaceSnapshot(), { clientKind: "web" })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Settings" }))
    await user.click(await screen.findByRole("button", { name: /Audit log/ }))
    await screen.findByRole("heading", { level: 1, name: "Audit log" })

    expect(screen.getByText(/^saves to this device · /u)).toBeTruthy()
    expect(screen.queryByText(/writes a file on this machine/u)).toBeNull()
  })
})

// The receipt's link and the refusal card's link name a dock tab. The shell
// is what opens it.
describe("thread links that name a dock tab", () => {
  it("opens Checkpoints from the latest receipt's See the checkpoints", async () => {
    await openWorkspace(withThreadItem({
      id: "receipt-wiring",
      kind: "receipt",
      decision: "allow-once",
      operation: "pnpm prisma migrate deploy",
      checkpoint: "ckpt_7f24",
      client: "desktop",
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^See the checkpoints/u }))
    await settle()

    expect(selectedTab()).toBe("Checkpoints")
  })

  it("opens Rules from an Always receipt's See the rule", async () => {
    await openWorkspace(withThreadItem({
      id: "receipt-wiring",
      kind: "receipt",
      decision: "always-project",
      operation: "pnpm prisma migrate deploy",
      checkpoint: "ckpt_7f24",
      client: "desktop",
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^See the rule/u }))
    await settle()

    expect(selectedTab()).toBe("Rules")
  })

  it("opens Rules from a policy refusal's See what a rule can never cover", async () => {
    await openWorkspace(withThreadItem({
      id: "policy-refusal-wiring",
      kind: "policy-refusal",
      operation: "Deploy the billing service to production",
      command: "pnpm -w deploy --env production",
      rule: "No deploys from an agent turn",
      setBy: "acme-eng owner, 2026-08-14",
      scope: "every machine in acme-eng",
      remedy: "Run it yourself from the deploy runbook, or ask an owner to retire the rule.",
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /^See what a rule can never cover/u }))
    await settle()

    expect(selectedTab()).toBe("Rules")
  })
})

// A watching desktop cannot hold the shell, but it can read it through
// terminal.watch the way the phone does, instead of an empty state.
describe("the Terminal tab on a watching desktop", () => {
  it("watches the session's shell", async () => {
    const snapshot = workspaceSnapshot({ clientAccess: "watching" } as Partial<Hello>)
    const socket = await openWorkspace(snapshot, { clientKind: "desktop" })
    const user = userEvent.setup()
    const open = screen.queryByRole("button", { name: "Open the sheet" })
    if (open) await user.click(open)
    await settle()
    await user.click(screen.getByRole("tab", { name: "Terminal" }))
    await waitFor(() => expect(sentRequests(socket, "terminal.watch")).toHaveLength(1))
    await settle()

    expect(sentRequests(socket, "terminal.watch").at(-1)?.params).toMatchObject({
      terminalId: terminalIdForSession(snapshot.activeSessionId!),
    })
    expect(sentRequests(socket, "terminal.create")).toEqual([])
  })
})
