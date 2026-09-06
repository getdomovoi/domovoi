import { createHash } from "node:crypto"
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { parse } from "yaml"

import {
  skillCapabilityManifestSchema,
  skillDeclaredSignatureSchema,
  skillFrontmatterConfigSchema,
  skillSummarySchema,
  skillDocumentSchema,
  type SkillDocument,
  type SkillInstallPreview,
  type SkillInstallScope,
  type SkillInstallSource,
  type SkillScope,
  type SkillSignature,
  type SkillSource,
  type SkillSummary,
  type SkillTrust,
} from "@getdomovoi/protocol"

import {
  installSkill,
  previewSkillInstall,
  SkillSourceError,
  type SkillInstallParams,
  type SkillInstallRoot,
} from "./skill-install.js"
import type { SkillReviews } from "./skill-reviews.js"
import {
  loadTrustedSkillKeys,
  skillContentDigest,
  verifySkillSignature,
  type TrustedSkillKeys,
} from "./skill-signing.js"

export const maxSkillFileBytes = 128 * 1_024
const maxSignatureFileBytes = 4 * 1_024
const maxSkillDepth = 4
const maxSkills = 512
export const skillInstallStagingPrefix = ".domovoi-install-"

export type SkillRoot = {
  path: string
  scope: SkillScope
  source: SkillSource
}

export interface SkillCatalog {
  list(): Promise<SkillSummary[]>
  read(id: string): Promise<SkillDocument>
}

export class SkillNotFoundError extends Error {
  constructor() {
    super("Skill not found")
    this.name = "SkillNotFoundError"
  }
}

export function manualReviewAuthority(review: { reviewedBy: { client: string } }): string {
  return `manual review · ${review.reviewedBy.client}`
}

export function signatureAuthority(keyId: string): string {
  return `signature · ${keyId}`
}

export type SkillCatalogOptions = {
  trustPath?: string
  report?: (detail: string) => void
}

type SkillListing = {
  key: string
  trust: Promise<TrustedSkillKeys>
  skills: Promise<SkillSummary[]>
}

export class FileSkillCatalog implements SkillCatalog {
  readonly #roots: readonly SkillRoot[]
  readonly #reviews: Pick<SkillReviews, "find"> | undefined
  readonly #trustPath: string | undefined
  readonly #report: ((detail: string) => void) | undefined
  #listing: SkillListing | undefined

  constructor(
    roots: readonly SkillRoot[],
    reviews?: Pick<SkillReviews, "find">,
    options: SkillCatalogOptions = {},
  ) {
    this.#roots = roots
    this.#reviews = reviews
    this.#trustPath = options.trustPath
    this.#report = options.report
  }

  invalidate(): void {
    this.#listing = undefined
  }

