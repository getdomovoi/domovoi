import type { SessionSearchResult, SessionSummary } from "@getdomovoi/protocol"
import { demoWorkspace } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { CommandPalette } from "./command-palette"
import type { WorkspaceCommand } from "./workspace-commands"

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
  const onOpenChange = vi.fn()
  const machineSearch = { here, machines, search, open }
  const view = render(<CommandPalette open platform="darwin" commands={commands} onOpenChange={onOpenChange} restoreFocusTo={null} machineSearch={machineSearch} />)
  // The shell hands the palette its switch while the window moves (J39), and
  // a new search target list once it has arrived.
  const switching = (to: { machineId: string; sessionId: string } | null, after = machineSearch) => {
    view.rerender(<CommandPalette open platform="darwin" commands={commands} onOpenChange={onOpenChange} restoreFocusTo={null} machineSearch={after} switching={to} />)
  }
  return { user: userEvent.setup(), open, onOpenChange, switching }
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
  expect(screen.getByText("wsl-ubuntu-24 did not answer, so its sessions were not searched.")).toBeTruthy()
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
  expect(screen.getByText("mac-mini-m4 did not answer, so its sessions were not searched.")).toBeTruthy()
})

it("adds the window's own summary matches to SESSIONS", async () => {
  const run = vi.fn()
  const local: WorkspaceCommand = { id: "session-s-local", label: "Tidy the webhook retries", section: "Sessions", keywords: [], kind: "SESSION", run }
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === here.id
    ? { query: "billing", truncated: false, matches: [{ session: session("s-local", "Tidy the webhook retries"), matchedIn: "summary" }] }
    : none("billing"))
  const { user } = palette(search, vi.fn(), [local])
  await user.type(screen.getByRole("combobox"), "billing")
  // The design names the group for this machine while others are searched.
  const sessions = await screen.findByRole("group", { name: "SESSIONS ON THIS MACHINE" })
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
  expect(await screen.findByText("hetzner-cx42 and wsl-ubuntu-24 did not answer, so their sessions were not searched.")).toBeTruthy()
})

// Ruled 2026-09-23 (A): a machine that stopped at the search limit says so.
it("says when a machine stopped at the search limit", async () => {
  const matches = Array.from({ length: 20 }, (_, index) => ({ session: session(`s-${index}`, `Billing task ${index}`), matchedIn: "title" as const }))
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === machines[0]!.id
    ? { query: "billing", truncated: true, matches }
    : none("billing"))
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  await screen.findByText("searched 3 of 3 machines")
  const group = screen.getByRole("group", { name: "hetzner-cx42" })
  expect(group.textContent).toContain("first 20 matches, more not shown")
  expect(group.textContent).not.toContain("Type more")
  expect(screen.getByRole("group", { name: "wsl-ubuntu-24" }).textContent).toContain("no matches")
})

// Desktop V2 (xmModel): leaving a silent machine out is undone by Add it back,
// and until then the machine stays unsearched, later queries included.
it("leaves a silent machine out until it is added back", async () => {
  let wslAnswers = false
  const search = vi.fn(async (machineId: string, query: string): Promise<SessionSearchResult> => {
    if (machineId === machines[1]!.id && !wslAnswers) throw new Error("no reply")
    return none(query)
  })
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  await user.click(await screen.findByRole("button", { name: "Search only what answered" }))
  expect(screen.getByText("wsl-ubuntu-24 is left out, so its sessions stay unsearched until you add it back.")).toBeTruthy()
  expect(screen.queryByText("wsl-ubuntu-24 did not answer, so its sessions were not searched.")).toBeNull()

  search.mockClear()
  await user.type(screen.getByRole("combobox"), "s")
  await screen.findByText("searched the 2 machines that answered")
  await waitFor(() => expect(search).toHaveBeenCalledWith(machines[0]!.id, "billings", expect.any(AbortSignal)))
  expect(search).not.toHaveBeenCalledWith(machines[1]!.id, expect.anything(), expect.anything())
  expect(screen.getByRole("group", { name: "wsl-ubuntu-24" }).textContent).toContain("not searched, left out")

  wslAnswers = true
  await user.click(screen.getByRole("button", { name: "Add it back" }))
  expect(search).toHaveBeenCalledWith(machines[1]!.id, "billings", expect.any(AbortSignal))
  await screen.findByText("searched 3 of 3 machines")
  expect(screen.getByRole("group", { name: "wsl-ubuntu-24" }).textContent).toContain("no matches")
  expect(screen.queryByRole("button", { name: "Add it back" })).toBeNull()
})

