import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const workflowDirectory = ".github/workflows"
const actionDirectory = ".github/actions"
const definitionFile = /\.ya?ml$/
const usesPattern = /^\s*(?:-\s*)?["']?uses["']?:\s*(\S+)/
const commitSha = /^[0-9a-f]{40}$/i
const imageDigest = /@sha256:[0-9a-f]{64}$/i

export function evaluateWorkflowPins(files) {
  const failures = []
  for (const file of files) {
    file.content.split(/\r?\n/).forEach((line, index) => {
      const match = usesPattern.exec(line)
      if (!match) return
      const reference = match[1].replace(/^["']|["']$/g, "")
      if (reference.startsWith("./") || reference.startsWith("$/")) return
      if (reference.startsWith("docker://")) {
        if (!imageDigest.test(reference)) {
          failures.push(`${file.path}:${index + 1}: ${reference} is not pinned to an image digest`)
        }
        return
      }
      const [, ref] = reference.split("@")
      if (ref && commitSha.test(ref)) return
      failures.push(`${file.path}:${index + 1}: ${reference} is not pinned to a commit SHA`)
    })
  }
  return failures
}

async function collectDefinitions(root, directory, recursive) {
  let entries
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      if (recursive) files.push(...(await collectDefinitions(root, path, recursive)))
      continue
    }
    if (!entry.isFile() || !definitionFile.test(entry.name)) continue
    files.push({ path, content: await readFile(join(root, path), "utf8") })
  }
  return files
}

export async function collectWorkflowFiles(root = repositoryRoot) {
  return [
    ...(await collectDefinitions(root, workflowDirectory, false)),
    ...(await collectDefinitions(root, actionDirectory, true)),
  ]
}

export async function checkWorkflowPins(root = repositoryRoot) {
  const files = await collectWorkflowFiles(root)
  const failures = files.length === 0
    ? [".github: no workflow or action definition was found, so no reference was checked"]
    : evaluateWorkflowPins(files)
  return { workflows: files.map((file) => file.path), failures }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkWorkflowPins()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}
