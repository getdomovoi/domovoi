import { describe, expect, it, jest } from "@jest/globals"
import { terminalListResultSchema, terminalWatchResultSchema, type TerminalSummary, type TerminalWatchResult } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import { watchFrom, withNotification, type TerminalWatch } from "../terminal-rows"
import { WatchingScreen } from "./watching"

// Phone v2 frame 04 (A): the read-only terminal, full screen. Fixtures go
// through the protocol's own schemas.

const metrics: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }

const owner = { client: "desktop" as const, clientId: "desktop-1", device: { id: `device-${"a".repeat(32)}`, label: "MacBook Pro" } }

function summary(overrides: Partial<TerminalSummary> = {}): TerminalSummary {
  return terminalListResultSchema.parse({
    terminals: [{
      terminalId: "terminal-1",
      sessionId: "session-billing",
      cols: 120,
      rows: 34,
      shell: "/bin/zsh",
      cwd: "/Users/mira/dev/acme/.domovoi/worktrees/wt-billing-idem",
      owner,
      claimHeld: true,
      openedAt: "2026-10-06T13:52:04.000Z",
      state: "live",
      ...overrides,
    }],
  }).terminals[0]!
}

function result(overrides: Partial<TerminalWatchResult> = {}): TerminalWatchResult {
  return terminalWatchResultSchema.parse({
    ...summary(),
    buffer: "$ pnpm vitest run src/webhooks\n ✓ src/webhooks/handler.spec.ts (14 tests) 412ms\n",
    bufferStartsAt: "2026-10-06T13:52:04.000Z",
    earlierOutputDropped: false,
    watchedAt: "2026-10-06T14:06:12.000Z",
    ...overrides,
  })
}

function watching(overrides: Partial<TerminalWatchResult> = {}): TerminalWatch {
  return { state: "watching", record: watchFrom(result(overrides)) }
}

function more(watch: TerminalWatch, data: string): TerminalWatch {
  if (watch.state !== "watching") throw new Error("only a watched terminal takes output")
  return { state: "watching", record: withNotification(watch.record, { method: "terminal.output", params: { terminalId: "terminal-1", data } }, new Date("2026-10-06T14:07:00.000Z")) }
}

function props(watch: TerminalWatch, overrides: Partial<Parameters<typeof WatchingScreen>[0]> = {}) {
  return {
    title: "Migrate billing webhooks",
    watch,
    connected: true,
    notice: undefined,
    onBack: jest.fn<() => void>(),
    onRetry: jest.fn<() => void>(),
    ...overrides,
  }
}

async function draw(watch: TerminalWatch, overrides: Partial<Parameters<typeof WatchingScreen>[0]> = {}) {
  const given = props(watch, overrides)
  const view = await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <WatchingScreen {...given} />
    </SafeAreaProvider>,
  )
  const redraw = async (next: TerminalWatch) => {
    await view.rerender(
      <SafeAreaProvider initialMetrics={metrics}>
        <WatchingScreen {...given} watch={next} />
      </SafeAreaProvider>,
    )
  }
  return { given, redraw }
}

// The scroller only scrolls once it has measured content taller than its
// viewport, and the testing library drops scroll events on a disabled one.
async function scrollUp() {
  const output = screen.getByTestId("terminal-output")
  await fireEvent(output, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 500 } } })
  await fireEvent(output, "contentSizeChange", 390, 2000)
  await fireEvent.scroll(output, {
    nativeEvent: { contentOffset: { x: 0, y: 0 }, layoutMeasurement: { width: 390, height: 500 }, contentSize: { width: 390, height: 2000 } },
  })
}