// The notice is the design's: a dot and one sentence on the card's own
// ground, not a danger panel with a second sentence.
it("says a machine did not answer in the design's notice", async () => {
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => {
    if (machineId === machines[1]!.id) throw new Error("no reply")
    return none("billing")
  })
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  const sentence = await screen.findByText("wsl-ubuntu-24 did not answer, so its sessions were not searched.")
  const notice = sentence.closest("[data-palette-notice]") as HTMLElement
  expect(notice.querySelector("[data-status-dot]")).toBeTruthy()
  expect(notice.className).not.toContain("danger")
})

it("marks each machine's answer with a dot, and sweeps while it asks", async () => {
  const hetzner = deferred<SessionSearchResult>()
  const search = vi.fn((machineId: string) => machineId === machines[0]!.id ? hetzner.promise : Promise.resolve(none("billing")))
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  await screen.findByText("2 of 3 answered, asking each machine directly")
  const asking = screen.getByRole("group", { name: "hetzner-cx42" })
  expect(asking.querySelector("[data-status-dot]")).toBeTruthy()
  expect(asking.querySelector(".sweep-bar")).toBeTruthy()
  expect(asking.textContent).toContain("asking")
  await act(async () => { hetzner.resolve(none("billing")) })
  expect(screen.getByRole("group", { name: "hetzner-cx42" }).querySelector(".sweep-bar")).toBeNull()
  expect(screen.getByRole("group", { name: "wsl-ubuntu-24" }).querySelector("[data-status-dot]")).toBeTruthy()
})

// The design's row meta is the session's state and its age ("failed 1h ago").
// A running session shows no duration: the wire carries no turn start until
// protocol 0.8.0 (ruling Q390 A).
it("shows a remote session's state and age as its meta", async () => {
  const hourAgo = new Date(Date.now() - 61 * 60_000).toISOString()
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === machines[0]!.id
    ? { query: "billing", truncated: false, matches: [
        { session: { ...session("s-replay", "Replay failed billing events"), state: "active", activeTurnId: "turn-1" }, matchedIn: "title" },
        { session: { ...session("s-drain", "Find why the queue drains"), state: "failed", updatedAt: hourAgo }, matchedIn: "title" },
      ] }
    : none("billing"))
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  const replay = await screen.findByRole("option", { name: /Replay failed billing events/u })
  expect(replay.querySelector("[data-palette-meta]")?.textContent).toBe("running")
  expect(replay.querySelector("[data-status-dot]")).toBeTruthy()
  const drain = screen.getByRole("option", { name: /Find why the queue drains/u })
  expect(drain.querySelector("[data-palette-meta]")?.textContent).toBe("failed 1h ago")
})

// Picking a row on another machine keeps the palette open on that row while
// the window switches, and closes it once the shell has opened the session.
it("shows the switch on the picked row and closes when it lands", async () => {
  const hits = { query: "billing", truncated: false, matches: [{ session: session("s-replay", "Replay failed billing events"), matchedIn: "title" as const }] }
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === machines[0]!.id ? hits : none("billing"))
  const open = vi.fn(() => true)
  const { user, onOpenChange, switching } = palette(search, open)
  await user.type(screen.getByRole("combobox"), "billing")
  await user.click(await screen.findByText("Replay failed billing events"))
  expect(open).toHaveBeenCalledWith(machines[0]!.id, "s-replay")
  expect(onOpenChange).not.toHaveBeenCalled()
  // The window has moved, so the shell's search targets have too; the row
  // stays as it was picked.
  switching({ machineId: machines[0]!.id, sessionId: "s-replay" }, { here: { id: machines[0]!.id, label: "hetzner-cx42" }, machines: [{ id: here.id, label: here.label, transport: "tailnet" }], search, open })
  const row = screen.getByRole("option", { name: /Replay failed billing events/u })
  expect(row.textContent).toContain("switching to hetzner-cx42")
  expect(row.querySelector(".sweep-bar")).toBeTruthy()
  expect(onOpenChange).not.toHaveBeenCalled()
  switching(null)
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("closes at once when the window cannot switch", async () => {
  const hits = { query: "billing", truncated: false, matches: [{ session: session("s-replay", "Replay failed billing events"), matchedIn: "title" as const }] }
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === machines[0]!.id ? hits : none("billing"))
  const { user, onOpenChange } = palette(search, vi.fn(() => false))
  await user.type(screen.getByRole("combobox"), "billing")
  await user.click(await screen.findByText("Replay failed billing events"))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
