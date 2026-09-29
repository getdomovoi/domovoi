import { demoWorkspace, toolInventorySchema, type ToolInventory, type ToolInventoryEntry } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { fitToolInventory } from "./tool-inventory.js"

const { id, name, platform, arch, version } = demoWorkspace.machine
const machine = { id, name, platform, arch, version }
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

const rule = (index: number, width = 40): ToolInventoryEntry => ({
  kind: "permission-rule", rule: "allow", detail: `Bash(pnpm run task${index} ${"x".repeat(width)})`,
  file: ".claude/settings.json", startsAtSessionStart: false, heldBack: false,
})

function inventory(counts: Record<string, number>, omittedEntries = 0): ToolInventory {
  return {
    machine,
    providers: Object.entries(counts).map(([provider, count]) => ({
      provider, toolServers: "read-from-files", omittedEntries,
      files: [{ path: ".claude/settings.json", source: "local-settings", state: "read" }],
      entries: Array.from({ length: count }, (_, index) => rule(index)),
    })),
  }
}

const listed = (value: ToolInventory) => value.providers.map((provider) => provider.entries.length)
const omitted = (value: ToolInventory) => value.providers.map((provider) => provider.omittedEntries)

describe("fitToolInventory", () => {
  it("leaves an inventory within the budget as it is", () => {
    const whole = inventory({ "claude-code": 10 })
    expect(toolInventorySchema.safeParse(whole).success).toBe(true)
    expect(fitToolInventory(whole, bytesOf(whole))).toEqual(whole)
  })

  it("leaves out only as many entries as the budget needs, counting each", () => {
    const whole = inventory({ "claude-code": 10 })
    const fitted = fitToolInventory(whole, bytesOf(whole) - 1)
    expect(listed(fitted)).toEqual([9])
    expect(omitted(fitted)).toEqual([1])
    expect(fitted.providers[0]!.entries).toEqual(whole.providers[0]!.entries.slice(0, 9))
  })

  it("counts the digit a growing count adds", () => {
    // The count goes from 9 to 10: one byte more. A budget one byte short of
    // the inventory without its last entry is met only by leaving out two.
    const whole = inventory({ "claude-code": 10 }, 9)
    const withoutLast = { ...whole, providers: [{ ...whole.providers[0]!, omittedEntries: 10, entries: whole.providers[0]!.entries.slice(0, 9) }] }
    expect(listed(fitToolInventory(whole, bytesOf(withoutLast)))).toEqual([9])
    expect(listed(fitToolInventory(whole, bytesOf(withoutLast) - 1))).toEqual([8])
  })

  it("takes entries from the provider listing the most, so a small one keeps its list", () => {
    const whole = inventory({ "claude-code": 40, codex: 3 })
    const fitted = fitToolInventory(whole, bytesOf(whole) - 1_000)
    expect(bytesOf(fitted)).toBeLessThanOrEqual(bytesOf(whole) - 1_000)
    expect(listed(fitted)[1]).toBe(3)
    expect(listed(fitted)[0]).toBeLessThan(40)
    expect(listed(fitted)[0]! + omitted(fitted)[0]!).toBe(40)
  })
})
