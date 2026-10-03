// Focus as a person meets it, across shadow roots and slots.
// document.activeElement and a document focus listener's event target name
// only the outermost shadow host; the element that holds focus may sit inside
// it, and a slotted element renders inside the shadow tree it is assigned to.

// The element that holds focus, walking open shadow roots down from
// document.activeElement. It stops at a host whose root is closed or holds no
// focus of its own, which is the answer then.
export function focusedElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

// The element a focus event is about: the first in its composed path, so a
// focus inside an open shadow root names the element there, not its host. A
// closed root keeps its elements out of the path, so its host is named.
export function focusEventElement(event: FocusEvent): Element | null {
  const first = event.composedPath()[0]
  if (first instanceof Element) return first
  return event.target instanceof Element ? event.target : null
}

// The element an element renders inside: the slot it is assigned to, else its
// parent, else, at the top of a shadow root, that root's host. A slotted
// element is a child of the host in the DOM but renders in the shadow tree
// at its slot, so the slot comes first. A closed root reports no slot.
function composedParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

// Element.closest across shadow boundaries and slots: the nearest of the
// element and the elements it renders inside that matches. Element.closest
// is not used even for a first step, since it would pass over a slot on any
// ancestor on its way up.
export function closestComposed(element: Element, selector: string): Element | null {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.matches(selector)) return current
  }
  return null
}

// Node.contains along the same composed ancestry.
export function containsComposed(container: Element, element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current === container) return true
  }
  return false
}
