import { describe, expect, it } from "@jest/globals"
import { render, screen } from "@testing-library/react-native"

import { Splash } from "./splash"

describe("Splash", () => {
  // Phone v2 frame 06: the mark above the wordmark while the app starts.
  it("draws the Domovoi mark above the wordmark", async () => {
    await render(<Splash />)
    expect(screen.getByRole("image", { name: "Domovoi" })).toBeOnTheScreen()
    expect(screen.getByText("Domovoi")).toBeOnTheScreen()
  })
})
