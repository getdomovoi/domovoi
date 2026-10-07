import type { SessionSearchResult } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { CommandPalette } from "./command-palette"
import type { WorkspaceCommand } from "./workspace-commands"

afterEach(cleanup)

// Desktop V2 draws the palette 660px wide with a plain query row, the scope on
// its right, and one-line rows: a coloured dot, the label, and the meta on the
// right. Rulings Q375 A and Q376 A (2026-10-02) take that restyle and keep the
// commands the design does not draw.
const commands: WorkspaceCommand[] = [
  { id: "take-checkpoint", label: "Take a checkpoint", section: "Session", keywords: [], tone: "online", detail: "manual", run: vi.fn() },
  { id: "open-changes", label: "Open the changes sheet", section: "Session", keywords: [], tone: "handoff", shortcut: "mod+shift+D", run: vi.fn() },
  { id: "session-s1", label: "Migrate billing webhooks", section: "Sessions", keywords: [], kind: "SESSION", tone: "waiting", meta: "codex · waiting", run: vi.fn() },
  { id: "machine-m1", label: "mac-mini-m4", section: "Machines", keywords: [], kind: "MACHINE", tone: "online", meta: "darwin · this machine", run: vi.fn() },
  { id: "skill-k1", label: "design-studio", section: "Skills", keywords: [], kind: "SKILL", tone: "handoff", meta: "built-in skill", run: vi.fn() },
]

function palette(extra: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  render(<CommandPalette open platform="darwin" commands={commands} onOpenChange={vi.fn()} restoreFocusTo={null} {...extra} />)
  return userEvent.setup()
}

const option = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`, "u") })
const meta = (row: HTMLElement) => row.querySelector("[data-palette-meta]")?.textContent

it("draws every row on one line: a dot, the label, and the meta on the right", () => {
  palette()
  const checkpoint = option("Take a checkpoint")
  expect(checkpoint.querySelector("[data-status-dot]")).toBeTruthy()
  expect(meta(checkpoint)).toBe("manual")
  expect(option("Open the changes sheet").querySelector("[data-palette-meta]")?.textContent).toBe("⌘⇧D")

  const session = screen.getByRole("option", { name: /Migrate billing webhooks/u })
  expect(session.querySelector("[data-status-dot]")).toBeTruthy()
  expect(meta(session)).toBe("codex · waiting")
  // The design draws no kind tag; the group heading says what the row is.
  expect(session.textContent).not.toContain("SESSION")
  expect(screen.getByRole("option", { name: /mac-mini-m4/u }).textContent).not.toContain("MACHINE")
  // The label and its meta share one line: nothing sits under the label.
  expect(checkpoint.querySelectorAll("[data-palette-label]")).toHaveLength(1)
  expect(checkpoint.querySelector("[data-palette-label]")?.textContent).toBe("Take a checkpoint")
})

it("draws the design's frame: 660px wide, 96px from the top", () => {
  palette()
  const frame = screen.getByRole("dialog", { name: "Domovoi commands" })
  // The width never outgrows the window, at any breakpoint.
  expect(frame.className.split(/\s+/u)).toEqual(expect.arrayContaining(["w-[660px]", "max-w-[calc(100%-2rem)]", "top-24"]))
  expect(frame.className).not.toMatch(/sm:max-w-\[660px\]/u)
  expect(frame.className).not.toMatch(/(^|\s)(top-1\/3|sm:max-w-sm)(\s|$)/u)
})

// A command's dot repeats nothing a reader needs, so it is hidden and adds no
// text; an entity's dot is its state and stays readable.
it("keeps a command's dot out of the row's name and text", () => {
  palette()
  expect(option("Take a checkpoint").textContent).toBe("Take a checkpointmanual")
  expect(screen.getByRole("option", { name: /^session, waiting Migrate billing webhooks/u })).toBeTruthy()
})

// PR #745 review (P2): a long meta (a provider name may run to 64 characters)
// truncates within a cap, so the row's label always keeps its share.
it("caps and truncates the meta so the label stays visible", () => {
  palette({ commands: [{ ...commands[2]!, meta: `${"p".repeat(64)} · waiting` }] })
  const session = screen.getByRole("option", { name: /Migrate billing webhooks/u })
  const meta = session.querySelector("[data-palette-meta]")!
  expect(meta.className.split(/\s+/u)).toEqual(expect.arrayContaining(["truncate", "max-w-[45%]"]))
  expect(session.querySelector("[data-palette-label]")!.className.split(/\s+/u)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]))
})

it("lists sessions, commands, machines and skills under their own headings", () => {
  palette()
  expect([...document.querySelectorAll("[cmdk-group-heading]")].map((heading) => heading.textContent))
    .toEqual(["SESSIONS", "COMMANDS", "MACHINES", "SKILLS"])
  expect(within(screen.getByRole("group", { name: "MACHINES" })).getByText("mac-mini-m4")).toBeTruthy()
  expect(within(screen.getByRole("group", { name: "SKILLS" })).getByText("design-studio")).toBeTruthy()
})

it("puts the scope on the right of the query row", () => {
  palette()
  const row = screen.getByRole("combobox").closest("[data-palette-query]")
  expect(row).toBeTruthy()
  expect(within(row as HTMLElement).getByText("sessions, machines, commands, skills")).toBeTruthy()
})

// PR #745 review (P1): on a narrow client the scope gives way to the query.
// It truncates rather than holding its width, and the field keeps a floor.
it("lets the scope give way to the query on a narrow window", () => {
  palette()
  const scope = screen.getByText("sessions, machines, commands, skills")
  expect(scope.className.split(/\s+/u)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]))
  expect(scope.className.split(/\s+/u)).not.toContain("shrink-0")
  expect(screen.getByRole("combobox").className).toMatch(/(^|\s)min-w-\[/u)
})

it("names this machine's sessions apart while other machines are searched", async () => {
  const none = async (): Promise<SessionSearchResult> => ({ query: "billing", truncated: false, matches: [] })
  const user = palette({
    machineSearch: {
      here: { id: "machine-here", label: "mac-mini-m4" },
      machines: [{ id: "machine-other", label: "hetzner-cx42", transport: "tailnet" }],
      search: vi.fn(none),
      open: vi.fn(),
    },
  })
  await user.type(screen.getByRole("combobox"), "billing")
  await screen.findByText("SESSIONS ON OTHER MACHINES")
  expect(screen.getByRole("group", { name: "SESSIONS ON THIS MACHINE" })).toBeTruthy()
  expect(screen.queryByRole("group", { name: "SESSIONS" })).toBeNull()
})
