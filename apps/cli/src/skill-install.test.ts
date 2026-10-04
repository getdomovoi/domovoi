import { describe, expect, it } from "vitest"

import { installSkill, previewSkill, renderInstalled, renderPreview, SkillInstallError } from "./skill-install.js"

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

// A newline, an escape sequence and a right-to-left override, built from code
// points so the source shows which invisible character each is.
const hostile = `\nX\u001b[31mY${String.fromCodePoint(0x202e)}Z`
const shown = "\\nX\\e[31mY\\u{202e}Z"

describe("skill install, with daemon text that carries control characters", () => {
  it("shows each one escaped in the preview, one fact per line", () => {
    const text = renderPreview(preview({
      description: `Triage${hostile}`,
      targets: [{ scope: "user", path: `/home/u/skills${hostile}`, state: "available" }],
      refusals: [{ kind: "skill-install-refused", reason: "symlink-escapes-source", path: `link${hostile}` }],
    }) as never, "user")
    expect(text.split("\n")).toEqual([
      `skill      pr-triage: Triage${shown}`,
      "files      1 (120 bytes)",
      `content    ${digest}`,
      `source     ${digest}`,
      "signature  unsigned",
      "trust      untrusted",
      `target     user: /home/u/skills${shown} (available)`,
      `refused    symlink-escapes-source link${shown}`,
      "",
    ])
  })

  it("names the installed skill and its path escaped, and leaves any script unchanged", () => {
    const summary = { name: `pr-triage${hostile}`, path: `/home/u/skills${hostile}`, scope: "user" as const }
    expect(renderInstalled(summary)).toBe(`installed pr-triage${shown} at /home/u/skills${shown} (user); enable it on the daemon when you have read it\n`)
    expect(renderInstalled({ name: "pr-triage", path: "/home/דנה/skills/café", scope: "project" }))
      .toBe("installed pr-triage at /home/דנה/skills/café (project); enable it on the daemon when you have read it\n")
  })
})
