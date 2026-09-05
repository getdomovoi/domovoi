import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { installBootstrapDaemon } from "./bootstrap-install.mjs"

export { bootstrapDaemon, downloadOverHttps, maximumManifestBytes } from "./bootstrap-download.mjs"

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
