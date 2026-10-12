import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, expect, it } from "vitest"

import { WorkspaceConnectionProvider } from "./connection-status"
import { ThreadSkeleton } from "./loading-skeleton"

afterEach(cleanup)

function Connection({ reconnecting = false, connectionError = "", authenticationRequired = null, children }: {
  reconnecting?: boolean
  connectionError?: string
  authenticationRequired?: string | null
  children: ReactNode
}) {
  return (
    <WorkspaceConnectionProvider
      connected={false}
      reconnecting={reconnecting}
      authenticationRequired={authenticationRequired}
      protocolError={null}
      connectionError={connectionError}
      machineName={undefined}
      onReconnect={() => {}}
    >
      {children}
    </WorkspaceConnectionProvider>
  )
}

it("gives the thread its own shape and its own line", () => {
  render(<ThreadSkeleton from="mac-mini-m4" />)

  expect(screen.getByTestId("thread-skeleton")).toBeTruthy()
  expect(screen.getByRole("status").textContent).toBe("reading the thread from mac-mini-m4")
})

// Ruled Q344 A: before the hello there is no machine name, and the line names
// the host it dialled, never the raw RPC address.
it("names the host rather than the RPC address before attach", () => {
  render(<ThreadSkeleton from="ws://127.0.0.1:47831/rpc" />)

  expect(screen.getByRole("status").textContent).toBe("reading the thread from 127.0.0.1:47831")
})

// Motion is functional when it says work is in flight. A still block cannot be
// told from a real but empty row, or from a render that has hung, and the line
// beside it is equally still.
it("shimmers, because stillness would say nothing", () => {
  const { container } = render(<ThreadSkeleton from="mac-mini-m4" />)

  for (const bar of container.querySelectorAll("span[aria-hidden]")) {
    expect(bar.className).toContain("skeleton-bar")
  }
})

// dv-pulse is reserved for something that wants a decision. A skeleton wants
// nothing, so the wrong keyframe here would be a wrong claim rather than a
// styling choice.
it("does not pulse, which would claim it wants a decision", () => {
  const { container } = render(<ThreadSkeleton from="mac-mini-m4" />)

  expect(container.innerHTML).not.toContain("pulse")
})

it("keeps shimmering while the first attempt is still in flight", () => {
  const { container } = render(<Connection><ThreadSkeleton from="ws://127.0.0.1:47831/rpc" /></Connection>)

  expect(screen.getByRole("status").textContent).toBe("reading the thread from 127.0.0.1:47831")
  for (const bar of container.querySelectorAll("span[aria-hidden]")) expect(bar.className).toContain("skeleton-bar")
})

// Ruled Q344 A: once the first attempt has failed, nothing is being read, and
// a shimmer and a "reading" line would claim a read that is not happening. The
// skeleton stops and says what is still true: nothing has been read yet. It
// stays stopped while the next attempt is in flight under the banner.
it("stops and says nothing has been read once the first attempt failed", () => {
  const { container, rerender } = render(
    <Connection reconnecting><ThreadSkeleton from="ws://127.0.0.1:47831/rpc" /></Connection>,
  )

  const stopped = () => {
    expect(screen.getByRole("status").textContent).toBe("Not connected. Nothing has been read from 127.0.0.1:47831 yet.")
    const bars = container.querySelectorAll("span[aria-hidden]")
    expect(bars.length).toBeGreaterThan(0)
    for (const bar of bars) expect(bar.className).not.toContain("skeleton-bar")
  }
  stopped()
  rerender(<Connection><ThreadSkeleton from="ws://127.0.0.1:47831/rpc" /></Connection>)
  stopped()
})

it("stops for a refused or failed connection too", () => {
  render(<Connection authenticationRequired="authentication failed"><ThreadSkeleton from="ws://127.0.0.1:47831/rpc" /></Connection>)
  expect(screen.getByRole("status").textContent).toBe("Not connected. Nothing has been read from 127.0.0.1:47831 yet.")
  cleanup()

  render(<Connection connectionError="Cannot reach ws://127.0.0.1:47831/rpc"><ThreadSkeleton from="ws://127.0.0.1:47831/rpc" /></Connection>)
  expect(screen.getByRole("status").textContent).toBe("Not connected. Nothing has been read from 127.0.0.1:47831 yet.")
})
