import { createHash, randomBytes } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

import {
  maximumSkillInstallFiles,
  skillInstallPreviewSchema,
  type SkillInstallPreview,
  type SkillInstallRefusal,
  type SkillInstallScope,
  type SkillInstallSource,
  type SkillInstallTarget,
} from "@getdomovoi/protocol"

import { skillContentDigest, type TrustedSkillKeys } from "./skill-signing.js"
import {
  escapesRoot,
  maxSkillFileBytes,
  skillFromContent,
  skillId,
  skillInstallStagingPrefix,
  skillSignatureMetadata,
} from "./skills.js"

export const maximumSkillInstallBytes = 8 * 1_024 * 1_024
export const maximumSkillInstallDepth = 8

export type SkillInstallRoot = { scope: SkillInstallScope; path: string }

export type SkillInstallParams = {
  source: SkillInstallSource
  scope: SkillInstallScope
  sourceDigest: string
}

export class SkillSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SkillSourceError"
  }
}

export class SkillInstallError extends Error {
  readonly refusal: SkillInstallRefusal

  constructor(refusal: SkillInstallRefusal, message: string) {
    super(message)
    this.name = "SkillInstallError"
    this.refusal = refusal
  }
}

type SourceFile = { path: string; absolutePath: string; bytes: number }

type SourceListing = {
  root: string
  files: SourceFile[]
  refusals: SkillInstallRefusal[]
}

function refusalMessage(refusal: SkillInstallRefusal): string {
  switch (refusal.reason) {
    case "source-changed":
      return "Skill source changed since it was reviewed; review it again"
    case "blocked":
      return "Blocked skills cannot be installed"
    case "name-conflict":
      return `A different skill already occupies ${refusal.path ?? "the target directory"}`
    case "symlink-escapes-source":
      return `${refusal.path ?? "A link"} points outside the skill source`
    case "source-too-large":
      return `Skill source exceeds ${maximumSkillInstallFiles} files, ${maximumSkillInstallBytes} bytes, or ${maximumSkillInstallDepth} directory levels`
  }
}

function refuse(refusal: Omit<SkillInstallRefusal, "kind">): SkillInstallError {
  const full: SkillInstallRefusal = { kind: "skill-install-refused", ...refusal }
  return new SkillInstallError(full, refusalMessage(full))
}

function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/")
}

function byPath(left: { path?: string | undefined }, right: { path?: string | undefined }): number {
  const [l, r] = [left.path ?? "", right.path ?? ""]
  return l < r ? -1 : l > r ? 1 : 0
}

async function listSource(sourcePath: string): Promise<SourceListing> {
  let root: string
  try {
    root = await realpath(sourcePath)
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new SkillSourceError(`Skill source is not a readable directory: ${sourcePath}`)
  }
  const files: SourceFile[] = []
  const refusals: SkillInstallRefusal[] = []
  const visited = new Set<string>()
  let tooLarge = false
  let totalBytes = 0
  const addFile = (path: string, absolutePath: string, bytes: number) => {
    totalBytes += bytes
    if (files.length >= maximumSkillInstallFiles || totalBytes > maximumSkillInstallBytes) {
      tooLarge = true
      return
    }
    files.push({ path, absolutePath, bytes })
  }
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maximumSkillInstallDepth) {
      tooLarge = true
      return
    }
    const canonical = await realpath(directory)
    if (visited.has(canonical)) return
    visited.add(canonical)
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const path = relativePosix(root, absolutePath)
      if (entry.isSymbolicLink()) {
        let target: string
        try {
          target = await realpath(absolutePath)
        } catch {
          refusals.push({ kind: "skill-install-refused", reason: "symlink-escapes-source", path })
          continue
        }
        if (escapesRoot(root, target)) {
          refusals.push({ kind: "skill-install-refused", reason: "symlink-escapes-source", path })
          continue
        }
        const resolved = await stat(target)
        if (resolved.isFile()) addFile(path, target, resolved.size)
        else if (resolved.isDirectory()) await visit(absolutePath, depth + 1)
        continue
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1)
        continue
      }
      if (entry.isFile()) addFile(path, absolutePath, (await stat(absolutePath)).size)
    }
  }
  await visit(root, 0)
  files.sort(byPath)
  refusals.sort(byPath)
  if (tooLarge) refusals.push({ kind: "skill-install-refused", reason: "source-too-large" })
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new SkillSourceError(`Skill source has no SKILL.md: ${sourcePath}`)
  }
  return { root, files, refusals }
}

