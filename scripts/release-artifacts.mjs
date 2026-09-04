import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { collectDependencyLicenses } from "./dependency-licenses.mjs"
import { inspectArchive, packPackage } from "./pack-package.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
export const publishablePackages = ["@getdomovoi/protocol", "@getdomovoi/daemon"]

export function packageUrl(name, version) {
  return `pkg:npm/${name.replace("@", "%40")}@${version}`
}

export function checksumManifest(entries) {
  return [...entries]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map((entry) => `${entry.sha256}  ${entry.file}\n`)
    .join("")
}

export function sbomComponents(graph) {
  const components = []
  for (const [license, packages] of Object.entries(graph)) {
    for (const entry of packages) {
      for (const version of entry.versions) {
        components.push({
          type: "library",
          name: entry.name,
          version,
          purl: packageUrl(entry.name, version),
          licenses: licenseEntries(license),
        })
      }
    }
  }
  return components.sort(
    (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  )
}

function licenseEntries(license) {
  if (license === "Unknown") return []
  if (/[()]|\bOR\b|\bAND\b|\bWITH\b/.test(license)) return [{ expression: license }]
  return [{ license: { id: license } }]
}

export function sbomDocument({ name, version, sha256, components }) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "library",
        name,
        version,
        purl: packageUrl(name, version),
        hashes: [{ alg: "SHA-256", content: sha256 }],
      },
    },
    components,
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export async function buildReleaseArtifacts(root = repositoryRoot, destination = join(root, "release")) {
  rmSync(destination, { force: true, recursive: true })
  mkdirSync(destination, { recursive: true })

  const checksums = []
  for (const selector of publishablePackages) {
    const staging = mkdtempSync(join(tmpdir(), "domovoi release-"))
    let archive
    try {
      const packed = await packPackage(selector, staging)
      archive = join(destination, basename(packed))
      copyFileSync(packed, archive)
    } finally {
      rmSync(staging, { force: true, recursive: true })
    }

    const { manifest } = await inspectArchive(archive)
    const file = basename(archive)
    const sha256 = sha256File(archive)
    const graph = collectDependencyLicenses(root, [selector])
    const document = sbomDocument({
      name: manifest.name,
      version: manifest.version,
      sha256,
      components: sbomComponents(graph),
    })
    const sbomFile = file.replace(/\.tgz$/, ".sbom.json")

    writeFileSync(join(destination, sbomFile), `${JSON.stringify(document, null, 2)}\n`)
    checksums.push({ file, sha256 }, { file: sbomFile, sha256: sha256File(join(destination, sbomFile)) })
  }

  writeFileSync(join(destination, "SHA256SUMS"), checksumManifest(checksums))
  return { destination, files: checksums.map((entry) => entry.file).sort() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildReleaseArtifacts()
  console.log(JSON.stringify(result, null, 2))
}
