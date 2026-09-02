const pinnedVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const sha256 = /^[0-9a-f]{64}$/
const checksumFile = "SHA256SUMS"
const archivePrefix = "getdomovoi-daemon"

export function bootstrapPlan({ version, baseUrl }) {
  if (typeof version !== "string" || !pinnedVersion.test(version)) {
    throw new Error(`${JSON.stringify(version ?? null)} is not a pinned release version`)
  }
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("https://")) {
    throw new Error(`${JSON.stringify(baseUrl ?? null)} does not download over https`)
  }

  const release = `${baseUrl.replace(/\/+$/, "")}/v${version}`
  const archive = `${archivePrefix}-${version}.tgz`
  return {
    version,
    archive,
    archiveUrl: `${release}/${archive}`,
    checksumUrl: `${release}/${checksumFile}`,
  }
}

export function expectedChecksum(manifest, file) {
  let found
  for (const line of manifest.split(/\r?\n/)) {
    if (line.trim() === "") continue
    const [digest, ...rest] = line.trim().split(/\s+/)
    if (rest.join(" ").replace(/^\*/, "") !== file) continue
    if (!sha256.test(digest)) throw new Error(`${file} is recorded with something that is not a sha256`)
    if (found !== undefined && found !== digest) throw new Error(`${file} is listed twice with different digests`)
    found = digest
  }
  if (found === undefined) throw new Error(`${file} is not listed in ${checksumFile}`)
  return found
}

export function verifyDownload({ file, manifest, digest }) {
  const expected = expectedChecksum(manifest, file)
  if (digest !== expected) {
    throw new Error(`${file} does not match ${checksumFile}: expected ${expected}, downloaded ${digest}`)
  }
  return true
}
