import { describe, expect, it } from "vitest"

import type { SkillInventorySource } from "@getdomovoi/protocol"

import { compareSkillInventories } from "./skill-fleet-comparison"

const digest = (character: string) => `sha256:${character.repeat(64)}` as const
const machine = (id: string, name: string) => ({
  id,
  name,
  platform: "linux",
  arch: "x64",
  version: "0.0.1",
})
const skill = (overrides: Record<string, unknown> = {}) => ({
  id: "skill-111111111111",
  name: "repo-audit",
  scope: "user" as const,
  source: "agents" as const,
  manifest: { version: 1 as const, capabilities: ["filesystem.read" as const] },
  contentDigest: digest("a"),
  signature: { state: "verified" as const },
  trust: { state: "trusted" as const, reason: "verified-signature" as const },
  ...overrides,
})

describe("skill fleet comparison comparator unit", () => {
  it("compares supplied inventories deterministically", () => {
    const sources: SkillInventorySource[] = [
      { state: "available", inventory: { machine: machine("machine-b", "Beta"), skills: [skill({ contentDigest: digest("b") })] } },
      { state: "available", inventory: { machine: machine("machine-a", "Alpha"), skills: [skill()] } },
    ]

    const first = compareSkillInventories(sources)
    const second = compareSkillInventories([...sources].reverse())
    expect(first).toEqual(second)
    expect(first[0]?.machines.map(({ machineId, state }) => ({ machineId, state }))).toEqual([
      { machineId: "machine-a", state: "same" },
      { machineId: "machine-b", state: "different" },
    ])
  })

  it("marks capability drift even when content digests match", () => {
    const rows = compareSkillInventories([
      { state: "available", inventory: { machine: machine("machine-a", "Alpha"), skills: [skill()] } },
      { state: "available", inventory: { machine: machine("machine-b", "Beta"), skills: [skill({ manifest: { version: 1, capabilities: ["process.execute"] } })] } },
    ])

    expect(rows[0]?.machines.map(({ state }) => state)).toEqual(["same", "different"])
  })

  it("distinguishes missing from inventories that were never fetched", () => {
    const rows = compareSkillInventories([
      { state: "available", inventory: { machine: machine("machine-a", "Alpha"), skills: [skill()] } },
      { state: "available", inventory: { machine: machine("machine-b", "Beta"), skills: [] } },
      { state: "unknown", machine: machine("machine-c", "Gamma") },
      { state: "unreachable", machine: machine("machine-d", "Delta") },
    ])

    expect(rows[0]?.machines.map(({ state }) => state)).toEqual([
      "same",
      "missing",
      "unreachable",
      "unknown",
    ])
  })

  it("surfaces blocked and untrusted skills before digest equality", () => {
    const rows = compareSkillInventories([
      { state: "available", inventory: { machine: machine("machine-a", "Alpha"), skills: [skill()] } },
      { state: "available", inventory: { machine: machine("machine-b", "Beta"), skills: [skill({ trust: { state: "untrusted", reason: "unsigned" }, signature: { state: "unsigned" } })] } },
      { state: "available", inventory: { machine: machine("machine-c", "Gamma"), skills: [skill({ trust: { state: "blocked", reason: "invalid-signature" }, signature: { state: "invalid", reason: "verification-failed" } })] } },
    ])

    expect(rows[0]?.machines.map(({ state }) => state)).toEqual(["same", "untrusted", "blocked"])
  })
})
