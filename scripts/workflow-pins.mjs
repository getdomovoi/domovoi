import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const workflowDirectory = ".github/workflows"
const usesPattern = /^\s*(?:-\s*)?uses:\s*(\S+)/
const commitSha = /^[0-9a-f]{40}$/i
const imageDigest = /@sha256:[0-9a-f]{64}$/i

export function evaluateWorkflowPins(files) {
  const failures = []
  for (const file of files) {
    file.content.split(/\r?\n/).forEach((line, index) => {
      const match = usesPattern.exec(line)
      if (!match) return
      const reference = match[1].replace(/^["']|["']$/g, "")
      if (reference.startsWith("./")) return
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

export async function collectWorkflowFiles(root = repositoryRoot) {
  const directory = join(root, workflowDirectory)
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue
    const path = `${workflowDirectory}/${entry.name}`
    files.push({ path, content: await readFile(join(root, path), "utf8") })
  }
  return files
}

export async function checkWorkflowPins(root = repositoryRoot) {
  const files = await collectWorkflowFiles(root)
  return { workflows: files.map((file) => file.path), failures: evaluateWorkflowPins(files) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkWorkflowPins()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}
