import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { collectDependencyLicenses, collectRuntimeLicenses, desktopPackages, mergeLicenseGraphs } from "./dependency-licenses.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// apps/desktop/electron-builder.yml copies these files into every build.
export const desktopNoticesDirectory = "apps/desktop/build/notices"

const noticeFile = /^(?:licen[cs]e|copying|notice)(?:-[a-z0-9]+)?(?:\.(?:md|markdown|txt|rst|html))?$/iu

// These get no notice. The Claude Agent SDK's per-platform packages are not in
// the build: electron-builder.yml excludes them and
// desktop-package-contents.test.mjs checks the exclusion. Domovoi's own
// packages are left out because they are not third-party.
const notShipped = [/^@anthropic-ai\/claude-agent-sdk-/u, /^@getdomovoi\//u]

export async function readNoticeTexts(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && noticeFile.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  return Promise.all(files.map(async (file) => ({ file, text: (await readFile(join(directory, file), "utf8")).trim() })))
}

export function renderThirdPartyNotices(entries) {
  const rule = "=".repeat(72)
  const sections = entries.map(({ name, version, license, texts }) => [
    rule,
    `${name}@${version}`,
    `License: ${license}`,
    "",
    texts.length === 0
      ? `This package publishes no license or notice file. Its declared license is ${license}.`
      : texts.map(({ file, text }) => `--- ${file} ---\n${text}`).join("\n\n"),
  ].join("\n"))
  return [
    "Third-party software in Domovoi Desktop",
    "",
    "Each section names a package this build contains, its version, the license its manifest",
    "declares, and the license and notice files the package publishes. Chromium's notices are",
    "in LICENSES.chromium.html and Electron's license is in LICENSE.electron.txt.",
    "",
    ...sections,
    "",
  ].join("\n")
}

export async function collectDesktopNotices(root = repositoryRoot) {
  const graph = mergeLicenseGraphs(await collectDependencyLicenses(root, desktopPackages), await collectRuntimeLicenses(root))
  const entries = []
  for (const [license, packages] of Object.entries(graph)) {
    for (const { name, versions, paths } of packages) {
      if (notShipped.some((pattern) => pattern.test(name))) continue
      for (const [index, version] of versions.entries()) {
        const path = paths?.[index]
        if (!path) throw new Error(`pnpm licenses list gave no install path for ${name}@${version}`)
        entries.push({ name, version, license, texts: await readNoticeTexts(path) })
      }
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name, "en") || left.version.localeCompare(right.version, "en"))
}

// Electron keeps LICENSE and LICENSES.chromium.html in its downloaded dist.
// A missing file stops packaging here rather than shipping a build without it.
export async function writeDesktopNotices(root = repositoryRoot) {
  const destination = join(root, desktopNoticesDirectory)
  const electron = dirname(createRequire(join(root, "apps/desktop/package.json")).resolve("electron/package.json"))
  await mkdir(destination, { recursive: true })
  for (const [from, to] of [["LICENSE", "LICENSE.electron.txt"], ["LICENSES.chromium.html", "LICENSES.chromium.html"]]) {
    try {
      await copyFile(join(electron, "dist", from), join(destination, to))
    } catch (error) {
      throw new Error(`Electron's dist has no ${from}; install dependencies with Electron's install script allowed`, { cause: error })
    }
  }
  const entries = await collectDesktopNotices(root)
  await writeFile(join(destination, "THIRD_PARTY_NOTICES.txt"), renderThirdPartyNotices(entries))
  return { destination, packages: entries.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { destination, packages } = await writeDesktopNotices()
    console.log(`Wrote notices for ${packages} packages to ${destination}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
