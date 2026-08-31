import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DaemonCredentialPrompt } from "./daemon-credential-prompt.js"

afterEach(cleanup)

const field = () => screen.getByLabelText("Daemon credential") as HTMLInputElement
const connect = () => screen.getByRole("button", { name: /connect/i }) as HTMLButtonElement

describe("DaemonCredentialPrompt interaction", () => {
  it("focuses the credential field so the operator can type immediately", () => {
    render(<DaemonCredentialPrompt onSubmit={vi.fn()} />)

    expect(document.activeElement).toBe(field())
  })

  it("keeps submission blocked while the credential is blank", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<DaemonCredentialPrompt onSubmit={onSubmit} />)

    expect(connect().disabled).toBe(true)

    await user.type(field(), "   ")
    expect(connect().disabled).toBe(true)

    await user.keyboard("{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("submits the trimmed credential once and leaves the typed value in the field", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<DaemonCredentialPrompt onSubmit={onSubmit} />)

    await user.type(field(), "  daemon-token-value  ")
    expect(connect().disabled).toBe(false)

    await user.click(connect())

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith("daemon-token-value")
    expect(field().value).toBe("  daemon-token-value  ")
  })
})
