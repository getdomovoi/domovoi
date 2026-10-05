import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { repositoryGitFilterErrorCode, type ProviderRuntime } from "@getdomovoi/protocol"

import { isStartOpener } from "./start-handoff"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import { assignSlotsLikeABrowser } from "./test-support/assigned-slot"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// The refusal card's code arrives only when the test lets it, as a slow chunk
// would, so the person can move on while it loads. The card suspends inside
// the surface's own boundary, which shows its loading line meanwhile. Each
// test arms a chunk of its own, since a loaded chunk never suspends again.
// It also keeps where the shell said the start came from, as the card read it.
const chunk = vi.hoisted(() => {
  const chunk = {
    ready: Promise.resolve(),
    release: () => {},
    arm: () => {},
    focusFrom: undefined as { trigger: Element | null; within: Element | null } | undefined,
  }
  chunk.arm = () => {
    chunk.ready = new Promise<void>((resolve) => { chunk.release = resolve })
  }
  return chunk
})
vi.mock("./session-refusal-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-refusal-card")>()
  const { createElement, lazy } = await import("react")
  type Card = typeof actual.SessionRefusalCard
  const cards = new WeakMap<Promise<void>, ReturnType<typeof lazy<Card>>>()
  const SessionRefusalCard = (props: Parameters<Card>[0]) => {
    chunk.focusFrom = props.focusFrom
    const ready = chunk.ready
    let card = cards.get(ready)
    if (!card) {
      card = lazy(async () => {
        await ready
        return { default: actual.SessionRefusalCard }
      })
      cards.set(ready, card)
    }
    return createElement(card, props)
  }
  return { ...actual, SessionRefusalCard }
})

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
  chunk.arm()
  chunk.focusFrom = undefined
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const codex: ProviderRuntime = { id: "codex", command: "codex", status: "ready", sessionCapable: true, version: "1.0.0" }

// A start refused while the card's code is still loading: the loading line
// holds focus, and the person moves into a text field and types. When the
// card arrives it does not take focus from the field (ruling Q400), even
// when the page put the loading line's old attribute on it (security review
// round 8).
it.each([
  ["a field", false],
  ["a field carrying the loading line's attribute", true],
])("leaves focus in %s the person moved to while the refusal's code loaded", async (_label, attribute) => {
  const base = workspaceSnapshot()
  const snapshot = workspaceSnapshot({ machine: { ...base.machine, providers: [codex] } })
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "New session" }))
  await settle()
  const models = [{
    provider: "codex", id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "",
    supportedReasoningEfforts: ["medium" as const], defaultReasoningEffort: "medium" as const, isDefault: true,
  }]
  await act(async () => {
    while (sentRequests(socket, "runtime.models").some((request) => !socket.answered.has(request.id))) respond(socket, "runtime.models", models)
  })
  await settle()
  await user.type(screen.getByLabelText("Session goal"), "Rotate the staging keys")
  await user.click(screen.getByRole("button", { name: "Create session" }))
  await settle()
  await act(async () => {
    fail(socket, "session.create", {
      code: repositoryGitFilterErrorCode,
      message: "This repository's own Git config sets the filter \"sops\".",
      data: {
        kind: "repository-git-filter", projectId: snapshot.project!.id, configDigest: `sha256:${"a".repeat(64)}`,
        trust: { state: "untrusted", reason: "not-trusted" }, drivers: [{ name: "sops", scope: "local" }], omittedDrivers: 0,
      },
    })
  })
  await settle()
  expect(await screen.findByText("Opening the refusal")).toBeTruthy()

  const field = document.body.appendChild(Object.assign(document.createElement("input"), { "aria-label": "Search session history" }))
  if (attribute) field.setAttribute("data-surface-loading", "")
  await user.click(field)
  await user.keyboard("review note")

  await act(async () => { chunk.release() })
  const heading = await screen.findByRole("heading", { name: "Domovoi did not start this session" })
  // Several frames pass, enough for the card's move to have happened.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })

  expect(document.activeElement).toBe(field)
  expect(document.activeElement).not.toBe(heading)
  await user.keyboard(" more")
  expect(field.value).toBe("review note more")
})

// The card takes focus only from a control Domovoi registered as a start's
// opener (ruling Q410): the New session button, the palette's New session row
// and the launcher's submit. A row that opens nothing is not registered.
it("registers the controls that open a session start, and no others", async () => {
  const { user } = await connectedShell()
  expect(isStartOpener(screen.getByRole("button", { name: "New session" }))).toBe(true)

  await user.keyboard("{Control>}k{/Control}")
  // The palette's code loads the first time it opens.
  expect(isStartOpener(await screen.findByRole("option", { name: /New session/ }))).toBe(true)
  expect(isStartOpener(screen.getByRole("option", { name: /Open project/ }))).toBe(false)
  await user.type(screen.getByRole("combobox"), "New session")
  await user.keyboard("{Enter}")
  await settle()
  expect(isStartOpener(screen.getByRole("button", { name: "Create session" }))).toBe(true)
  expect(isStartOpener(screen.getByRole("button", { name: "Cancel" }))).toBe(false)
})

