import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { SkillInstallError, SkillSourceError } from "./skill-install.js"
import {
  generateSkillSigningKey,
  signSkillDigest,
  skillContentDigest,
  skillKeyId,
} from "./skill-signing.js"
import { FileSkillCatalog, type SkillRoot } from "./skills.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

const skillContent = [
  "---",
  "name: pr-triage",
  "description: Triage pull requests.",
  "domovoi:",
  "  manifest:",
  "    version: 1",
  "    capabilities:",
  "      - filesystem.read",
  "      - process.execute",
  "---",
  "",
  "# Instructions",
  "",
].join("\n")

type Scratch = {
  home: string
  project: string
  source: string
  roots: SkillRoot[]
  catalog: FileSkillCatalog
}

async function scratch(content = skillContent): Promise<Scratch> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "domovoi-skill-install-")))
  scratchDirectories.push(directory)
  const home = join(directory, "home")
  const project = join(directory, "project")
  const source = join(directory, "work", "pr-triage")
  await mkdir(join(source, "scripts"), { recursive: true })
  await writeFile(join(source, "SKILL.md"), content)
  await writeFile(join(source, "scripts", "triage.ts"), "export const triage = true\n")
  const roots: SkillRoot[] = [
    { path: join(home, ".domovoi", "skills"), scope: "user", source: "domovoi" },
    { path: join(home, ".agents", "skills"), scope: "user", source: "agents" },
    { path: join(project, ".domovoi", "skills"), scope: "project", source: "domovoi" },
  ]
  const catalog = new FileSkillCatalog(roots, undefined, {
    trustPath: join(home, ".domovoi", "skill-trusted-keys.json"),
  })
  return { home, project, source, roots, catalog }
}

function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

