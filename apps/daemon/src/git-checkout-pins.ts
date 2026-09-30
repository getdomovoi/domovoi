import { execFile, spawn } from "node:child_process"
import { readFile } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

import { gitEnvironment, inertRepositoryConfig, trustedConfigScopes } from "./git-environment.js"
import { isStandardLfsFilterLine } from "./git-read-config.js"
import { classify, type GitFilterSetting } from "./repository-git-filters.js"

const execute = promisify(execFile)
const readBytes = promisify(readFile)

// What checking a new session worktree out runs with, so it runs no filter
// the scan before it did not approve. The scan and the checkout are separate
// Git processes, and another session's agent can write the shared config in
// between. So every filter driver the checkout's attributes can select is
// pinned, as command-line config that no repository file overrides, to the
// value the scan approved: the person's global or system value, the exact
// `git lfs install` line, or nothing. Attributes come from sources read here
// once: the commit's own .gitattributes files, which cannot change, and
// info/attributes, the person's attributes file and Git's system file as they
// are now. On Git 2.40 and later the checkout reads in-tree attributes from
// the commit (--attr-source), so a .gitattributes planted in the new worktree
// is not read. The Git LFS settings git-lfs would start a program for are
// pinned the same way where a name is known.
//
// Not closed here: info/attributes rewritten after this read to select a
// driver the config then defines; a process command added for a driver the
// person gave only clean or smudge (see below); a Git LFS custom transfer or
// extension named only after this read; and on Git older than 2.40, a
// .gitattributes planted in the new worktree.

export type CheckoutPins = { env: NodeJS.ProcessEnv; globalOptions: string[] }

const maximumAttributesBytes = 16 * 1024 * 1024
const filterOperations = ["clean", "smudge", "process"] as const

let gitVersion: Promise<[number, number] | undefined> | undefined

function installedGitVersion(): Promise<[number, number] | undefined> {
  gitVersion ??= execute("git", ["--version"], { env: gitEnvironment(), encoding: "utf8" }).then(({ stdout }) => {
    const match = /(\d+)\.(\d+)/u.exec(stdout)
    return match ? [Number(match[1]), Number(match[2])] as [number, number] : undefined
  }, () => undefined)
  return gitVersion
}

async function gitOutput(directory: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await execute("git", ["-C", directory, ...inertRepositoryConfig, ...args], {
    env: gitEnvironment(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}),
  })).stdout
}

