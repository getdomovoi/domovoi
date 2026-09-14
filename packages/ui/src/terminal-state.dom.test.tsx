import { act, cleanup, render, screen } from "@testing-library/react"
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

// A terminal that has exited still offers Restart, and Restart also needs the
// connection. The reason line is about the disabled controls, not about which
// ones they are, so it stays on screen after the process has gone.
it("keeps saying why Restart is inert when the process has exited offline", async () => {
  let handlers: Parameters<Parameters<typeof TerminalPane>[0]["controls"]["subscribe"]>[1] | undefined
  const base = controls()
  const live = {
    ...base,
    create: vi.fn(async () => ({
      terminalId: "terminal-one", sessionId: "session-billing", cols: 80, rows: 24, shell: "bash",
      cwd: "/worktrees/demo", buffer: "", owner: { client: "desktop" as const, clientId: "desktop-1" },
    })),
    subscribe: vi.fn((_id: string, next: typeof handlers) => { handlers = next; return () => {} }),
  }
  const view = (connected: boolean) => (
    <TerminalPane
      connected={connected}
      controls={live as unknown as Parameters<typeof TerminalPane>[0]["controls"]}
      machineName="mac-mini-m4"
      sessionId="session-billing"
    />
  )
  const { rerender } = render(view(true))
  await act(async () => { await Promise.resolve() })
  await act(async () => { handlers?.closed({ terminalId: "terminal-one", exitCode: 0 }) })
  rerender(view(false))

  expect(screen.getByRole("button", { name: /Restart/ }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByText(/Reconnect to the execution machine to restart/)).toBeTruthy()
})
