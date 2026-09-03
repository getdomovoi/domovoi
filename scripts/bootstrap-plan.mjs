const numeric = "0|[1-9]\\d*"
const identifier = `(?:${numeric}|\\d*[A-Za-z-][0-9A-Za-z-]*)`
const pinnedVersion = new RegExp(
  `^(?:${numeric})\\.(?:${numeric})\\.(?:${numeric})`
  + `(?:-${identifier}(?:\\.${identifier})*)?`
  + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
)
const sha256 = /^[0-9a-f]{64}$/
const checksumFile = "SHA256SUMS"
const archivePrefix = "getdomovoi-daemon"

function downloadBase(baseUrl) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`${JSON.stringify(baseUrl ?? null)} is not a url that downloads over https`)
  }
  if (url.protocol !== "https:") throw new Error(`${url.protocol} does not download over https`)
  if (url.hostname === "") throw new Error(`${baseUrl} names no host to download from`)
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${baseUrl} carries a query or fragment, so it does not name a release directory`)
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
}

export function bootstrapPlan({ version, baseUrl }) {
  if (typeof version !== "string" || !pinnedVersion.test(version)) {
    throw new Error(`${JSON.stringify(version ?? null)} is not a pinned release version`)
  }
  const release = `${downloadBase(baseUrl)}/v${version}`
  const archive = `${archivePrefix}-${version}.tgz`
  return {
    version,
    archive,
    archiveUrl: `${release}/${archive}`,
    checksumUrl: `${release}/${checksumFile}`,
  }
}

export function pinnedSha256(digest) {
  if (typeof digest !== "string" || !sha256.test(digest)) {
    throw new Error(`${JSON.stringify(digest ?? null)} is not a sha256 to pin the archive to`)
  }
  return digest
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
