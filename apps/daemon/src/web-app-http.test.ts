import { createHash } from "node:crypto"
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { LoadedWebAppFile, WebAppBundleLoad } from "./web-app-bundle.js"
import { createWebAppHttpHandler } from "./web-app-http.js"

const root = "/private/owners/example-owner/private-web-install"
const index = "<!doctype html><title>Domovoi</title><p>Loaded app</p>"
const servers: Server[] = []

function file(body: string, contentType: string, cacheClass: LoadedWebAppFile["cacheClass"] = "entry"): LoadedWebAppFile {
  const bytes = Buffer.from(body)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  return { bytes, contentType, sha256, etag: `"${sha256}"`, cacheClass }
}

const files = new Map([
  ["/index.html", file(index, "text/html; charset=utf-8")],
  ["/sw.js", file("self.addEventListener('install', () => {})", "text/javascript; charset=utf-8")],
  ["/manifest.webmanifest", file('{"name":"Domovoi"}', "application/manifest+json")],
  ["/icons/app.svg", file("<svg></svg>", "image/svg+xml")],
  ["/assets/app.js", file("export const app = 1", "text/javascript; charset=utf-8")],
  ["/assets/index-B0V_-a_P.js", file("export const hashed = 1", "text/javascript; charset=utf-8", "hashed")],
])
const loaded: WebAppBundleLoad = { state: "loaded", root, version: "0.0.1", protocolVersion: "0.8.0", files }

const unavailable: { bundle: Exclude<WebAppBundleLoad, { state: "loaded" }>, copy: string }[] = [
  {
    bundle: { state: "absent", root, reason: "manifest-missing" },
    copy: "No web app is installed for this Domovoi daemon. The machine's owner can install one; the daemon's startup output says where it looks.",
  },
  {
    bundle: { state: "invalid", root, reason: "digest-mismatch", path: "private-file.js" },
    copy: "The web app installed here failed its checks, so it is not served. The daemon's log names the file.",
  },
  {
    bundle: { state: "incompatible", root, reason: "protocol-incompatible", bundleProtocolVersion: "0.9.7", daemonProtocolVersion: "0.8.4" },
    copy: "The web app installed here is for protocol 0.9, and this daemon speaks 0.8. Install the web app from the same release as the daemon.",
  },
]

type Response = { status: number | undefined, headers: IncomingHttpHeaders, body: string }

async function serve(options: { bundle?: WebAppBundleLoad, scheme?: "http" | "https", authorities?: ReadonlySet<string> } = {}) {
  // The scheme is supplied by the listener. HTTPS policy tests still use this
  // bare HTTP transport; certificate and listener integration belong to slice 4.
  const authorities = options.authorities ?? new Set(["localhost:47831"])
  const server = createServer(createWebAppHttpHandler({ bundle: options.bundle ?? loaded, scheme: options.scheme ?? "http", authorities }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Expected TCP address")
  return async (path = "/", options: { method?: string, host?: string, headers?: Record<string, string> } = {}): Promise<Response> => {
    return await new Promise((resolve, reject) => {
      // http.request preserves raw dot segments and absolute-form targets.
      const req = request({
        hostname: "127.0.0.1", port: address.port, path, method: options.method ?? "GET", agent: false,
        headers: { host: options.host ?? "localhost:47831", ...options.headers },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("error", reject)
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }))
      })
      req.on("error", reject)
      req.end()
    })
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }))
})

function appCsp(source = "ws://localhost:47831"): string {
  return "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'" + (source ? ` ${source}` : "")
    + "; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; "
    + "form-action 'none'; frame-ancestors 'none'"
}

const stateCsp = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"

function securityHeaders(response: Response, csp = appCsp()): void {
  expect(response.headers).toMatchObject({
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  })
  expect(response.headers["strict-transport-security"]).toBeUndefined()
  expect(response.headers["content-security-policy-report-only"]).toBeUndefined()
}

function notFound(response: Response, csp = appCsp()): void {
  expect(response.status).toBe(404)
  expect(response.body).toBe('{"error":"not_found"}')
  expect(response.headers["content-type"]).toMatch(/^application\/json\b/)
  expect(response.headers["cache-control"]).toBe("no-store")
  securityHeaders(response, csp)
}