// With no session open, the thread's empty state offers New session too.
it("registers the empty thread's New session button", async () => {
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  const empty = workspaceSnapshot({
    sessions: [], activeSessionId: null, approvals: [], thread: [], annotations: [], artifacts: [], workingPlans: [],
  })
  await act(async () => { completeHandshake(socket, empty) })
  await settle()
  const buttons = screen.getAllByRole("button", { name: "New session" })
  expect(buttons.length).toBe(2)
  for (const button of buttons) expect(isStartOpener(button)).toBe(true)
})

// The launcher closes after the refusal and gives focus back to the New
// session button that opened it, before the card's code arrives. That is the
// start's own opener, so the card takes focus from it.
it("takes focus from the New session button the launcher gave focus back to", async () => {
  const shell = await connectedShell()
  const { user } = shell
  const newSession = screen.getByRole("button", { name: "New session" })
  await user.click(newSession)
  await settle()
  await refusedFromLauncher(shell)
  newSession.focus()
  const heading = await cardArrives()
  expect(document.activeElement).toBe(heading)
})

// A browser hands a document focusin listener the event retargeted to the
// outermost shadow host, as document.activeElement names that host too, and
// its composed path leaves out every node inside a closed root. happy-dom
// hands it the element inside, so the test retargets as a browser would, for
// every listener after the window's capture phase.
function retargetFocusLikeABrowser() {
  const insideClosedRoot = (node: EventTarget) => {
    if (!(node instanceof Node)) return false
    for (let root = node.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
      if (root.mode === "closed") return true
    }
    return false
  }
  const retarget = (event: FocusEvent) => {
    const path = event.composedPath()
    let root = (path[0] as Node | undefined)?.getRootNode()
    if (!(root instanceof ShadowRoot)) return
    let host = root.host
    while ((root = host.getRootNode()) instanceof ShadowRoot) host = root.host
    const visible = path.filter((node) => !insideClosedRoot(node))
    Object.defineProperty(event, "target", { configurable: true, get: () => host })
    Object.defineProperty(event, "composedPath", { configurable: true, value: () => visible })
  }
  window.addEventListener("focusin", retarget, true)
  return () => window.removeEventListener("focusin", retarget, true)
}

async function connectedShell() {
  const base = workspaceSnapshot()
  const snapshot = workspaceSnapshot({ machine: { ...base.machine, providers: [codex] } })
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  return { socket, snapshot, user: userEvent.setup() }
}

// From wherever focus is, open the command palette, start a new session and
// have the daemon refuse it. The refusal's code is still loading afterwards.
async function refusedFromPalette(shell: Awaited<ReturnType<typeof connectedShell>>) {
  const { user } = shell
  await user.keyboard("{Control>}k{/Control}")
  await user.type(await screen.findByRole("combobox"), "New session")
  await user.keyboard("{Enter}")
  await settle()
  await refusedFromLauncher(shell)
}

// With the launcher open, create a session and have the daemon refuse it.
async function refusedFromLauncher({ socket, snapshot, user }: Awaited<ReturnType<typeof connectedShell>>) {
  // The launcher's code loads the first time it opens.
  await screen.findByLabelText("Session goal")
  const models = [{
    provider: "codex", id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "",
    supportedReasoningEfforts: ["medium" as const], defaultReasoningEffort: "medium" as const, isDefault: true,
  }]
  await act(async () => {
    while (sentRequests(socket, "runtime.models").some((request) => !socket.answered.has(request.id))) respond(socket, "runtime.models", models)
  })
  await settle()
  await user.type(screen.getByLabelText("Session goal"), "Rotate the staging keys")
  await user.click(screen.getByRole("button", { name: "Create session" }))
  await settle()
  await act(async () => {
    fail(socket, "session.create", {
      code: repositoryGitFilterErrorCode,
      message: "This repository's own Git config sets the filter \"sops\".",
      data: {
        kind: "repository-git-filter", projectId: snapshot.project!.id, configDigest: `sha256:${"a".repeat(64)}`,
        trust: { state: "untrusted", reason: "not-trusted" }, drivers: [{ name: "sops", scope: "local" }], omittedDrivers: 0,
      },
    })
  })
  await settle()
  expect(await screen.findByText("Opening the refusal")).toBeTruthy()
}

