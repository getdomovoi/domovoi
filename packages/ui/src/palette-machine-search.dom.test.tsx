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
        // PR #745 review (P2): active is running with or without a turn id, as
        // sessionTone reads this machine's own session rows.
        { session: { ...session("s-live", "Billing live without a turn id"), state: "active" }, matchedIn: "title" },
        { session: { ...session("s-drain", "Find why the queue drains"), state: "failed", updatedAt: hourAgo }, matchedIn: "title" },
        // A turn stopped at a gate keeps its turn id; the row says it waits.
        { session: { ...session("s-gate", "Apply the billing migration"), state: "waiting", activeTurnId: "turn-2", updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() }, matchedIn: "title" },
      ] }
    : none("billing"))
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  const replay = await screen.findByRole("option", { name: /Replay failed billing events/u })
  expect(replay.querySelector("[data-palette-meta]")?.textContent).toBe("running")
  expect(replay.querySelector("[data-status-dot]")).toBeTruthy()
  const drain = screen.getByRole("option", { name: /Find why the queue drains/u })
  expect(drain.querySelector("[data-palette-meta]")?.textContent).toBe("failed 1h ago")
  expect(screen.getByRole("option", { name: /Billing live without a turn id/u }).querySelector("[data-palette-meta]")?.textContent).toBe("running")
  const gate = screen.getByRole("option", { name: /Apply the billing migration/u })
  expect(gate.querySelector("[data-palette-meta]")?.textContent).toBe("waiting 5m ago")
})

// Review 2026-10-06: Add it back during the debounce of a new query must not
// ask for the old one; the pending search takes the machine back in.
it("adds a machine back into the query being typed, not the last one asked", async () => {
  let wslAnswers = false
  const search = vi.fn(async (machineId: string, query: string): Promise<SessionSearchResult> => {
    if (machineId === machines[1]!.id && !wslAnswers) throw new Error("no reply")
    return none(query)
  })
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  await user.click(await screen.findByRole("button", { name: "Search only what answered" }))
  wslAnswers = true
  search.mockClear()
  await user.type(screen.getByRole("combobox"), "s")
  await user.click(screen.getByRole("button", { name: "Add it back" }))
  expect(search).not.toHaveBeenCalledWith(machines[1]!.id, "billing", expect.anything())
  await screen.findByText("searched 3 of 3 machines")
  expect(search).toHaveBeenCalledWith(machines[1]!.id, "billings", expect.any(AbortSignal))
})

it("answers Enter on the notice's button, not on the highlighted row", async () => {
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => {
    if (machineId === machines[1]!.id) throw new Error("no reply")
    return none("billing")
  })
  const run = vi.fn()
  const { user, onOpenChange } = palette(search, vi.fn(), [{ id: "open-project", label: "Open billing project", section: "Project", keywords: [], run }])
  await user.type(screen.getByRole("combobox"), "billing")
  const button = await screen.findByRole("button", { name: "Search only what answered" })
  button.focus()
  await user.keyboard("{Enter}")
  expect(run).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(screen.getByText("wsl-ubuntu-24 is left out, so its sessions stay unsearched until you add it back.")).toBeTruthy()
})

it("keeps the picked row while the query changes during the switch", async () => {
  const hits = (query: string) => ({ query, truncated: false, matches: [{ session: session("s-replay", "Replay failed billing events"), matchedIn: "title" as const }] })
  const search = vi.fn(async (machineId: string, query: string): Promise<SessionSearchResult> => machineId === machines[0]!.id && query === "billing" ? hits(query) : none(query))
  const { user, switching } = palette(search, vi.fn(() => true))
  await user.type(screen.getByRole("combobox"), "billing")
  await user.click(await screen.findByText("Replay failed billing events"))
  switching({ machineId: machines[0]!.id, sessionId: "s-replay" })
  await user.type(screen.getByRole("combobox"), "x")
  await new Promise((settle) => setTimeout(settle, 400))
  expect(screen.getByRole("option", { name: /Replay failed billing events/u }).textContent).toContain("switching to hetzner-cx42")
})

// Review round 2: a row picked while the next query waits out its debounce
// belongs to the answers on screen, and the waiting search must not replace them.
it("keeps a row picked during the next query's debounce", async () => {
  const hits = (query: string) => ({ query, truncated: false, matches: [{ session: session("s-replay", "Replay failed billing events"), matchedIn: "title" as const }] })
  const search = vi.fn(async (machineId: string, query: string): Promise<SessionSearchResult> => machineId === machines[0]!.id && query === "billing" ? hits(query) : none(query))
  const { user, switching } = palette(search, vi.fn(() => true))
  await user.type(screen.getByRole("combobox"), "billing")
  const row = await screen.findByText("Replay failed billing events")
  await user.type(screen.getByRole("combobox"), "x")
  await user.click(row)
  switching({ machineId: machines[0]!.id, sessionId: "s-replay" })
  await new Promise((settle) => setTimeout(settle, 400))
  expect(search).not.toHaveBeenCalledWith(machines[0]!.id, "billingx", expect.anything())
  expect(screen.getByRole("option", { name: /Replay failed billing events/u }).textContent).toContain("switching to hetzner-cx42")
})

