import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspaceConnectionStatus } from "./connection-status.js"

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

  it("keeps the lost-daemon copy for an ordinary disconnect", () => {
    render(<WorkspaceConnectionStatus {...baseProps} reconnecting />)

    expect(
      screen.getByText(
        "Lost the daemon on this-machine. Existing session state remains on that machine.",
      ),
    ).toBeDefined()
    expect(screen.getByText("retrying")).toBeDefined()
    expect(screen.getByRole("button", { name: "Reconnect now" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Change credential" })).toBeNull()
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

    screen.getByRole("button", { name: "Reconnect now" }).click()

    expect(onReconnect).toHaveBeenCalledOnce()
  })
})
