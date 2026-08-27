import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const repositoryRoot = new URL("../", import.meta.url)

function packageJson(path) {
  return JSON.parse(readFileSync(new URL(`${path}/package.json`, repositoryRoot), "utf8"))
}

function packPreview(selector) {
  const stdout = execFileSync(
    pnpmCommand,
    ["--filter", selector, "pack", "--dry-run", "--json"],
    { cwd: repositoryRoot, encoding: "utf8", shell: process.platform === "win32" },
  )

  assert.ok(stdout.trim(), "pnpm pack returned no JSON")
  return JSON.parse(stdout)
}

const contracts = [
  {
    selector: "@getdomovoi/protocol",
    path: "packages/protocol",
    requiredFiles: ["README.md", "LICENSE", "package.json", "dist/index.js", "dist/index.d.ts"],
  },
  {
    selector: "@getdomovoi/daemon",
    path: "apps/daemon",
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
  const manifest = packageJson(contract.path)
  const preview = packPreview(contract.selector)
  const files = new Set(preview.files.map(({ path }) => path))

  assert.equal(manifest.private, undefined, `${contract.selector} must be publishable`)
  assert.equal(manifest.license, "Apache-2.0")
  assert.equal(manifest.publishConfig?.access, "public")
  assert.equal(manifest.homepage, "https://domovoi.sh")

  for (const requiredFile of contract.requiredFiles) {
    assert.ok(files.has(requiredFile), `${contract.selector} must pack ${requiredFile}`)
  }

  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(src|test|tests)(\/|$)/, `${contract.selector} leaked ${file}`)
  }
}

console.log("Package artifact contracts passed")
