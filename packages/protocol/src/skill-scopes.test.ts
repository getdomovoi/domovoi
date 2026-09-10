import { describe, expect, it } from "vitest"
import { compareSkillDeclaredScopes, skillCapabilityManifestsEqual, skillCapabilityManifestSchema, type SkillCapabilityScopeDeclaration } from "./skills.js"

const manifest = {
  version: 2,
  capabilities: ["network.connect", "process.execute"],
  scopes: [
    { capability: "network.connect", scope: { kind: "hosts", hosts: ["api.example.test"] } },
    { capability: "process.execute", scope: { kind: "commands", commands: [{ executable: "pnpm", args: ["test"] }] } },
  ],
}

describe("declared capability scopes", () => {
  it("retains complete v2 declarations without changing the capability id array", () => {
    expect(skillCapabilityManifestSchema.parse(manifest)).toEqual(manifest)
  })

  it("keeps legacy declarations unknown instead of manufacturing unrestricted scopes", () => {
    const legacy = { version: 1, capabilities: ["network.connect"] }
    expect(skillCapabilityManifestSchema.parse(legacy)).toEqual(legacy)
  })

  it.each([
    { capability: "filesystem.read", scope: { kind: "paths", paths: [{ root: "workspace", path: "src", recursive: true }] } },
    { capability: "filesystem.write", scope: { kind: "paths", paths: [{ root: "absolute", path: "/tmp/report.txt", recursive: false }] } },
    { capability: "secrets.read", scope: { kind: "names", names: ["SERVICE_TOKEN"] } },
    { capability: "preview.render", scope: { kind: "all" } },
  ])("retains $capability targets", (declaration) => {
    const value = { version: 2, capabilities: [declaration.capability], scopes: [declaration] }
    expect(skillCapabilityManifestSchema.parse(value)).toEqual(value)
  })

  it.each([
    { ...manifest, scopes: manifest.scopes.slice(0, 1) },
    { ...manifest, scopes: [...manifest.scopes, manifest.scopes[0]] },
    { ...manifest, scopes: [...manifest.scopes, { capability: "secrets.read", scope: { kind: "all" } }] },
    { version: 2, capabilities: ["network.connect"], scopes: [{ capability: "network.connect", scope: { kind: "commands", commands: [] } }] },
    { version: 1, capabilities: [], scopes: [] },
  ])("rejects incomplete, duplicate or incompatible scope records %#", (value) => {
    expect(skillCapabilityManifestSchema.safeParse(value).success).toBe(false)
  })

  it.each(["https://example.test", "example.test:80", "*.example.test", "UPPER.test", "bad..test", "-bad.test", "bad.test.", "[broken]", "a".repeat(64) + ".test"])("rejects noncanonical host %s", (host) => {
    expect(skillCapabilityManifestSchema.safeParse({ version: 2, capabilities: ["network.connect"], scopes: [
      { capability: "network.connect", scope: { kind: "hosts", hosts: [host] } },
    ] }).success).toBe(false)
  })

  it.each(["api.example.test", "127.0.0.1", "[::1]"])("accepts canonical host %s", (host) => {
    expect(skillCapabilityManifestSchema.safeParse({ version: 2, capabilities: ["network.connect"], scopes: [
      { capability: "network.connect", scope: { kind: "hosts", hosts: [host] } },
    ] }).success).toBe(true)
  })

  it.each([
    { root: "workspace", path: "../outside", recursive: true },
    { root: "workspace", path: "src//nested", recursive: true },
    { root: "workspace", path: "/absolute", recursive: false },
    { root: "workspace", path: "C:/absolute", recursive: false },
    { root: "workspace", path: "src\\nested", recursive: false },
    { root: "absolute", path: "relative", recursive: false },
    { root: "absolute", path: "/tmp/../outside", recursive: true },
    { root: "absolute", path: "c:/lowercase-drive", recursive: false },
  ])("rejects ambiguous path %#", (path) => {
    expect(skillCapabilityManifestSchema.safeParse({ version: 2, capabilities: ["filesystem.read"], scopes: [
      { capability: "filesystem.read", scope: { kind: "paths", paths: [path] } },
    ] }).success).toBe(false)
  })

  it("bounds the whole manifest even when every argument fits its individual limit", () => {
    expect(skillCapabilityManifestSchema.safeParse({ version: 2, capabilities: ["process.execute"], scopes: [
      { capability: "process.execute", scope: { kind: "commands", commands: [{ executable: "cmd", args: Array.from({ length: 64 }, () => "x".repeat(2_048)) }] } },
    ] }).success).toBe(false)
  })

  it.each([
    { capability: "network.connect", scope: { kind: "hosts", hosts: ["example.test", "example.test"] } },
    { capability: "secrets.read", scope: { kind: "names", names: ["TOKEN", "TOKEN"] } },
    { capability: "filesystem.read", scope: { kind: "paths", paths: [{ root: "workspace", path: "src", recursive: true }, { root: "workspace", path: "src", recursive: true }] } },
    { capability: "process.execute", scope: { kind: "commands", commands: [{ executable: "cmd", args: [] }, { executable: "cmd", args: [] }] } },
    { capability: "process.execute", scope: { kind: "commands", commands: [{ executable: "cmd", args: [String.fromCharCode(0)] }] } },
    { capability: "secrets.read", scope: { kind: "names", names: ["bad\nname"] } },
  ])("rejects duplicate targets and invalid literal names %#", (declaration) => {
    expect(skillCapabilityManifestSchema.safeParse({ version: 2, capabilities: [declaration.capability], scopes: [declaration] }).success).toBe(false)
  })
})

