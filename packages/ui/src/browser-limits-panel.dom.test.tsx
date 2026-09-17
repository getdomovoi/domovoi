import { cleanup, render, screen } from "@testing-library/react"
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

  it("continues into the session on the one button", async () => {
    const user = userEvent.setup()
    const onContinue = vi.fn()
    render(<BrowserLimitsPanel rows={rows} onContinue={onContinue} />)

    await user.click(screen.getByRole("button", { name: "Continue to the session" }))

    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})
