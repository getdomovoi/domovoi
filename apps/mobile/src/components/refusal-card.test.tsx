import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"

import type { PhoneRefusal } from "../session-refusal"
import { RefusalCard } from "./refusal-card"

const refusal: PhoneRefusal = {
  title: "Domovoi did not start this session",
  code: "refused · untrusted git filter",
  sentence: "Checking out acme-api would run the sops filter driver, which is not trusted on studio.",
  names: ["sops · local git config"],
  omitted: 0,
  awaitsTrust: true,
}

describe("RefusalCard", () => {
  // Skills design step 16: the phone shows the refusal with the filter it
  // names, points to what is held back, and says trust is granted elsewhere.
  it("names the refusal and the filter, opens what is held back, and points to desktop or web", async () => {
    const onSeeHeldBack = jest.fn<() => void>()
    await render(<RefusalCard refusal={refusal} onSeeHeldBack={onSeeHeldBack} />)

    expect(screen.getByText("Domovoi did not start this session")).toBeOnTheScreen()
    expect(screen.getByText("refused · untrusted git filter")).toBeOnTheScreen()
    expect(screen.getByText(refusal.sentence)).toBeOnTheScreen()
    expect(screen.getByText("It names")).toBeOnTheScreen()
    expect(screen.getByText("sops · local git config")).toBeOnTheScreen()
    expect(screen.getByText("Nothing from the repository ran.")).toBeOnTheScreen()
    expect(screen.getByText("Trust from desktop or web")).toBeOnTheScreen()
    expect(screen.getByText("A phone shows this but cannot trust it.")).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "See what is held back" }))
    expect(onSeeHeldBack).toHaveBeenCalledTimes(1)
  })

  it("counts drivers it does not name, and does not point to trust that would not lift the refusal", async () => {
    await render(<RefusalCard refusal={{ ...refusal, omitted: 2, awaitsTrust: false }} onSeeHeldBack={jest.fn()} />)

    expect(screen.getByText("and 2 more")).toBeOnTheScreen()
    expect(screen.queryByText("Trust from desktop or web")).toBeNull()
    expect(screen.getByText("A phone shows this but cannot trust it.")).toBeOnTheScreen()
  })
})
