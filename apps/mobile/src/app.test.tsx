import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, maximumReviewAnnotations, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { act, fireEvent, render, screen } from "@testing-library/react-native"

import { App } from "./app"
import { ThemeProvider } from "./theme/theme-provider"

// The phone's root: a stored credential is restored, the daemon is reached
// over a socket this test drives, and each assertion reads the frames the app
// sent, which is what the daemon would act on.

const mockHeld = new Map<string, string>()

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => mockHeld.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockHeld.set(key, value) },
  deleteItemAsync: async (key: string) => { mockHeld.delete(key) },
}))

// The app draws its own SafeAreaProvider, which waits for native insets that a
// test never reports. The library's own mock supplies them.
jest.mock("react-native-safe-area-context", () => jest.requireActual<{ default: unknown }>("react-native-safe-area-context/jest/mock").default)

// NativeWind compiles the stylesheet at build time; a test has nothing to load.
jest.mock("./global.css", () => ({}))

// The preview screen's web view is native. Nothing here opens a preview.
jest.mock("react-native-webview", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native")
  return { WebView: View }
})

jest.mock("./lib/relay-pin", () => ({
  createRelayPinStore: () => ({}),
  reconcileRelayPin: () => Promise.resolve("trusted"),
}))

type Frame = { jsonrpc: "2.0", id: number, method: string, params: Record<string, unknown> }

class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 0
  sent: Frame[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.made.push(this) }
  send(payload: string) { this.sent.push(JSON.parse(payload) as Frame) }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
  requests(method: string): Frame[] {
    return this.sent.filter((frame) => frame.method === method)
  }
  answer(method: string, result: unknown) {
    const request = this.requests(method).at(-1)
    if (!request) throw new Error(`nothing asked for ${method}`)
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) })
  }
  push(method: string, params: unknown) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) })
  }
}

const original = Reflect.get(globalThis, "WebSocket") as unknown

beforeEach(() => {
  FakeSocket.made = []
  mockHeld.clear()
  mockHeld.set("domovoi.daemon.url", "wss://desk.example.ts.net:47831/rpc")
  mockHeld.set("domovoi.daemon.token", "t".repeat(43))
  mockHeld.set("domovoi.daemon.client", "phone")
  Reflect.set(globalThis, "WebSocket", FakeSocket)
})

afterEach(() => {
  Reflect.set(globalThis, "WebSocket", original)
})

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

// Restores the stored credential and answers the greeting with this snapshot.
async function openApp(snapshot: WorkspaceSnapshot, clientAccess: "full" | "watching" = "full") {
  const view = await render(<ThemeProvider><App /></ThemeProvider>)
  await settle()
  const socket = FakeSocket.made.at(-1)
  if (!socket) throw new Error("the app did not dial the stored daemon")
  await act(async () => {
    socket.readyState = 1
    socket.onopen?.()
  })
  expect(socket.requests("system.hello")[0]?.params).toMatchObject({ client: "phone", authToken: "t".repeat(43) })
  await act(async () => { socket.answer("system.hello", { ...snapshot, clientAccess }) })
  await settle()
  return { view, socket }
}

const billing = demoWorkspace.sessions.find((session) => session.id === "session-billing")!
const audit = demoWorkspace.sessions.find((session) => session.id === "session-audit")!
const approval = demoWorkspace.approvals[0]!

