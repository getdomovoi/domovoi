import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { TerminalPane } from "./terminal-pane"

afterEach(cleanup)

const controls = () => ({
  clientId: "desktop-1",
  create: vi.fn(async () => { throw new Error("not reached") }),
  write: vi.fn(async () => {}),
  resize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  claim: vi.fn(async () => ({ terminalId: "terminal-one", owner: { client: "desktop" as const, clientId: "desktop-1" } })),
  subscribe: vi.fn(() => () => {}),
})

const pane = (over: Record<string, unknown> = {}) => render(
  <TerminalPane
    connected
    controls={controls() as unknown as Parameters<typeof TerminalPane>[0]["controls"]}
    machineName="mac-mini-m4"
    sessionId="session-billing"
    {...over}
  />,
)

// The only empty state this pane has is a legitimate collapse: it is reachable
// with no session and nothing else, because every other cause is pane chrome
// rather than a blank screen. Pinned so a later reading does not "fix" it.
it("shows its one empty state only when there is no session", () => {
  pane({ sessionId: null })

  expect(screen.getByText("No active session")).toBeTruthy()
})

// The status dot was a raw span, aria-hidden, beside a screen-reader-only line.
// So a sighted reader told connected from disconnected by colour alone, which is
// the rule the design system's own atom exists to enforce.
it("says its status in words rather than leaving colour to carry it", () => {
  pane({ connected: false })

  expect(screen.getByText("disconnected")).toBeTruthy()
})

// "connecting" as the fallback for an unknown shell said the wrong thing while
// disconnected: a pane that is not connected is not on its way to being.
it("does not claim to be connecting while disconnected", () => {
  const { container } = pane({ connected: false })

  expect(container.textContent).not.toContain("connecting")
})

// Three controls go inert on disconnect. A disabled control with no reason reads
// as broken rather than unavailable, the same failure as the skills pane's dead
// review button.
it("says why its controls are inert while disconnected", () => {
  pane({ connected: false })

  expect(screen.getByText(/Reconnect to the execution machine/)).toBeTruthy()
})
