import { describe, expect, it } from "vitest"

import {
  maximumWebBundleBytes,
  maximumWebBundleFileBytes,
  maximumWebBundleFiles,
  maximumWebBundlePathLength,
  parseWebBundleManifest,
  protocolVersion,
  webBundleCompatibility,
  webBundleContentType,
  webBundleFormat,
  webBundleManifestFileName,
  webBundleManifestSchema,
  webBundlePathRefusal,
} from "./index.js"

const digest = "a".repeat(64)

function manifest(files: Record<string, { sha256: string, bytes: number }> = { "index.html": { sha256: digest, bytes: 10 } }) {
  return { format: 1, version: "0.0.1", protocolVersion, files }
}

describe("web bundle manifest", () => {
  it("names its file and format", () => {
    expect(webBundleManifestFileName).toBe("domovoi-web.json")
    expect(webBundleFormat).toBe(1)
  })

  it("accepts the shape the build writes and keeps every field", () => {
    const value = manifest({
      "index.html": { sha256: digest, bytes: 1234 },
      "assets/index-DsHW9SSB.js": { sha256: "0123456789abcdef".repeat(4), bytes: 456_789 },
      "icons/icon-192.png": { sha256: digest, bytes: 0 },
    })
    const parsed = parseWebBundleManifest(value)
    expect(parsed).toEqual({ success: true, manifest: value })
    expect(webBundleManifestSchema.parse(value)).toEqual(value)
  })

  it("accepts a prerelease workspace version and any protocol version shape", () => {
    expect(parseWebBundleManifest({ ...manifest(), version: "0.1.0-beta.2" }).success).toBe(true)
    // Compatibility is the daemon's decision, not the schema's: a bundle for
    // another protocol minor still parses, so it can be reported as such.
    expect(parseWebBundleManifest({ ...manifest(), protocolVersion: "9.9.9" }).success).toBe(true)
  })

  it.each([
    ["no object", null],
    ["another format", { ...manifest(), format: 2 }],
    ["format as text", { ...manifest(), format: "1" }],
    ["no version", { format: 1, protocolVersion, files: manifest().files }],
    ["a malformed version", { ...manifest(), version: "v1" }],
    ["a malformed protocol version", { ...manifest(), protocolVersion: "0.8" }],
    ["an unknown field", { ...manifest(), signature: "x" }],
    ["files as a list", { ...manifest(), files: [] }],
    ["an uppercase digest", manifest({ "index.html": { sha256: "A".repeat(64), bytes: 1 } })],
    ["a short digest", manifest({ "index.html": { sha256: "a".repeat(63), bytes: 1 } })],
    ["a negative size", manifest({ "index.html": { sha256: digest, bytes: -1 } })],
    ["a fractional size", manifest({ "index.html": { sha256: digest, bytes: 1.5 } })],
    ["an unknown file field", { ...manifest(), files: { "index.html": { sha256: digest, bytes: 1, mode: 420 } } }],
  ])("refuses %s as a schema failure", (_name, value) => {
    expect(parseWebBundleManifest(value)).toEqual({ success: false, reason: "manifest-schema" })
    expect(webBundleManifestSchema.safeParse(value).success).toBe(false)
  })

  it("requires index.html, the document served at /", () => {
    const value = manifest({ "sw.js": { sha256: digest, bytes: 1 } })
    expect(parseWebBundleManifest(value)).toEqual({ success: false, reason: "missing-index" })
    expect(webBundleManifestSchema.safeParse(value).success).toBe(false)
  })

  it("bounds the number of files", () => {
    const files: Record<string, { sha256: string, bytes: number }> = { "index.html": { sha256: digest, bytes: 1 } }
    for (let index = 0; index < maximumWebBundleFiles; index += 1) files[`assets/f${index}.js`] = { sha256: digest, bytes: 1 }
    expect(Object.keys(files)).toHaveLength(maximumWebBundleFiles + 1)
    expect(parseWebBundleManifest(manifest(files))).toEqual({ success: false, reason: "too-many-files" })
    delete files["assets/f0.js"]
    expect(parseWebBundleManifest(manifest(files)).success).toBe(true)
  })

  it("bounds each file's size", () => {
    expect(parseWebBundleManifest(manifest({ "index.html": { sha256: digest, bytes: maximumWebBundleFileBytes } })).success).toBe(true)
    expect(parseWebBundleManifest(manifest({ "index.html": { sha256: digest, bytes: maximumWebBundleFileBytes + 1 } })))
      .toEqual({ success: false, reason: "file-too-large", path: "index.html" })
  })

  it("bounds the total size", () => {
    const files: Record<string, { sha256: string, bytes: number }> = {}
    const count = Math.ceil(maximumWebBundleBytes / maximumWebBundleFileBytes)
    files["index.html"] = { sha256: digest, bytes: maximumWebBundleBytes - (count - 1) * maximumWebBundleFileBytes }
    for (let index = 1; index < count; index += 1) files[`assets/f${index}.js`] = { sha256: digest, bytes: maximumWebBundleFileBytes }
    expect(parseWebBundleManifest(manifest(files)).success).toBe(true)
    files["assets/extra.js"] = { sha256: digest, bytes: 1 }
    expect(parseWebBundleManifest(manifest(files))).toEqual({ success: false, reason: "bundle-too-large" })
  })

  it("reports a refused path with its reason and the path", () => {
    const value = manifest({ "index.html": { sha256: digest, bytes: 1 }, "../secret.js": { sha256: digest, bytes: 1 } })
    expect(parseWebBundleManifest(value)).toEqual({ success: false, reason: "path-malformed", path: "../secret.js" })
    expect(webBundleManifestSchema.safeParse(value).success).toBe(false)
    expect(parseWebBundleManifest(manifest({ "index.html": { sha256: digest, bytes: 1 }, "rpc/a.js": { sha256: digest, bytes: 1 } })))
      .toEqual({ success: false, reason: "path-reserved", path: "rpc/a.js" })
    expect(parseWebBundleManifest(manifest({ "index.html": { sha256: digest, bytes: 1 }, "notes.txt": { sha256: digest, bytes: 1 } })))
      .toEqual({ success: false, reason: "path-extension", path: "notes.txt" })
  })

  it("sees a __proto__ key that JSON.parse keeps as an own property", () => {
    const value: unknown = JSON.parse(`{"format":1,"version":"0.0.1","protocolVersion":"${protocolVersion}","files":{"index.html":{"sha256":"${digest}","bytes":1},"__proto__":{"sha256":"${digest}","bytes":1}}}`)
    expect(parseWebBundleManifest(value)).toEqual({ success: false, reason: "path-extension", path: "__proto__" })
    expect(webBundleManifestSchema.safeParse(value).success).toBe(false)
  })
})

