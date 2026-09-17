import { describe, expect, it } from "vitest"

import { browserLimitsSeen, markBrowserLimitsSeen } from "./browser-limits-seen"

function storage(): Pick<Storage, "getItem" | "setItem"> {
  const held = new Map<string, string>()
  return { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => { held.set(key, value) } }
}

describe("browser limits, seen once per tab", () => {
  it("is unseen until marked, and marking reports that the tab can hold it", () => {
    const tab = storage()
    expect(browserLimitsSeen(tab)).toBe(false)
    expect(markBrowserLimitsSeen(tab)).toBe(true)
    expect(browserLimitsSeen(tab)).toBe(true)
  })

  it("reports a tab that cannot hold anything, and shows the panel again there", () => {
    const blocked: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => { throw new Error("SecurityError") },
      setItem: () => { throw new Error("SecurityError") },
    }
    expect(markBrowserLimitsSeen(blocked)).toBe(false)
    expect(browserLimitsSeen(blocked)).toBe(false)
  })
})
