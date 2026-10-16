import { demoWorkspace, type ThreadItem, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Thread } from "./thread"

afterEach(cleanup)

const handlers = {
  onQueuedChange: vi.fn(),
  onResolve: vi.fn(async () => {}),
  onSetRuntime: vi.fn(async () => {}),
  onForkSession: vi.fn(async () => {}),
  onListModels: vi.fn(async () => []),
  onNewSession: vi.fn(),
  onSend: vi.fn(async () => {}),
  onCheckpoint: vi.fn(async () => {}),
  onRestoreCheckpoint: vi.fn(async () => {}),
  onPauseSession: vi.fn(async () => {}),
}

function conversation(running: boolean, extra: ThreadItem[] = []): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const sessionId = snapshot.activeSessionId!
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)!
  if (running) session.activeTurnId = "provider-turn"
  else delete session.activeTurnId
  snapshot.thread = [
    { id: "user-1", sessionId, kind: "user", body: "Webhooks get delivered twice.", createdAt: "2026-09-08T09:00:00.000Z" },
    { id: "assistant-1", sessionId, kind: "assistant", body: "The handler processes the event first.", createdAt: "2026-09-08T09:00:05.000Z" },
    ...extra,
  ]
  return snapshot
}

const classes = (element: Element) => element.className.split(/\s+/u)
const prose = (text: string) => screen.getByText(text).closest("[data-assistant-prose]")!

// D5, Desktop V2 conversation.assistant-prose: the prose sits in the column
// with no avatar box, at 13.5px/1.65, with a primary caret after the last
// prose while the turn works.
describe("assistant prose", () => {
  it("draws no avatar box before the prose", () => {
    render(<Thread snapshot={conversation(false)} connected queued={undefined} {...handlers} />)
    const row = prose("The handler processes the event first.")
    expect(row.querySelector("svg")).toBeNull()
    expect(row.parentElement?.getAttribute("data-thread-column")).toBe("")
  })

  it("sets the prose at 13.5px with a 1.65 line height", () => {
    render(<Thread snapshot={conversation(false)} connected queued={undefined} {...handlers} />)
    expect(classes(prose("The handler processes the event first."))).toEqual(expect.arrayContaining(["[&>div]:text-[13.5px]", "[&>div]:leading-[1.65]"]))
  })

  it("carries the working caret on the latest prose while the turn works", () => {
    const extra: ThreadItem[] = [{ id: "assistant-2", sessionId: demoWorkspace.activeSessionId!, kind: "assistant", body: "Adding a replay table.", createdAt: "2026-09-08T09:00:09.000Z" }]
    render(<Thread snapshot={conversation(true, extra)} connected queued={undefined} {...handlers} />)
    expect(prose("Adding a replay table.").hasAttribute("data-working")).toBe(true)
    expect(prose("The handler processes the event first.").hasAttribute("data-working")).toBe(false)
  })

  // jsdom draws no pseudo-elements, so the caret's measures are read from
  // the classes that make it: 1.5px by 15px of primary, 3px after the last
  // block, blinking only where motion is allowed.
  it("draws the caret as the design measures it, on the working prose only", () => {
    const caret = [
      "[&>div>:last-child]:after:content-['']",
      "[&>div>:last-child]:after:inline-block",
      "[&>div>:last-child]:after:w-[1.5px]",
      "[&>div>:last-child]:after:h-[15px]",
      "[&>div>:last-child]:after:ml-[3px]",
      "[&>div>:last-child]:after:align-[-2px]",
      "[&>div>:last-child]:after:bg-primary",
      "motion-safe:[&>div>:last-child]:after:animate-[dv-composer-caret_1.1s_steps(1)_infinite]",
    ]
    const extra: ThreadItem[] = [{ id: "assistant-2", sessionId: demoWorkspace.activeSessionId!, kind: "assistant", body: "Adding a replay table.", createdAt: "2026-09-08T09:00:09.000Z" }]
    render(<Thread snapshot={conversation(true, extra)} connected queued={undefined} {...handlers} />)
    expect(classes(prose("Adding a replay table."))).toEqual(expect.arrayContaining(caret))
    expect(classes(prose("The handler processes the event first.")).some((name) => name.includes(":after:"))).toBe(false)
  })

  it("drops the caret once the turn is done", () => {
    render(<Thread snapshot={conversation(false)} connected queued={undefined} {...handlers} />)
    expect(prose("The handler processes the event first.").hasAttribute("data-working")).toBe(false)
  })

  // With the daemon lost nobody can see the turn working; the header says
  // stalled, and the prose does not keep claiming it.
  it("drops the caret while the daemon is lost", () => {
    render(<Thread snapshot={conversation(true)} connected={false} queued={undefined} {...handlers} />)
    expect(prose("The handler processes the event first.").hasAttribute("data-working")).toBe(false)
  })

  it("does not put the caret on prose from before the running turn's message", () => {
    const extra: ThreadItem[] = [{ id: "user-2", sessionId: demoWorkspace.activeSessionId!, kind: "user", body: "Now the tests.", createdAt: "2026-09-08T09:01:00.000Z" }]
    render(<Thread snapshot={conversation(true, extra)} connected queued={undefined} {...handlers} />)
    expect(prose("The handler processes the event first.").hasAttribute("data-working")).toBe(false)
  })
})

