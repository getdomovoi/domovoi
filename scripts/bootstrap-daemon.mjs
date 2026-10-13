import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { installBootstrapDaemon } from "./bootstrap-install.mjs"
import { bootstrapDaemon, downloadOverHttps } from "./bootstrap-download.mjs"
import { bootstrapPlan } from "./bootstrap-plan.mjs"

export { bootstrapDaemon, downloadOverHttps, maximumManifestBytes } from "./bootstrap-download.mjs"

async function inventoryOptions({ verification, ...options }) {
  const base = new URL(options.baseUrl)
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Signed bootstrap needs a credential-free HTTPS release base")
  }
  const { fetchVerifiedReleaseInventory } = await import("../apps/daemon/dist/update-verification.js")
  const { inventory } = await fetchVerifiedReleaseInventory(verification)
  const file = inventory.files.find((entry) => entry.kind === "npm" && entry.packageName === "@getdomovoi/daemon")
  if (!file) throw new Error("Authenticated inventory contains no daemon archive")
  if (options.maximumBytes !== undefined && (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1)) {
    throw new Error("Signed bootstrap byte limit must be a positive safe integer")
  }
  const plan = bootstrapPlan({ version: inventory.version, baseUrl: options.baseUrl })
  const download = options.download ?? downloadOverHttps
  const exactDownload = async (url, transport) => {
    const source = await download(url, transport)
    if (url !== plan.archiveUrl) return source
    return (async function* () {
      const chunks = typeof source === "string" ? [Buffer.from(source)] : source instanceof Uint8Array ? [source] : source
      let length = 0
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Signed bootstrap received a non-byte archive chunk")
        length += chunk.byteLength
        if (length > file.length) throw new Error("Archive exceeds its authenticated length")
        yield chunk
      }
      // Completion is checked before the existing downloader verifies and
      // publishes its private staging. A matching hash alone is insufficient.
      if (length !== file.length) throw new Error("Archive differs from its authenticated length")
    })()
  }
  return { ...options, version: inventory.version, expectedSha256: file.sha256,
    maximumBytes: Math.min(file.length, options.maximumBytes ?? 256 * 1024 * 1024), download: exactDownload }
}

export async function bootstrapDaemonFromInventory(options) {
  return bootstrapDaemon(await inventoryOptions(options))
}

export async function installBootstrapDaemonFromInventory(options) {
  return installBootstrapDaemon(await inventoryOptions(options))
}

const usage = "Usage: node scripts/bootstrap-daemon.mjs <version> <baseUrl> <destination> <expectedSha256>\n"

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, baseUrl, destination, expectedSha256] = process.argv.slice(2)
  if (expectedSha256 === undefined) {
    process.stderr.write(usage)
    process.exitCode = 1
  } else {
    const result = await installBootstrapDaemon({ version, baseUrl, destination, expectedSha256 })
    console.log(JSON.stringify(result, null, 2))
  }
}