describe("WatchingScreen", () => {
  it("names the shell, its size, Live and the device that holds the claim, read-only", async () => {
    await draw(watching())
    expect(screen.getByText("Migrate billing webhooks")).toBeOnTheScreen()
    expect(screen.getByText("read-only")).toBeOnTheScreen()
    expect(screen.getByText("zsh · wt-billing-idem")).toBeOnTheScreen()
    expect(screen.getByText("120×34")).toBeOnTheScreen()
    expect(screen.getByText("Live")).toBeOnTheScreen()
    expect(screen.getByText("Claimed by MacBook Pro")).toBeOnTheScreen()
    expect(screen.getByText("Read-only. Only the claimant can type or resize.")).toBeOnTheScreen()
    // A phone has nothing to type with.
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("shows the recent output, the mark where live output starts, and what arrived live", async () => {
    await draw(more(watching(), " ❯ src/webhooks/replay.spec.ts (5 tests | 1 failed) 2.41s\n"))
    expect(screen.getByText("$ pnpm vitest run src/webhooks")).toBeOnTheScreen()
    expect(screen.getByText(/^Recent output above\. Live from \d\d:\d\d:\d\d\.$/)).toBeOnTheScreen()
    expect(screen.getByText(" ❯ src/webhooks/replay.spec.ts (5 tests | 1 failed) 2.41s")).toBeOnTheScreen()
  })

  it("follows output from the start, and offers no jump while it does", async () => {
    await draw(watching())
    expect(screen.getByRole("switch", { name: "Follow output" })).toBeChecked()
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull()
  })

  it("counts what lands after follow is turned off, and jumping follows again", async () => {
    const first = watching()
    const { redraw } = await draw(first)
    await fireEvent.press(screen.getByRole("switch", { name: "Follow output" }))
    expect(screen.getByRole("switch", { name: "Follow output" })).not.toBeChecked()
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeOnTheScreen()

    await redraw(more(first, "one\ntwo\nthree\n"))
    expect(screen.getByText("3 new")).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "Jump to latest, 3 new" }))
    expect(screen.getByRole("switch", { name: "Follow output" })).toBeChecked()
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull()
  })

  it("leaves a reader who scrolled up where they are, and offers the jump back", async () => {
    const first = watching({ buffer: "line\n".repeat(80) })
    const { redraw } = await draw(first)
    await scrollUp()
    await redraw(more(first, "late\n"))
    expect(screen.getByRole("button", { name: "Jump to latest, 1 new" })).toBeOnTheScreen()
  })

  // 04b, with a failing exit: the end is stated and follow turns off.
  it("says Failed for a shell that exited with an error, and has nothing to follow", async () => {
    await draw(watching({ state: "closed", claimHeld: false, closedAt: "2026-10-06T14:09:40.000Z", exitCode: 1 }))
    expect(screen.getByText("Failed")).toBeOnTheScreen()
    expect(screen.getByText("Last claimed by MacBook Pro")).toBeOnTheScreen()
    expect(screen.getByText(/^The shell exited with code 1 at \d\d:\d\d:\d\d\. No more output will arrive\.$/)).toBeOnTheScreen()
    expect(screen.getByRole("switch", { name: "Follow output" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull()
  })

  // 04d: unconfirmed, not failed, and the gap marked where it began.
  it("says Unconfirmed and marks the gap while the connection is down", async () => {
    await draw(watching(), { connected: false })
    expect(screen.getByText("Unconfirmed")).toBeOnTheScreen()
    expect(screen.getByText("Last heard: claimed by MacBook Pro")).toBeOnTheScreen()
    expect(screen.getByText(/^Nothing received since \d\d:\d\d:\d\d\. Reconnecting replays the recent output first\.$/)).toBeOnTheScreen()
  })

  it("says it is reading before the daemon answers the watch", async () => {
    await draw({ state: "reading", summary: summary() })
    expect(screen.getByText("zsh · wt-billing-idem")).toBeOnTheScreen()
    expect(screen.getByText("Reading the terminal.")).toBeOnTheScreen()
  })

  it("shows the daemon's refusal of the watch and asks again on request", async () => {
    const { given } = await draw({ state: "failed", summary: summary(), message: "Terminal does not exist" })
    expect(screen.getByText("The terminal could not be read")).toBeOnTheScreen()
    expect(screen.getByText("Terminal does not exist")).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }))
    expect(given.onRetry).toHaveBeenCalledTimes(1)
  })

  it("goes back to the thread", async () => {
    const { given } = await draw(watching())
    await fireEvent.press(screen.getByRole("button", { name: "Back to the thread" }))
    expect(given.onBack).toHaveBeenCalledTimes(1)
  })
})
