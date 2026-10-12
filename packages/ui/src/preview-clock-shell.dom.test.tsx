import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { protocolVersion, type FleetMachine } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { installFakeWebSocket, completeHandshake, respond, sentRequests, workspaceSnapshot } from "./test-support/fake-websocket"

let sockets: ReturnType<typeof installFakeWebSocket>
let loadedFrames: boolean | undefined
const happyDom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM
beforeEach(() => {
  globalThis.localStorage?.clear()
  sockets = installFakeWebSocket()
  loadedFrames = happyDom?.settings.disableIframePageLoading
  if (happyDom) happyDom.settings.disableIframePageLoading = true
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sockets.uninstall()
  if (happyDom && loadedFrames !== undefined) happyDom.settings.disableIframePageLoading = loadedFrames
})
const settle = () => act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve() })
const machineId = `machine-${"b".repeat(32)}`
const deviceId = `device-${"c".repeat(32)}`
const observedAt = "2026-09-06T00:00:00.000Z"
const transport = { kind: "local", endpoint: "ws://127.0.0.1:49812/rpc", authenticated: true } as const
const studio = workspaceSnapshot()
const target = {
  ...studio,
  machine: { ...studio.machine, id: machineId, name: "Studio" },
  artifacts: [...studio.artifacts, {
    id: "preview-on-studio",
    sessionId: studio.activeSessionId!,
    title: "Replay table",
    type: "preview" as const,
    revision: 1,
    mimeType: "text/html",
    path: "previews/replay.preview.html",
  }],
}
if (target.project) target.project = { ...target.project, machineId }
const machine: FleetMachine = {
  id: machineId, label: "Studio", platform: "linux", arch: "x64", version: "0.0.1", protocolVersion,
  connection: "direct", health: "healthy", self: false, capabilities: ["sessions", "terminals", "skills"],
  heartbeat: { state: "online", lastSeenAt: observedAt },
  verifiedRoute: { endpoint: "ws://127.0.0.1:49812/rpc", lastAuthenticatedAt: observedAt },
  transports: [transport],
}
const openStudio = /^Open its (\d+ )?sessions? on Studio$/u

// The preview grant is signed by the machine the window is attached to, so
// its expiry is read with that machine's clock offset, not the home
// daemon's. Here the home daemon runs two minutes ahead of this client and
// Studio 55 s behind: Studio's 60 s grant reads as one minute only with
// Studio's offset (with the home's, or none, it would be the 10 s floor).
it("reads an attached machine's preview grant with that machine's clock", async () => {
  // This client's clock stands still on a whole second, so the 60 s grant
  // reads exactly 60 s whatever the runner's speed (see the delay below).
  const now = Date.parse("2026-10-12T04:00:00.000Z")
  vi.spyOn(Date, "now").mockReturnValue(now)
  const user = userEvent.setup()
  render(<WorkspaceShell />)
  const home = sockets.socket(0)
  await act(async () => { completeHandshake(home) })
  await settle()
  await act(async () => { respond(home, "fleet.list", { daemonTime: new Date(now + 120_000).toISOString(), entries: [{ kind: "machine", machine }] }) })
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Machines and daemons/u }))
  await user.click(await screen.findByRole("button", { name: "Authorize this client for Studio" }))
  const dialog = screen.getByRole("dialog")
  await user.click(within(dialog).getByLabelText("Client credential"))
  await user.paste("x".repeat(43))
  await user.click(within(dialog).getByRole("button", { name: "Verify client access" }))
  await settle()
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const proof = sockets.socket(1)
  await act(async () => { completeHandshake(proof, target) })
  await settle()
  await act(async () => { respond(proof, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  await user.click(screen.getByRole("button", { name: openStudio }))
  await settle()
  await act(async () => { respond(home, "fleet.clientRoute", { outcome: "ready", machineId, transport }) })
  await settle()
  const remote = sockets.socket(2)
  await act(async () => { completeHandshake(remote, target) })
  await settle()
  await act(async () => { respond(remote, "device.current", { kind: "client", machineId, deviceId, client: "web", clientAccess: "full" }) })
  await settle()
  await act(async () => { respond(remote, "fleet.list", { daemonTime: new Date(now - 55_000).toISOString(), entries: [] }) })
  await settle()

  const sheet = screen.queryByRole("button", { name: "Open the sheet" })
  if (sheet) await user.click(sheet)
  await user.click(await screen.findByRole("tab", { name: "Preview" }))
  await waitFor(() => expect(sentRequests(remote, "artifact.authorize")).toHaveLength(1))
  expect(sentRequests(home, "artifact.authorize")).toHaveLength(0)
  // A slow runner (Windows CI took over a second here) between Studio's
  // daemonTime and its grant answer. With a running clock that time is real
  // grant age and the chip rightly reads 59s; the pinned clock above keeps
  // both stamps and the receipt at one instant, so only the offset decides.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const request = sentRequests(remote, "artifact.authorize")[0]!.params as {
    sessionId: string, artifactId: string, revision: number, bridgeChannel?: string, parentOrigin?: string
  }
  await act(async () => {
    respond(remote, "artifact.authorize", {
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      revision: request.revision,
      purpose: "preview",
      ...(request.bridgeChannel ? { bridgeChannel: request.bridgeChannel } : {}),
      ...(request.parentOrigin ? { parentOrigin: request.parentOrigin } : {}),
      expiresAt: Math.floor((now - 55_000) / 1_000) + 60,
      signature: "s".repeat(43),
    })
  })
  expect(await screen.findByText("authorized · 1m left")).toBeTruthy()
}, 15_000)