describe("web app HTTP requests", () => {
  it("serves the index at / and /index.html with identical HEAD metadata", async () => {
    const get = await serve()
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body).toBe(index)
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(index)))
    securityHeaders(response)
    expect((await get("/index.html")).body).toBe(index)
    const head = await get("/", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(head.body).toBe("")
    for (const [name, value] of Object.entries(response.headers)) {
      if (name !== "date") expect(head.headers[name]).toEqual(value)
    }
  })

  it.each(["POST", "PUT", "DELETE", "OPTIONS", "PATCH"])("refuses %s with Allow and no-store", async (method) => {
    const response = await (await serve())("/", { method })
    expect(response.status).toBe(405)
    expect(response.headers.allow).toBe("GET, HEAD")
    expect(response.headers["cache-control"]).toBe("no-store")
    securityHeaders(response)
  })

  it.each([
    "/assets/", "/missing", "/domovoi-web.json", "/../domovoi-web.json", "/%2e%2e/", "/./", "/a/../",
    "/a%2fb", "/assets%2Fapp.js", "/%00", "/%", "/%C0%AF", "/%5cindex.html", "/\\index.html",
    "/%252f", "/%2569ndex.html", "http://localhost:47831/", "*", "//localhost:47831/",
  ])("returns 404 for raw target %s", async (path) => {
    notFound(await (await serve())(path))
  })

  it("decodes once and ignores Range", async () => {
    const response = await (await serve())("/%69ndex.html", { headers: { range: "bytes=0-9" } })
    expect(response.status).toBe(200)
    expect(response.body).toBe(index)
    expect(response.headers["content-range"]).toBeUndefined()
    expect(response.headers["content-encoding"]).toBeUndefined()
  })

  it("never sends a HEAD error body", async () => {
    const get = await serve()
    const response = await get("/missing", { method: "HEAD" })
    expect(response.status).toBe(404)
    expect(response.body).toBe("")
    expect(response.headers["cache-control"]).toBe("no-store")
    securityHeaders(response)
  })

  it("never echoes or logs query content on files, validation, errors or state pages", async () => {
    const logs = ["log", "info", "warn", "error", "debug"] as const
    const spies = logs.map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const query = "?code=synthetic-pairing-query&bad=%00%2f%zz"
    const get = await serve()
    const responses = [
      await get(`/${query}`), await get(`/missing${query}`), await get(`/${query}`, { method: "POST" }),
      await get(`/${query}`, { headers: { "if-none-match": files.get("/index.html")!.etag } }),
      await get(`/${query}`, { host: "unknown.example" }),
    ]
    for (const { bundle } of unavailable) responses.push(await (await serve({ bundle }))(`/${query}`))
    expect(responses.map((response) => response.status)).toEqual([200, 404, 405, 304, 404, 503, 503, 503])
    for (const response of responses) expect(JSON.stringify(response)).not.toContain("synthetic-pairing-query")
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe("web app authorities and CSP", () => {
  it.each([
    ["http", "LOCALHOST:80", "localhost", "ws://localhost"],
    ["http", "localhost", "LOCALHOST:80", "ws://localhost"],
    ["https", "STUDIO.EXAMPLE:443", "studio.example", "wss://studio.example"],
    ["https", "studio.example", "STUDIO.EXAMPLE:443", "wss://studio.example"],
    ["https", "studio.example:47831", "studio.example:47831", "wss://studio.example:47831"],
    ["https", "studio.example:80", "studio.example:80", "wss://studio.example:80"],
    ["http", "[::1]:80", "[0:0:0:0:0:0:0:1]", "ws://[::1]"],
    ["https", "[::1]:443", "[::1]", "wss://[::1]"],
  ] as const)("canonicalizes %s authority %s and Host %s", async (scheme, authority, host, source) => {
    const response = await (await serve({ scheme, authorities: new Set([authority]) }))("/", { host })
    expect(response.status).toBe(200)
    securityHeaders(response, appCsp(source))
  })

  it.each(["unknown.example:47831", "localhost", "localhost:443", "user@localhost:47831", "localhost:47831/", "localhost:47831?x", "localhost:47831#x", "localhost:47831\\", "localhost:47831;evil", "localhost:47831 evil", "", "[broken"])("refuses unknown or malformed Host %s", async (host) => {
    notFound(await (await serve())("/", { host }), appCsp(""))
  })

  it("uses only the matched authority, not other authorities or forwarded headers", async () => {
    const get = await serve({ scheme: "https", authorities: new Set(["studio.example:443", "other.example:443"]) })
    const response = await get("/", { host: "STUDIO.EXAMPLE", headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", forwarded: "host=evil.example;proto=http" } })
    securityHeaders(response, appCsp("wss://studio.example"))
    notFound(await get("/", { host: "studio.example:80" }), appCsp(""))
  })

  it("does not admit wildcard or source-injecting configured authorities", async () => {
    const get = await serve({ authorities: new Set(["*.example", "localhost:47831;evil", "user@localhost:47831"]) })
    notFound(await get("/", { host: "*.example" }), appCsp(""))
    notFound(await get("/", { host: "localhost:47831;evil" }), appCsp(""))
    notFound(await get(), appCsp(""))
  })
})

describe("web app cache headers", () => {
  it.each([...files.keys()])("uses the loaded cache class and MIME type for %s", async (path) => {
    const response = await (await serve())(path)
    const expected = files.get(path)!
    expect(response.status).toBe(200)
    expect(response.body).toBe(expected.bytes.toString("utf8"))
    expect(response.headers["content-type"]).toBe(expected.contentType)
    expect(response.headers["cache-control"]).toBe(expected.cacheClass === "entry" ? "no-cache" : "private, max-age=31536000, immutable")
    expect(response.headers.etag).toBe(expected.etag)
    securityHeaders(response)
  })

  it.each(["GET", "HEAD"])("revalidates every file for %s with all security headers", async (method) => {
    const get = await serve()
    for (const [path, entry] of files) {
      for (const validator of [entry.etag, `W/${entry.etag}`, `"old", W/${entry.etag}`, "*"]) {
        const response = await get(path, { method, headers: { "if-none-match": validator } })
        expect(response.status).toBe(304)
        expect(response.body).toBe("")
        expect(response.headers.etag).toBe(entry.etag)
        expect(response.headers["cache-control"]).toBe(entry.cacheClass === "entry" ? "no-cache" : "private, max-age=31536000, immutable")
        securityHeaders(response)
      }
    }
  })

  it("sends bytes for stale validators and cannot validate a missing path", async () => {
    const get = await serve()
    const response = await get("/", { headers: { "if-none-match": '"old"' } })
    expect(response.status).toBe(200)
    expect(response.body).toBe(index)
    notFound(await get("/missing", { headers: { "if-none-match": "*" } }))
  })

  it("keeps the TLS CSP on 304 responses", async () => {
    const response = await (await serve({ scheme: "https" }))("/", { headers: { "if-none-match": "*" } })
    expect(response.status).toBe(304)
    securityHeaders(response, appCsp("wss://localhost:47831"))
  })
})

describe("web app state page", () => {
  it.each(unavailable)("reports $bundle.state with fixed copy and no private details", async ({ bundle, copy }) => {
    const get = await serve({ bundle })
    const response = await get()
    expect(response.status).toBe(503)
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers.etag).toBeUndefined()
    expect(response.body).toContain(copy)
    for (const privateText of [root, "example-owner", "private-file.js", bundle.reason]) {
      expect(response.body).not.toContain(privateText)
    }
    expect(response.body.replace(/<[^>]*>/g, "")).not.toMatch(/[!\u2014]/)
    securityHeaders(response, stateCsp)
    const head = await get("/", { method: "HEAD" })
    expect(head.status).toBe(503)
    expect(head.body).toBe("")
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(response.body)))
    securityHeaders(head, stateCsp)
    expect((await get("/", { headers: { "if-none-match": "*" } })).status).toBe(503)
    notFound(await get("/index.html"))
    notFound(await get("/sw.js"))
    notFound(await get("/", { host: "unknown.example" }), appCsp(""))
    expect((await get("/", { method: "POST" })).status).toBe(405)
  })
})
