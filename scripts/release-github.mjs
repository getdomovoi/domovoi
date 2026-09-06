import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { verifyRelease } from "./release-plan.mjs"

// Ports receive the caller's one deadline. Tests exercise the actual ordering
// without credentials, registry writes, git tags, or GitHub releases.
export async function publishCanonicalRelease(release, { request, readVersion, upload, notes, deadline }) {
  const call = (...args) => deadline.run(() => request(...args))
  for (const pkg of release.packages) {
    const published = await deadline.run(() => readVersion(pkg))
    if (published?.name !== pkg.name || published.version !== pkg.version) throw new Error(`${pkg.name}@${pkg.version} is not yet on npm; retry after both packages publish`)
    if (!published.dist?.integrity?.split(/\s+/u).includes(pkg.integrity)) throw new Error(`${pkg.name} npm integrity differs from this release; do not overwrite or republish it`)
    if (!published.dist.attestations?.provenance?.predicateType || !published.dist.attestations?.url) {
      throw new Error(`${pkg.name} has no npm provenance reference; do not announce an unattested release`)
    }
  }
  const tagPath = `/git/ref/tags/${encodeURIComponent(release.gitTag)}`
  const reference = await call(tagPath)
  if (reference) {
    let object = reference.object
    for (let depth = 0; object?.type === "tag" && depth < 8; depth += 1) {
      object = (await call(`/git/tags/${object.sha}`))?.object
    }
    if (object?.type !== "commit" || object.sha !== release.commit) {
      throw new Error(`${release.gitTag} already names another commit; it will not be moved`)
    }
  }
  let record = await call(`/releases/tags/${encodeURIComponent(release.gitTag)}`)
  if (!record) {
    // The tag endpoint need not expose drafts. Look for an interrupted draft
    // before creating one, and fail closed if that bounded list is exhausted.
    const recent = await call("/releases?per_page=100")
    if (!Array.isArray(recent)) throw new Error("GitHub returned no release list")
    record = recent.find((item) => item.tag_name === release.gitTag)
    if (!record && recent.length === 100) throw new Error("Release draft lookup exceeded 100 records; inspect older drafts before retrying")
  }
  const source = `Source commit: ${release.commit}`
  if (record && (!record.body?.includes(source) || record.prerelease !== release.prerelease)) {
    throw new Error(`${release.gitTag} already has different release metadata; it will not be replaced`)
  }
  if (!reference) await call("/git/refs", "POST", { ref: `refs/tags/${release.gitTag}`, sha: release.commit })
  if (!record) {
    record = await call("/releases", "POST", { tag_name: release.gitTag, target_commitish: release.commit,
      name: `Domovoi ${release.version}`, body: `${source}\n\n${notes}`, draft: true,
      prerelease: release.prerelease, make_latest: "false" })
  }
  for (const file of release.files) {
    const existing = record.assets?.find((asset) => asset.name === file.name)
    if (existing) {
      if (existing.digest !== `sha256:${file.sha256}`) throw new Error(`Release asset ${file.name} has a different or missing checksum; it will not be overwritten`)
    } else {
      if (!record.draft) throw new Error(`Published release is missing ${file.name}; inspect it before repairing a public release`)
      await deadline.run(() => upload(record.id, file))
    }
  }
  const complete = await call(`/releases/${record.id}`)
  for (const file of release.files) {
    if (complete.assets?.find((asset) => asset.name === file.name)?.digest !== `sha256:${file.sha256}`) {
      throw new Error(`Release asset ${file.name} was not verified after upload; the draft remains unpublished`)
    }
  }
  if (complete.draft) await call(`/releases/${record.id}`, "PATCH", { draft: false, make_latest: "false" })
  return { tag: release.gitTag, commit: release.commit, assets: release.files.map((file) => file.name) }
}

async function jsonRequest(url, deadline, options = {}) {
  return deadline.run(async () => {
    const response = await fetch(url, { ...options, signal: deadline.signal })
    if (response.status === 404) { await response.body?.cancel(); return undefined }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Release request to ${new URL(url).origin} answered HTTP ${response.status}`) }
    return response.json()
  })
}

function changelogEntry(text, version) {
  const lines = text.replace(/\r\n/gu, "\n").split("\n")
  const start = lines.indexOf(`## ${version}`)
  if (start < 0) throw new Error(`Changelog has no entry for ${version}`)
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith("## ")) end += 1
  return lines.slice(start + 1, end).join("\n").trim()
}

export async function releaseGithub({ root = process.cwd(), env = process.env } = {}) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "getdomovoi/domovoi" || env.GITHUB_REF !== "refs/heads/main" || !env.GH_TOKEN) {
    throw new Error("GitHub release creation runs only in the approved main release workflow")
  }
  const deadline = bootstrapDeadline(600_000, "GitHub release exceeded ten minutes; inspect npm, the tag and any draft before retrying")
  try {
    const directory = join(root, "release")
    const release = await deadline.run(() => verifyRelease({ root, commit: env.GITHUB_SHA }))
    const notes = []
    for (const pkg of release.packages) {
      const text = await deadline.run(() => readFile(join(root, pkg.directory, "CHANGELOG.md"), "utf8"))
      notes.push(`## ${pkg.name}\n\n${changelogEntry(text, pkg.version)}`)
    }
    const headers = { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
    const request = (path, method = "GET", body) => jsonRequest(`https://api.github.com/repos/getdomovoi/domovoi${path}`, deadline,
      { method, headers: { ...headers, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const readVersion = (pkg) => jsonRequest(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, deadline)
    const upload = async (id, file) => {
      const path = join(directory, file.name)
      const metadata = await deadline.run(() => stat(path))
      deadline.check()
      const body = createReadStream(path, { signal: deadline.signal })
      try {
        return await jsonRequest(`https://uploads.github.com/repos/getdomovoi/domovoi/releases/${id}/assets?name=${encodeURIComponent(file.name)}`, deadline,
          { method: "POST", headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(metadata.size) }, body, duplex: "half" })
      } finally { body.destroy() }
    }
    return await publishCanonicalRelease(release, { request, readVersion, upload, notes: notes.join("\n\n"), deadline })
  } finally { deadline.clear() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await releaseGithub(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
