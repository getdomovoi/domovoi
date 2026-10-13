import { createHash } from "node:crypto"

function shape(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) throw new Error("Invalid distribution config shape")
}

function text(value, maximum = 256) {
  if (typeof value !== "string" || !value.length || value.length > maximum
    || /[^\x20-\x7e]|#\{/.test(value)) throw new Error("Distribution config contains unsafe Ruby text")
  return value
}

function https(value) {
  text(value, 2048)
  let url
  try { url = new URL(value) } catch { throw new Error("Distribution config requires an HTTPS URL") }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Distribution config requires a credential-free HTTPS URL without query or fragment")
  }
  return url.href.replace(/\/+$/, "")
}

function configuration(input) {
  // Capture validated values before the asynchronous verifier gives control to
  // caller callbacks. Later mutations cannot alter emitted Ruby or identities.
  const config = structuredClone(input)
  shape(config, ["schemaVersion", "releaseBaseUrl", "cask"])
  if (config.schemaVersion !== 1) throw new Error("Unsupported distribution config version")
  config.releaseBaseUrl = https(config.releaseBaseUrl)
  const cask = config.cask
  shape(cask, ["token", "name", "description", "homepage", "packageName", "bundleId", "app", "architectures"])
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text(cask.token, 64))) throw new Error("Invalid cask config token")
  text(cask.name, 128); text(cask.description); text(cask.packageName, 128); text(cask.bundleId, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.app$/.test(text(cask.app, 128))) throw new Error("Invalid app config path")
  cask.homepage = https(cask.homepage)
  shape(cask.architectures, ["arm64", "x64"])
  for (const arch of ["arm64", "x64"]) {
    const selector = cask.architectures[arch]
    shape(selector, ["platform", "arch", "format"])
    if (selector.platform !== "darwin" || selector.arch !== arch || selector.format !== "dmg") {
      throw new Error("Unsupported distribution architecture config")
    }
  }
  return config
}

const ruby = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`

/** Returns text only. There is no publish port or unsigned inventory input. */
export async function generateDistributionManifests({ config: input, verification }) {
  const config = configuration(input)
  const { fetchVerifiedReleaseInventory } = await import("../apps/daemon/dist/update-verification.js")
  const { inventory, bytes } = await fetchVerifiedReleaseInventory(verification)
  const { cask } = config
  const variants = ["arm64", "x64"].map((arch) => {
    const selector = cask.architectures[arch]
    const file = inventory.files.find((entry) => entry.kind === "desktop" && entry.arch === selector.arch
      && entry.platform === selector.platform && entry.format === selector.format)
    if (!file) throw new Error("The cask requires both authenticated DMG architectures")
    if (file.packageName !== cask.packageName || file.bundleId !== cask.bundleId || file.app !== cask.app) {
      throw new Error("Cask config cannot override authenticated app identity")
    }
    const url = `${config.releaseBaseUrl}/${encodeURIComponent(inventory.gitTag)}/${encodeURIComponent(file.name)}`
    return `  on_${arch === "arm64" ? "arm" : "intel"} do\n    sha256 ${ruby(file.sha256)}\n    url ${ruby(url)}\n  end`
  })
  const output = `cask ${ruby(cask.token)} do\n  version ${ruby(inventory.version)}\n\n${variants.join("\n\n")}\n\n`
    + `  name ${ruby(cask.name)}\n  desc ${ruby(cask.description)}\n  homepage ${ruby(cask.homepage)}\n\n`
    + `  depends_on :macos\n  app ${ruby(cask.app)}\nend\n`
  return { inventorySha256: createHash("sha256").update(bytes).digest("hex"),
    version: inventory.version, channel: inventory.channel, commit: inventory.commit,
    files: { [`${cask.token}.rb`]: output } }
}