describe("skill install", () => {
  it("previews the declared capabilities, trust, digests, files, and targets", async () => {
    const { home, project, source, catalog } = await scratch()
    const { privateKey, publicKey } = generateSkillSigningKey()
    const contentDigest = skillContentDigest(skillContent)
    await writeFile(join(source, "SKILL.md.sig"), JSON.stringify({
      version: 1,
      contentDigest,
      algorithm: "ed25519",
      keyId: skillKeyId(publicKey),
      value: signSkillDigest(contentDigest, privateKey),
    }))

    const preview = await catalog.installPreview({ kind: "path", path: source })

    expect(preview).toMatchObject({
      source: { kind: "path", path: source },
      name: "pr-triage",
      description: "Triage pull requests.",
      manifest: { version: 1, capabilities: ["filesystem.read", "process.execute"] },
      contentDigest: digestOf(skillContent),
      signature: { state: "unverified", keyId: skillKeyId(publicKey) },
      trust: { state: "untrusted", reason: "unverified-signature" },
      files: [
        { path: "SKILL.md", bytes: Buffer.byteLength(skillContent) },
        { path: "SKILL.md.sig", bytes: expect.any(Number) },
        { path: "scripts/triage.ts", bytes: 27 },
      ],
      targets: [
        { scope: "project", path: join(project, ".domovoi", "skills", "pr-triage"), state: "available" },
        { scope: "user", path: join(home, ".domovoi", "skills", "pr-triage"), state: "available" },
      ],
      refusals: [],
    })
    expect(preview.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(preview.sourceDigest).not.toBe(preview.contentDigest)
  })

  it("refuses an install whose source changed since the preview", async () => {
    const { home, source, catalog } = await scratch()
    const preview = await catalog.installPreview({ kind: "path", path: source })
    await writeFile(join(source, "scripts", "triage.ts"), "export const triage = false\n")

    await expect(catalog.install({
      source: { kind: "path", path: source },
      scope: "user",
      sourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({
      name: "SkillInstallError",
      refusal: { kind: "skill-install-refused", reason: "source-changed" },
    })

    await expect(stat(join(home, ".domovoi", "skills"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await catalog.list()).toEqual([])
  })

  it("refuses to install a blocked skill", async () => {
    const { source, catalog } = await scratch()
    await writeFile(join(source, "SKILL.md.sig"), "{}")

    const preview = await catalog.installPreview({ kind: "path", path: source })

    expect(preview.trust).toEqual({ state: "blocked", reason: "invalid-signature" })
    expect(preview.refusals).toEqual([{ kind: "skill-install-refused", reason: "blocked" }])
    await expect(catalog.install({
      source: { kind: "path", path: source },
      scope: "user",
      sourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({ refusal: { reason: "blocked" } })
    expect(await catalog.list()).toEqual([])
  })

  it("copies the files into the scope's root and lists the entry there", async () => {
    const { project, source, catalog } = await scratch()
    const preview = await catalog.installPreview({ kind: "path", path: source })

    const installed = await catalog.install({
      source: { kind: "path", path: source },
      scope: "project",
      sourceDigest: preview.sourceDigest,
    })

    const directory = join(project, ".domovoi", "skills", "pr-triage")
    expect(installed).toMatchObject({
      name: "pr-triage",
      scope: "project",
      source: "domovoi",
      path: join(directory, "SKILL.md"),
      contentDigest: preview.contentDigest,
      manifest: preview.manifest,
      trust: { state: "untrusted", reason: "unsigned" },
    })
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe(skillContent)
    expect(await readFile(join(directory, "scripts", "triage.ts"), "utf8")).toBe("export const triage = true\n")
    expect(await readdir(join(project, ".domovoi", "skills"))).toEqual(["pr-triage"])
    expect(await catalog.list()).toEqual([installed])
    expect((await catalog.read(installed.id)).content).toBe(skillContent)
    expect((await catalog.installPreview({ kind: "path", path: source })).targets).toContainEqual({
      scope: "project",
      path: directory,
      state: "installed",
    })
  })

  it("refuses a symlink that points outside the source", async () => {
    const { home, source, catalog } = await scratch()
    const outside = join(home, "secret.txt")
    await mkdir(home, { recursive: true })
    await writeFile(outside, "not part of the skill\n")
    await symlink(outside, join(source, "scripts", "escape"))

    const preview = await catalog.installPreview({ kind: "path", path: source })

    expect(preview.refusals).toEqual([{
      kind: "skill-install-refused",
      reason: "symlink-escapes-source",
      path: "scripts/escape",
    }])
    expect(preview.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/triage.ts"])
    await expect(catalog.install({
      source: { kind: "path", path: source },
      scope: "user",
      sourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({ refusal: { reason: "symlink-escapes-source", path: "scripts/escape" } })
    await expect(stat(join(home, ".domovoi", "skills"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses an existing name unless the installed files are identical", async () => {
    const { home, source, catalog } = await scratch()
    const preview = await catalog.installPreview({ kind: "path", path: source })
    const first = await catalog.install({
      source: { kind: "path", path: source },
      scope: "user",
      sourceDigest: preview.sourceDigest,
    })

    expect((await catalog.installPreview({ kind: "path", path: source })).targets).toContainEqual({
      scope: "user",
      path: join(home, ".domovoi", "skills", "pr-triage"),
      state: "installed",
    })
    await expect(catalog.install({
      source: { kind: "path", path: source },
      scope: "user",
      sourceDigest: preview.sourceDigest,
    })).resolves.toEqual(first)

    await writeFile(join(source, "scripts", "triage.ts"), "export const triage = 2\n")
    const changed = await catalog.installPreview({ kind: "path", path: source })
    expect(changed.targets).toContainEqual({
      scope: "user",
      path: join(home, ".domovoi", "skills", "pr-triage"),
      state: "conflict",
    })
    await expect(catalog.install({
      source: { kind: "path", path: source },
      scope: "user",
      sourceDigest: changed.sourceDigest,
    })).rejects.toMatchObject({
      refusal: { reason: "name-conflict", path: join(home, ".domovoi", "skills", "pr-triage") },
    })
    expect(await readFile(join(home, ".domovoi", "skills", "pr-triage", "scripts", "triage.ts"), "utf8"))
      .toBe("export const triage = true\n")
  })

  it("names a source that is not a skill and ignores staging directories", async () => {
    const { home, roots, catalog } = await scratch()
    const empty = join(home, "empty")
    await mkdir(empty, { recursive: true })

    await expect(catalog.installPreview({ kind: "path", path: empty }))
      .rejects.toBeInstanceOf(SkillSourceError)
    await expect(catalog.installPreview({ kind: "path", path: join(home, "missing") }))
      .rejects.toBeInstanceOf(SkillSourceError)

    const staging = join(roots[0]!.path, ".domovoi-install-abcdef", "pr-triage")
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, "SKILL.md"), skillContent)
    expect(await catalog.list()).toEqual([])
    expect(SkillInstallError.name).toBe("SkillInstallError")
  })
})
