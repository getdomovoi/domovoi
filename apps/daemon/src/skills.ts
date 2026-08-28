import { createHash } from "node:crypto"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { parse } from "yaml"

import {
  skillSummarySchema,
  type SkillScope,
  type SkillSource,
  type SkillSummary,
} from "@getdomovoi/protocol"

const maxSkillFileBytes = 128 * 1_024
const maxSkillDepth = 4
const maxSkills = 512

export type SkillRoot = {
  path: string
  scope: SkillScope
  source: SkillSource
}

export interface SkillCatalog {
  list(): Promise<SkillSummary[]>
}

export class FileSkillCatalog implements SkillCatalog {
  readonly #roots: readonly SkillRoot[]

  constructor(roots: readonly SkillRoot[]) {
    this.#roots = roots
  }

  async list(): Promise<SkillSummary[]> {
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
        const skill = await readSkill(path, root)
        if (skill) skills.push(skill)
      }
    }
    return skills.sort((left, right) =>
      left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    )
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

async function readSkill(path: string, root: SkillRoot): Promise<SkillSummary | undefined> {
  try {
    const file = await stat(path)
    if (!file.isFile() || file.size > maxSkillFileBytes) return undefined
    const content = await readFile(path, "utf8")
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    if (!frontmatter) return undefined
    const metadata = parse(frontmatter, { maxAliasCount: 0 }) as unknown
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
    const record = metadata as Record<string, unknown>
    const canonicalPath = await realpath(path)
    const canonicalRoot = await realpath(root.path)
    if (root.scope !== "user" && escapesRoot(canonicalRoot, canonicalPath)) {
      return undefined
    }
    const candidate = {
      id: `skill-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12)}`,
      name: record.name,
      description: record.description,
      path: resolve(path),
      scope: root.scope,
      source: root.source,
    }
    const parsed = skillSummarySchema.safeParse(candidate)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function escapesRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
}