describe("App", () => {
  // Sessions draws the idle card's fleet rows and the UNREACHABLE line from
  // the fleet, so opening on Sessions asks for it, without waiting for the
  // Machines tab.
  it("asks for the fleet when Sessions opens", async () => {
    const { socket } = await openApp(workspace())
    expect(socket.requests("fleet.list").length).toBeGreaterThan(0)
  })

  it("names the session a gate belongs to above it", async () => {
    expect(approval.sessionId).toBe(billing.id)
    await openApp(workspace())
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))

    expect(screen.getByRole("header", { name: "Waiting on you" })).toBeOnTheScreen()
    expect(screen.getByText(billing.title)).toBeOnTheScreen()
  })

  it("answers the gate it opened with one approval.resolve carrying that approval's id", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    await settle()

    const sent = socket.requests("approval.resolve")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.params).toMatchObject({ approvalId: approval.id, decision: "allow-once", revision: 0 })
  })

  // Round 4 on #545: the daemon rewrites a file card when the file it reaches
  // moves, and refuses an Allow that names the card as it was. The phone shows
  // the card it was last sent and answers with that card's revision.
  it("shows the file a rewritten gate reaches and answers with the revision it shows", async () => {
    const raised = workspace()
    raised.approvals[0]!.command = "Edit"
    raised.approvals[0]!.affects = "The file one/file in the session worktree."
    const { socket } = await openApp(raised)
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    expect(screen.getByText("The file one/file in the session worktree.")).toBeOnTheScreen()

    const rewritten = structuredClone(raised)
    rewritten.approvals[0]!.affects = "The file two/file in the session worktree."
    rewritten.approvals[0]!.revision = 1
    await act(async () => { socket.push("workspace.changed", rewritten) })
    await settle()
    expect(screen.getByText("The file two/file in the session worktree.")).toBeOnTheScreen()
    expect(screen.queryByText("The file one/file in the session worktree.")).toBeNull()

    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    await settle()
    expect(socket.requests("approval.resolve").map((frame) => frame.params)).toEqual([
      { approvalId: approval.id, decision: "allow-once", revision: 1 },
    ])
  })

  it("names the revision of the gate it denies with a reason", async () => {
    const raised = workspace()
    raised.approvals[0]!.revision = 2
    const { socket } = await openApp(raised)
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))
    await fireEvent.changeText(screen.getByLabelText("Reason sent to the agent"), "Use staging first")
    await fireEvent.press(screen.getByRole("button", { name: "Send denial" }))
    await settle()
    expect(socket.requests("approval.resolve").map((frame) => frame.params)).toEqual([
      { approvalId: approval.id, decision: "deny-explain", explanation: "Use staging first", revision: 2 },
    ])
  })

  it("keeps the gate on screen with the reason when the daemon refuses the answer", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    const request = socket.requests("approval.resolve")[0]!
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "The approval store is unavailable" } }) })
    })
    await settle()

    expect(screen.getByRole("button", { name: "Allow once" })).toBeOnTheScreen()
    expect(screen.getByText(/The approval store is unavailable/)).toBeOnTheScreen()
  })

  it("closes the reason screen when another device answers the gate", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))
    expect(screen.getByLabelText("Reason sent to the agent")).toBeOnTheScreen()

    const answered = workspace()
    answered.approvals = []
    await act(async () => { socket.push("workspace.changed", answered) })
    await settle()

    expect(screen.queryByLabelText("Reason sent to the agent")).toBeNull()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()

    // The next gate opens on its own decision, not on the reason written for
    // the one that was answered elsewhere.
    const next = workspace()
    next.approvals = [{ ...approval, id: "approval-next" }]
    await act(async () => { socket.push("workspace.changed", next) })
    await settle()
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    expect(screen.getByRole("button", { name: "Allow once" })).toBeOnTheScreen()
    expect(screen.queryByLabelText("Reason sent to the agent")).toBeNull()
  })

  it("drops the gate when the daemon says this credential only watches", async () => {
    await openApp(workspace(), "watching")
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))

    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
    expect(screen.getByText("Watching only. A device paired with full access answers this gate.")).toBeOnTheScreen()
  })

  // Ruling Q356 A: Tell the agent on a policy refusal sends the refusal's
  // remedy to the session as a steer, through the same session.send a typed
  // message uses. Like a typed message it names the session's open comments
  // (ruling Q402), since the daemon attaches only the comments a message names.
  it("sends a policy refusal's remedy to the agent", async () => {
    const snapshot = workspace()
    const session = snapshot.sessions.find((candidate) => candidate.id === audit.id)!
    session.workspacePath = "/worktrees/repo-audit"
    session.providerThreadId = "provider-thread-audit"
    // A comment sits on an artifact of its own session.
    const comment = snapshot.annotations.find((annotation) => annotation.sessionId === billing.id)!
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === comment.artifactId)!
    snapshot.artifacts.push({ ...structuredClone(artifact), id: "artifact-audit", sessionId: audit.id })
    snapshot.annotations.push({ ...structuredClone(comment), id: "annotation-audit-open", sessionId: audit.id, artifactId: "artifact-audit", status: "open" })
    snapshot.thread.push({
      id: "refusal-audit",
      sessionId: audit.id,
      kind: "policy-refusal",
      operation: "Apply a production database migration",
      command: "prisma migrate deploy --url $PROD_DATABASE_URL",
      rule: "no writes to a production database",
      setBy: "dana@acme.dev",
      scope: "every machine on this account",
      remedy: "Run it against acme_dev instead.",
      createdAt: "2026-08-25T23:00:00.000Z",
    })
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: audit.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))
    await settle()

    const sent = socket.requests("session.send")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.params).toMatchObject({
      sessionId: audit.id,
      prompt: "Run it against acme_dev instead.",
      client: "phone",
      review: { annotationIds: ["annotation-audit-open"] },
    })
  })

  // The turn can end between the phone's snapshot and the send. The daemon
  // then holds the queued remedy with its reason (no boundary can release
  // it), so the refusal must not promise it reaches the agent at turn end.
  it("says a remedy the daemon held is held, not on its way", async () => {
    const snapshot = workspace()
    const session = snapshot.sessions.find((candidate) => candidate.id === audit.id)!
    session.workspacePath = "/worktrees/repo-audit"
    session.providerThreadId = "provider-thread-audit"
    session.activeTurnId = "provider-turn-audit"
    snapshot.thread.push({
      id: "refusal-audit",
      sessionId: audit.id,
      kind: "policy-refusal",
      operation: "Apply a production database migration",
      command: "prisma migrate deploy --url $PROD_DATABASE_URL",
      rule: "no writes to a production database",
      setBy: "dana@acme.dev",
      scope: "every machine on this account",
      remedy: "Run it against acme_dev instead.",
      createdAt: "2026-08-25T23:00:00.000Z",
    })
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: audit.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Tell the agent" }))
    expect(socket.requests("session.send")[0]?.params).toMatchObject({ delivery: "next-turn-replace" })

    const reason = "No provider turn is active, so no successful boundary can release this send."
    const reply = structuredClone(snapshot)
    reply.sessions.find((candidate) => candidate.id === audit.id)!.activeTurnId = undefined
    reply.queuedSends = [{
      id: "queue-audit",
      sessionId: audit.id,
      state: "held",
      reason,
      createdAt: "2026-08-25T23:01:00.000Z",
      origin: { client: "phone", connectionId: "3f1c2b8e-1d2a-4c5b-9e6f-7a8b9c0d1e2f" },
      skillIds: [],
      attachments: [],
    }]
    await act(async () => { socket.answer("session.send", reply) })
    await settle()

    expect(screen.getByText("Held. It will not reach the agent on its own.")).toBeOnTheScreen()
    expect(screen.queryByText("Sent. It will reach the agent when this turn ends.")).toBeNull()
  })

  // A send's failure belongs to the session it was for. One that lands after
  // the person has moved to another session must not show there.
  it("keeps a late send failure on the session it was for", async () => {
    const snapshot = workspace()
    snapshot.approvals = []
    for (const session of snapshot.sessions) {
      session.workspacePath = `/worktrees/${session.id}`
      session.providerThreadId = `provider-thread-${session.id}`
    }
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: audit.title }))
    await fireEvent.changeText(screen.getByLabelText("Reply to this session"), "Check the lockfile too")
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    await fireEvent.press(screen.getByRole("button", { name: "Back to sessions" }))
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    const request = socket.requests("session.send")[0]!
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "The audit session refused the send" } }) })
    })
    await settle()

    expect(screen.queryByText(/The audit session refused the send/)).toBeNull()

    // The failure is kept for the session it was for, and shown there when the
    // person comes back, because the draft it carried is gone.
    await fireEvent.press(screen.getByRole("button", { name: "Back to sessions" }))
    await fireEvent.press(screen.getByRole("button", { name: audit.title }))
    expect(screen.getByText(/The audit session refused the send/)).toBeOnTheScreen()
  })

  it("sends one turn for a double tap on Send", async () => {
    const snapshot = workspace()
    const idle = snapshot.sessions.find((session) => session.id === audit.id)!
    idle.workspacePath = "/worktrees/repo-audit"
    idle.providerThreadId = "provider-thread-audit"
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: audit.title }))
    await fireEvent.changeText(screen.getByLabelText("Reply to this session"), "Check the lockfile too")
    const send = screen.getByRole("button", { name: "Send" })
    await act(async () => {
      fireEvent.press(send)
      fireEvent.press(send)
    })
    await settle()

    const sent = socket.requests("session.send")
    expect(sent).toHaveLength(1)
    // A session with no open comment sends an explicit empty review.
    expect(sent[0]?.params).toEqual({ sessionId: audit.id, prompt: "Check the lockfile too", client: "phone", review: { annotationIds: [] } })
  })

  // Rulings Q348 A and Q402: the daemon attaches only the comments a message
  // names. A comment the phone sent to the agent is an open comment of the
  // session, so a send names every open comment of that session, newest
  // first, and nothing resolved or from another session.
  it("names the session's open comments in the review it sends", async () => {
    const snapshot = workspace()
    snapshot.approvals = []
    const session = snapshot.sessions.find((candidate) => candidate.id === billing.id)!
    session.workspacePath = "/worktrees/billing"
    session.providerThreadId = "provider-thread-billing"
    const open = snapshot.annotations.filter((annotation) => annotation.sessionId === billing.id && annotation.status === "open")
    expect(open.map((annotation) => annotation.id)).toEqual(["annotation-migration-machine", "annotation-replay-copy"])
    snapshot.annotations.push({ ...structuredClone(open[1]!), id: "annotation-resolved", status: "resolved" })
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.changeText(screen.getByLabelText("Reply to this session"), "Address the comments")
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    await settle()

    expect(socket.requests("session.send").map((frame) => frame.params)).toEqual([
      expect.objectContaining({
        sessionId: billing.id,
        prompt: "Address the comments",
        client: "phone",
        review: { annotationIds: ["annotation-migration-machine", "annotation-replay-copy"] },
      }),
    ])
  })

  // Codex review of PR #717: a message carries at most the newest
  // maximumReviewAnnotations open comments. The phone counts the rest on the
  // review, the daemon records them as the turn's limit omission, and the
  // phone shows that line under the message it sent.
  it("counts the open comments over the limit and shows them under the sent message", async () => {
    const snapshot = workspace()
    snapshot.approvals = []
    const session = snapshot.sessions.find((candidate) => candidate.id === billing.id)!
    session.workspacePath = "/worktrees/billing"
    session.providerThreadId = "provider-thread-billing"
    const comment = snapshot.annotations.find((annotation) => annotation.sessionId === billing.id)!
    snapshot.annotations = Array.from({ length: maximumReviewAnnotations + 1 }, (_, index) => ({
      ...structuredClone(comment),
      id: `comment-${String(index).padStart(2, "0")}`,
      status: "open" as const,
      updatedAt: `2026-09-30T13:${String(index).padStart(2, "0")}:00.000Z`,
    }))
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.changeText(screen.getByLabelText("Reply to this session"), "Address every comment")
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    await settle()

    const annotationIds = snapshot.annotations.slice(1).map((annotation) => annotation.id).reverse()
    expect(socket.requests("session.send").map((frame) => frame.params.review)).toEqual([
      { annotationIds, omittedOverLimit: 1 },
    ])
    expect(screen.queryByText("1 open annotation was over the per-turn limit")).toBeNull()

    const delivered = structuredClone(snapshot)
    delivered.thread.push({
      id: "thread-user-over-limit", sessionId: billing.id, kind: "user", body: "Address every comment", createdAt: "2026-09-30T14:00:00.000Z",
      providerPromptDelivery: {
        version: 1,
        budget: { unit: "utf16-code-units", limit: 262_144, used: 9_000 },
        handoff: { status: "not-required" },
        workingPlan: { status: "not-required" },
        annotations: { availableCount: maximumReviewAnnotations + 1, deliveredIds: annotationIds, omitted: { budget: 0, limit: 1 } },
        skills: { selection: "project-default", delivered: [], omitted: { budget: [], limit: [], unavailable: [], reviewChanged: [], policy: [] } },
      },
    })
    await act(async () => { socket.push("workspace.changed", delivered) })
    await settle()
    expect(screen.getByText("1 open annotation was over the per-turn limit")).toBeOnTheScreen()
  })

  // Ruling Q211: the phone Tools screen reads tool.inventory for the machine
  // it is connected to and shows what the repository holds back. It reads
  // and never asks to trust.
  it("opens Tools from the connected machine and reads what the repository holds back", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("tab", { name: "Machines" }))
    await settle()
    const self = demoWorkspace.machine
    await act(async () => {
      socket.answer("fleet.list", {
        entries: [{
          kind: "machine",
          machine: {
            id: self.id,
            label: self.name,
            platform: "darwin",
            arch: "arm64",
            version: "0.0.1",
            connection: "local",
            capabilities: ["sessions"],
            protocolVersion: "0.2.0",
            transports: [],
            heartbeat: { state: "online", lastSeenAt: new Date().toISOString() },
            health: "healthy",
            self: true,
          },
        }],
      })
    })
    await settle()

    await fireEvent.press(screen.getByRole("button", { name: `Tools on ${self.name}` }))
    await settle()
    expect(socket.requests("tool.inventory").map((frame) => frame.params)).toEqual([{}])
    expect(screen.getByText(`Reading the agents' files on ${self.name}.`)).toBeOnTheScreen()

    await act(async () => {
      socket.answer("tool.inventory", {
        machine: { id: self.id, name: self.name, platform: "darwin", arch: "arm64", version: "0.0.1" },
        repository: { projectId: "project-acme-api", root: "/Users/dev/src/acme-api", configDigest: `sha256:${"a".repeat(64)}`, trust: { state: "untrusted", reason: "not-trusted" } },
        providers: [{
          provider: "claude-code",
          toolServers: "read-from-files",
          omittedEntries: 0,
          files: [{ path: ".mcp.json", source: "repository-file", state: "read" }],
          entries: [{ kind: "tool-server", name: "postgres-dev", transport: "stdio", command: "npx -y @acme/pg-mcp", envKeys: [], file: ".mcp.json", startsAtSessionStart: true, heldBack: true }],
        }],
      })
    })
    await settle()

    expect(screen.getByText(`acme-api is held back on ${self.name}`)).toBeOnTheScreen()
    expect(screen.getByText("postgres-dev")).toBeOnTheScreen()
    expect(screen.getByText("Trust from desktop or web")).toBeOnTheScreen()
    expect(socket.sent.filter((frame) => frame.method.startsWith("repository."))).toEqual([])

    await fireEvent.press(screen.getByRole("button", { name: "Back" }))
    expect(screen.queryByText("Trust from desktop or web")).toBeNull()
    expect(screen.getByRole("button", { name: `Tools on ${self.name}` })).toBeOnTheScreen()
  })

  it("shows the daemon's refusal when Tools cannot be read, and asks again on request", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("tab", { name: "Machines" }))
    await settle()
    const self = demoWorkspace.machine
    await act(async () => {
      socket.answer("fleet.list", {
        entries: [{
          kind: "machine",
          machine: {
            id: self.id, label: self.name, platform: "darwin", arch: "arm64", version: "0.0.1", connection: "local",
            capabilities: ["sessions"], protocolVersion: "0.2.0", transports: [],
            heartbeat: { state: "online", lastSeenAt: new Date().toISOString() }, health: "healthy", self: true,
          },
        }],
      })
    })
    await settle()
    await fireEvent.press(screen.getByRole("button", { name: `Tools on ${self.name}` }))
    const request = socket.requests("tool.inventory")[0]!
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "A phone or tablet credential may only watch sessions, answer gates, and start, stop or steer sessions" } }) })
    })
    await settle()
    expect(screen.getByText("Tools could not be read")).toBeOnTheScreen()
    expect(screen.getByText(/A phone or tablet credential may only watch sessions/)).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "Try again" }))
    expect(socket.requests("tool.inventory")).toHaveLength(2)
  })

  // A project opened on any client while Tools is up changes what the daemon
  // reads, so the screen reads again rather than showing the last project.
  it("reads Tools again when the open project changes", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("tab", { name: "Machines" }))
    await settle()
    const self = demoWorkspace.machine
    await act(async () => {
      socket.answer("fleet.list", {
        entries: [{
          kind: "machine",
          machine: {
            id: self.id, label: self.name, platform: "darwin", arch: "arm64", version: "0.0.1", connection: "local",
            capabilities: ["sessions"], protocolVersion: "0.2.0", transports: [],
            heartbeat: { state: "online", lastSeenAt: new Date().toISOString() }, health: "healthy", self: true,
          },
        }],
      })
    })
    await settle()
    await fireEvent.press(screen.getByRole("button", { name: `Tools on ${self.name}` }))
    await settle()
    await act(async () => {
      socket.answer("tool.inventory", {
        machine: { id: self.id, name: self.name, platform: "darwin", arch: "arm64", version: "0.0.1" },
        repository: { projectId: "project-acme-api", root: "/Users/dev/src/acme-api", configDigest: `sha256:${"a".repeat(64)}`, trust: { state: "untrusted", reason: "not-trusted" } },
        providers: [],
      })
    })
    await settle()
    expect(screen.getByText(`acme-api on ${self.name}`)).toBeOnTheScreen()

    // The same project again reads nothing new.
    await act(async () => { socket.push("workspace.changed", workspace()) })
    await settle()
    expect(socket.requests("tool.inventory")).toHaveLength(1)

    const moved = workspace()
    moved.project = { ...moved.project!, id: "project-billing", name: "billing", path: "/Users/dev/src/billing" }
    // A snapshot's sessions belong to its open project.
    moved.sessions = moved.sessions.map((session) => ({ ...session, projectId: "project-billing" }))
    await act(async () => { socket.push("workspace.changed", moved) })
    await settle()
    expect(socket.requests("tool.inventory")).toHaveLength(2)
    expect(screen.queryByText(`acme-api on ${self.name}`)).toBeNull()
    expect(screen.getByText(`Reading the agents' files on ${self.name}.`)).toBeOnTheScreen()
  })

  // Skills design step 16 (ruling Q203 A): a phone start refused over a
  // repository git filter shows the refusal, opens what is held back, and
  // says trust is granted from desktop or web. The phone never asks to trust.
  it("shows a start refused over a git filter and opens what is held back", async () => {
    const snapshot = workspace()
    const runtime = billing.runtime
    snapshot.machine.providers = [{ id: runtime.provider, command: runtime.provider, status: "ready", sessionCapable: true }]
    // The Sessions tab offers a fresh start when no session exists, so the
    // snapshot holds nothing that names one.
    Object.assign(snapshot, { sessions: [], approvals: [], activeSessionId: null, thread: [], workingPlans: [], artifacts: [], annotations: [] })
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: "Start a session" }))
    await fireEvent.changeText(screen.getByLabelText("What to do"), "Rotate the staging keys")
    await fireEvent.press(screen.getByRole("button", { name: "Start" }))
    await settle()
    await act(async () => {
      socket.answer("runtime.discover", {
        machineId: snapshot.machine.id,
        provider: runtime.provider,
        status: "ready",
        models: [{ provider: runtime.provider, id: runtime.model, displayName: runtime.model, description: "", supportedReasoningEfforts: [runtime.reasoning], defaultReasoningEffort: runtime.reasoning, isDefault: true }],
        defaultRuntime: runtime,
        permissionModes: [runtime.permissionMode],
        supportsAuto: runtime.permissionMode === "build",
      })
    })
    await settle()
    const create = socket.requests("session.create")[0]!
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: create.id, error: {
        code: -32020,
        message: "This repository's own Git config sets the filter \"sops\".",
        data: {
          kind: "repository-git-filter",
          projectId: snapshot.project!.id,
          configDigest: `sha256:${"a".repeat(64)}`,
          trust: { state: "untrusted", reason: "not-trusted" },
          drivers: [{ name: "sops", scope: "local" }],
          omittedDrivers: 0,
        },
      } }) })
    })
    await settle()

    expect(screen.getByText("Domovoi did not start this session")).toBeOnTheScreen()
    expect(screen.getByText(`Checking out acme-api would run the sops filter driver, which is not trusted on ${snapshot.machine.name}.`)).toBeOnTheScreen()
    expect(screen.getByText("Trust from desktop or web")).toBeOnTheScreen()
    expect(socket.requests("session.send")).toEqual([])

    await fireEvent.press(screen.getByRole("button", { name: "See what is held back" }))
    await settle()
    expect(socket.requests("tool.inventory").map((frame) => frame.params)).toEqual([{}])
    expect(screen.getByText(`Reading the agents' files on ${snapshot.machine.name}.`)).toBeOnTheScreen()
    expect(socket.sent.filter((frame) => frame.method.startsWith("repository."))).toEqual([])
  })

  // An inventory read on an earlier visit is not a claim about now: Tools
  // opened again while the connection is down shows nothing read, not it.
  it("does not show the last inventory when Tools opens again while disconnected", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("tab", { name: "Machines" }))
    await settle()
    const self = demoWorkspace.machine
    await act(async () => {
      socket.answer("fleet.list", {
        entries: [{
          kind: "machine",
          machine: {
            id: self.id, label: self.name, platform: "darwin", arch: "arm64", version: "0.0.1", connection: "local",
            capabilities: ["sessions"], protocolVersion: "0.2.0", transports: [],
            heartbeat: { state: "online", lastSeenAt: new Date().toISOString() }, health: "healthy", self: true,
          },
        }],
      })
    })
    await settle()
    await fireEvent.press(screen.getByRole("button", { name: `Tools on ${self.name}` }))
    await settle()
    await act(async () => {
      socket.answer("tool.inventory", {
        machine: { id: self.id, name: self.name, platform: "darwin", arch: "arm64", version: "0.0.1" },
        repository: { projectId: "project-acme-api", root: "/Users/dev/src/acme-api", configDigest: `sha256:${"a".repeat(64)}`, trust: { state: "untrusted", reason: "not-trusted" } },
        providers: [],
      })
    })
    await settle()
    expect(screen.getByText(`acme-api on ${self.name}`)).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Back" }))

    await act(async () => { socket.close() })
    await settle()
    await fireEvent.press(screen.getByRole("button", { name: `Tools on ${self.name}` }))
    await settle()
    expect(screen.queryByText(`acme-api on ${self.name}`)).toBeNull()
    expect(screen.getByText(`Reading the agents' files on ${self.name}.`)).toBeOnTheScreen()
    expect(socket.requests("tool.inventory")).toHaveLength(1)
  })

  // Phone v2 frame 04: the phone lists the open session's terminals, watches
  // each, reads live output, and stops watching when the person leaves.
  describe("terminals", () => {
    const owner = { client: "desktop", clientId: "desktop-1", device: { id: `device-${"a".repeat(32)}`, label: "MacBook Pro" } }
    const terminal = {
      terminalId: "terminal-1",
      sessionId: audit.id,
      cols: 120,
      rows: 34,
      shell: "/bin/zsh",
      cwd: "/Users/mira/dev/acme/.domovoi/worktrees/wt-audit",
      owner,
      claimHeld: true,
      openedAt: "2026-10-06T13:52:04.000Z",
      state: "live",
    }
    const watchResult = {
      ...terminal,
      buffer: "$ pnpm audit\nfirst\n",
      bufferStartsAt: "2026-10-06T13:52:04.000Z",
      earlierOutputDropped: false,
      watchedAt: "2026-10-06T14:06:12.000Z",
    }

    async function openAudit() {
      const snapshot = workspace()
      snapshot.approvals = []
      const opened = await openApp(snapshot)
      await fireEvent.press(screen.getByRole("button", { name: audit.title }))
      await settle()
      return opened
    }

    async function watchOne(socket: FakeSocket) {
      expect(socket.requests("terminal.list").at(-1)?.params).toEqual({ sessionId: audit.id })
      await act(async () => { socket.answer("terminal.list", { terminals: [terminal] }) })
      await settle()
      expect(socket.requests("terminal.watch").at(-1)?.params).toEqual({ terminalId: "terminal-1" })
      await act(async () => { socket.answer("terminal.watch", watchResult) })
      await settle()
    }

    it("watches the open session's terminals, reads live output, and unwatches on leave", async () => {
      const { socket } = await openAudit()
      await watchOne(socket)
      expect(screen.getByText("zsh · wt-audit")).toBeOnTheScreen()
      expect(screen.getByRole("button", { name: "Show all 2 lines" })).toBeOnTheScreen()

      await act(async () => { socket.push("terminal.output", { terminalId: "terminal-1", data: "third\n" }) })
      await settle()
      await fireEvent.press(screen.getByRole("button", { name: "Show all 3 lines" }))
      expect(screen.getByText("Read-only. Only the claimant can type or resize.")).toBeOnTheScreen()
      expect(screen.getByText("Claimed by MacBook Pro")).toBeOnTheScreen()
      expect(screen.getByText("third")).toBeOnTheScreen()
      // A phone watches; it never types, resizes or claims.
      expect(socket.sent.filter((frame) => ["terminal.input", "terminal.resize", "terminal.claim", "terminal.create", "terminal.close"].includes(frame.method))).toEqual([])

      await fireEvent.press(screen.getByRole("button", { name: "Back to the thread" }))
      expect(screen.getByRole("button", { name: "Show all 3 lines" })).toBeOnTheScreen()
      expect(socket.requests("terminal.unwatch")).toEqual([])

      await fireEvent.press(screen.getByRole("button", { name: "Back to sessions" }))
      await settle()
      expect(socket.requests("terminal.unwatch").map((frame) => frame.params)).toEqual([{ terminalId: "terminal-1" }])
    })

    // The daemon may have taken a watch whose answer has not come back. Leaving
    // ends it anyway, rather than leaving output flowing to no screen.
    it("unwatches a terminal whose watch is still unanswered when the person leaves", async () => {
      const { socket } = await openAudit()
      await act(async () => { socket.answer("terminal.list", { terminals: [terminal] }) })
      await settle()
      expect(socket.requests("terminal.watch")).toHaveLength(1)

      await fireEvent.press(screen.getByRole("button", { name: "Back to sessions" }))
      await settle()
      expect(socket.requests("terminal.unwatch").map((frame) => frame.params)).toEqual([{ terminalId: "terminal-1" }])
    })

    // The list after a reconnect is the daemon's word on the terminal's state.
    it("takes the state from the list after a reconnect, before the new watch answers", async () => {
      const { socket } = await openAudit()
      await watchOne(socket)
      await act(async () => { socket.close() })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)) })
      const next = FakeSocket.made.at(-1)!
      await act(async () => {
        next.readyState = 1
        next.onopen?.()
      })
      await act(async () => { next.answer("system.hello", { ...workspace(), approvals: [], clientAccess: "full" }) })
      await settle()
      await act(async () => {
        next.answer("terminal.list", { terminals: [{ ...terminal, state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 1 }] })
      })
      await settle()
      expect(screen.getByText("Failed")).toBeOnTheScreen()
      expect(screen.getByText("Last claimed by MacBook Pro")).toBeOnTheScreen()
    })

    it("says Failed when the watched shell exits with an error", async () => {
      const { socket } = await openAudit()
      await watchOne(socket)
      await act(async () => { socket.push("terminal.closed", { terminalId: "terminal-1", exitCode: 1 }) })
      await settle()
      expect(screen.getByText("Failed")).toBeOnTheScreen()
      expect(screen.getByText("Last claimed by MacBook Pro")).toBeOnTheScreen()
    })

    it("says Unconfirmed while the connection is down, and watches again once it is back", async () => {
      const { socket } = await openAudit()
      await watchOne(socket)
      await act(async () => { socket.close() })
      await settle()
      expect(screen.getByText("Unconfirmed")).toBeOnTheScreen()
      expect(screen.getByText("Last heard: claimed by MacBook Pro")).toBeOnTheScreen()
      // What was read stays on screen while the route is down.
      expect(screen.getByRole("button", { name: "Show all 2 lines" })).toBeOnTheScreen()

      // The first retry waits a second.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)) })
      const next = FakeSocket.made.at(-1)!
      expect(next).not.toBe(socket)
      await act(async () => {
        next.readyState = 1
        next.onopen?.()
      })
      await act(async () => { next.answer("system.hello", { ...workspace(), approvals: [], clientAccess: "full" }) })
      await settle()
      await watchOne(next)
      expect(screen.getByText("Live")).toBeOnTheScreen()
    })

    it("closes the full view when the daemon no longer lists its terminal", async () => {
      const { socket } = await openAudit()
      await watchOne(socket)
      await fireEvent.press(screen.getByRole("button", { name: "Show all 2 lines" }))
      expect(screen.getByRole("button", { name: "Back to the thread" })).toBeOnTheScreen()

      await act(async () => { socket.close() })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)) })
      const next = FakeSocket.made.at(-1)!
      await act(async () => {
        next.readyState = 1
        next.onopen?.()
      })
      await act(async () => { next.answer("system.hello", { ...workspace(), approvals: [], clientAccess: "full" }) })
      await settle()
      await act(async () => { next.answer("terminal.list", { terminals: [] }) })
      await settle()
      expect(screen.queryByRole("button", { name: "Back to the thread" })).toBeNull()
      expect(screen.getByRole("button", { name: "Back to sessions" })).toBeOnTheScreen()
    })
  })
})
