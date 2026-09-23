import type { SessionSearchResult, SessionSummary } from "@getdomovoi/protocol"
import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { CommandPalette } from "./command-palette"

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

function palette(search: (machineId: string, query: string, signal: AbortSignal) => Promise<SessionSearchResult>, open = vi.fn()) {
  render(<CommandPalette open platform="darwin" commands={[]} onOpenChange={vi.fn()} restoreFocusTo={null} machineSearch={{ machines, search, open }} />)
  return { user: userEvent.setup(), open }
}

// J39 (2026-09-23): the palette asks each admitted machine directly, shows
// what each one answered, and never rounds a silent machine down to no results.
it("searches every admitted machine and says which answered", async () => {
  const hetzner = deferred<SessionSearchResult>()
  const wsl = deferred<SessionSearchResult>()
  const search = vi.fn((machineId: string) => machineId === machines[0]!.id ? hetzner.promise : wsl.promise)
  const { user, open } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  await screen.findByText("SESSIONS ON OTHER MACHINES")
  expect(screen.getByText("titles and summaries, every machine")).toBeTruthy()
  expect(screen.getByText("1 of 3 answered, asking each machine directly")).toBeTruthy()
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
