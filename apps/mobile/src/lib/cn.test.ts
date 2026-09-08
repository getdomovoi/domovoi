import { describe, expect, it } from "vitest"

import { cn } from "./cn"

describe("cn", () => {
  it("drops the branches a caller did not take", () => {
    expect(cn("p-2", false, undefined, null, "text-foreground")).toBe("p-2 text-foreground")
  })

  // NativeWind would otherwise pick by the order Tailwind wrote the rules,
  // where text-[13px] outranks text-[10px] whatever the call site asked for.
  it("lets the later size win however the stylesheet is ordered", () => {
    expect(cn("font-mono text-[13px] text-foreground", "text-[10px]"))
      .toBe("font-mono text-foreground text-[10px]")
    expect(cn("text-[10px]", "text-[13px]")).toBe("text-[13px]")
  })

  it("lets the later colour win", () => {
    expect(cn("text-muted-foreground", "text-faint")).toBe("text-faint")
    expect(cn("bg-card", "bg-warn-bg")).toBe("bg-warn-bg")
    expect(cn("border-warn-border", "border-border")).toBe("border-border")
  })

  it("lets the later face win", () => {
    expect(cn("font-sans", "font-sans-semibold")).toBe("font-sans-semibold")
  })

  it("keeps a border width and style beside a border colour", () => {
    expect(cn("rounded-2xl border border-border bg-card p-3.5", "border-dashed border-primary"))
      .toBe("rounded-2xl border bg-card p-3.5 border-dashed border-primary")
  })

  it("keeps corner radii, which are not one property", () => {
    expect(cn("rounded-2xl rounded-br-xl")).toBe("rounded-2xl rounded-br-xl")
  })

  it("treats a variant as a condition rather than a conflict", () => {
    expect(cn("opacity-100", "active:opacity-70")).toBe("opacity-100 active:opacity-70")
  })

  it("settles padding by edge, so p-0 clears a card's own padding", () => {
    expect(cn("p-3.5", "p-0")).toBe("p-0")
    expect(cn("p-3.5", "px-3")).toBe("p-3.5 px-3")
  })

  it("leaves a class it does not own alone", () => {
    expect(cn("flex-1 min-h-tap items-center", "flex-row"))
      .toBe("flex-1 min-h-tap items-center flex-row")
  })
})
