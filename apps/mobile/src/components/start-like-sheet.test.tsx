import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { StartLikeSheet } from "./start-like-sheet"

async function draw(overrides: Partial<Parameters<typeof StartLikeSheet>[0]> = {}) {
  const props = {
    open: true,
    like: { title: "Migrate billing webhooks", machine: "mac-mini-m4", runtime: "claude/opus" },
    starting: false,
    problem: "",
    onStart: jest.fn<(prompt: string, mode: "ask" | "plan" | "build") => void>(),
    onClose: jest.fn<() => void>(),
    ...overrides,
  }
  await render(<StartLikeSheet {...props} />)
  return props
}

describe("StartLikeSheet", () => {
  it("names what it copies, starts in Plan, and sends the words with the mode", async () => {
    const props = await draw()

    expect(screen.getByText(/mac-mini-m4 · claude\/opus/)).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Plan" }).props.accessibilityState).toMatchObject({ selected: true })
    expect(screen.getByText(/comes back as a proposal/)).toBeOnTheScreen()

    await fireEvent.changeText(screen.getByLabelText("What to do"), "Rotate the Stripe webhook secret")
    await fireEvent.press(screen.getByRole("button", { name: "Start" }))

    expect(props.onStart).toHaveBeenCalledWith("Rotate the Stripe webhook secret", "plan")
  })

  it("lets the mode change, and says what each one means from a phone", async () => {
    const props = await draw()

    await fireEvent.press(screen.getByRole("button", { name: "Build" }))
    expect(screen.getByText(/writes to the worktree with nobody reading/)).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByLabelText("What to do"), "Do it")
    await fireEvent.press(screen.getByRole("button", { name: "Start" }))

    expect(props.onStart).toHaveBeenCalledWith("Do it", "build")
  })

  it("will not start with nothing to do, and shows a refusal where the person is", async () => {
    const props = await draw({ problem: "Session create failed" })

    await fireEvent.press(screen.getByRole("button", { name: "Start" }))
    expect(props.onStart).not.toHaveBeenCalled()
    expect(screen.getByText("Session create failed")).toBeOnTheScreen()
  })
})
