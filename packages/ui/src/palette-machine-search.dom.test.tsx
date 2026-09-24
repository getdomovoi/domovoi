import type { SessionSearchResult, SessionSummary } from "@getdomovoi/protocol"
import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { CommandPalette, type WorkspaceCommand } from "./command-palette"

afterEach(cleanup)

const session = (id: string, title: string): SessionSummary => ({ ...demoWorkspace.sessions[0]!, id, title })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const machines = [
  { id: `machine-${"b".repeat(32)}`, label: "hetzner-cx42", transport: "tailnet" },
  { id: `machine-${"c".repeat(32)}`, label: "wsl-ubuntu-24", transport: "tailnet" },
]

const here = { id: `machine-${"a".repeat(32)}`, label: "mac-mini-m4" }
const none = (query: string): SessionSearchResult => ({ query, truncated: false, matches: [] })

function palette(search: (machineId: string, query: string, signal: AbortSignal) => Promise<SessionSearchResult>, open = vi.fn(), commands: WorkspaceCommand[] = []) {
  render(<CommandPalette open platform="darwin" commands={commands} onOpenChange={vi.fn()} restoreFocusTo={null} machineSearch={{ here, machines, search, open }} />)
  return { user: userEvent.setup(), open }
}

// J39 (2026-09-23): the palette asks each admitted machine directly, shows
// what each one answered, and never rounds a silent machine down to no results.
it("searches every admitted machine and says which answered", async () => {
  const hetzner = deferred<SessionSearchResult>()
  const wsl = deferred<SessionSearchResult>()
  const search = vi.fn((machineId: string) => machineId === here.id ? Promise.resolve(none("billing")) : machineId === machines[0]!.id ? hetzner.promise : wsl.promise)
  const { user, open } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  await screen.findByText("SESSIONS ON OTHER MACHINES")
  expect(screen.getByText("titles and summaries, every machine")).toBeTruthy()
  expect(await screen.findByText("1 of 3 answered, asking each machine directly")).toBeTruthy()
  expect(search).toHaveBeenCalledWith(machines[0]!.id, "billing", expect.any(AbortSignal))
  await act(async () => {
    hetzner.resolve({ query: "billing", truncated: false, matches: [
      { session: session("s-replay", "Replay failed billing events from the dead letter queue"), matchedIn: "title" },
      { session: session("s-drain", "Find why the staging queue drains at 40 per second"), matchedIn: "summary" },
    ] })
  })
  const group = screen.getByRole("group", { name: "hetzner-cx42" })
  expect(group.textContent).toContain("2 matches")
  expect(within(group).getByText("in summary")).toBeTruthy()
  await act(async () => { wsl.reject(new Error("no reply")) })
  expect(screen.getByText("searched 2 of 3 machines")).toBeTruthy()
  expect(screen.getByRole("group", { name: "wsl-ubuntu-24" }).textContent).toContain("not searched, did not answer")
  expect(screen.getByText("wsl-ubuntu-24 did not answer, so its sessions were not searched. This is not the same as having no results, and Domovoi will not round it down to one.")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Search only what answered" }))
  expect(screen.getByText("searched the 2 machines that answered")).toBeTruthy()
  expect(screen.getByRole("group", { name: "wsl-ubuntu-24" }).textContent).toContain("not searched, left out")
  await user.click(screen.getByText("Replay failed billing events from the dead letter queue"))
  expect(open).toHaveBeenCalledWith(machines[0]!.id, "s-replay")
})

it("asks nothing until there is a query, and says when a machine has no match", async () => {
  const search = vi.fn(async (): Promise<SessionSearchResult> => ({ query: "x", truncated: false, matches: [] }))
  const { user } = palette(search)
  expect(screen.queryByText("SESSIONS ON OTHER MACHINES")).toBeNull()
  expect(search).not.toHaveBeenCalled()
  await user.type(screen.getByRole("combobox"), "zz")
  await screen.findByText("searched 3 of 3 machines")
  expect(screen.getByRole("group", { name: "hetzner-cx42" }).textContent).toContain("no matches")
})

// Review 2026-09-23: the window's own machine is searched too and counted by
// its answer, and its summary matches join the SESSIONS group.
it("searches the window's own machine and counts it by its answer", async () => {
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => {
    if (machineId === here.id) throw new Error("no reply")
    return none("billing")
  })
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  expect(await screen.findByText("searched 2 of 3 machines")).toBeTruthy()
  expect(search).toHaveBeenCalledWith(here.id, "billing", expect.any(AbortSignal))
  expect(screen.getByText("mac-mini-m4 did not answer, so its sessions were not searched. This is not the same as having no results, and Domovoi will not round it down to one.")).toBeTruthy()
})

it("adds the window's own summary matches to SESSIONS", async () => {
  const run = vi.fn()
  const local: WorkspaceCommand = { id: "session-s-local", label: "Tidy the webhook retries", section: "Sessions", keywords: [], kind: "SESSION", run }
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === here.id
    ? { query: "billing", truncated: false, matches: [{ session: session("s-local", "Tidy the webhook retries"), matchedIn: "summary" }] }
    : none("billing"))
  const { user } = palette(search, vi.fn(), [local])
  await user.type(screen.getByRole("combobox"), "billing")
  const sessions = await screen.findByRole("group", { name: "SESSIONS" })
  expect(within(sessions).getByText("Tidy the webhook retries")).toBeTruthy()
  expect(within(sessions).getByText("in summary")).toBeTruthy()
  await user.click(within(sessions).getByText("Tidy the webhook retries"))
  expect(run).toHaveBeenCalledOnce()
})

it("names every silent machine in one plural notice", async () => {
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => {
    if (machineId === here.id) return none("billing")
    throw new Error("no reply")
  })
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  expect(await screen.findByText("hetzner-cx42 and wsl-ubuntu-24 did not answer, so their sessions were not searched. This is not the same as having no results, and Domovoi will not round it down to one.")).toBeTruthy()
})