function treeDigest(entries: ReadonlyArray<{ path: string; digest: string }>): string {
  const manifest = [...entries]
    .sort(byPath)
    .map((entry) => `${entry.path}\0${entry.digest}\n`)
    .join("")
  return `sha256:${createHash("sha256").update(manifest).digest("hex")}`
}

function fileDigest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

async function sourceDigestOf(files: readonly SourceFile[]): Promise<string> {
  const entries = await Promise.all(files.map(async (file) => ({
    path: file.path,
    digest: fileDigest(await readFile(file.absolutePath)),
  })))
  return treeDigest(entries)
}

async function targetState(
  directory: string,
  sourceDigest: string,
): Promise<SkillInstallTarget["state"]> {
  try {
    await lstat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "available"
    return "conflict"
  }
  try {
    const listing = await listSource(directory)
    if (listing.refusals.length > 0) return "conflict"
    return (await sourceDigestOf(listing.files)) === sourceDigest ? "installed" : "conflict"
  } catch {
    return "conflict"
  }
}

export async function previewSkillInstall(
  source: SkillInstallSource,
  roots: readonly SkillInstallRoot[],
  trust: TrustedSkillKeys,
): Promise<SkillInstallPreview> {
  const listing = await listSource(source.path)
  const skillFile = listing.files.find((file) => file.path === "SKILL.md")!
  if (skillFile.bytes > maxSkillFileBytes) {
    throw new SkillSourceError(`SKILL.md is larger than ${maxSkillFileBytes} bytes: ${source.path}`)
  }
  const content = await readFile(skillFile.absolutePath, "utf8")
  const contentDigest = skillContentDigest(content)
  const skill = skillFromContent(content, {
    id: skillId(listing.root),
    path: skillFile.absolutePath,
    scope: "user",
    source: "domovoi",
  }, contentDigest, await skillSignatureMetadata(skillFile.absolutePath, contentDigest, trust))
  if (!skill) {
    throw new SkillSourceError(`SKILL.md does not declare a valid skill: ${source.path}`)
  }
  const sourceDigest = await sourceDigestOf(listing.files)
  const targets = await Promise.all(roots.map(async (root) => {
    const path = join(root.path, skill.name)
    return { scope: root.scope, path, state: await targetState(path, sourceDigest) }
  }))
  const refusals = skill.trust.state === "blocked"
    ? [...listing.refusals, { kind: "skill-install-refused" as const, reason: "blocked" as const }]
    : listing.refusals
  return skillInstallPreviewSchema.parse({
    source,
    name: skill.name,
    description: skill.description,
    manifest: skill.manifest,
    contentDigest,
    sourceDigest,
    signature: skill.signature,
    trust: skill.trust,
    files: listing.files.map((file) => ({ path: file.path, bytes: file.bytes })),
    targets,
    refusals,
  })
}

async function copyIntoStaging(files: readonly SourceFile[], staging: string): Promise<string> {
  const entries: Array<{ path: string; digest: string }> = []
  for (const file of files) {
    if ((await lstat(file.absolutePath)).isSymbolicLink()) {
      throw refuse({ reason: "source-changed" })
    }
    const content = await readFile(file.absolutePath)
    const destination = join(staging, ...file.path.split("/"))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, { flag: "wx" })
    entries.push({ path: file.path, digest: fileDigest(content) })
  }
  return treeDigest(entries)
}

export async function installSkill(
  params: SkillInstallParams,
  roots: readonly SkillInstallRoot[],
  trust: TrustedSkillKeys,
): Promise<{ path: string }> {
  const root = roots.find((candidate) => candidate.scope === params.scope)
  if (!root) throw new SkillSourceError(`No ${params.scope} skill directory is available`)
  const preview = await previewSkillInstall(params.source, [root], trust)
  if (preview.sourceDigest !== params.sourceDigest) throw refuse({ reason: "source-changed" })
  const refusal = preview.refusals[0]
  if (refusal) throw new SkillInstallError(refusal, refusalMessage(refusal))
  const target = preview.targets[0]!
  if (target.state === "installed") return { path: join(target.path, "SKILL.md") }
  if (target.state === "conflict") throw refuse({ reason: "name-conflict", path: target.path })

  const listing = await listSource(params.source.path)
  await mkdir(root.path, { recursive: true })
  const staging = join(root.path, `${skillInstallStagingPrefix}${randomBytes(6).toString("hex")}`)
  await mkdir(staging)
  try {
    const copiedDigest = await copyIntoStaging(listing.files, staging)
    if (copiedDigest !== params.sourceDigest) throw refuse({ reason: "source-changed" })
    try {
      await rename(staging, target.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") {
        throw refuse({ reason: "name-conflict", path: target.path })
      }
      throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { path: join(target.path, "SKILL.md") }
}
