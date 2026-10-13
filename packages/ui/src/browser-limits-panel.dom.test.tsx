import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BrowserLimitsPanel, type BrowserLimit } from "./browser-limits-panel.js"

afterEach(cleanup)

const rows: BrowserLimit[] = [
  { what: "Watch a session live", state: "same as desktop", tone: "same", why: "The daemon streams the thread over loopback." },
  { what: "Notifications", state: "refused", tone: "refused", why: "This browser does not provide the Notifications API." },
  { what: "Open the repository", state: "not possible", tone: "never", why: "Nothing is cloned into the browser." },
]

describe("BrowserLimitsPanel", () => {
  it("states each limit as a row with what, its state and why, before anything is hit", () => {
    render(<BrowserLimitsPanel rows={rows} onContinue={vi.fn()} />)

    expect(screen.getByRole("heading", { name: "What a browser tab can and cannot do" })).toBeTruthy()
    expect(screen.getByText("Each difference follows from one fact: no daemon, no repository, no keychain.")).toBeTruthy()
    const list = screen.getByRole("list", { name: "Browser limits" })
    const items = list.querySelectorAll("li")
    expect(items).toHaveLength(3)
    expect(items[1]!.textContent).toContain("Notifications")
    expect(items[1]!.textContent).toContain("refused")
    expect(items[1]!.textContent).toContain("This browser does not provide the Notifications API.")
    expect(items[1]!.getAttribute("data-tone")).toBe("refused")
  })

  // The Web v2 bar above the page carries the mark, so the page draws none
  // of its own (web-v2 appbar).
  it("draws no mark of its own under the bar", () => {
    const { container } = render(<BrowserLimitsPanel rows={rows} onContinue={vi.fn()} />)
    expect(container.querySelector("svg path[fill-rule='evenodd']")).toBeNull()
  })

  it("continues into the session on the one button", async () => {
    const user = userEvent.setup()
    const onContinue = vi.fn()
    render(<BrowserLimitsPanel rows={rows} onContinue={onContinue} />)

    await user.click(screen.getByRole("button", { name: "Continue to the session" }))

    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  // Q99 A: inside a session the same limits open as a dialog over the live
  // session, closed by Back or Escape, and focus goes back to the opener.
  it("opens as a dialog over a session and hands focus back on the way out", async () => {
    const user = userEvent.setup()
    const opener = document.createElement("button")
    document.body.append(opener)
    const onContinue = vi.fn()
    const { rerender } = render(<BrowserLimitsPanel rows={rows} onContinue={onContinue} continueLabel="Back" dialog={{ open: true, returnFocusTo: opener }} />)

    const dialog = screen.getByRole("dialog", { name: "What a browser tab can and cannot do" })
    expect(dialog.textContent).toContain("Each difference follows from one fact: no daemon, no repository, no keychain.")
    expect(screen.getByRole("list", { name: "Browser limits" }).querySelectorAll("li")).toHaveLength(3)
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "What a browser tab can and cannot do" }))

    await user.keyboard("{Escape}")
    expect(onContinue).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(onContinue).toHaveBeenCalledTimes(2)

    rerender(<BrowserLimitsPanel rows={rows} onContinue={onContinue} continueLabel="Back" dialog={{ open: false, returnFocusTo: opener }} />)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it("names the way back when it was opened before there is a session", async () => {
    const user = userEvent.setup()
    const onContinue = vi.fn()
    render(<BrowserLimitsPanel rows={rows} onContinue={onContinue} continueLabel="Back to pairing" />)

    expect(screen.queryByRole("button", { name: "Continue to the session" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Back to pairing" }))

    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})
