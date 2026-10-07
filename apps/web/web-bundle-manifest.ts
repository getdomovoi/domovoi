import { createHash } from "node:crypto"
import { lstat, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { Plugin } from "vite"

// From the protocol's source, not its package: vite loads this file for every
// build and test run, and the package resolves to a dist/ that may not be
// built yet.
import { parseWebBundleManifest, webBundleFormat, webBundleManifestFileName, type WebBundleManifest } from "../../packages/protocol/src/web-bundle"
import { protocolVersion } from "../../packages/protocol/src/protocol-version"

// Every regular file under the output directory, by its "/"-joined relative
// path. A link or any other kind of file fails the build: the daemon refuses
// the whole bundle for one, so a manifest that listed it would never serve.
async function emittedFiles(root: string, directory: string = root): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join("/")
    if (relative === webBundleManifestFileName) continue
    const kind = await lstat(absolute)
    if (kind.isDirectory()) files.push(...await emittedFiles(root, absolute))
    else if (kind.isFile()) files.push(relative)
    else throw new Error(`The web build emitted ${relative}, which is not a regular file. The daemon serves regular files only.`)
  }
  return files
}

// Writes domovoi-web.json (S3.2, docs/plans/s3-2-web-over-tailnet.md section
// 1.1) into a built web app: every file the build emitted with its SHA-256 and
// size, never the manifest itself. The manifest is checked with the schema the
// daemon reads it with, so a build the daemon would refuse fails here instead.
export async function writeWebBundleManifest(directory: string, version: string): Promise<WebBundleManifest> {
  const files: Record<string, { sha256: string; bytes: number }> = {}
  for (const relative of (await emittedFiles(directory)).sort()) {
    const contents = await readFile(path.join(directory, ...relative.split("/")))
    files[relative] = { sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength }
  }
  const parsed = parseWebBundleManifest({ format: webBundleFormat, version, protocolVersion, files })
  if (!parsed.success) {
    throw new Error(`The daemon would refuse this web build (${parsed.reason}${parsed.path === undefined ? "" : `: ${parsed.path}`}), so no ${webBundleManifestFileName} was written.`)
  }
  await writeFile(path.join(directory, webBundleManifestFileName), `${JSON.stringify(parsed.manifest, null, 2)}\n`)
  return parsed.manifest
}

// The version of the package being built. Every Domovoi package shares one
// version, so this is the workspace version.
async function packageVersion(root: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const version = typeof manifest === "object" && manifest !== null ? (manifest as { version?: unknown }).version : undefined
  if (typeof version !== "string") throw new Error(`${path.join(root, "package.json")} names no version for ${webBundleManifestFileName}`)
  return version
}

// Runs after the bundle is written, when vite has also copied public/, so
// the files it lists are the files on disk.
export function webBundleManifest(): Plugin {
  let root = ""
  let outDir = ""
  return {
    name: "domovoi-web-bundle-manifest",
    apply: "build",
    configResolved(config) {
      root = config.root
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        await writeWebBundleManifest(outDir, await packageVersion(root))
      },
    },
  }
}
