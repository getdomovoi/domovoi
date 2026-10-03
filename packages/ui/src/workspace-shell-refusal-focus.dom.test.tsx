import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { repositoryGitFilterErrorCode, type ProviderRuntime } from "@getdomovoi/protocol"

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

// The refusal card's code arrives only when the test lets it, as a slow chunk
// would, so the person can move on while it loads. The card suspends inside
// the surface's own boundary, which shows its loading line meanwhile. Each
// test arms a chunk of its own, since a loaded chunk never suspends again.
const chunk = vi.hoisted(() => {
  const chunk = { ready: Promise.resolve(), release: () => {}, arm: () => {} }
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
// card arrives it does not take focus from the field (ruling Q400).
it("leaves focus in a field the person moved to while the refusal's code loaded", async () => {
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

// A browser hands a document focusin listener the event retargeted to the
// outermost shadow host, as document.activeElement names that host too.
// happy-dom hands it the element inside, so the test retargets as a browser
// would, for every listener after the window's capture phase.
function retargetFocusLikeABrowser() {
  const retarget = (event: FocusEvent) => {
    let root = (event.composedPath()[0] as Node | undefined)?.getRootNode()
    if (!(root instanceof ShadowRoot)) return
    let host = root.host
    while ((root = host.getRootNode()) instanceof ShadowRoot) host = root.host
    Object.defineProperty(event, "target", { configurable: true, get: () => host })
  }
  window.addEventListener("focusin", retarget, true)
  return () => window.removeEventListener("focusin", retarget, true)
}

// The person is typing in a field inside an open shadow root, opens the
// command palette, starts a new session and is refused. While the refusal's
// code loads they go back to the field. Its host is where focus was before
// the start, but the field is text entry, so the card leaves focus there.
it("leaves focus in a shadow root field the start was launched from", async () => {
  const restore = retargetFocusLikeABrowser()
  try {
    const base = workspaceSnapshot()
    const snapshot = workspaceSnapshot({ machine: { ...base.machine, providers: [codex] } })
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => { completeHandshake(socket, snapshot) })
    await settle()
    const user = userEvent.setup()
    const host = document.body.appendChild(document.createElement("div"))
    const field = host.attachShadow({ mode: "open" }).appendChild(Object.assign(document.createElement("input"), { "aria-label": "Review note" }))
    await user.click(field)
    await user.keyboard("review note")
    expect(document.activeElement).toBe(host)

    await user.keyboard("{Control>}k{/Control}")
    await user.type(screen.getByRole("combobox"), "New session")
    await user.keyboard("{Enter}")
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

    await user.click(field)
    await act(async () => { chunk.release() })
    const heading = await screen.findByRole("heading", { name: "Domovoi did not start this session" })
    // Several frames pass, enough for the card's move to have happened.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })

    expect(document.activeElement).not.toBe(heading)
    expect(host.shadowRoot?.activeElement).toBe(field)
    await user.keyboard(" more")
    expect(field.value).toBe("review note more")
  } finally {
    restore()
  }
})