  async list(): Promise<SkillSummary[]> {
    return (await this.#cachedListing()).skills
  }

  async installPreview(source: SkillInstallSource): Promise<SkillInstallPreview> {
    const listing = await this.#cachedListing()
    return previewSkillInstall(source, this.#installRoots(), await listing.trust)
  }

  async install(params: SkillInstallParams): Promise<SkillSummary> {
    const listing = await this.#cachedListing()
    const installed = await installSkill(params, this.#installRoots(), await listing.trust)
    this.invalidate()
    const canonicalPath = await realpath(installed.path)
    for (const skill of await this.list()) {
      if (skill.path === installed.path || skill.path === canonicalPath) return skill
    }
    throw new SkillSourceError(`Installed skill was not discovered at ${installed.path}`)
  }

  #installRoots(): SkillInstallRoot[] {
    const roots: SkillInstallRoot[] = []
    for (const root of this.#roots) {
      if (root.source !== "domovoi" || root.scope === "system") continue
      const scope: SkillInstallScope = root.scope
      roots.push({ scope, path: root.path })
    }
    return roots.sort((left, right) => left.scope.localeCompare(right.scope))
  }

  async read(id: string): Promise<SkillDocument> {
    const listing = await this.#cachedListing()
    const skill = (await listing.skills).find((candidate) => candidate.id === id)
    if (!skill) throw new SkillNotFoundError()
    let handle
    try {
      handle = await open(skill.path, "r")
      const canonicalPath = await realpath(skill.path)
      if (skillId(canonicalPath) !== id) throw new SkillNotFoundError()
      const file = await handle.stat()
      if (!file.isFile() || file.size > maxSkillFileBytes) throw new SkillNotFoundError()
      const content = await handle.readFile("utf8")
      const contentDigest = skillContentDigest(content)
      const currentSkill = skillFromContent(content, {
        id,
        path: skill.path,
        scope: skill.scope,
        source: skill.source,
      }, contentDigest, await skillSignatureMetadata(skill.path, contentDigest, await listing.trust))
      if (!currentSkill) throw new SkillNotFoundError()
      return skillDocumentSchema.parse({
        skill: this.#withManualReview(currentSkill),
        content,
      })
    } catch (error) {
      if (error instanceof SkillNotFoundError) throw error
      if (error && typeof error === "object" && "code" in error) throw new SkillNotFoundError()
      throw error
    } finally {
      await handle?.close()
    }
  }

  async #cachedListing(): Promise<SkillListing> {
    const key = await this.#listingKey()
    if (this.#listing?.key === key) return this.#listing
    const trust = this.#loadTrust()
    const entry = { key, trust, skills: this.#walk(trust) }
    this.#listing = entry
    entry.skills.catch(() => {
      if (this.#listing === entry) this.#listing = undefined
    })
    return entry
  }

  async #loadTrust(): Promise<TrustedSkillKeys> {
    const loadedAt = new Date().toISOString()
    if (!this.#trustPath) return { path: undefined, loadedAt, keys: new Map() }
    try {
      return await loadTrustedSkillKeys(this.#trustPath)
    } catch (error) {
      this.#report?.(error instanceof Error ? error.message : String(error))
      return { path: this.#trustPath, loadedAt, keys: new Map() }
    }
  }

  async #listingKey(): Promise<string> {
    const parts: string[] = []
    if (this.#trustPath) {
      try {
        const metadata = await stat(this.#trustPath, { bigint: true })
        parts.push(
          `${this.#trustPath}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.mode}`,
        )
      } catch {
        parts.push(`${this.#trustPath}:missing`)
      }
    }
    for (const root of this.#roots) {
      const rootPath = await canonicalDirectory(root.path)
      if (!rootPath) {
        parts.push(`${root.path}:missing`)
        continue
      }
      const files = await skillFiles(rootPath, root.scope)
      parts.push(`${root.path}:${rootPath}`)
      for (const path of files.sort()) {
        for (const candidate of [path, `${path}.sig`]) {
          try {
            const metadata = await stat(candidate, { bigint: true })
            parts.push(
              `${candidate}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`,
            )
          } catch {
            parts.push(`${candidate}:missing`)
          }
        }
      }
    }
    return parts.join("|")
  }

  async #walk(trust: Promise<TrustedSkillKeys>): Promise<SkillSummary[]> {
    const trustedKeys = await trust
    const skills: SkillSummary[] = []
    const seenFiles = new Set<string>()
    for (const root of this.#roots) {
      if (skills.length >= maxSkills) break
      const rootPath = await canonicalDirectory(root.path)
      if (!rootPath) continue
      const files = await skillFiles(rootPath, root.scope)
      for (const path of files) {
        if (skills.length >= maxSkills) break
        let canonicalPath
        try {
          canonicalPath = await realpath(path)
        } catch {
          continue
        }
        if (seenFiles.has(canonicalPath)) continue
        seenFiles.add(canonicalPath)
        const skill = await readSkill(path, root, trustedKeys)
        if (skill) skills.push(this.#withManualReview(skill))
      }
    }
    return skills.sort((left, right) =>
      left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    )
  }

  #withManualReview(skill: SkillSummary): SkillSummary {
    if (!this.#reviews || skill.trust.state !== "untrusted") return skill
    const review = this.#reviews.find(skill.id, skill.contentDigest)
    if (!review) return skill
    return {
      ...skill,
      trust: {
        state: "trusted",
        reason: "manual-review",
        authority: manualReviewAuthority(review),
      },
    }
  }
}

export function skillRoots(home: string, project?: string): SkillRoot[] {
  const roots: SkillRoot[] = [
    { path: join(home, ".domovoi", "skills"), scope: "user", source: "domovoi" },
    { path: join(home, ".agents", "skills"), scope: "user", source: "agents" },
    { path: join(home, ".kilo", "skills"), scope: "user", source: "kilo" },
    { path: join(home, ".claude", "skills"), scope: "user", source: "claude" },
    { path: join(home, ".codex", "skills"), scope: "user", source: "codex" },
    { path: resolve(sep, "etc", "domovoi", "skills"), scope: "system", source: "domovoi" },
  ]
  if (!project) return roots
  return roots.concat([
    { path: join(project, ".domovoi", "skills"), scope: "project", source: "domovoi" },
    { path: join(project, ".agents", "skills"), scope: "project", source: "agents" },
    { path: join(project, ".kilo", "skills"), scope: "project", source: "kilo" },
    { path: join(project, ".claude", "skills"), scope: "project", source: "claude" },
    { path: join(project, ".codex", "skills"), scope: "project", source: "codex" },
  ])
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path)
    return (await stat(canonical)).isDirectory() ? canonical : undefined
  } catch {
    return undefined
  }
}

async function skillFiles(root: string, scope: SkillScope): Promise<string[]> {
  const files: string[] = []
  const visitedDirectories = new Set<string>()
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxSkillDepth || files.length >= maxSkills) return
    let canonicalDirectoryPath
    try {
      canonicalDirectoryPath = await realpath(directory)
    } catch {
      return
    }
    if (visitedDirectories.has(canonicalDirectoryPath)) return
    visitedDirectories.add(canonicalDirectoryPath)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith(skillInstallStagingPrefix)) continue
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(path)
        continue
      }
      if (entry.isDirectory()) await visit(path, depth + 1)
      if (entry.isSymbolicLink()) {
        try {
          const canonicalTarget = await realpath(path)
          if (scope !== "user" && escapesRoot(root, canonicalTarget)) continue
          const target = await stat(path)
          if (target.isFile() && entry.name === "SKILL.md") files.push(path)
          if (target.isDirectory()) await visit(path, depth + 1)
        } catch {
          continue
        }
      }
      if (files.length >= maxSkills) return
    }
  }
  await visit(root, 0)
  return files
}

