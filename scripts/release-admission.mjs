import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { requirePublishedArtifact } from "./release-github.mjs"
import { verifyRelease } from "./release-plan.mjs"

export async function checkReleaseAdmission({ env, release, readPackage, deadline }) {
  deadline.check()
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "getdomovoi/domovoi" || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Publishing is admitted only in the approved main workflow")
  }
  if (env.RELEASE_PUBLISHING !== "enabled") throw new Error("Publishing must be explicitly enabled by a maintainer")
  if (env.FIRST_PUBLISH !== "true") {
    if (env.NPM_BOOTSTRAP_TOKEN) throw new Error("A bootstrap token cannot enter ordinary trusted publishing")
    return { mode: "trusted" }
  }
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("First publishing requires a manual workflow dispatch")
  if (!env.NPM_BOOTSTRAP_TOKEN?.trim()) throw new Error("First publishing requires the temporary NPM_BOOTSTRAP_TOKEN environment secret")
  if (!release.prerelease || release.npmTag !== "alpha") throw new Error("Bootstrap admission is restricted to the first alpha")
  for (const pkg of release.packages) {
    const existing = await deadline.run(() => readPackage(pkg))
    if (existing === undefined) continue // Only an authoritative registry 404 means absent.
    if (!existing.versions || typeof existing.versions !== "object" || Array.isArray(existing.versions)) {
      throw new Error(`${pkg.name}: registry returned no version inventory`)
    }
    const versions = Object.keys(existing.versions)
    if (versions.length !== 1 || versions[0] !== pkg.version) {
      throw new Error(`${pkg.name} already exists with another version; use trusted publishing, not bootstrap`)
    }
    // A partial first publication may retry the missing package. Never use
    // the bootstrap credential to advance or replace an existing version.
    requirePublishedArtifact(pkg, existing.versions[pkg.version])
  }
  return { mode: "first-publish" }
}

export async function releaseAdmission({ root = process.cwd(), env = process.env } = {}) {
  const deadline = bootstrapDeadline(60_000, "Release admission exceeded one minute; no publication was admitted")
  try {
    const release = await deadline.run(() => verifyRelease({ root, commit: env.GITHUB_SHA }))
    const readPackage = (pkg) => deadline.run(async () => {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, { signal: deadline.signal })
      if (response.status === 404) { await response.body?.cancel(); return undefined }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`npm registry answered HTTP ${response.status}`) }
      return response.json()
    })
    return await checkReleaseAdmission({ env, release, readPackage, deadline })
  } finally { deadline.clear() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await releaseAdmission(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
