import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FileSkillCatalog, skillRoots } from "./skills.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function skill(root: string, directory: string, frontmatter: string): Promise<string> {
  const path = join(root, directory)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Instructions\n`)
  return path
}

describe("FileSkillCatalog", () => {
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

    await expect(catalog.list()).resolves.toEqual([
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

  it.skipIf(process.platform === "win32")("follows user links but not project links outside their root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-skills-links-"))
    scratchDirectories.push(scratch)
    const shared = join(scratch, "shared")
    const userRoot = join(scratch, "user-skills")
    const projectRoot = join(scratch, "project-skills")
    await skill(shared, "plan-preview", "name: plan-preview\ndescription: Render plans as HTML.")
    await mkdir(userRoot, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await symlink(join(shared, "plan-preview"), join(userRoot, "plan-preview"), "dir")
    await symlink(join(shared, "plan-preview"), join(userRoot, "plan-preview-alias"), "dir")
    await symlink(join(shared, "plan-preview"), join(projectRoot, "plan-preview"), "dir")

    const skills = await new FileSkillCatalog([
      { path: userRoot, scope: "user", source: "agents" },
      { path: projectRoot, scope: "project", source: "agents" },
    ]).list()

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: "plan-preview", scope: "user" })
    expect(skills[0]!.path).toBe(join(userRoot, "plan-preview", "SKILL.md"))
  })
})

describe("skillRoots", () => {
  it("covers shared and provider skill directories without deciding trust", () => {
    expect(skillRoots("/home/dev", "/repo")).toEqual(expect.arrayContaining([
      { path: "/home/dev/.domovoi/skills", scope: "user", source: "domovoi" },
      { path: "/home/dev/.agents/skills", scope: "user", source: "agents" },
      { path: "/home/dev/.claude/skills", scope: "user", source: "claude" },
      { path: "/home/dev/.codex/skills", scope: "user", source: "codex" },
      { path: "/home/dev/.kilo/skills", scope: "user", source: "kilo" },
      { path: "/repo/.agents/skills", scope: "project", source: "agents" },
      { path: "/repo/.kilo/skills", scope: "project", source: "kilo" },
    ]))
  })
})
