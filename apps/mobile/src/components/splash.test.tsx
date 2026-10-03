import { describe, expect, it } from "@jest/globals"
import { render, screen } from "@testing-library/react-native"

import { Splash } from "./splash"

describe("Splash", () => {
  // Phone v2 frame 06: the mark above the wordmark while the app starts.
  it("draws the Domovoi mark above the wordmark", async () => {
    await render(<Splash />)
    expect(screen.getByTestId("domovoi-mark", { includeHiddenElements: true })).toBeOnTheScreen()
    expect(screen.getByText("Domovoi")).toBeOnTheScreen()
  })

  // Frame 06 draws the mark's working variant while the app starts (ruling
  // Q386 A).
  it("draws the working mark", async () => {
    await render(<Splash />)
    expect(screen.getByTestId("domovoi-mark-working", { includeHiddenElements: true })).toBeOnTheScreen()
  })

  // The wordmark already says Domovoi, so the mark is not announced twice.
  it("names Domovoi once to a screen reader", async () => {
    await render(<Splash />)
    expect(screen.queryByRole("image", { name: "Domovoi" })).toBeNull()
  })
})