// The card's code arrives, and several frames pass, enough for the card's
// move to have happened.
async function cardArrives() {
  await act(async () => { chunk.release() })
  const heading = await screen.findByRole("heading", { name: "Domovoi did not start this session" })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
  return heading
}

// The person is typing in a field inside an open shadow root, opens the
// command palette, starts a new session and is refused. While the refusal's
// code loads they go back to the field. Its host is where focus was before
// the start, but the field is text entry, so the card leaves focus there.
it("leaves focus in a shadow root field the start was launched from", async () => {
  const restore = retargetFocusLikeABrowser()
  try {
    const shell = await connectedShell()
    const { user } = shell
    const host = document.body.appendChild(document.createElement("div"))
    const field = host.attachShadow({ mode: "open" }).appendChild(Object.assign(document.createElement("input"), { "aria-label": "Review note" }))
    await user.click(field)
    await user.keyboard("review note")
    expect(document.activeElement).toBe(host)

    await refusedFromPalette(shell)
    await user.click(field)
    const heading = await cardArrives()

    expect(document.activeElement).not.toBe(heading)
    expect(host.shadowRoot?.activeElement).toBe(field)
    await user.keyboard(" more")
    expect(field.value).toBe("review note more")
  } finally {
    restore()
  }
})

// The same flow from a light DOM field the page put the opener's old
// attribute on. The field is where focus was before the start, so the shell
// saves it as the trigger, but no attribute makes it Domovoi's own control
// (security review round 8).
it("leaves focus in a field carrying the opener attribute the start was launched from", async () => {
  const shell = await connectedShell()
  const { user } = shell
  const field = document.body.appendChild(Object.assign(document.createElement("input"), { "aria-label": "Review note" }))
  field.setAttribute("data-domovoi-opener", "")
  await user.click(field)
  await user.keyboard("review note")

  await refusedFromPalette(shell)
  expect(chunk.focusFrom?.trigger).toBe(field)
  await user.click(field)
  const heading = await cardArrives()

  expect(document.activeElement).not.toBe(heading)
  expect(document.activeElement).toBe(field)
  await user.keyboard(" more")
  expect(field.value).toBe("review note more")
})

// The same flow from a field inside a closed shadow root whose host takes
// focus by tabindex, with or without an attribute the page copied onto the
// host. Nothing outside the root can see whether the host or the field holds
// focus, and the host is where focus was before the start, so the card leaves
// focus where it is (ruling Q410, security review round 8).
it.each([
  [0, ""],
  [-1, ""],
  [0, "data-domovoi-opener"],
  [0, "data-surface-loading"],
])("leaves focus in a closed shadow root whose host has tabindex %i and attribute '%s'", async (tabIndex, attribute) => {
  const restore = retargetFocusLikeABrowser()
  try {
    const shell = await connectedShell()
    const { user } = shell
    const host = document.body.appendChild(Object.assign(document.createElement("div"), { tabIndex }))
    if (attribute) host.setAttribute(attribute, "")
    const root = host.attachShadow({ mode: "closed" })
    const field = root.appendChild(Object.assign(document.createElement("input"), { "aria-label": "Review note" }))
    await user.click(field)
    expect(document.activeElement).toBe(host)
    expect(root.activeElement).toBe(field)

    await refusedFromPalette(shell)
    await user.click(field)
    expect(root.activeElement).toBe(field)
    const heading = await cardArrives()

    expect(document.activeElement).not.toBe(heading)
    expect(document.activeElement).toBe(host)
    expect(root.activeElement).toBe(field)
  } finally {
    restore()
  }
})

// A widget draws a dialog in its open shadow root around a slot, and the
// page's own button is assigned to that slot. The button renders inside the
// dialog, so the shell does not record it as the control a start came from,
// and when the person returns to it the card leaves focus there.
it("does not take a control slotted into another dialog as the start's opener", async () => {
  const restore = assignSlotsLikeABrowser()
  try {
    const shell = await connectedShell()
    const { user } = shell
    const widget = document.body.appendChild(document.createElement("div"))
    const dialog = widget.attachShadow({ mode: "open" }).appendChild(document.createElement("div"))
    dialog.setAttribute("role", "dialog")
    dialog.appendChild(document.createElement("slot"))
    const button = widget.appendChild(Object.assign(document.createElement("button"), { textContent: "Widget action" }))
    await user.click(button)
    expect(document.activeElement).toBe(button)

    await refusedFromPalette(shell)
    expect(chunk.focusFrom?.trigger).not.toBe(button)
    await user.click(button)
    const heading = await cardArrives()

    expect(document.activeElement).not.toBe(heading)
    expect(document.activeElement).toBe(button)
  } finally {
    restore()
  }
})