async function readIfPresent(path: string): Promise<string> {
  try {
    const bytes = await readBytes(path)
    if (bytes.byteLength > maximumAttributesBytes) throw new Error("An attributes file is larger than Domovoi reads")
    return bytes.toString("utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return ""
    throw error
  }
}

// The contents of the commit's .gitattributes files, at every depth.
async function commitAttributes(directory: string, commit: string, signal?: AbortSignal): Promise<string[]> {
  const listing = await gitOutput(directory, ["ls-tree", "-r", "-z", "--full-tree", commit], signal)
  const objects: string[] = []
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab === -1) continue
    const [, type, object] = entry.slice(0, tab).split(" ")
    if (type === "blob" && basename(entry.slice(tab + 1)) === ".gitattributes" && object) objects.push(object)
  }
  if (objects.length === 0) return []
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", directory, ...inertRepositoryConfig, "cat-file", "--batch"], {
      env: gitEnvironment(), stdio: ["pipe", "pipe", "ignore"], ...(signal ? { signal } : {}),
    })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > maximumAttributesBytes) {
        child.kill()
        reject(new Error("The commit's attributes are larger than Domovoi reads"))
        return
      }
      chunks.push(chunk)
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file exited with ${code}`))
        return
      }
      // Each object is "<oid> blob <size>\n<content>\n".
      const output = Buffer.concat(chunks)
      const texts: string[] = []
      let at = 0
      while (at < output.byteLength) {
        const header = output.indexOf(0x0a, at)
        if (header === -1) break
        const fields = output.subarray(at, header).toString("utf8").split(" ")
        const length = Number(fields[2])
        if (fields[1] !== "blob" || !Number.isInteger(length)) {
          reject(new Error("git cat-file answered with something other than a blob"))
          return
        }
        texts.push(output.subarray(header + 1, header + 1 + length).toString("utf8"))
        at = header + 1 + length + 1
      }
      resolvePromise(texts)
    })
    child.stdin.end(`${objects.join("\n")}\n`)
  })
}

// The person's attributes file: core.attributesFile from their global or
// system config, else Git's default under XDG_CONFIG_HOME or ~/.config.
async function personAttributesPath(directory: string, signal?: AbortSignal): Promise<string> {
  let output = ""
  try {
    output = await gitOutput(directory, ["config", "--show-scope", "-z", "--get-all", "core.attributesfile"], signal)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error
  }
  const fields = output.split("\0")
  let configured: string | undefined
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (trustedConfigScopes.has(fields[index]!)) configured = fields[index + 1]!
  }
  const home = process.env.HOME || homedir()
  if (configured !== undefined && configured !== "") {
    if (configured === "~" || configured.startsWith("~/")) return join(home, configured.slice(1))
    return isAbsolute(configured) ? configured : resolve(directory, configured)
  }
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg ? xdg : join(home, ".config"), "git", "attributes")
}

export async function gitCheckoutPins(
  directory: string,
  commit: string,
  settings: readonly GitFilterSetting[],
  signal?: AbortSignal,
): Promise<CheckoutPins> {
  const env: NodeJS.ProcessEnv = {}
  const texts = await commitAttributes(directory, commit, signal)
  const infoAttributes = resolve(directory, (await gitOutput(directory, ["rev-parse", "--git-path", "info/attributes"], signal)).trim())
  texts.push(await readIfPresent(infoAttributes))
  const personAttributes = await personAttributesPath(directory, signal)
  texts.push(await readIfPresent(personAttributes))
  let systemAttributes: string | undefined
  try {
    systemAttributes = (await gitOutput(directory, ["var", "GIT_ATTR_SYSTEM"], signal)).trim()
  } catch {
    signal?.throwIfAborted()
    // Git without `git var GIT_ATTR_SYSTEM` (before 2.42): its system
    // attributes file is not read at all, so no name there goes unpinned.
    env.GIT_ATTR_NOSYSTEM = "1"
  }
  if (systemAttributes) texts.push(await readIfPresent(systemAttributes))

  // Any `filter=<name>` token, in a pattern line or a macro definition. A
  // pattern that happens to spell one only adds a pin.
  const names = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/(?:^|\s)filter=(\S+)/gu)) names.add(match[1]!)
  }

  const pins = new Map<string, string>()
  // The value the scan approved for a key: the last one Git reads from the
  // person's own config or an exact `git lfs install` line, else nothing.
  const approved = (key: string) => settings
    .filter((setting) => setting.key === key && (trustedConfigScopes.has(setting.scope) || isStandardLfsFilterLine(setting.key, setting.value)))
    .at(-1)?.value ?? ""
  for (const name of names) {
    const values = Object.fromEntries(filterOperations.map((operation) => [operation, approved(`filter.${name}.${operation}`)]))
    pins.set(`filter.${name}.clean`, values.clean!)
    pins.set(`filter.${name}.smudge`, values.smudge!)
    // Git prefers a process command to clean and smudge whenever one is set,
    // even an empty one, which then runs nothing at all. So a driver the
    // person gave clean or smudge but no process cannot have its process
    // pinned without switching the driver off; that key stays unpinned.
    if (values.process !== "" || (values.clean === "" && values.smudge === "")) pins.set(`filter.${name}.process`, values.process!)
  }
  pins.set("lfs.standalonetransferagent", approved("lfs.standalonetransferagent"))
  for (const setting of settings) {
    if (setting.key.startsWith("lfs.") && trustedConfigScopes.has(setting.scope) && classify(setting.key, setting.value)) {
      pins.set(setting.key, approved(setting.key))
    }
  }
  pins.set("core.attributesFile", personAttributes)

  let index = 0
  for (const [key, value] of pins) {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
    index += 1
  }
  env.GIT_CONFIG_COUNT = String(index)

  const version = await installedGitVersion()
  const attributeSource = version !== undefined && (version[0] > 2 || (version[0] === 2 && version[1] >= 40))
  return { env, globalOptions: attributeSource ? [`--attr-source=${commit}`] : [] }
}
