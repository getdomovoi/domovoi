import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { closestComposed, containsComposed } from "./composed-focus"
import { assignSlotsLikeABrowser } from "./test-support/assigned-slot"

let restoreSlots = () => {}
beforeEach(() => { restoreSlots = assignSlotsLikeABrowser() })
afterEach(() => {
  restoreSlots()
  document.body.replaceChildren()
})

const dialogSelector = "[role='dialog']"

// A widget whose open shadow root draws a dialog around a slot. The control
// the page puts in the widget lives in the light DOM, but it renders inside
// that dialog, where its assigned slot places it.
function slottedDialog() {
  const host = document.body.appendChild(document.createElement("div"))
  const dialog = host.attachShadow({ mode: "open" }).appendChild(document.createElement("div"))
  dialog.setAttribute("role", "dialog")
  dialog.appendChild(document.createElement("slot"))
  const button = host.appendChild(document.createElement("button"))
  return { host, dialog, button }
}

describe("composed ancestry", () => {
  it("finds the dialog a slotted control renders in", () => {
    const { dialog, button } = slottedDialog()
    expect(button.assignedSlot).toBe(dialog.querySelector("slot"))
    expect(closestComposed(button, dialogSelector)).toBe(dialog)
    expect(containsComposed(dialog, button)).toBe(true)
  })

  // The slot sits on an ancestor of the control, not on the control itself.
  it("finds the dialog through a slot on an ancestor", () => {
    const { host, dialog } = slottedDialog()
    const group = host.appendChild(document.createElement("div"))
    const button = group.appendChild(document.createElement("button"))
    expect(closestComposed(button, dialogSelector)).toBe(dialog)
    expect(containsComposed(dialog, button)).toBe(true)
  })

  // The light DOM parent of a slotted control matches the selector, but the
  // control renders in the shadow dialog first, which is the closer one.
  it("prefers the slot's dialog over a light DOM ancestor that also matches", () => {
    const outer = document.body.appendChild(document.createElement("section"))
    outer.setAttribute("role", "dialog")
    const host = outer.appendChild(document.createElement("div"))
    const dialog = host.attachShadow({ mode: "open" }).appendChild(document.createElement("div"))
    dialog.setAttribute("role", "dialog")
    dialog.appendChild(document.createElement("slot"))
    const button = host.appendChild(document.createElement("button"))
    expect(closestComposed(button, dialogSelector)).toBe(dialog)
    expect(containsComposed(outer, button)).toBe(true)
  })

  it("climbs from a shadow root to its host", () => {
    const dialog = document.body.appendChild(document.createElement("div"))
    dialog.setAttribute("role", "dialog")
    const host = dialog.appendChild(document.createElement("div"))
    const button = host.attachShadow({ mode: "open" }).appendChild(document.createElement("button"))
    expect(closestComposed(button, dialogSelector)).toBe(dialog)
    expect(containsComposed(dialog, button)).toBe(true)
  })

  it("answers nothing outside any match", () => {
    const button = document.body.appendChild(document.createElement("button"))
    const other = document.body.appendChild(document.createElement("div"))
    expect(closestComposed(button, dialogSelector)).toBeNull()
    expect(containsComposed(other, button)).toBe(false)
  })
})
