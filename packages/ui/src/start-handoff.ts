// The elements a refused start's card may take focus from, known by identity
// (ruling Q410, security review round 8). Domovoi's own components register
// them through the ref callbacks here. Nothing on the page can claim a place
// by copying an attribute, since the sets are private to this module and hold
// the exact nodes the components rendered.

const openers = new WeakSet<Element>()
const loadingLines = new WeakSet<Element>()

// The ref of a control that opens a session start: the New session buttons,
// the palette's New session row, the launcher's submit and the fork controls.
// Only a native button, or an option or menu item row a Domovoi component
// draws as a plain div, is kept. Neither is text entry, and a button cannot
// host a shadow root at all.
export function startOpenerRef(element: HTMLElement | null): (() => void) | undefined {
  if (!element || !openerShape(element)) return undefined
  openers.add(element)
  return () => { openers.delete(element) }
}

// The ref of the line a surface's code loads behind, which holds focus while
// it does.
export function loadingLineRef(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return undefined
  loadingLines.add(element)
  return () => { loadingLines.delete(element) }
}

// Whether this exact element is a registered start control.
export function isStartOpener(element: Element): boolean {
  return openers.has(element) && openerShape(element)
}

// Whether this exact element is a registered loading line.
export function isLoadingLine(element: Element): boolean {
  return loadingLines.has(element)
}

function openerShape(element: Element): boolean {
  if (element instanceof HTMLButtonElement) return true
  const role = element.getAttribute("role")
  return element instanceof HTMLDivElement && (role === "option" || role === "menuitem")
}
