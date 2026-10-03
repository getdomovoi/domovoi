import { describe, expect, it } from "@jest/globals"
import { render, screen } from "@testing-library/react-native"

import { Mark, markForm } from "./mark"

describe("Mark", () => {
  // The brand handoff (design/design_handoff_domovoi_brand/README.md, "Size
  // behaviour"): the full mark, eyes and mustache, at 28px and above; the
  // reduced mark below, because mid-face detail turns to mud.
  it("picks the full mark from 28px and the reduced mark below", () => {
    expect(markForm(62)).toBe("full")
    expect(markForm(28)).toBe("full")
    expect(markForm(27)).toBe("reduced")
    expect(markForm(24)).toBe("reduced")
  })

  it("draws at either size", async () => {
    await render(<Mark size={62} />)
    expect(screen.getByTestId("domovoi-mark", { includeHiddenElements: true })).toBeOnTheScreen()
    await render(<Mark size={24} />)
    expect(screen.getByTestId("domovoi-mark", { includeHiddenElements: true })).toBeOnTheScreen()
  })
})
