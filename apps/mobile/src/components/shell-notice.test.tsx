import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { ShellNotice } from "./shell-notice"
import { shellState, unreachableShell, type UnreachableShell } from "../shell-state"

// The screen only ever draws states where a daemon is in hand and unreachable.
// A phone with no daemon named at all is UnpairedScreen's, one tab at a time.
function unreachable(shell: ReturnType<typeof shellState>): UnreachableShell {
  const narrowed = unreachableShell(shell)
  if (!narrowed) throw new Error("this state is not ShellNotice's to draw")
  return narrowed
}

const reaching = unreachable(shellState({
  restoringCredential: false,
  hasCredential: true,
  hasSnapshot: false,
  fault: {
    retriable: true,
    headline: "Cannot reach the daemon",
    detail: "The connection did not open.",
  },
}))

const refused = unreachable(shellState({
  restoringCredential: false,
  hasCredential: true,
  hasSnapshot: false,
  fault: {
    retriable: false,
    headline: "The daemon refused this credential",
    detail: "The pairing token is wrong, or this device has been revoked. Pair again in Settings.",
  },
}))

const restoring = unreachable(shellState({
  restoringCredential: true,
  hasCredential: false,
  hasSnapshot: false,
  fault: undefined,
}))

async function draw(overrides: Partial<Parameters<typeof ShellNotice>[0]> = {}) {
  const props = {
    shell: reaching,
    address: "ws://studio-arch:7433",
    bottomInset: 0,
    onOpenSettings: jest.fn<() => void>(),
    onRetry: jest.fn<() => void>(),
    ...overrides,
  }
  await render(<ShellNotice {...props} />)
  return props
}

describe("ShellNotice", () => {
  // The whole point of the screen: it says the phone cannot see anything rather
  // than drawing a session list it cannot vouch for.
  it("says no daemon is reachable and names the one route it has", async () => {
    await draw()
    expect(screen.getByText("No daemon reachable")).toBeOnTheScreen()
    expect(screen.getByText("ws://studio-arch:7433")).toBeOnTheScreen()
  })

  it("asks for a connection now when the retry is pressed", async () => {
    const { onRetry } = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Retry now" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  // Retrying a credential the daemon has already refused spends battery to be
  // told the same thing again, so the offer is not made.
  it("offers Settings rather than a retry when the answer will not change", async () => {
    await draw({ shell: refused })
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull()
    expect(screen.getByRole("button", { name: "Settings" })).toBeOnTheScreen()
  })

  // Restoring is the phone still working. Calling that unreachable would be a
  // failure reported before anything has failed.
  it("does not call a credential that is still being read unreachable", async () => {
    await draw({ shell: restoring, address: "" })
    expect(screen.queryByText("No daemon reachable")).toBeNull()
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull()
  })

  it("names no address it has not been given", async () => {
    await draw({ shell: restoring, address: "" })
    expect(screen.queryByText("Address")).toBeNull()
  })
})
