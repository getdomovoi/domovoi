import { createHash } from "node:crypto"
import { removeScratchDirectories } from "./test-scratch.js"
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FileSkillCatalog, skillRoots } from "./skills.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

async function skill(root: string, directory: string, frontmatter: string): Promise<string> {
  const path = join(root, directory)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Instructions\n`)
  return path
}

function directoryLinkType(platform: NodeJS.Platform): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir"
}

describe("FileSkillCatalog", () => {
  it.each([
    ["win32", "junction"],
    ["linux", "dir"],
    ["darwin", "dir"],
  ] as const)("uses %s-compatible directory links", (platform, expected) => {
    expect(directoryLinkType(platform)).toBe(expected)
  })

  it("binds declared capabilities and conservative trust state to the skill content", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-manifest-"))
    scratchDirectories.push(scratch)
    const root = join(scratch, "skills")
    const content = [
      "---",
      "name: artifact-review",
      "description: Review generated artifacts.",
      "domovoi:",
      "  manifest:",
      "    version: 1",
      "    capabilities:",
      "      - filesystem.read",
      "      - preview.render",
      "---",
      "",
      "# Instructions",
      "",
    ].join("\n")
    const directory = join(root, "artifact-review")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "SKILL.md"), content)
    const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`
    await writeFile(join(directory, "SKILL.md.sig"), JSON.stringify({
      version: 1,
      contentDigest,
      algorithm: "ed25519",
      keyId: "publisher:test-key",
      value: "ZGVjbGFyZWQtc2lnbmF0dXJl",
    }))

    const catalog = new FileSkillCatalog([
      { path: root, scope: "user", source: "domovoi" },
    ])

    const [discovered] = await catalog.list()
    expect(discovered).toMatchObject({
      manifest: {
        version: 1,
        capabilities: ["filesystem.read", "preview.render"],
      },
      contentDigest,
      signature: {
        state: "unverified",
        algorithm: "ed25519",
        keyId: "publisher:test-key",
      },
      trust: { state: "untrusted", reason: "unverified-signature" },
    })
    expect(discovered?.signature).not.toHaveProperty("state", "verified")
  })

  it("defaults undeclared skills to no capabilities and unsigned untrusted state", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-unsigned-"))
    scratchDirectories.push(scratch)
    const root = join(scratch, "skills")
    await skill(root, "plain", "name: plain\ndescription: Plain instructions.")

    const [discovered] = await new FileSkillCatalog([
      { path: root, scope: "user", source: "domovoi" },
    ]).list()

    expect(discovered).toMatchObject({
      manifest: { version: 1, capabilities: [] },
      contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      signature: { state: "unsigned" },
      trust: { state: "untrusted", reason: "unsigned" },
    })
  })

  it("does not discover malformed or unknown capability manifests", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-capabilities-"))
    scratchDirectories.push(scratch)
    const root = join(scratch, "skills")
    await skill(root, "unknown", [
      "name: unknown",
      "description: Unknown privilege.",
      "domovoi:",
      "  manifest:",
      "    version: 1",
      "    capabilities: [machine.takeover]",
    ].join("\n"))
    await skill(root, "duplicate", [
      "name: duplicate",
      "description: Duplicate privilege.",
      "domovoi:",
      "  manifest:",
      "    version: 1",
      "    capabilities: [filesystem.read, filesystem.read]",
    ].join("\n"))

    await expect(new FileSkillCatalog([
      { path: root, scope: "user", source: "domovoi" },
    ]).list()).resolves.toEqual([])
  })

  it("surfaces malformed signature declarations as blocked instead of trusting or hiding them", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-signature-"))
    scratchDirectories.push(scratch)
    const root = join(scratch, "skills")
    const directory = await skill(
      root,
      "bad-signature",
      "name: bad-signature\ndescription: Malformed publisher evidence.",
    )
    await writeFile(join(directory, "SKILL.md.sig"), JSON.stringify({
      version: 1,
      contentDigest: `sha256:${"a".repeat(64)}`,
      algorithm: "ed25519",
      keyId: "publisher:test-key",
      value: "not_base64!",
    }))

    const [discovered] = await new FileSkillCatalog([
      { path: root, scope: "user", source: "domovoi" },
    ]).list()

    expect(discovered).toMatchObject({
      signature: { state: "invalid", reason: "malformed" },
      trust: { state: "blocked", reason: "invalid-signature" },
    })
  })

  it("recomputes document metadata so its digest always matches returned content", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-digest-"))
    scratchDirectories.push(scratch)
    const root = join(scratch, "skills")
    const directory = await skill(root, "mutable", "name: mutable\ndescription: Initial instructions.")
    const catalog = new FileSkillCatalog([
      { path: root, scope: "user", source: "domovoi" },
    ])
    const [listed] = await catalog.list()
    const changed = "---\nname: mutable\ndescription: Changed instructions.\n---\n\n# Changed\n"
    await writeFile(join(directory, "SKILL.md"), changed)

    const document = await catalog.read(listed!.id)
    expect(document.content).toBe(changed)
    expect(document.skill.contentDigest).toBe(
      `sha256:${createHash("sha256").update(changed).digest("hex")}`,
    )
    expect(document.skill.description).toBe("Changed instructions.")
  })

  it("discovers valid metadata with stable source provenance", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-"))
    scratchDirectories.push(scratch)
    const userRoot = join(scratch, "home", ".agents", "skills")
    const projectRoot = join(scratch, "repo", ".kilo", "skills")
    await skill(userRoot, "repo-audit", [
      "name: repo-audit",
      "description: >-",
      "  Audit a repository and render a ranked report.",
    ].join("\n"))
    await skill(projectRoot, "release-notes", [
      "name: release-notes",
      "description: Build release notes from merged changes.",
    ].join("\n"))

    const catalog = new FileSkillCatalog([
      { path: userRoot, scope: "user", source: "agents" },
      { path: userRoot, scope: "user", source: "agents" },
      { path: projectRoot, scope: "project", source: "kilo" },
    ])

    const discovered = await catalog.list()
    expect(discovered).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^skill-[a-f0-9]{12}$/),
        name: "release-notes",
        description: "Build release notes from merged changes.",
        scope: "project",
        source: "kilo",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^skill-[a-f0-9]{12}$/),
        name: "repo-audit",
        description: "Audit a repository and render a ranked report.",
        scope: "user",
        source: "agents",
      }),
    ])
    const repoAudit = discovered.find((entry) => entry.name === "repo-audit")!
    await expect(catalog.read(repoAudit.id)).resolves.toMatchObject({
      skill: repoAudit,
      content: expect.stringContaining("# Instructions"),
    })
    await expect(catalog.read("skill-000000000000")).rejects.toThrow("Skill not found")
  })

  it("skips malformed and oversized skill files without failing discovery", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-invalid-"))
    scratchDirectories.push(scratch)
    const root = join(scratch, "skills")
    await skill(root, "missing-description", "name: missing-description")
    await skill(root, "invalid-name", "name: Invalid Name\ndescription: Invalid name")
    await skill(root, "oversized", `name: oversized\ndescription: ${"x".repeat(140_000)}`)

    await expect(new FileSkillCatalog([
      { path: root, scope: "user", source: "domovoi" },
    ]).list()).resolves.toEqual([])
  })

  it("follows user links but not project links outside their root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-links-"))
    scratchDirectories.push(scratch)
    const shared = join(scratch, "shared")
    const userRoot = join(scratch, "user-skills")
    const projectRoot = join(scratch, "project-skills")
    await skill(shared, "plan-preview", "name: plan-preview\ndescription: Render plans as HTML.")
    await mkdir(userRoot, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    const linkType = directoryLinkType(process.platform)
    await symlink(join(shared, "plan-preview"), join(userRoot, "plan-preview"), linkType)
    await symlink(join(shared, "plan-preview"), join(userRoot, "plan-preview-alias"), linkType)
    await symlink(join(shared, "plan-preview"), join(projectRoot, "plan-preview"), linkType)

    const skills = await new FileSkillCatalog([
      { path: userRoot, scope: "user", source: "agents" },
      { path: projectRoot, scope: "project", source: "agents" },
    ]).list()

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: "plan-preview", scope: "user" })
    expect(skills[0]!.path).toBe(join(await realpath(userRoot), "plan-preview", "SKILL.md"))
  })
})

describe("skillRoots", () => {
  it("covers shared and provider skill directories without deciding trust", () => {
    const home = resolve(sep, "home", "dev")
    const project = resolve(sep, "repo")
    expect(skillRoots(home, project)).toEqual(expect.arrayContaining([
      { path: join(home, ".domovoi", "skills"), scope: "user", source: "domovoi" },
      { path: join(home, ".agents", "skills"), scope: "user", source: "agents" },
      { path: join(home, ".claude", "skills"), scope: "user", source: "claude" },
      { path: join(home, ".codex", "skills"), scope: "user", source: "codex" },
      { path: join(home, ".kilo", "skills"), scope: "user", source: "kilo" },
      { path: join(project, ".agents", "skills"), scope: "project", source: "agents" },
      { path: join(project, ".kilo", "skills"), scope: "project", source: "kilo" },
    ]))
  })
})
