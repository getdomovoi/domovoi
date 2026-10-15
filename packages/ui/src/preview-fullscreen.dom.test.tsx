import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { PreviewFullscreen } from "./preview-fullscreen"
import { TitlebarLeadingInset } from "./titlebar-inset"

afterEach(cleanup)

function fullscreen(wrap: (node: ReactNode) => ReactNode = (node) => node) {
  return render(wrap(
    <PreviewFullscreen
      open
      onOpenChange={vi.fn()}
      title="Pricing page"
      meta="apps/web/pricing.html"
      widths={<button type="button">Desktop width</button>}
      stage={<p>page</p>}
      commentsTitle="Comments"
      commentCount="0"
      annotate={<button type="button">Annotate</button>}
      comments={null}
    />,
  ))
}

const topRow = () => screen.getByText("Pricing page").closest<HTMLElement>(".electron-drag")

// Fullscreen covers the whole window, its top row where the shell's titlebar
// was. Inside a desktop shell that reserves the macOS window buttons' inset,
// the row starts past them and drags the window; its controls opt out.
it("starts the top row past the window buttons the shell reserves, and drags the window from it", () => {
  fullscreen((node) => <TitlebarLeadingInset.Provider value={84}>{node}</TitlebarLeadingInset.Provider>)

  const row = topRow()
  expect(row?.style.paddingLeft).toBe("84px")
  const controls = [...row?.querySelectorAll("button") ?? []]
  expect(controls.map((control) => control.textContent)).toEqual(["Desktop width", "Exit fullscreenesc"])
  for (const control of controls) {
    expect(control.closest(".electron-no-drag"), `${control.textContent} inherits the drag region`).not.toBeNull()
  }
})

it("reserves no inset where no shell provides one, as on the web", () => {
  fullscreen()

  expect(topRow()?.style.paddingLeft).toBe("")
})
