import { describe, expect, it } from "@jest/globals"
import { render, screen } from "@testing-library/react-native"

import { Mark, markFeatures, markForm } from "./mark"

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

  // Ruling Q386 A: the working variant. The brand handoff ("Working state")
  // widens the full mark's eyes to r 3.8 and changes nothing else, so the
  // eyes keep mark.svg's centres (42, 31) and (58, 31) and the mustache stays.
  it("widens the full mark's eyes to r 3.8 for the working variant", () => {
    expect(markForm(62, "working")).toBe("working")
    expect(markFeatures("working")).toBe(
      "M38.2 31a3.8 3.8 0 1 0 7.6 0a3.8 3.8 0 1 0 -7.6 0Z"
      + "M54.2 31a3.8 3.8 0 1 0 7.6 0a3.8 3.8 0 1 0 -7.6 0Z"
      + "M34 43C40 40 45 43 50 43C55 43 60 40 66 43C59 50 54 47 50 47C46 47 41 50 34 43Z",
    )
  })

  // The handoff defines the working state on the full form only. Below 28px
  // the reduced form is drawn whatever the variant.
  it("keeps the reduced mark below 28px for the working variant", () => {
    expect(markForm(24, "working")).toBe("reduced")
  })

  it("names the form it draws", async () => {
    await render(<Mark size={62} variant="working" />)
    expect(screen.getByTestId("domovoi-mark-working", { includeHiddenElements: true })).toBeOnTheScreen()
  })
})