describe("web bundle compatibility", () => {
  it("uses the admission rule: major and minor match, patch may differ", () => {
    expect(webBundleCompatibility("0.8.0", "0.8.0")).toBe("compatible")
    expect(webBundleCompatibility("0.8.7", "0.8.0")).toBe("compatible")
    expect(webBundleCompatibility("0.7.0", "0.8.0")).toBe("machine-ahead")
    expect(webBundleCompatibility("0.9.0", "0.8.0")).toBe("machine-behind")
    expect(webBundleCompatibility("1.8.0", "0.8.0")).toBe("machine-behind")
    expect(webBundleCompatibility(protocolVersion)).toBe("compatible")
  })
})

describe("web bundle paths", () => {
  it.each([
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "favicon.ico",
    "icons/icon-192.png",
    "icons/mark.svg",
    "assets/index-DsHW9SSB.js",
    "assets/index-Bq_x-1.css",
    "assets/inter-latin.woff2",
    "rpc.js",
    "healthz.html",
    "assets/artifacts/a.js",
  ])("accepts %s", (path) => {
    expect(webBundlePathRefusal(path)).toBeUndefined()
  })

  it.each([
    "",
    ".",
    "..",
    "./index.html",
    "../index.html",
    "assets/../index.html",
    "assets/./a.js",
    "assets/..",
    "/index.html",
    "//index.html",
    "assets//a.js",
    "assets/",
    "assets\\a.js",
    "a\0.js",
    "%2e%2e/a.js",
    "assets/%2e%2e/a.js",
    "assets%2fa.js",
    ".hidden.js",
    "assets/.a.js",
    "a b.js",
    "é.js",
    "a:b.js",
    "index.html\n",
    `${"x".repeat(maximumWebBundlePathLength - 2)}.js`,
  ])("refuses %j as malformed", (path) => {
    expect(webBundlePathRefusal(path)).toBe("path-malformed")
  })

  it("allows a path at the length bound", () => {
    expect(webBundlePathRefusal(`${"x".repeat(maximumWebBundlePathLength - 3)}.js`)).toBeUndefined()
  })

  it.each([
    "rpc",
    "healthz",
    "artifacts",
    "rpc/a.js",
    "healthz/index.html",
    "artifacts/a.html",
    "Artifacts/a.html",
    "RPC/a.js",
    "domovoi-web.json",
  ])("refuses %s as a daemon route or the manifest itself", (path) => {
    expect(webBundlePathRefusal(path)).toBe("path-reserved")
  })

  it.each([
    "a",
    "a.txt",
    "a.json",
    "assets/a.map",
    "assets/a.mjs",
    "index.htm",
    "assets/a.JS",
    "index.html.txt",
    "assets/a.wasm",
  ])("refuses %s for its extension", (path) => {
    expect(webBundlePathRefusal(path)).toBe("path-extension")
  })

  it("takes the content type from the extension table", () => {
    expect(webBundleContentType("index.html")).toBe("text/html; charset=utf-8")
    expect(webBundleContentType("assets/a.js")).toBe("text/javascript; charset=utf-8")
    expect(webBundleContentType("assets/a.css")).toBe("text/css; charset=utf-8")
    expect(webBundleContentType("icons/a.svg")).toBe("image/svg+xml")
    expect(webBundleContentType("icons/a.png")).toBe("image/png")
    expect(webBundleContentType("favicon.ico")).toBe("image/x-icon")
    expect(webBundleContentType("manifest.webmanifest")).toBe("application/manifest+json")
    expect(webBundleContentType("assets/a.woff2")).toBe("font/woff2")
    expect(webBundleContentType("notes.txt")).toBeUndefined()
  })
})
