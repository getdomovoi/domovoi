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
// the surface's own boundary, which shows its loading line meanwhile.
const chunk = vi.hoisted(() => {
  let release = () => {}
  const ready = new Promise<void>((resolve) => { release = resolve })
  return { ready, release: () => release() }
})
vi.mock("./session-refusal-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-refusal-card")>()
  const { createElement, lazy } = await import("react")
  const Delayed = lazy(async () => {
    await chunk.ready
    return { default: actual.SessionRefusalCard }
  })
  const SessionRefusalCard = (props: Parameters<typeof actual.SessionRefusalCard>[0]) => createElement(Delayed, props)
  return { ...actual, SessionRefusalCard }
})

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
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
