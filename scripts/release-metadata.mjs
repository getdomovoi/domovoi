import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual, promisify } from "node:util"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { collectWorkspacePackages } from "./version-lockstep.mjs"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const changesetsCli = require.resolve("@changesets/cli/bin.js")
const documentationOrTest = /(?:\.md$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__snapshots__|test-fixtures|tests)\/)/u

// A version PR is recognized by its contents, never its branch name or actor.
// It may consume changesets and write versions/changelogs, not change source,
// dependencies, scripts or the dependency lock. Those still need new metadata.
async function isVersionOnly(files, packages, root, readBase, deadline) {
  const allowed = new Set(packages.flatMap(({ path }) => [path, `${dirname(path)}/CHANGELOG.md`]))
  if (files.some((file) => !allowed.has(file) && file !== ".changeset/pre.json" && !/^\.changeset\/(?:pre\/)?[^/]+\.md$/u.test(file))) return false
  let nextVersion
  for (const { path } of packages) {
    const beforeText = await readBase(path)
    if (beforeText === undefined) return false
    const before = JSON.parse(beforeText)
    const after = JSON.parse(await deadline.run(() => readFile(join(root, path), "utf8")))
    if (typeof after.version !== "string" || before.version === after.version) return false
    nextVersion ??= after.version
    if (nextVersion !== after.version) return false
    const previousVersion = before.version
    before.version = after.version
    if (!isDeepStrictEqual(before, after)) return false
    const changelogPath = `${dirname(path)}/CHANGELOG.md`
    if (!files.includes(changelogPath)) return false
    const changelog = await deadline.run(() => readFile(join(root, changelogPath), "utf8"))
    if (!changelog.includes(`\n## ${after.version}\n`) || previousVersion === nextVersion) return false
  }
  return packages.length > 0
}

export async function checkReleaseMetadata({ root = process.cwd(), base, timeoutMs = 60_000 }) {
  if (!/^[a-f0-9]{40}$/u.test(base ?? "")) throw new Error("Release metadata requires the full PR base commit SHA")
  const deadline = bootstrapDeadline(timeoutMs, `Release metadata check exceeded ${timeoutMs} ms`)
  const run = (command, args) => deadline.run(() => exec(command, args, {
    cwd: root, encoding: "utf8", signal: deadline.signal, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
  }))
  try {
    const { packages, failures } = await deadline.run(() => collectWorkspacePackages(root))
    if (failures.length) throw new Error(failures.join("; "))
    const diff = await run("git", ["diff", "--name-only", "-z", "--no-renames", base, "--"])
    const files = diff.stdout.split("\0").filter(Boolean)
    const impact = files.filter((file) => ["pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file)
      || packages.some(({ path }) => file.startsWith(`${dirname(path)}/`) && !documentationOrTest.test(file)))
    const added = (await run("git", ["diff", "--name-only", "-z", "--diff-filter=A", base, "--", ".changeset/"])).stdout.split("\0")
    const ownChangesets = added.filter((file) => /^\.changeset\/[^/]+\.md$/u.test(file) && file !== ".changeset/README.md")
    if (impact.length === 0 && ownChangesets.length === 0) return { state: "no-release-change", files }
    const readBase = async (path) => {
      const exists = await run("git", ["ls-tree", "--name-only", base, "--", path])
      return exists.stdout.trim() ? (await run("git", ["show", `${base}:${path}`])).stdout : undefined
    }
    if (await isVersionOnly(files, packages, root, readBase, deadline)) return { state: "version", files }
    try {
      if (ownChangesets.length === 0) throw new Error("No new changeset accompanies this PR")
      await run(process.execPath, [changesetsCli, "status", "--since", base])
    } catch (cause) {
      throw new Error("This PR needs release metadata: run pnpm changeset, or pnpm changeset --empty for an explicit no-release decision.\n"
        + (cause.stderr || cause.stdout || cause.message), { cause })
    }
    return { state: "changeset", files: impact }
  } finally { deadline.clear() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await checkReleaseMetadata({ base: process.env.RELEASE_BASE_SHA ?? process.argv[2] }), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
