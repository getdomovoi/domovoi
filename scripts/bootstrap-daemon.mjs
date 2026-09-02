import { createHash } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { bootstrapPlan, verifyDownload } from "./bootstrap-plan.mjs"

const defaultMaximumBytes = 256 * 1024 * 1024

async function downloadOverHttps(url, { maximumBytes }) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  if (!response.url.startsWith("https://")) {
    throw new Error(`${url} redirected to ${response.url}, which is not https`)
  }

  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`${url} is larger than ${maximumBytes} bytes`)
  }
  return Buffer.from(await response.arrayBuffer())
}

export async function bootstrapDaemon({
  version,
  baseUrl,
  destination,
  download,
  maximumBytes = defaultMaximumBytes,
}) {
  const plan = bootstrapPlan({ version, baseUrl })
  const fetchBytes = download ?? ((url) => downloadOverHttps(url, { maximumBytes }))

  const manifest = String(await fetchBytes(plan.checksumUrl))
  const bytes = Buffer.from(await fetchBytes(plan.archiveUrl))
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${plan.archive} is larger than ${maximumBytes} bytes`)
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex")
  verifyDownload({ file: plan.archive, manifest, digest: sha256 })

  const release = join(destination, `v${plan.version}`)
  const path = join(release, plan.archive)
  const staging = `${path}.partial`
  await mkdir(release, { recursive: true })
  try {
    await writeFile(staging, bytes, { mode: 0o600 })
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }

  return { version: plan.version, path, sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, baseUrl, destination] = process.argv.slice(2)
  const result = await bootstrapDaemon({
    version,
    baseUrl,
    destination: destination ?? join(dirname(fileURLToPath(import.meta.url)), "..", "release"),
  })
  console.log(JSON.stringify(result, null, 2))
}