async function readSkill(
  path: string,
  root: SkillRoot,
  trust: TrustedSkillKeys,
): Promise<SkillSummary | undefined> {
  try {
    const file = await stat(path)
    if (!file.isFile() || file.size > maxSkillFileBytes) return undefined
    const content = await readFile(path, "utf8")
    const contentDigest = skillContentDigest(content)
    const canonicalPath = await realpath(path)
    const canonicalRoot = await realpath(root.path)
    if (root.scope !== "user" && escapesRoot(canonicalRoot, canonicalPath)) {
      return undefined
    }
    return skillFromContent(content, {
      id: skillId(canonicalPath),
      path: resolve(path),
      scope: root.scope,
      source: root.source,
    }, contentDigest, await skillSignatureMetadata(path, contentDigest, trust))
  } catch {
    return undefined
  }
}

type SkillIdentity = Pick<SkillSummary, "id" | "path" | "scope" | "source">

export function skillFromContent(
  content: string,
  identity: SkillIdentity,
  contentDigest: string,
  signatureMetadata: { signature: SkillSignature; trust: SkillTrust },
): SkillSummary | undefined {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!frontmatter) return undefined
  const metadata = parse(frontmatter, { maxAliasCount: 0 }) as unknown
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const record = metadata as Record<string, unknown>
  const config = skillFrontmatterConfigSchema.safeParse(record.domovoi ?? {})
  if (!config.success) return undefined
  const manifest = skillCapabilityManifestSchema.parse(
    config.data.manifest ?? { version: 1, capabilities: [] },
  )
  const parsed = skillSummarySchema.safeParse({
    ...identity,
    name: record.name,
    description: record.description,
    manifest,
    contentDigest,
    ...signatureMetadata,
  })
  return parsed.success ? parsed.data : undefined
}

export async function skillSignatureMetadata(
  skillPath: string,
  contentDigest: string,
  trust: TrustedSkillKeys,
): Promise<{ signature: SkillSignature; trust: SkillTrust }> {
  try {
    const signaturePath = `${skillPath}.sig`
    const link = await lstat(signaturePath)
    if (link.isSymbolicLink() || !link.isFile() || link.size > maxSignatureFileBytes) {
      return blockedSignature("malformed")
    }
    const declaration = skillDeclaredSignatureSchema.safeParse(
      JSON.parse(await readFile(signaturePath, "utf8")),
    )
    if (!declaration.success) return blockedSignature("malformed")
    if (declaration.data.contentDigest !== contentDigest) {
      return blockedSignature("verification-failed")
    }
    const { algorithm, keyId, value } = declaration.data
    const publicKey = trust.keys.get(keyId)
    if (!publicKey || trust.path === undefined) {
      return {
        signature: { state: "unverified", algorithm, keyId, value },
        trust: { state: "untrusted", reason: "unverified-signature" },
      }
    }
    if (!verifySkillSignature(contentDigest, value, publicKey)) {
      return blockedSignature("verification-failed")
    }
    return {
      signature: {
        state: "verified",
        algorithm,
        keyId,
        value,
        verifiedBy: trust.path,
        verifiedAt: trust.loadedAt,
      },
      trust: { state: "trusted", reason: "verified-signature", authority: signatureAuthority(keyId) },
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        signature: { state: "unsigned" },
        trust: { state: "untrusted", reason: "unsigned" },
      }
    }
    return blockedSignature("malformed")
  }
}

function blockedSignature(reason: "malformed" | "verification-failed"): {
  signature: SkillSignature
  trust: SkillTrust
} {
  return {
    signature: { state: "invalid", reason },
    trust: { state: "blocked", reason: "invalid-signature" },
  }
}

export function skillId(canonicalPath: string): string {
  return `skill-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12)}`
}

export function escapesRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
}
