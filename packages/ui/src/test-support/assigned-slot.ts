// happy-dom has no working Element.assignedSlot. A browser answers it for a
// child of a host with an open shadow root: the first slot in that root, in
// tree order, whose name is the child's slot attribute (the default slot has
// none). A closed root, or a child with no matching slot, answers null. Tests
// that put a page's control in a widget's slot install this to answer as a
// browser would, and put back what was there afterwards.
export function assignSlotsLikeABrowser(): () => void {
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "assignedSlot")
  Object.defineProperty(Element.prototype, "assignedSlot", {
    configurable: true,
    get(this: Element): HTMLSlotElement | null {
      const root = this.parentElement?.shadowRoot
      if (!root) return null
      const name = this.getAttribute("slot") ?? ""
      for (const slot of root.querySelectorAll("slot")) {
        if ((slot.getAttribute("name") ?? "") === name) return slot
      }
      return null
    },
  })
  return () => {
    if (own) Object.defineProperty(Element.prototype, "assignedSlot", own)
    else Reflect.deleteProperty(Element.prototype, "assignedSlot")
  }
}
