import { describe, expect, it } from "vitest"

import { installSkill, previewSkill, renderPreview, SkillInstallError } from "./skill-install.js"

const digest = "sha256:" + "a".repeat(64)
const preview = (overrides: Record<string, unknown> = {}) => ({
  source: { kind: "path", path: "/skills/pr-triage" }, name: "pr-triage", description: "Triage pull requests",
  manifest: { version: 1, capabilities: [] }, contentDigest: digest, sourceDigest: digest,
  signature: { state: "unsigned" }, trust: { state: "untrusted", reason: "unsigned" },
  files: [{ path: "SKILL.md", bytes: 120 }], targets: [{ scope: "user", path: "/home/u/.domovoi/skills/pr-triage", state: "available" }], refusals: [],
  ...overrides,
})

describe("skill install", () => {
  it("previews from the path, then installs with the previewed digest", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === "skill.installPreview") return preview()
      return { id: `skill-${"b".repeat(12)}`, name: "pr-triage", description: "Triage pull requests", path: "/home/u/.domovoi/skills/pr-triage", scope: "user", source: "domovoi", manifest: { version: 1, capabilities: [] }, contentDigest: digest, signature: { state: "unsigned" }, trust: { state: "untrusted", reason: "unsigned" } }
    }
    const seen = await previewSkill({ call, path: "/skills/pr-triage" })
    expect(renderPreview(seen, "user")).toMatch(/^target {5}user: \/home\/u\/\.domovoi\/skills\/pr-triage \(available\)$/m)
    await installSkill({ call, path: "/skills/pr-triage", scope: "user", preview: seen })
    expect(calls.map((entry) => entry.method)).toEqual(["skill.installPreview", "skill.install"])
    expect(calls[1]!.params).toMatchObject({ scope: "user", sourceDigest: digest, source: { kind: "path", path: "/skills/pr-triage" } })
  })

  it("does not install what the preview refused, or into a conflicting target", async () => {
    const call = async () => { throw new Error("must not be called") }
    await expect(installSkill({ call, path: "/x", scope: "user", preview: preview({ refusals: [{ kind: "skill-install-refused", reason: "not-retained" }] }) as never }))
      .rejects.toBeInstanceOf(SkillInstallError)
    await expect(installSkill({ call, path: "/x", scope: "project", preview: preview() as never }))
      .rejects.toThrow(/no project target/)
    await expect(installSkill({ call, path: "/x", scope: "user", preview: preview({ targets: [{ scope: "user", path: "/p", state: "conflict" }] }) as never }))
      .rejects.toThrow(/already occupies/)
  })
})

describe("skill install, after peer review", () => {
  it("shows both digests with labels, and pins the source digest it showed", async () => {
    const content = "sha256:" + "a".repeat(64)
    const source = "sha256:" + "b".repeat(64)
    const seen = preview({ contentDigest: content, sourceDigest: source })
    const text = renderPreview(seen as never, "user")
    expect(text).toMatch(new RegExp(`^content    ${content}$`, "m"))
    expect(text).toMatch(new RegExp(`^source     ${source}$`, "m"))
    let pinned: unknown
    const call = async (method: string, params: Record<string, unknown>) => {
      if (method === "skill.install") pinned = params.sourceDigest
      return { id: `skill-${"b".repeat(12)}`, name: "pr-triage", description: "Triage pull requests", path: "/p", scope: "user", source: "domovoi", manifest: { version: 1, capabilities: [] }, contentDigest: content, signature: { state: "unsigned" }, trust: { state: "untrusted", reason: "unsigned" } }
    }
    await installSkill({ call, path: "/skills/pr-triage", scope: "user", preview: seen as never })
    expect(pinned).toBe(source)
  })
})
