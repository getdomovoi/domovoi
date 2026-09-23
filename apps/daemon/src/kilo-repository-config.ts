import { lstat } from "node:fs/promises"
import { join } from "node:path"

const kiloRepositoryConfigFiles = [".kilo/mcp.json", ".kilocode/mcp.json", ".kilocodemodes"] as const

export async function kiloRepositoryConfigNotice(
  provider: string,
  worktree: string,
): Promise<{ body: string; detail: string } | undefined> {
  if (provider !== "kilo") return undefined
  const present: string[] = []
  for (const file of kiloRepositoryConfigFiles) {
    try {
      await lstat(join(worktree, file))
      present.push(file)
    } catch {
      continue
    }
  }
  if (present.length === 0) return undefined
  return {
    body: "Kilo will run programs this repository lists, with no approval card.",
    detail: `This worktree has ${present.join(", ")}. Kilo 7.7.6 starts the tool servers in .kilo/mcp.json and .kilocode/mcp.json, and loads the agents in .kilocodemodes, even with project configuration switched off. Domovoi cannot hold these back, so for Kilo in this repository, repository code does not wait for your trust.`,
  }
}
