// Focus as a person meets it, across shadow roots. document.activeElement and
// a document focus listener's event target name only the outermost shadow
// host; the element that holds focus may sit inside it.

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

// Element.closest across shadow boundaries: an element inside a shadow root
// is also inside whatever holds its host.
export function closestComposed(element: Element, selector: string): Element | null {
  for (let current: Element | null = element; current;) {
    const found = current.closest(selector)
    if (found) return found
    const root = current.getRootNode()
    current = root instanceof ShadowRoot ? root.host : null
  }
  return null
}

// Node.contains across shadow boundaries, the same way.
export function containsComposed(container: Element, element: Element): boolean {
  for (let current: Element | null = element; current;) {
    if (container.contains(current)) return true
    const root = current.getRootNode()
    current = root instanceof ShadowRoot ? root.host : null
  }
  return false
}

// Whether focus sits somewhere this document cannot see into: a frame, which
// holds focus of its own, or a shadow host focusedElement stopped at. A host
// with an open root that holds no focus is answered directly. A closed root
// cannot be detected, so an element that holds focus without being focusable
// by itself (a custom element, or an element that may host a shadow root and
// has no tabindex) is taken to be a host that passed focus inside.
export function focusIsOpaque(element: Element): boolean {
  if (element instanceof HTMLIFrameElement || element instanceof HTMLObjectElement || element instanceof HTMLEmbedElement) return true
  if (element.shadowRoot) return true
  if (element.localName.includes("-")) return true
  return shadowHostNames.has(element.localName) && !element.hasAttribute("tabindex")
}

// The standard elements that may host a shadow root (DOM Standard,
// attachShadow). None of them takes focus without a tabindex or editing.
const shadowHostNames = new Set([
  "article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "main", "nav", "p", "section", "span",
])
