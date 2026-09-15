import { describe, expect, it } from "vitest"
import { rpcMethods, rpcMethodMutations } from "./rpc.js"

describe("Rules protocol RPCs", () => {
  it("validates revocation input and classifies it as a mutation", () => {
    const method = Reflect.get(rpcMethods, "approvalRule.revoke") as { params: { safeParse(value: unknown): { success: boolean } } } | undefined
    expect(method).toBeDefined()
    expect(method!.params.safeParse({ ruleId: "rule-one", client: "cli" }).success).toBe(true)
    expect(method!.params.safeParse({ ruleId: "", client: "cli" }).success).toBe(false)
    expect(method!.params.safeParse({ ruleId: "rule-one", client: "cli", inactivatedBy: "desktop" }).success).toBe(false)
    expect(Reflect.get(rpcMethodMutations, "approvalRule.revoke")).toBe("mutating")
  })

  it("validates renderable hard-gate categories and rejects unknown or duplicate categories", () => {
    const method = Reflect.get(rpcMethods, "permission.hardGates") as { params: { safeParse(value: unknown): { success: boolean } }; result: { safeParse(value: unknown): { success: boolean } } } | undefined
    expect(method).toBeDefined()
    expect(method!.params.safeParse({}).success).toBe(true)
    expect(method!.params.safeParse({ client: "cli" }).success).toBe(false)
    const category = { id: "destructive-operations", label: "drop, truncate or force-push" }
    expect(method!.result.safeParse({ categories: [category] }).success).toBe(true)
    expect(method!.result.safeParse({ categories: [category, category] }).success).toBe(false)
    expect(method!.result.safeParse({ categories: [{ ...category, id: "invented" }] }).success).toBe(false)
    expect(method!.result.safeParse({ categories: [{ ...category, label: "" }] }).success).toBe(false)
    expect(Reflect.get(rpcMethodMutations, "permission.hardGates")).toBe("read-only")
  })
})
