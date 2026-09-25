import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const workflowDirectory = ".github/workflows"
const settingsFile = "packages/ui/src/settings-shell.tsx"

// Settings says the build is not signed and does not update itself (J10,
// ND6 2026-09-23). That line is true while the only signing build is a
// maintainer dispatch that publishes nothing. The day a workflow that
// requires signing runs on a push, tag, release or schedule, signed builds
// reach people and the line becomes a lie the app keeps telling. This fails
// then, so the copy changes with the fact rather than after it.
export const unsignedBuildLine = "This build is not signed and does not update itself. Get new versions from the release page."

const requiresSigning = /DOMOVOI_DESKTOP_REQUIRE_SIGNING:\s*['"]?true['"]?/
const automaticTriggers = ["push", "pull_request", "pull_request_target", "release", "schedule", "workflow_call", "workflow_run"]

export function workflowTriggers(content) {
  const lines = content.split(/\r?\n/)
  // YAML allows the key quoted; an unread key would pass the check silently.
  const onKey = /^(?:on|"on"|'on'):\s*(\S.*)?$/
  const start = lines.findIndex((line) => onKey.test(line))
  if (start === -1) return []
  const inline = /^(?:on|"on"|'on'):\s*(\S.*)$/.exec(lines[start])
  if (inline) {
    const value = inline[1].trim()
    if (value.startsWith("[")) return value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean)
    return [value]
  }
  const triggers = []
  let indent
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) break
    const key = /^(\s+)(\w[\w-]*):/.exec(line)
    indent ??= key?.[1]
    if (key && key[1] === indent) triggers.push(key[2])
  }
  return triggers
}

export function evaluateUnsignedBuild(files, settingsSource) {
  const failures = []
  const saysUnsigned = settingsSource.includes(unsignedBuildLine)
  for (const file of files) {
    if (!requiresSigning.test(file.content)) continue
    const automatic = workflowTriggers(file.content).filter((trigger) => automaticTriggers.includes(trigger))
    if (automatic.length && saysUnsigned) {
      failures.push(`${file.path}: requires signing on ${automatic.join(", ")}, but ${settingsFile} still says "${unsignedBuildLine}"`)
    }
  }
  if (!saysUnsigned && files.every((file) => !requiresSigning.test(file.content) || workflowTriggers(file.content).every((trigger) => !automaticTriggers.includes(trigger)))) {
    failures.push(`${settingsFile} no longer says the build is unsigned, but no workflow requires signing on an automatic trigger`)
  }
  return failures
}

export async function checkUnsignedBuild(root = repositoryRoot) {
  const entries = await readdir(join(root, workflowDirectory))
  const files = await Promise.all(entries.filter((name) => /\.ya?ml$/.test(name)).map(async (name) => ({
    path: `${workflowDirectory}/${name}`,
    content: await readFile(join(root, workflowDirectory, name), "utf8"),
  })))
  const settingsSource = await readFile(join(root, settingsFile), "utf8")
  return evaluateUnsignedBuild(files, settingsSource)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const failures = await checkUnsignedBuild()
  for (const failure of failures) console.error(failure)
  if (failures.length) process.exitCode = 1
  else console.log("the unsigned-build line matches the workflows: no automatic signing build")
}
