import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const repositoryRoot = new URL("../", import.meta.url)

function packedPackage(selector) {
  const destination = mkdtempSync(join(tmpdir(), "domovoi-pack-"))

  try {
    const stdout = execFileSync(
      pnpmCommand,
      ["--filter", selector, "pack", "--json", "--pack-destination", destination],
      { cwd: repositoryRoot, encoding: "utf8", shell: process.platform === "win32" },
    )
    assert.ok(stdout.trim(), "pnpm pack returned no JSON")

    const preview = JSON.parse(stdout)
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", preview.filename, "package/package.json"], {
        encoding: "utf8",
      }),
    )
    return { manifest, preview }
  } finally {
    rmSync(destination, { force: true, recursive: true })
  }
}

const contracts = [
  {
    selector: "@getdomovoi/protocol",
    requiredFiles: ["README.md", "LICENSE", "package.json", "dist/index.js", "dist/index.d.ts"],
  },
  {
    selector: "@getdomovoi/daemon",
    requiredFiles: [
      "README.md",
      "LICENSE",
      "package.json",
      "dist/index.js",
      "dist/server.js",
      "dist/server.d.ts",
    ],
  },
]

for (const contract of contracts) {
  const { manifest, preview } = packedPackage(contract.selector)
  const files = new Set(preview.files.map(({ path }) => path))

  assert.equal(manifest.private, undefined, `${contract.selector} must be publishable`)
  assert.equal(manifest.license, "Apache-2.0")
  assert.equal(manifest.publishConfig?.access, "public")
  assert.equal(manifest.homepage, "https://domovoi.sh")
  assert.equal(manifest.engines?.node, ">=22")

  for (const requiredFile of contract.requiredFiles) {
    assert.ok(files.has(requiredFile), `${contract.selector} must pack ${requiredFile}`)
  }

  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(src|test|tests)(\/|$)/, `${contract.selector} leaked ${file}`)
  }
}

console.log("Package artifact contracts passed")
