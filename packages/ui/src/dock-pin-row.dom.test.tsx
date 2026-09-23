import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { MachineSheet } from "./machine-sheet"

// The pin control belongs to the dock's tab row. Laid out anywhere else it
// either takes a row of its own above the tabs or sits over the last tabs,
// which is what the maintainer saw in both the floating and the pinned sheet.
function DockLike({ pinControl }: { pinControl: React.ReactNode }) {
  return (
    <div className="flex h-11 items-center border-b px-2" data-testid="dock-tab-row">
      <div role="tablist">
        <button type="button" role="tab">Plan</button>
        <button type="button" role="tab">Checkpoints</button>
      </div>
      {pinControl}
      <button type="button" aria-label="Collapse dock" />
    </div>
  )
}

describe("the pin control shares the dock tab row", () => {
  it("puts the floating sheet's pin control in the tab row rather than a row of its own", () => {
    render(
      <MachineSheet
        open
        pinned={false}
        onClose={() => {}}
        onTogglePin={() => {}}
        renderPinControl={(control) => <DockLike pinControl={control} />}
      >
        <div>surfaces</div>
      </MachineSheet>,
    )

    const pin = screen.getByRole("button", { name: "Pin" })
    expect(pin.closest("[data-testid='dock-tab-row']")).not.toBeNull()
  })

  it("keeps the tab row the only row above the surfaces", () => {
    const { container } = render(
      <MachineSheet
        open
        pinned={false}
        onClose={() => {}}
        onTogglePin={() => {}}
        renderPinControl={(control) => <DockLike pinControl={control} />}
      >
        <div>surfaces</div>
      </MachineSheet>,
    )

    const section = container.querySelector("section[aria-label='Machine surfaces']")
    expect(section?.children.length).toBe(1)
  })
})
