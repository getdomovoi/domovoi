import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

// The design draws the lost-daemon banner at the top of the thread column.
// Without a thread column there is nowhere else to say it, so it spans the
// window as before.
it("draws the banner across the window when there is no thread column", async () => {
  render(<WorkspaceShell />)
  await settle()

  // Before the hello the skeleton names the host, never the RPC address.
  expect(screen.getByTestId("thread-skeleton").textContent).not.toContain("ws://")

  await act(async () => { harness.socket(0).drop() })
  await settle()

  const banner = screen.getByText("Cannot reach the daemon. Workspace state is waiting for a verified response.")
  expect(banner.closest("main")).toBeNull()
  expect(screen.getByTestId("thread-skeleton").textContent).toBe("Not connected. Nothing has been read from 127.0.0.1:47831 yet.")
})

const lostBanners = () => screen.getAllByRole("status").filter((region) => region.textContent?.includes("Lost the daemon on macbook-pro-m3"))

// The desktop app runs its own daemon on this machine, so the close of its
// loopback socket is when the daemon was last heard.
it("draws the banner at the top of the thread column once there is one", async () => {
  render(<WorkspaceShell clientKind="desktop" localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app" }} />)
  await act(async () => { completeHandshake(harness.socket(0)) })
  await settle()

  await act(async () => { harness.socket(0).drop() })
  await settle()

  const banners = lostBanners()
  expect(banners).toHaveLength(1)
  expect(banners[0]!.textContent).toContain("last heard")
  const thread = banners[0]!.closest("main")
  expect(thread).not.toBeNull()
  expect(thread!.querySelector("[data-workspace-composer]")).not.toBeNull()
})

// A browser tab's loopback address can be the local end of an SSH forward to
// another machine, so a tab says no time.
it("says no time in a browser, whose loopback address may be a forward", async () => {
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0)) })
  await settle()

  await act(async () => { harness.socket(0).drop() })
  await settle()

  const banners = lostBanners()
  expect(banners).toHaveLength(1)
  expect(banners[0]!.textContent).not.toContain("last heard")
})
