import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SessionAttachment, TerminalOwnershipNotification, TerminalSession, TerminalWatchResult } from "@getdomovoi/protocol"

import { createComposerInbox, type ComposerInbox } from "./composer-inbox"
import { dockTabDefinitions } from "./dock-tabs"
import { TerminalPane, type TerminalControls } from "./terminal-pane"

afterEach(cleanup)

const sessionId = "session-terminal"
const terminalId = `terminal-${sessionId}`
const thisClient = "client-aaaaaaaa"
const otherClient = "client-bbbbbbbb"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((complete, failure) => {
    resolve = complete
    reject = failure
  })
  return { promise, resolve, reject }
}

type TerminalPaneHandlers = Parameters<TerminalControls["subscribe"]>[1]

function harness() {
  const create = deferred<TerminalSession>()
  const claim = deferred<TerminalOwnershipNotification>()
  const claimRequest = vi.fn(() => claim.promise)
  const write = vi.fn(async () => undefined)
  const resize = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  let handlers: TerminalPaneHandlers | undefined
  const controls: TerminalControls = {
    clientId: thisClient,
    create: () => create.promise,
    claim: claimRequest,
    write,
    resize,
    close,
    subscribe: (_terminalId, next) => {
      handlers = next
      return () => {
        handlers = undefined
      }
    },
  }
  return {
    controls,
    write,
    resize,
    close,
    claimRequest,
    connect: (owner: string) => create.resolve({
      terminalId,
      sessionId,
      cols: 80,
      rows: 24,
      shell: "bash",
      cwd: "/worktrees/demo",
      buffer: "",
      owner: { client: "web", clientId: owner },
    }),
    grantOwnership: (owner: string) => claim.resolve({
      terminalId,
      owner: { client: "web", clientId: owner },
    }),
    refuseOwnership: (cause: unknown) => claim.reject(cause),
    deliverOutput: (data: string) => handlers?.output({ terminalId, data }),
    deliverOwnership: (owner: string) => handlers?.ownership({
      terminalId,
      owner: { client: "web", clientId: owner },
    }),
  }
}

