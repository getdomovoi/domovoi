import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { TurnActivity } from "./turn-activity"

afterEach(cleanup)

it("travels the working bar instead of fading it", () => {
  const { container } = render(<TurnActivity items={[]} running />)

  expect(container.querySelector(".sweep-bar"), "the running bar does not use the sweep").not.toBeNull()
  expect(container.querySelector(".animate-pulse")).toBeNull()
})

// The chip opens the list of tool steps. A turn that has not called a tool has
// no steps, so the chip offers nothing to open until one arrives.
it("does not offer to open an empty step list", () => {
  const { container } = render(<TurnActivity items={[]} running />)
  const chip = container.querySelector("button")!

  expect(chip.disabled).toBe(true)
  expect(chip.querySelector("svg")).toBeNull()
})