const scoped = (...scopes: SkillCapabilityScopeDeclaration[]) => skillCapabilityManifestSchema.parse({ version: 2, capabilities: scopes.map((entry) => entry.capability), scopes })
const hosts = (...names: string[]): SkillCapabilityScopeDeclaration => ({ capability: "network.connect", scope: { kind: "hosts", hosts: names } })

describe("declared scope comparisons", () => {
  it("never treats a missing or legacy baseline as unchanged", () => {
    const current = scoped(hosts("api.example.test"))
    expect(compareSkillDeclaredScopes(undefined, current)).toEqual({ state: "unknown", reason: "baseline" })
    expect(compareSkillDeclaredScopes({ version: 1, capabilities: ["network.connect"] }, current)).toEqual({ state: "unknown", reason: "baseline" })
    expect(compareSkillDeclaredScopes(current, { version: 1, capabilities: ["network.connect"] })).toEqual({ state: "unknown", reason: "current" })
    expect(compareSkillDeclaredScopes(scoped(), scoped())).toEqual({ state: "known", changes: [] })
  })

  it("reports widening, narrowing and replacement without cancelling gains against losses", () => {
    const one = scoped(hosts("a.test"))
    const two = scoped(hosts("a.test", "b.test"))
    expect(compareSkillDeclaredScopes(one, two)).toMatchObject({ state: "known", changes: [{ change: "widened", gained: true, lost: false }] })
    expect(compareSkillDeclaredScopes(two, one)).toMatchObject({ state: "known", changes: [{ change: "narrowed", gained: false, lost: true }] })
    expect(compareSkillDeclaredScopes(one, scoped(hosts("b.test")))).toMatchObject({ state: "known", changes: [{ change: "changed", gained: true, lost: true }] })
    expect(compareSkillDeclaredScopes(two, scoped(hosts("b.test", "a.test")))).toEqual({ state: "known", changes: [] })
  })

  it("distinguishes exact named targets from all targets", () => {
    const named = scoped(hosts("api.example.test"))
    const all = scoped({ capability: "network.connect", scope: { kind: "all" } })
    expect(compareSkillDeclaredScopes(named, all)).toMatchObject({ changes: [{ change: "widened" }] })
    expect(compareSkillDeclaredScopes(all, named)).toMatchObject({ changes: [{ change: "narrowed" }] })
    expect(compareSkillDeclaredScopes(all, all)).toEqual({ state: "known", changes: [] })
    expect(compareSkillDeclaredScopes(scoped(), all)).toEqual({ state: "known", changes: [] })
  })

  it("uses exact argv order and secret names", () => {
    const before = scoped({ capability: "process.execute", scope: { kind: "commands", commands: [{ executable: "tool", args: ["one", "two"] }] } })
    const after = scoped({ capability: "process.execute", scope: { kind: "commands", commands: [{ executable: "tool", args: ["two", "one"] }] } })
    expect(skillCapabilityManifestsEqual(before, before)).toBe(true)
    expect(compareSkillDeclaredScopes(before, after)).toMatchObject({ changes: [{ gained: true, lost: true }] })
    expect(compareSkillDeclaredScopes(
      scoped({ capability: "secrets.read", scope: { kind: "names", names: ["A"] } }),
      scoped({ capability: "secrets.read", scope: { kind: "names", names: ["A", "B"] } }),
    )).toMatchObject({ changes: [{ change: "widened" }] })
  })

  it.each([
    ["workspace", "src/file.ts", false, "src", true, "widened"],
    ["workspace", "src", false, "src", true, "widened"],
    ["workspace", "src", true, "src-other", true, "changed"],
    ["workspace", "src", true, ".", true, "widened"],
    ["workspace", ".", false, "src", true, "changed"],
    ["absolute", "/tmp/out", true, "/", true, "widened"],
    ["absolute", "C:/out", true, "C:/", true, "widened"],
  ] as const)("compares path boundaries %#", (root, oldPath, oldRecursive, newPath, newRecursive, change) => {
    const path = (value: string, recursive: boolean) => scoped({ capability: "filesystem.read", scope: { kind: "paths", paths: [{ root, path: value, recursive }] } })
    expect(compareSkillDeclaredScopes(path(oldPath, oldRecursive), path(newPath, newRecursive))).toMatchObject({ changes: [{ change }] })
  })

  it("compares manifests independent of set ordering while preserving versions and scopes", () => {
    const network = hosts("api.test")
    const preview: SkillCapabilityScopeDeclaration = { capability: "preview.render", scope: { kind: "all" } }
    expect(skillCapabilityManifestsEqual(scoped(network, preview), scoped(preview, network))).toBe(true)
    expect(skillCapabilityManifestsEqual(scoped(network), scoped(hosts("other.test")))).toBe(false)
    expect(skillCapabilityManifestsEqual(scoped(network), scoped())).toBe(false)
    expect(skillCapabilityManifestsEqual({ version: 1, capabilities: ["network.connect"] }, scoped(network))).toBe(false)
    expect(skillCapabilityManifestsEqual({ version: 1, capabilities: ["network.connect", "preview.render"] }, { version: 1, capabilities: ["preview.render", "network.connect"] })).toBe(true)
  })
})