describe("TerminalPane ownership", () => {
  it("silences non-owner input until Take the shell hands the terminal back", async () => {
    const user = userEvent.setup()
    const target = harness()
    render(
      <TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )

    await act(async () => {
      target.connect(otherClient)
    })
    expect(screen.getByRole("button", { name: "Take the shell" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Tab" }))
    await user.click(screen.getByRole("button", { name: "Close terminal" }))
    expect(target.write).not.toHaveBeenCalled()
    expect(target.close).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close terminal" }).disabled).toBe(true)

    await user.click(screen.getByRole("button", { name: "Take the shell" }))
    expect(target.claimRequest).toHaveBeenCalledWith(terminalId)
    await act(async () => {
      target.grantOwnership(thisClient)
    })

    expect(screen.queryByRole("button", { name: "Take the shell" })).toBeNull()
    expect(screen.getByRole("button", { name: "Interrupt ⌃C" })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close terminal" }).disabled).toBe(false)

    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(target.write).toHaveBeenCalledWith(terminalId, "\t")
    await user.click(screen.getByRole("button", { name: "Close terminal" }))
    expect(target.close).toHaveBeenCalledWith(terminalId)
  })

  it("follows an owner change delivered through the ownership notification", async () => {
    const user = userEvent.setup()
    const target = harness()
    render(
      <TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )

    await act(async () => {
      target.connect(otherClient)
    })
    expect(screen.getByRole("button", { name: "Take the shell" })).toBeTruthy()

    await act(async () => {
      target.deliverOwnership(thisClient)
    })
    expect(screen.queryByRole("button", { name: "Take the shell" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(target.write).toHaveBeenCalledWith(terminalId, "\t")

    await act(async () => {
      target.deliverOwnership(otherClient)
    })
    expect(screen.getByRole("button", { name: "Take the shell" })).toBeTruthy()
  })

  it("reports a refused takeover and stays read-only", async () => {
    const user = userEvent.setup()
    const target = harness()
    render(
      <TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )

    await act(async () => {
      target.connect(otherClient)
    })
    await user.click(screen.getByRole("button", { name: "Take the shell" }))
    await act(async () => {
      target.refuseOwnership(new Error("Terminal is being taken over"))
    })

    expect((await screen.findByRole("alert")).textContent).toContain("Terminal is being taken over")
    expect(screen.getByRole("button", { name: "Take the shell" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(target.write).not.toHaveBeenCalled()
  })
})

const phone = {
  client: "phone" as const,
  clientId: otherClient,
  device: { id: "device-0123456789abcdef0123456789abcdef", label: "iPhone 16 Pro" },
}

function watchResult(over: Partial<TerminalWatchResult> = {}): TerminalWatchResult {
  return {
    terminalId,
    sessionId,
    cols: 80,
    rows: 24,
    shell: "bash",
    cwd: "/worktrees/demo",
    owner: phone,
    claimHeld: true,
    openedAt: "2026-10-07T14:04:00.000Z",
    state: "live",
    buffer: "$ pnpm test\r\n PASS  webhooks\r\n",
    earlierOutputDropped: false,
    watchedAt: "2026-10-07T14:05:00.000Z",
    ...over,
  }
}

// Each watch call gets its own reply, so a retry is answered on its own.
function watcher() {
  const target = harness()
  const replies: ReturnType<typeof deferred<TerminalWatchResult>>[] = []
  const watch = vi.fn((_terminalId: string) => {
    const reply = deferred<TerminalWatchResult>()
    replies.push(reply)
    return reply.promise
  })
  const unwatch = vi.fn(async (_terminalId: string) => undefined)
  const create = vi.fn(target.controls.create)
  const controls: TerminalControls = { ...target.controls, create, watch, unwatch }
  const watched = {
    resolve: (result: TerminalWatchResult) => replies.at(-1)!.resolve(result),
    reject: (cause: unknown) => replies.at(-1)!.reject(cause),
  }
  return { ...target, controls, create, watch, unwatch, watched }
}

// What xterm drew, row by row, once its write queue has run.
async function drawnRows(container: HTMLElement): Promise<string[]> {
  let rows: string[] = []
  await vi.waitFor(() => {
    rows = [...container.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent ?? "")
    expect(rows.join("\n")).toContain("PASS  webhooks")
  })
  return rows
}

describe("TerminalPane claim banner", () => {
  it("says this desktop holds the shell", async () => {
    const target = harness()
    render(<TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />)

    await act(async () => {
      target.connect(thisClient)
    })

    expect(screen.getByText("You hold this shell")).toBeTruthy()
    expect(screen.getByText("One claimant at a time. Other devices can watch.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Take the shell" })).toBeNull()
    // Q340 A: the design's footer says the agent owns a read-only shell,
    // which is false for this PTY. The footer says what is true here.
    expect(screen.getByText("interactive, this device holds the shell")).toBeTruthy()
    expect(screen.queryByText(/the agent owns this shell/u)).toBeNull()
  })

  it("names the device that holds the shell and offers to take it", async () => {
    const target = harness()
    const controls: TerminalControls = {
      ...target.controls,
      create: async () => ({
        terminalId, sessionId, cols: 80, rows: 24, shell: "bash", cwd: "/worktrees/demo", buffer: "", owner: phone,
      }),
    }
    render(<TerminalPane connected controls={controls} machineName="worktop" sessionId={sessionId} />)

    expect(await screen.findByText("Claimed by iPhone 16 Pro")).toBeTruthy()
    expect(screen.getByText("Reading is free, typing needs the claim.")).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take the shell" }).disabled).toBe(false)
    expect(screen.getByText("read-only until you take the shell")).toBeTruthy()
  })
})

describe("TerminalPane on a watching desktop", () => {
  it("reads the stream through terminal.watch and never opens or types", async () => {
    const user = userEvent.setup()
    const target = watcher()
    const { container, unmount } = render(
      <TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )

    expect(target.watch).toHaveBeenCalledWith(terminalId)
    expect(target.create).not.toHaveBeenCalled()
    await act(async () => {
      target.watched.resolve(watchResult())
    })

    // The kept record and what arrives afterwards both reach the screen.
    await act(async () => {
      target.deliverOutput("$ echo after\r\nafter\r\n")
    })
    const rows = (await drawnRows(container)).join("\n")
    expect(rows).toContain("$ pnpm test")
    await vi.waitFor(() => expect(container.textContent).toContain("$ echo after"))

    // Typing into the stream reaches nothing.
    const field = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!
    await user.type(field, "rm -rf /{enter}")
    expect(target.write).not.toHaveBeenCalled()

    expect(screen.getByText("Claimed by iPhone 16 Pro")).toBeTruthy()
    const take = screen.getByRole<HTMLButtonElement>("button", { name: "Take the shell" })
    expect(take.disabled).toBe(true)
    // A disabled control says why, beside it.
    expect(screen.getByText("This view reads the shell and cannot take it.")).toBeTruthy()
    expect(screen.getByText("read-only, this device watches")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Close terminal" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Interrupt ⌃C" })).toBeNull()
    expect(screen.queryByText("Watching only")).toBeNull()

    await user.click(take)
    expect(target.claimRequest).not.toHaveBeenCalled()
    expect(target.write).not.toHaveBeenCalled()

    unmount()
    expect(target.unwatch).toHaveBeenCalledWith(terminalId)
  })

  it("says nobody holds a shell whose claimant has gone", async () => {
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)

    await act(async () => {
      target.watched.resolve(watchResult({ claimHeld: false }))
    })

    expect(screen.getByText("Nobody holds this shell")).toBeTruthy()
  })

  it("follows an owner change while watching", async () => {
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.resolve(watchResult({ claimHeld: false }))
    })

    await act(async () => {
      target.deliverOwnership(otherClient)
    })

    expect(screen.getByText("Claimed by a browser")).toBeTruthy()
  })

  it("says when the session has no shell open and checks again on request", async () => {
    const user = userEvent.setup()
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)

    await act(async () => {
      target.watched.reject(new Error("Terminal does not exist"))
    })

    expect(screen.getByText("No shell is open in this session")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Check again" }))
    expect(target.watch).toHaveBeenCalledTimes(2)

    // The second answer finds the shell, and the pane reads it.
    await act(async () => {
      target.watched.resolve(watchResult())
    })
    expect(screen.queryByText("No shell is open in this session")).toBeNull()
    expect(screen.getByText("Claimed by iPhone 16 Pro")).toBeTruthy()
  })

  // The daemon replays the holder's grid. Fitting the record to this pane's
  // width instead would move every cursor-positioned character.
  it("draws the watched shell at the holder's grid", async () => {
    const target = watcher()
    const { container } = render(
      <TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )

    await act(async () => {
      target.watched.resolve(watchResult({ cols: 132, rows: 40 }))
    })

    expect((await drawnRows(container)).length).toBe(40)
  })

  // A shell that exited is a closed record. Its holder can open another one,
  // so the watcher can look again rather than staying on the old record.
  it("can look again once the watched shell has exited", async () => {
    const user = userEvent.setup()
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.resolve(watchResult({ state: "closed", closedAt: "2026-10-07T14:06:00.000Z", exitCode: 0, claimHeld: false }))
    })

    await user.click(screen.getByRole("button", { name: "Check again" }))

    expect(target.unwatch).toHaveBeenCalledWith(terminalId)
    expect(target.watch).toHaveBeenCalledTimes(2)
  })

  it("stops watching one session's shell when the pane moves to another", async () => {
    const target = watcher()
    const view = (id: string) => (
      <TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={id} />
    )
    const { rerender } = render(view(sessionId))
    await act(async () => {
      target.watched.resolve(watchResult())
    })

    rerender(view("session-other"))

    expect(target.unwatch).toHaveBeenCalledTimes(1)
    expect(target.unwatch).toHaveBeenCalledWith(terminalId)
    expect(target.watch).toHaveBeenLastCalledWith("terminal-session-other")
  })

  it("keeps the watching empty state when this client cannot watch", () => {
    const target = harness()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)

    expect(screen.getByText("Watching only")).toBeTruthy()
  })
})

describe("Attach this output to the composer", () => {
  async function printed(target: ReturnType<typeof harness>, composer: ComposerInbox) {
    render(<TerminalPane connected controls={target.controls} composer={composer} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })
    await act(async () => {
      target.deliverOutput("$ echo hi\r\nhi\r\n")
    })
  }

  it("hands what the pane shows to this session's composer", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    await printed(harness(), composer)

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    expect(attachment).toMatchObject({ kind: "text", name: "terminal-output.txt", mimeType: "text/plain" })
    expect("content" in attachment ? attachment.content : "").toContain("$ echo hi\nhi")
    expect(screen.getByText("Attached to the composer as terminal-output.txt.")).toBeTruthy()
  })

  it("is not offered when no composer is open for this session", async () => {
    const composer = createComposerInbox()
    const other = vi.fn(() => "attached" as const)
    composer.open("session-other", other)
    await printed(harness(), composer)

    expect(screen.queryByRole("button", { name: "Attach this output to the composer" })).toBeNull()
    expect(other).not.toHaveBeenCalled()
  })

  it("says so when the composer is full", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    composer.open(sessionId, () => "full")
    await printed(harness(), composer)

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    expect(await screen.findByText(/The composer already holds the most attachments/u)).toBeTruthy()
  })
})

// Q340 A: the design's tip says the stream is read-only and the agent owns the
// shell. The tab is an interactive PTY a person opens, so the tip says that.
describe("the Terminal tab tip", () => {
  it("describes the shell this tab really holds", () => {
    const tip = dockTabDefinitions.find((tab) => tab.id === "terminal")?.note ?? ""
    expect(tip).toBe("A shell on the machine, in the session's worktree. One device types at a time; the others can read.")
    expect(tip).not.toMatch(/agent owns|read-only/u)
  })
})

describe("terminal chrome", () => {
  it("separates the terminal chrome from the output surface", () => {
    const { controls } = harness()
    render(<TerminalPane sessionId={sessionId} machineName="workshop" controls={controls} connected />)

    const header = screen.getByText(/^pty · workshop/u).closest("div")
    expect(header?.className).toContain("bg-sidebar")
  })
})
