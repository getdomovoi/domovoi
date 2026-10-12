import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useWorkspaceConnection, WorkspaceConnectionProvider, WorkspaceConnectionStatus } from "./connection-status.js"

afterEach(cleanup)

const baseProps = {
  connected: false,
  reconnecting: false,
  authenticationRequired: null,
  protocolError: null,
  connectionError: "",
  machineName: "this-machine" as const,
  onReconnect: () => {},
}

describe("WorkspaceConnectionStatus", () => {
  it("says retrying only while a reconnect is scheduled", () => {
    const { rerender } = render(
      <WorkspaceConnectionStatus {...baseProps} reconnecting machineName={undefined} />,
    )

    expect(screen.getByText("retrying")).toBeDefined()

    rerender(<WorkspaceConnectionStatus {...baseProps} reconnecting={false} machineName={undefined} />)
    expect(screen.queryByText("retrying")).toBeNull()
  })

  it("tells a refused connection why it was refused and drops the retrying label", () => {
    render(
      <WorkspaceConnectionStatus
        {...baseProps}
        authenticationRequired="device credential revoked"
      />,
    )

    expect(
      screen.getByText(
        "The daemon on this-machine refused this connection: device credential revoked",
      ),
    ).toBeDefined()
    expect(screen.queryByText("retrying")).toBeNull()
  })

  it("explains a client that is out of date with the daemon even while connected", () => {
    render(
      <WorkspaceConnectionStatus
        {...baseProps}
        connected
        protocolError="Daemon sent a workspace.changed notification this client could not parse"
      />,
    )

    expect(
      screen.getByText(
        "This client is out of date with the daemon. Daemon sent a workspace.changed notification this client could not parse",
      ),
    ).toBeDefined()
    expect(screen.queryByText("Lost the daemon")).toBeNull()
  })

  // The design's banner: the machine on one line, then the mono line that says
  // what is still true on it.
  it("names the machine and says what is still intact on it", () => {
    render(<WorkspaceConnectionStatus {...baseProps} reconnecting />)

    expect(screen.getByText("Lost the daemon on this-machine")).toBeDefined()
    expect(
      screen.getByText("the worktree and this thread are intact on the machine, nothing was rolled back"),
    ).toBeDefined()
    expect(screen.getByText("retrying")).toBeDefined()
    expect(screen.getByRole("button", { name: "Retry now" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Change credential" })).toBeNull()
  })

  // Drawn as an outline in the banner's own danger tones. A filled
  // destructive button reads as an action that destroys something.
  it("draws Retry now as an outline in danger tones", () => {
    render(<WorkspaceConnectionStatus {...baseProps} />)

    const retry = screen.getByRole("button", { name: "Retry now" })
    expect(retry.className).toContain("border-danger-border")
    expect(retry.className).toContain("text-danger-foreground")
    expect(retry.className).not.toContain("bg-destructive")
  })

  it("says when the daemon was last heard only when that is known", () => {
    const lostAt = new Date("2026-10-12T10:00:00.000Z")
    const { rerender } = render(
      <WorkspaceConnectionStatus {...baseProps} lastHeardAt={lostAt} now={new Date("2026-10-12T10:00:41.000Z")} />,
    )
    expect(screen.getByText("Lost the daemon on this-machine, last heard 41s ago")).toBeDefined()

    rerender(<WorkspaceConnectionStatus {...baseProps} lastHeardAt={undefined} now={new Date("2026-10-12T10:00:41.000Z")} />)
    expect(screen.getByText("Lost the daemon on this-machine")).toBeDefined()
    expect(screen.queryByText(/last heard/u)).toBeNull()
  })

  it("leaves the lost banner to the thread column when the shell has one", () => {
    render(<WorkspaceConnectionStatus {...baseProps} lostBanner={false} protocolError="Client is too old" />)

    expect(screen.queryByText(/Lost the daemon/u)).toBeNull()
    expect(screen.getByText("This client is out of date with the daemon. Client is too old")).toBeDefined()
  })

  it("offers the credential action when one is available", () => {
    render(
      <WorkspaceConnectionStatus
        {...baseProps}
        authenticationRequired="authentication failed"
        onChangeCredential={() => {}}
      />,
    )

    expect(screen.getByRole("button", { name: "Change credential" })).toBeDefined()
  })

  it("reconnects through the banner action", async () => {
    const onReconnect = vi.fn()
    render(<WorkspaceConnectionStatus {...baseProps} onReconnect={onReconnect} />)

    screen.getByRole("button", { name: "Retry now" }).click()

    expect(onReconnect).toHaveBeenCalledOnce()
  })
})

// Last heard is when this client saw an open loopback connection to that
// machine close: a daemon on this machine that stops or dies closes its socket
// at once. A client that opened with the daemon already gone never heard it, a
// switch to another machine is not a loss of this one, and a connection over a
// network can die silently and be seen closing late, so none of them says a
// time.
describe("WorkspaceConnectionProvider", () => {
  const connection = { ...baseProps, connected: true, machineId: "machine-1", endpoint: "ws://127.0.0.1:47831/rpc" }
  function Banner() {
    const state = useWorkspaceConnection()
    return state ? <WorkspaceConnectionStatus {...state} /> : null
  }

  afterEach(() => { vi.useRealTimers() })

  it("records last heard when it sees a loopback connection close", () => {
    vi.useFakeTimers({ now: new Date("2026-10-12T10:00:00.000Z") })
    const { rerender } = render(<WorkspaceConnectionProvider {...connection}><Banner /></WorkspaceConnectionProvider>)
    rerender(<WorkspaceConnectionProvider {...connection} connected={false}><Banner /></WorkspaceConnectionProvider>)
    act(() => { vi.advanceTimersByTime(41_000) })

    expect(screen.getByText("Lost the daemon on this-machine, last heard 41s ago")).toBeDefined()

    rerender(<WorkspaceConnectionProvider {...connection}><Banner /></WorkspaceConnectionProvider>)
    expect(screen.queryByText(/Lost the daemon/u)).toBeNull()
  })

  it("does not invent a time for a daemon it never heard", () => {
    render(<WorkspaceConnectionProvider {...connection} connected={false}><Banner /></WorkspaceConnectionProvider>)

    expect(screen.getByText("Lost the daemon on this-machine")).toBeDefined()
    expect(screen.queryByText(/last heard/u)).toBeNull()
  })

  it("does not carry last heard to a machine it was not heard from", () => {
    const { rerender } = render(<WorkspaceConnectionProvider {...connection}><Banner /></WorkspaceConnectionProvider>)
    rerender(<WorkspaceConnectionProvider {...connection} connected={false} machineId={undefined} machineName={undefined}><Banner /></WorkspaceConnectionProvider>)
    rerender(<WorkspaceConnectionProvider {...connection} connected={false} machineId="machine-2" machineName="other-machine"><Banner /></WorkspaceConnectionProvider>)

    expect(screen.getByText("Lost the daemon on other-machine")).toBeDefined()
    expect(screen.queryByText(/last heard/u)).toBeNull()
  })

  // Two machines can share a name. The time belongs to the machine, not to
  // the word on the banner.
  it("tells machines apart by id, not by name", () => {
    const { rerender } = render(<WorkspaceConnectionProvider {...connection}><Banner /></WorkspaceConnectionProvider>)
    rerender(<WorkspaceConnectionProvider {...connection} connected={false}><Banner /></WorkspaceConnectionProvider>)
    rerender(<WorkspaceConnectionProvider {...connection} connected={false} machineId="machine-2"><Banner /></WorkspaceConnectionProvider>)

    expect(screen.getByText("Lost the daemon on this-machine")).toBeDefined()
    expect(screen.queryByText(/last heard/u)).toBeNull()
  })

  it("says no time for a daemon it reached over a network", () => {
    const remote = { ...connection, endpoint: "wss://studio.tailnet.example:47831/rpc" }
    const { rerender } = render(<WorkspaceConnectionProvider {...remote}><Banner /></WorkspaceConnectionProvider>)
    rerender(<WorkspaceConnectionProvider {...remote} connected={false}><Banner /></WorkspaceConnectionProvider>)

    expect(screen.getByText("Lost the daemon on this-machine")).toBeDefined()
    expect(screen.queryByText(/last heard/u)).toBeNull()
  })

  // The age ticks every second. Inside a live region each tick would be
  // announced again, so the ticking words are hidden from assistive
  // technology and the region carries the clock time instead.
  it("keeps the ticking age out of the live announcement", () => {
    vi.useFakeTimers({ now: new Date("2026-10-12T10:00:00.000Z") })
    const { rerender } = render(<WorkspaceConnectionProvider {...connection}><Banner /></WorkspaceConnectionProvider>)
    rerender(<WorkspaceConnectionProvider {...connection} connected={false}><Banner /></WorkspaceConnectionProvider>)
    const region = screen.getByRole("status")
    const announced = () => {
      const copy = region.cloneNode(true) as HTMLElement
      for (const hidden of copy.querySelectorAll("[aria-hidden]")) hidden.remove()
      return copy.textContent
    }
    const before = announced()
    act(() => { vi.advanceTimersByTime(5_000) })

    expect(announced()).toBe(before)
    expect(announced()).toContain("last heard at")
    expect(screen.getByText("Lost the daemon on this-machine, last heard 5s ago")).toBeDefined()
  })
})