// D8, Desktop V2 conversation.user-turn: a right-aligned card at most 74% of
// the column, 11px by 15px of padding, 14px corners with the 4px one at the
// bottom right, on accent with no border, its text at 13.5px/1.6.
describe("the user turn", () => {
  it("is drawn as the design measures it", () => {
    render(<Thread snapshot={conversation(false)} connected queued={undefined} {...handlers} />)
    const card = screen.getByTestId("user-turn")
    expect(card.textContent).toContain("Webhooks get delivered twice.")
    expect(classes(card)).toEqual(expect.arrayContaining([
      "self-end", "max-w-[74%]", "px-[15px]", "py-[11px]", "rounded-[14px_14px_4px_14px]", "bg-accent",
      "[&>div:first-child]:text-[13.5px]", "[&>div:first-child]:leading-[1.6]",
    ]))
    expect(classes(card)).not.toContain("border")
    expect(classes(card)).not.toContain("bg-card")
  })

  // Walk finding F26: a photo sent from the phone reached the agent and was
  // nowhere in the thread. The turn shows what it carried, as the composer
  // chip drew it before the send. No client holds a sent image's bytes, so
  // each is a chip, never a thumbnail of something this client does not have.
  it("shows each attachment the turn carried as a chip", () => {
    const sessionId = demoWorkspace.activeSessionId!
    const sent: ThreadItem = {
      id: "user-2", sessionId, kind: "user", body: "Describe this image", createdAt: "2026-09-08T09:01:00.000Z",
      attachments: [
        { kind: "image", mimeType: "image/jpeg", width: 2048, height: 1536, bytes: 1_412_000 },
        { kind: "workspace-file", path: "src/webhooks/replay.spec.ts" },
      ],
    }
    render(<Thread snapshot={conversation(false, [sent])} connected queued={undefined} {...handlers} />)
    const [plain, carrying] = screen.getAllByTestId("user-turn")
    expect(within(plain!).queryByRole("list", { name: "Sent with this message" })).toBeNull()
    const list = within(carrying!).getByRole("list", { name: "Sent with this message" })
    const chips = within(list).getAllByRole("listitem")
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "JPGImage1.4 MB · 2048 × 1536",
      "TSsrc/webhooks/replay.spec.tsworktree file",
    ])
    expect(chips[0]!.getAttribute("aria-label")).toBe("JPEG image, 1.4 MB, 2048 by 1536 pixels")
    expect(carrying!.querySelector("img")).toBeNull()
    expect(within(list).queryByRole("button")).toBeNull()
  })

  // Codex review round 2: a long name gives way, the size never does, and
  // the whole fact is one hover away for a name cut short.
  it("keeps a chip's size whole when its name is long", () => {
    const sessionId = demoWorkspace.activeSessionId!
    const name = `${"very-long-output-name-".repeat(10)}.txt`
    const sent: ThreadItem = {
      id: "user-2", sessionId, kind: "user", body: "Read this", createdAt: "2026-09-08T09:01:00.000Z",
      attachments: [{ kind: "text", name, bytes: 3_200 }],
    }
    render(<Thread snapshot={conversation(false, [sent])} connected queued={undefined} {...handlers} />)
    const chip = within(screen.getByRole("list", { name: "Sent with this message" })).getByRole("listitem")
    expect(chip.getAttribute("title")).toBe(`Text file ${name}, 3.2 kB`)
    expect(classes(within(chip).getByText("3.2 kB"))).toContain("shrink-0")
    expect(classes(within(chip).getByText(name))).toEqual(expect.arrayContaining(["min-w-0", "truncate"]))
  })
})
