import { describe, expect, it } from "vitest"

import { cn } from "./cn"

describe("cn", () => {
  it("drops the branches a caller did not take", () => {
    expect(cn("p-2", false, undefined, null, "text-foreground")).toBe("p-2 text-foreground")
  })
})
