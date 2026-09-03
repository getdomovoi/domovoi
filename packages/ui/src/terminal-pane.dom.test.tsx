import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TerminalOwnershipNotification, TerminalSession } from "@getdomovoi/protocol"

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
    deliverOwnership: (owner: string) => handlers?.ownership({
      terminalId,
      owner: { client: "web", clientId: owner },
    }),
  }
}

describe("TerminalPane ownership", () => {
  it("silences non-owner input until Take over hands the terminal back", async () => {
    const user = userEvent.setup()
    const target = harness()
    render(
      <TerminalPane connected controls={target.controls} machineName="worktop" sessionId={sessionId} />,
    )

    await act(async () => {
      target.connect(otherClient)
    })
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Tab" }))
    await user.click(screen.getByRole("button", { name: "Close terminal" }))
    expect(target.write).not.toHaveBeenCalled()
    expect(target.close).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close terminal" }).disabled).toBe(true)

    await user.click(screen.getByRole("button", { name: "Take over" }))
    expect(target.claimRequest).toHaveBeenCalledWith(terminalId)
    await act(async () => {
      target.grantOwnership(thisClient)
    })

    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull()
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
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy()

    await act(async () => {
      target.deliverOwnership(thisClient)
    })
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(target.write).toHaveBeenCalledWith(terminalId, "\t")

    await act(async () => {
      target.deliverOwnership(otherClient)
    })
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy()
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
    await user.click(screen.getByRole("button", { name: "Take over" }))
    await act(async () => {
      target.refuseOwnership(new Error("Terminal is being taken over"))
    })

    expect((await screen.findByRole("alert")).textContent).toContain("Terminal is being taken over")
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Tab" }))
    expect(target.write).not.toHaveBeenCalled()
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