// PR #745 review (P2): while a picked row switches the window nothing can be
// asked, so the notice's action waits, and the machine stays left out.
it("holds Add it back while a picked row switches the window", async () => {
  const hits = { query: "billing", truncated: false, matches: [{ session: session("s-replay", "Replay failed billing events"), matchedIn: "title" as const }] }
  const search = vi.fn(async (machineId: string, query: string): Promise<SessionSearchResult> => {
    if (machineId === machines[1]!.id) throw new Error("no reply")
    return machineId === machines[0]!.id ? hits : none(query)
  })
  const { user, switching } = palette(search, vi.fn(() => true))
  await user.type(screen.getByRole("combobox"), "billing")
  await user.click(await screen.findByRole("button", { name: "Search only what answered" }))
  await user.click(screen.getByText("Replay failed billing events"))
  switching({ machineId: machines[0]!.id, sessionId: "s-replay" })
  const addBack = screen.getByRole("button", { name: "Add it back" })
  expect(addBack.hasAttribute("disabled")).toBe(true)
  await user.click(addBack)
  expect(screen.getByText("wsl-ubuntu-24 is left out, so its sessions stay unsearched until you add it back.")).toBeTruthy()
  expect(screen.getByRole("group", { name: "wsl-ubuntu-24" }).textContent).toContain("not searched, left out")
})

// PR #745 review (P2): every other action waits too, or its result would be
// replaced by the session the switch opens when it lands.
it("runs no other command while a picked row switches the window", async () => {
  const hits = { query: "billing", truncated: false, matches: [{ session: session("s-replay", "Replay failed billing events"), matchedIn: "title" as const }] }
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === machines[0]!.id ? hits : none("billing"))
  const run = vi.fn()
  const openElsewhere = vi.fn()
  const { user, onOpenChange, switching } = palette(search, vi.fn(() => true), [
    { id: "machine-billing", label: "billing-box", section: "Machines", keywords: [], kind: "MACHINE", openElsewhere, run },
    { id: "surface-fleet", label: "Show all billing machines", section: "Navigate", keywords: [], run },
  ])
  await user.type(screen.getByRole("combobox"), "billing")
  await user.click(await screen.findByText("Replay failed billing events"))
  switching({ machineId: machines[0]!.id, sessionId: "s-replay" })
  const fleet = screen.getByRole("option", { name: /Show all billing machines/u })
  expect(fleet.getAttribute("aria-disabled")).toBe("true")
  await user.click(fleet)
  await user.click(screen.getByRole("option", { name: /billing-box/u }))
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  expect(run).not.toHaveBeenCalled()
  expect(openElsewhere).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
})

// PR #745 review (P2): a long unbroken machine name truncates, and the
// transport and the machine's answer keep their place on a narrow window.
it("truncates a long machine name and keeps its answer in view", async () => {
  const search = vi.fn(async (_machineId: string, query: string): Promise<SessionSearchResult> => none(query))
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  await screen.findByText("searched 3 of 3 machines")
  const group = within(screen.getByRole("group", { name: "hetzner-cx42" }))
  expect(group.getByText("hetzner-cx42").className.split(/\s+/u)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]))
  expect(group.getByText("tailnet").className.split(/\s+/u)).toContain("shrink-0")
  expect(group.getByText("no matches").className.split(/\s+/u)).toContain("shrink-0")
})

// The notice's button keeps Enter to itself, and only Enter: the palette's
// toggle and every other key still reach the window.
it("lets every key but Enter leave the notice's button", async () => {
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => {
    if (machineId === machines[1]!.id) throw new Error("no reply")
    return none("billing")
  })
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  const button = await screen.findByRole("button", { name: "Search only what answered" })
  const seen: string[] = []
  const listen = (event: KeyboardEvent) => { seen.push(event.key) }
  window.addEventListener("keydown", listen)
  try {
    button.focus()
    await user.keyboard("{Meta>}k{/Meta}")
    expect(seen).toContain("k")
  } finally {
    window.removeEventListener("keydown", listen)
  }
})

it("names a finished or moving session by its state", async () => {
  const search = vi.fn(async (machineId: string): Promise<SessionSearchResult> => machineId === machines[0]!.id
    ? { query: "billing", truncated: false, matches: [
        { session: { ...session("s-done", "Billing export finished"), state: "done" }, matchedIn: "title" },
        { session: { ...session("s-move", "Billing moving over"), state: "transferring" }, matchedIn: "title" },
      ] }
    : none("billing"))
  const { user } = palette(search)
  await user.type(screen.getByRole("combobox"), "billing")
  const done = await screen.findByRole("option", { name: /Billing export finished/u })
  expect(done.querySelector("[data-palette-meta]")?.textContent).toMatch(/^done /u)
  expect(screen.getByRole("option", { name: /Billing moving over/u }).querySelector("[data-palette-meta]")?.textContent).toMatch(/^transferring /u)
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
