import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { maximumTerminalReplayCharacters, maximumTextAttachmentBytes } from "@getdomovoi/protocol"
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
  const release = deferred<TerminalOwnershipNotification>()
  const releaseRequest = vi.fn((_terminalId: string) => release.promise)
  const write = vi.fn(async () => undefined)
  const resize = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  let handlers: TerminalPaneHandlers | undefined
  const controls: TerminalControls = {
    clientId: thisClient,
    create: () => create.promise,
    claim: claimRequest,
    release: releaseRequest,
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
    releaseRequest,
    grantRelease: (owner: string) => release.resolve({
      terminalId,
      owner: { client: "web", clientId: owner },
      claimHeld: false,
    }),
    refuseRelease: (cause: unknown) => release.reject(cause),
    deliverResized: (cols: number, rows: number) => handlers?.resized?.({ terminalId, cols, rows }),
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
    deliverClosed: (exitCode: number) => handlers?.closed({ terminalId, exitCode }),
    deliverOwnership: (owner: string, claimHeld?: boolean) => handlers?.ownership({
      terminalId,
      owner: { client: "web", clientId: owner },
      ...(claimHeld === undefined ? {} : { claimHeld }),
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

  it("stops typing when its own claim is released", async () => {
    const user = userEvent.setup()
    const target = harness()
    render(
      <TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )
    await act(async () => {
      target.connect(thisClient)
    })
    expect(screen.getByText("You hold this shell")).toBeTruthy()

    // A release names the last holder, this client, with the claim no longer held.
    await act(async () => {
      target.deliverOwnership(thisClient, false)
    })

    expect(screen.getByText("Nobody holds this shell")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Take the shell" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(target.write).not.toHaveBeenCalled()
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

type WatchReply = Awaited<ReturnType<NonNullable<TerminalControls["watch"]>>>

function watchResult(over: Partial<WatchReply> = {}): WatchReply {
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
  const replies: ReturnType<typeof deferred<WatchReply>>[] = []
  const watch = vi.fn((_terminalId: string, _options?: { followResize: true }) => {
    const reply = deferred<WatchReply>()
    replies.push(reply)
    return reply.promise
  })
  const unwatch = vi.fn(async (_terminalId: string) => undefined)
  const create = vi.fn(target.controls.create)
  const controls: TerminalControls = { ...target.controls, create, watch, unwatch }
  const watched = {
    resolve: (result: WatchReply) => replies.at(-1)!.resolve(result),
    reject: (cause: unknown) => replies.at(-1)!.reject(cause),
  }
  return { ...target, controls, create, watch, unwatch, watched }
}

// xterm parses writes asynchronously. Output is parsed in order, so once the
// last line shows, everything before it is in the buffer.
async function parsedThrough(container: HTMLElement, last: string): Promise<void> {
  await vi.waitFor(() => expect(container.textContent).toContain(last), { timeout: 15_000 })
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

  // A dropped connection releases the claim on the daemon's side, and this
  // pane cannot see what happens next, so it says neither who holds it nor
  // that this device does.
  it("stops claiming the shell while disconnected", async () => {
    const target = harness()
    const view = (connected: boolean) => (
      <TerminalPane connected={connected} controls={target.controls} machineName="worktop" sessionId={sessionId} />
    )
    const { rerender } = render(view(true))
    await act(async () => {
      target.connect(thisClient)
    })

    rerender(view(false))

    expect(screen.queryByText("You hold this shell")).toBeNull()
    expect(screen.queryByText("interactive, this device holds the shell")).toBeNull()
    expect(screen.getByText("not connected, who holds the shell is not known")).toBeTruthy()
  })

  // A closed terminal holds no claim, so the footer stops saying this device
  // holds it once the shell has exited.
  it("stops claiming the shell once it has exited", async () => {
    const target = harness()
    render(<TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })

    await act(async () => {
      target.deliverClosed(0)
    })

    expect(screen.queryByText("interactive, this device holds the shell")).toBeNull()
    expect(screen.queryByText("You hold this shell")).toBeNull()
    expect(screen.getByText("closed, the shell has exited")).toBeTruthy()
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

  // Desktop V2 dock terminal: the holder's banner offers Release the shell.
  // The shell keeps running with nobody holding it, and any device can take it.
  it("releases the shell this desktop holds", async () => {
    const user = userEvent.setup()
    const target = harness()
    render(<TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })

    await user.click(screen.getByRole("button", { name: "Release the shell" }))
    expect(target.releaseRequest).toHaveBeenCalledWith(terminalId)
    // One request at a time: the button waits for the daemon's answer.
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Release the shell" }).disabled).toBe(true)
    await act(async () => {
      target.grantRelease(thisClient)
    })

    expect(screen.getByText("Nobody holds this shell")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Release the shell" })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take the shell" }).disabled).toBe(false)
    expect(screen.getByText("read-only until you take the shell")).toBeTruthy()
    // The reply alone stops input; the ownership notice may still be on its way.
    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(target.write).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Interrupt ⌃C" }).disabled).toBe(true)
  })

  it("reports a refused release and keeps the claim", async () => {
    const user = userEvent.setup()
    const target = harness()
    render(<TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })

    await user.click(screen.getByRole("button", { name: "Release the shell" }))
    await act(async () => {
      target.refuseRelease(new Error(""))
    })

    expect((await screen.findByRole("alert")).textContent).toContain("Terminal release failed")
    expect(screen.getByText("You hold this shell")).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Release the shell" }).disabled).toBe(false)
  })

  it("offers no release to a pane that does not hold the shell, or cannot release", async () => {
    const target = harness()
    render(<TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(otherClient)
    })
    expect(screen.queryByRole("button", { name: "Release the shell" })).toBeNull()
    cleanup()

    const older = harness()
    const { release: _release, ...withoutRelease } = older.controls
    render(<TerminalPane connected controls={withoutRelease} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      older.connect(thisClient)
    })
    expect(screen.getByText("You hold this shell")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Release the shell" })).toBeNull()
  })

  it("says since when the holder took the shell", async () => {
    const target = harness()
    const claimedAt = new Date()
    claimedAt.setHours(14, 4, 0, 0)
    const controls: TerminalControls = {
      ...target.controls,
      create: async () => ({
        terminalId, sessionId, cols: 80, rows: 24, shell: "bash", cwd: "/worktrees/demo", buffer: "",
        owner: { ...phone, claimedAt: claimedAt.toISOString() },
      }),
    }
    render(<TerminalPane connected controls={controls} machineName="worktop" sessionId={sessionId} />)

    expect(await screen.findByText("Claimed by iPhone 16 Pro since 14:04")).toBeTruthy()
  })

  it("gives the day of a claim taken before today", async () => {
    const target = harness()
    const claimedAt = new Date()
    claimedAt.setDate(claimedAt.getDate() - 3)
    claimedAt.setHours(9, 30, 0, 0)
    const day = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(claimedAt)
    const controls: TerminalControls = {
      ...target.controls,
      create: async () => ({
        terminalId, sessionId, cols: 80, rows: 24, shell: "bash", cwd: "/worktrees/demo", buffer: "",
        owner: { ...phone, claimedAt: claimedAt.toISOString() },
      }),
    }
    render(<TerminalPane connected controls={controls} machineName="worktop" sessionId={sessionId} />)

    expect(await screen.findByText(`Claimed by iPhone 16 Pro since ${day} 09:30`)).toBeTruthy()
  })
})

describe("TerminalPane on a watching desktop", () => {
  it("reads the stream through terminal.watch and never opens or types", async () => {
    const user = userEvent.setup()
    const target = watcher()
    const { container, unmount } = render(
      <TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )

    expect(target.watch).toHaveBeenCalledWith(terminalId, { followResize: true })
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

  it("says nobody holds the shell once the holder releases it", async () => {
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.resolve(watchResult())
    })
    expect(screen.getByText("Claimed by iPhone 16 Pro")).toBeTruthy()

    await act(async () => {
      target.deliverOwnership(otherClient, false)
    })

    expect(screen.getByText("Nobody holds this shell")).toBeTruthy()
  })

  // A release keeps the last holder and its claim time, so the time alone
  // does not mean anyone holds the shell.
  it("drops since once the holder releases the shell", async () => {
    const target = watcher()
    const claimedAt = new Date()
    claimedAt.setHours(14, 4, 0, 0)
    const owner = { ...phone, claimedAt: claimedAt.toISOString() }
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.resolve(watchResult({ owner }))
    })
    expect(screen.getByText("Claimed by iPhone 16 Pro since 14:04")).toBeTruthy()

    await act(async () => {
      target.deliverOwnership(otherClient, false)
    })

    expect(screen.getByText("Nobody holds this shell")).toBeTruthy()
    expect(screen.queryByText(/since/u)).toBeNull()
  })

  // terminal.resized arrives in order with the output, so output printed for
  // the old grid draws at the old grid and output after it at the new one.
  it("redraws at the holder's grid when the daemon says it changed", async () => {
    const target = watcher()
    const list = vi.fn(async (_sessionId: string) => {
      const { buffer: _buffer, earlierOutputDropped: _dropped, watchedAt: _watchedAt, followsResize: _follows, ...listed } = watchResult()
      return [listed]
    })
    const { container } = render(
      <TerminalPane connected readOnly controls={{ ...target.controls, list }} holderRefreshMs={20} machineName="worktop" sessionId={sessionId} />,
    )
    await act(async () => {
      target.watched.resolve(watchResult({ followsResize: true, buffer: "" }))
    })
    const rowsDrawn = () => [...container.querySelectorAll(".xterm-rows > div")].map((row) => (row.textContent ?? "").replace(/\u00a0/gu, " "))
    await vi.waitFor(() => expect(rowsDrawn()).toHaveLength(24))

    await act(async () => {
      target.deliverOutput("\x1b[1;120HX")
      target.deliverResized(132, 40)
      target.deliverOutput("\x1b[2;120HY")
    })

    await vi.waitFor(() => {
      const rows = rowsDrawn()
      expect(rows).toHaveLength(40)
      // At 80 columns the first cursor move clamps to the last column.
      expect(rows[0]!.indexOf("X")).toBe(79)
      expect(rows[1]!.indexOf("Y")).toBe(119)
    })
    // The daemon's list still says 80 by 24 here, and a pane that follows
    // the notice does not take its grid from the list.
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(2))
    expect(rowsDrawn()).toHaveLength(40)
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
      target.watched.resolve(watchResult({ cols: 132, rows: 40, buffer: " PASS  webhooks\x1b[1;120HX" }))
    })

    const rows = await drawnRows(container)
    expect(rows.length).toBe(40)
    // Column 120 exists only at the holder's width; at the default 80 the
    // cursor move would clamp and put the X at column 80.
    expect(rows[0]!.replace(/\u00a0/gu, " ").indexOf("X")).toBe(119)
  })

  // A watch that has been answered is not on its way anywhere, so the status
  // stops saying connecting once the daemon replied.
  it("settles the status once the daemon answers a watch", async () => {
    const user = userEvent.setup()
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    expect(screen.getByText("Terminal status: connecting.")).toBeTruthy()

    await act(async () => {
      target.watched.reject(new Error("Terminal does not exist"))
    })
    expect(screen.getByText("Terminal status: no shell.")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Check again" }))
    await act(async () => {
      target.watched.reject(new Error("Daemon connection is not open"))
    })
    expect(screen.getByText("Terminal status: unavailable.")).toBeTruthy()
    expect(document.body.textContent).not.toContain("connecting")
  })

  // An RPC error may carry no message. The refusal still settles the status
  // and says something.
  it("settles on a refusal with no message, watching or opening", async () => {
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.reject(new Error(""))
    })
    expect(screen.getByText("Terminal status: unavailable.")).toBeTruthy()
    expect((await screen.findByRole("alert")).textContent).toContain("Terminal could not be read")
    cleanup()

    const opening = harness()
    const refusing: TerminalControls = { ...opening.controls, create: async () => { throw new Error("") } }
    render(<TerminalPane connected controls={refusing} machineName="worktop" sessionId={sessionId} />)
    expect((await screen.findByRole("alert")).textContent).toContain("Terminal could not start")
    expect(screen.getByText("Terminal status: unavailable.")).toBeTruthy()
  })

  it("offers to look again after a watch the daemon refused", async () => {
    const user = userEvent.setup()
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.reject(new Error("Daemon connection is not open"))
    })

    expect((await screen.findByRole("alert")).textContent).toContain("Daemon connection is not open")
    await user.click(screen.getByRole("button", { name: "Check again" }))
    expect(target.watch).toHaveBeenCalledTimes(2)
  })

  it("says why a watcher's controls are inert while disconnected", async () => {
    const target = watcher()
    const view = (connected: boolean) => (
      <TerminalPane connected={connected} readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />
    )
    const { rerender } = render(view(true))
    await act(async () => {
      target.watched.reject(new Error("Terminal does not exist"))
    })

    rerender(view(false))

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check again" }).disabled).toBe(true)
    expect(screen.getByText("Reconnect to the execution machine to read this shell.")).toBeTruthy()
  })

  it("announces who holds the shell", async () => {
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.resolve(watchResult({ claimHeld: false }))
    })
    await act(async () => {
      target.deliverOwnership(otherClient)
    })

    expect(screen.getAllByRole("status").some((region) => region.textContent?.includes("Claimed by a browser"))).toBe(true)
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
    expect(screen.getByText("closed, the shell has exited")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Check again" }))

    expect(target.unwatch).toHaveBeenCalledWith(terminalId)
    expect(target.watch).toHaveBeenCalledTimes(2)
  })

  it("says the watched shell exited when the close arrives live", async () => {
    const target = watcher()
    render(<TerminalPane connected readOnly controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.resolve(watchResult())
    })

    await act(async () => {
      target.deliverClosed(0)
    })

    expect(screen.queryByText("read-only, this device watches")).toBeNull()
    expect(screen.getByText("closed, the shell has exited")).toBeTruthy()
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
    expect(target.watch).toHaveBeenLastCalledWith("terminal-session-other", { followResize: true })
  })

  // The daemon sends nothing when the holder's connection drops, and nothing
  // when the holder resizes. terminal.list carries both, so a pane that does
  // not hold the shell reads it again on a short interval.
  it("rereads the holder and its grid while it does not hold the shell", async () => {
    const target = watcher()
    const listing = (over: Partial<TerminalWatchResult>) => {
      const { buffer: _buffer, earlierOutputDropped: _dropped, watchedAt: _watchedAt, followsResize: _follows, ...listed } = watchResult(over)
      return listed
    }
    let answer = listing({ claimHeld: false })
    const list = vi.fn(async (_sessionId: string) => [answer])
    const controls: TerminalControls = { ...target.controls, list }
    const { container, unmount } = render(
      <TerminalPane connected readOnly controls={controls} holderRefreshMs={20} machineName="worktop" sessionId={sessionId} />,
    )
    await act(async () => {
      target.watched.resolve(watchResult())
    })

    // The holder's connection dropped.
    expect(await screen.findByText("Nobody holds this shell")).toBeTruthy()
    expect(list).toHaveBeenCalledWith(sessionId)

    // Another device took the shell and set a wider grid.
    answer = listing({ owner: { client: "web", clientId: otherClient }, cols: 132, rows: 40 })
    expect(await screen.findByText("Claimed by a browser")).toBeTruthy()
    await vi.waitFor(() => expect(container.querySelectorAll(".xterm-rows > div").length).toBe(40))
    await act(async () => {
      target.deliverOutput("\x1b[1;120HX")
    })
    await vi.waitFor(() => {
      const first = container.querySelector(".xterm-rows > div")?.textContent ?? ""
      expect(first.replace(/\u00a0/gu, " ").indexOf("X")).toBe(119)
    })

    // Nothing is read after the pane goes.
    unmount()
    const calls = list.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(list.mock.calls.length).toBe(calls)
  })

  // The daemon keeps a bounded record. When the start of the shell's output
  // is gone, the view says so, and so does anything attached from it. The
  // note lives outside the stream, so a screen clear cannot erase it.
  it("marks a watched record whose start the daemon no longer keeps", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = watcher()
    const { container } = render(
      <TerminalPane connected readOnly composer={composer} controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )
    await act(async () => {
      target.watched.resolve(watchResult({ earlierOutputDropped: true }))
    })

    await drawnRows(container)
    await act(async () => {
      target.deliverOutput("\x1b[2J\x1b[H$ after the clear\r\n")
    })
    await vi.waitFor(() => expect(container.textContent).toContain("$ after the clear"))
    expect(screen.getByText("Earlier output was not kept. The daemon's record of this shell starts after it.")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))
    const [attachment] = receive.mock.calls[0]!
    expect("content" in attachment ? attachment.content : "").toMatch(/^\[earlier output was not kept; the record starts here\]/u)
  })

  // A watch it cannot undo would leave this connection in the shell's
  // audience after the pane is gone, so watch and unwatch come as a pair.
  it("does not watch without a way to stop", () => {
    const target = watcher()
    const { unwatch: _unwatch, ...rest } = target.controls
    // @ts-expect-error watch without unwatch is not a TerminalControls
    const halfPair: TerminalControls = rest
    render(<TerminalPane connected readOnly controls={halfPair} machineName="worktop" sessionId={sessionId} />)

    expect(target.watch).not.toHaveBeenCalled()
    expect(screen.getByText("Watching only")).toBeTruthy()
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

  // xterm parses writes later. An attach right after output arrives waits for
  // that parse, so the file holds what was printed, not an older screen.
  it("attaches output that arrived just before the click", { timeout: 20_000 }, async () => {
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = harness()
    render(<TerminalPane connected controls={target.controls} composer={composer} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index}\r\n`).join("")

    await act(async () => {
      target.deliverOutput(`${lines}LAST LINE\r\n`)
      fireEvent.click(screen.getByRole("button", { name: "Attach this output to the composer" }))
    })

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1), { timeout: 15_000 })
    const [attachment] = receive.mock.calls[0]!
    expect("content" in attachment ? attachment.content : "").toContain("LAST LINE")
  })

  // terminal.create hands back the daemon's record with no flag for a dropped
  // start. A record at the replay limit may have lost its start, so the view
  // and the file say so.
  it("marks output joined from a record at the replay limit", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = harness()
    const full = `${"r".repeat(79)}\n`.repeat(Math.ceil(maximumTerminalReplayCharacters / 80)).slice(-maximumTerminalReplayCharacters)
    const controls: TerminalControls = {
      ...target.controls,
      create: async () => ({
        terminalId, sessionId, cols: 80, rows: 24, shell: "bash", cwd: "/worktrees/demo", buffer: full, owner: { client: "web", clientId: thisClient },
      }),
    }
    render(<TerminalPane connected controls={controls} composer={composer} machineName="worktop" sessionId={sessionId} />)

    expect(await screen.findByText("The daemon's record of this shell is full, so earlier output may not have been kept.")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    expect("content" in attachment ? attachment.content : "").toMatch(/^\[the daemon's record of this shell was full; earlier output may be missing from this file\]\n/u)
  })

  // Read from a real xterm at width 5: blanks the shell printed before a wrap
  // stay in the line, and the padding xterm adds before a wide character that
  // did not fit on the row does not.
  it("keeps printed blanks across a wrap and drops wrap padding", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = watcher()
    render(<TerminalPane connected readOnly composer={composer} controls={target.controls} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.watched.resolve(watchResult({ cols: 5, rows: 24, buffer: "abc  def\r\nabcd中\r\n" }))
    })

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    expect("content" in attachment ? attachment.content : "").toBe("abc  def\nabcd中")
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

  // The attachment has a byte limit. When the pane holds more than fits, the
  // file starts with a line saying its start was cut, and the note says so.
  // 4,000 writes parse slowly when the whole suite runs at once.
  it("marks an attachment the byte limit cut", { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = harness()
    const { container } = render(<TerminalPane connected controls={target.controls} composer={composer} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })
    const line = `${"x".repeat(78)}\r\n`
    await act(async () => {
      target.deliverOutput("$ first command\r\n")
      for (let index = 0; index < 4_000; index += 1) target.deliverOutput(line)
      target.deliverOutput("END OF OUTPUT\r\n")
    })
    await parsedThrough(container, "END OF OUTPUT")

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    const content = "content" in attachment ? attachment.content : ""
    expect(content).toMatch(/^\[earlier lines were cut to fit the attachment limit\]\n/u)
    expect(content).not.toContain("$ first command")
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(maximumTextAttachmentBytes)
    expect(screen.getByText(/The start was cut to fit the attachment limit\./u)).toBeTruthy()
  })

  // The pane keeps a bounded history (5,000 rows; 50 here, so filling it is
  // cheap). Past that xterm drops the oldest, well inside the byte limit, and
  // the file says so.
  it("marks an attachment once the pane's history is full", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = harness()
    const { container } = render(<TerminalPane connected controls={target.controls} composer={composer} historyRows={50} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })
    // One write that fills the history and then clears it: the clear shrinks
    // the buffer below full before any batch ends, but the lines that
    // scrolled out are still gone, so the mark stays.
    const lines = Array.from({ length: 150 }, (_, index) => `line ${index}\r\n`).join("")
    await act(async () => {
      target.deliverOutput(`$ first command\r\n${lines}\x1b[3J$ after the clear\r\n`)
    })
    await parsedThrough(container, "$ after the clear")

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    const content = "content" in attachment ? attachment.content : ""
    expect(content).toMatch(/^\[this pane's history filled up; earlier output may be missing from this file\]\n/u)
    expect(content).not.toContain("$ first command")
    expect(screen.getByText(/The pane's history filled up, so earlier output may be missing\./u)).toBeTruthy()
  })

  // Rows also leave the history without a line feed: an index (ESC D) at the
  // bottom of the screen scrolls just the same.
  it("marks an attachment whose history filled through index scrolls", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = harness()
    const { container } = render(<TerminalPane connected controls={target.controls} composer={composer} historyRows={50} machineName="worktop" sessionId={sessionId} />)
    await act(async () => {
      target.connect(thisClient)
    })
    const rows = Array.from({ length: 150 }, (_, index) => `row ${index}\r\x1bD`).join("")
    await act(async () => {
      target.deliverOutput(`${rows}\x1b[3J$ after the clear\r\x1bD`)
    })
    await parsedThrough(container, "$ after the clear")

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    expect("content" in attachment ? attachment.content : "").toMatch(/^\[this pane's history filled up; earlier output may be missing from this file\]\n/u)
  })

  // Narrowing the grid reflows long rows into more rows, which can push the
  // oldest out of the history with no output at all.
  it("marks an attachment whose history filled when the grid narrowed", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = watcher()
    const listing = (over: Partial<TerminalWatchResult>) => {
      const { buffer: _buffer, earlierOutputDropped: _dropped, watchedAt: _watchedAt, followsResize: _follows, ...listed } = watchResult(over)
      return listed
    }
    const list = vi.fn(async (_sessionId: string) => [listing({ cols: 20 })])
    const controls: TerminalControls = { ...target.controls, list }
    const { container } = render(
      <TerminalPane connected readOnly composer={composer} controls={controls} historyRows={50} holderRefreshMs={20} machineName="worktop" sessionId={sessionId} />,
    )
    // 40 lines fit the history at 80 columns; at 20 each takes 4 rows.
    const wide = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(5, "0")} ${"z".repeat(60)}\r\n`).join("")
    await act(async () => {
      target.watched.resolve(watchResult({ buffer: `${wide}END OF OUTPUT\r\n` }))
    })
    await parsedThrough(container, "END OF OUTPUT")
    await vi.waitFor(() => expect(list).toHaveBeenCalled())
    await act(async () => {
      target.deliverOutput("\x1b[3J$ after the clear\r\n")
    })
    await parsedThrough(container, "$ after the clear")

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    expect("content" in attachment ? attachment.content : "").toMatch(/^\[this pane's history filled up; earlier output may be missing from this file\]\n/u)
  })

  // Fewer rows lower the history's capacity before the reflow runs, so a
  // wider, shorter grid can drop rows that a wider one would then merge.
  it("marks an attachment whose history filled when the grid got shorter", async () => {
    const user = userEvent.setup()
    const composer = createComposerInbox()
    const receive = vi.fn((_attachment: SessionAttachment) => "attached" as const)
    composer.open(sessionId, receive)
    const target = watcher()
    const { buffer: _buffer, earlierOutputDropped: _dropped, watchedAt: _watchedAt, followsResize: _follows, ...listed } = watchResult({ cols: 160, rows: 5 })
    const list = vi.fn(async (_sessionId: string) => [listed])
    const controls: TerminalControls = { ...target.controls, list }
    const { container } = render(
      <TerminalPane connected readOnly composer={composer} controls={controls} historyRows={50} holderRefreshMs={20} machineName="worktop" sessionId={sessionId} />,
    )
    // 30 lines of 81 characters take about 60 rows at 80 by 24: inside the 74
    // a 24-row screen allows, past the 55 a 5-row screen does.
    const wrapped = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(5, "0")}${"w".repeat(76)}\r\n`).join("")
    await act(async () => {
      target.watched.resolve(watchResult({ buffer: `${wrapped}END OF OUTPUT\r\n` }))
    })
    await parsedThrough(container, "END OF OUTPUT")
    await vi.waitFor(() => expect(list).toHaveBeenCalled())
    await vi.waitFor(() => expect(container.querySelectorAll(".xterm-rows > div").length).toBe(5))

    await user.click(screen.getByRole("button", { name: "Attach this output to the composer" }))

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1))
    const [attachment] = receive.mock.calls[0]!
    expect("content" in attachment ? attachment.content : "").toMatch(/^\[this pane's history filled up; earlier output may be missing from this file\]\n/u)
  })

  // A disconnect disposes the renderer the button reads from, so the button
  // goes with it rather than staying and doing nothing.
  it("is not offered once the renderer is gone", async () => {
    const composer = createComposerInbox()
    composer.open(sessionId, () => "attached")
    const target = harness()
    const view = (connected: boolean) => (
      <TerminalPane connected={connected} controls={target.controls} composer={composer} machineName="worktop" sessionId={sessionId} />
    )
    const { rerender } = render(view(true))
    await act(async () => {
      target.connect(thisClient)
    })
    expect(screen.getByRole("button", { name: "Attach this output to the composer" })).toBeTruthy()

    rerender(view(false))

    expect(screen.queryByRole("button", { name: "Attach this output to the composer" })).toBeNull()
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
