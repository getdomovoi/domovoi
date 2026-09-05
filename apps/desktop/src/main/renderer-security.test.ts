import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import {
  isAuthorizedRendererEvent,
  isTrustedRendererFrameUrl,
  rendererContentSecurityPolicy,
  rendererEndpointUrl,
  resolveRendererTarget,
} from "./renderer-security.js"

describe("rendererEndpointUrl", () => {
  it.each([
    ["wss://[::1]:50123/rpc", "wss://localhost:50123/rpc"],
    ["ws://[0:0:0:0:0:0:0:1]:47831/rpc", "ws://localhost:47831/rpc"],
    ["wss://[::ffff:127.0.0.1]:50123/rpc", "wss://localhost:50123/rpc"],
    ["wss://[::ffff:127.255.0.9]:50123/rpc", "wss://localhost:50123/rpc"],
  ])("names a loopback IPv6 endpoint by localhost so the policy can allow it: %s", (endpoint, rewritten) => {
    expect(rendererEndpointUrl(endpoint)).toBe(rewritten)
  })

  it.each([
    "wss://[fe80::1]:50123/rpc",
    "wss://[2001:db8::1]:50123/rpc",
    "wss://[::ffff:10.0.0.2]:50123/rpc",
    "ws://127.0.0.1:47831/rpc",
    "wss://build-box.tail.net:47831/rpc",
    "wss://localhost:50123/rpc",
    "not a url",
  ])("leaves every other endpoint untouched: %s", (endpoint) => {
    expect(rendererEndpointUrl(endpoint)).toBe(endpoint)
  })
})

function connectSources(policy: string): string[] {
  const directive = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith("connect-src "))
  if (!directive) throw new Error("connect-src is missing")
  return directive.slice("connect-src ".length).split(/\s+/u)
}

function allowsConnection(policy: string, url: string): boolean {
  const target = new URL(url)
  const scheme = target.protocol.replace(":", "")
  const port = target.port || (scheme === "wss" ? "443" : "80")
  return connectSources(policy).some((source) => {
    const match = /^(ws|wss):\/\/([^:/]+)(?::(\*|\d+))?$/u.exec(source)
    if (!match) return false
    const [, sourceScheme, host, sourcePort] = match
    if (sourceScheme !== scheme || host !== target.hostname) return false
    if (sourcePort === "*") return true
    return (sourcePort ?? (sourceScheme === "wss" ? "443" : "80")) === port
  })
}

describe("rendererContentSecurityPolicy", () => {
  it("does not block an attached endpoint on another loopback port", () => {
    const policy = rendererContentSecurityPolicy("ws://127.0.0.1:50999/rpc")

    expect(allowsConnection(policy, "ws://127.0.0.1:50999/rpc")).toBe(true)
    expect(allowsConnection(policy, "wss://localhost:47831/rpc")).toBe(true)
    expect(allowsConnection(policy, "ws://10.0.0.2:47831/rpc")).toBe(false)
  })

  it("allows exactly the acquired origin off loopback and nothing wider", () => {
    const policy = rendererContentSecurityPolicy("wss://build-box.tail.net:47831/rpc")

    expect(connectSources(policy)).toContain("wss://build-box.tail.net:47831")
    expect(allowsConnection(policy, "wss://build-box.tail.net:47831/rpc")).toBe(true)
    expect(allowsConnection(policy, "wss://build-box.tail.net:47832/rpc")).toBe(false)
    expect(allowsConnection(policy, "ws://build-box.tail.net:47831/rpc")).toBe(false)
    expect(allowsConnection(policy, "wss://other.tail.net:47831/rpc")).toBe(false)
  })

  it("never widens to a wildcard host, a bare scheme, or a bracketed host", () => {
    for (const endpoint of [
      undefined,
      "ws://127.0.0.1:47831/rpc",
      "wss://build-box.tail.net:47831/rpc",
      "wss://[::1]:50123/rpc",
      "http://127.0.0.1:47831/rpc",
      "not a url",
    ]) {
      const sources = connectSources(rendererContentSecurityPolicy(endpoint))
      expect(sources).toContain("'self'")
      for (const source of sources) {
        expect(source).not.toMatch(/^\*|\/\/\*|^wss?:$|\[/u)
      }
    }
  })

  it("keeps the loopback forms the daemon can publish when no endpoint is known", () => {
    const policy = rendererContentSecurityPolicy(undefined)

    expect(allowsConnection(policy, "ws://127.0.0.1:47831/rpc")).toBe(true)
    expect(allowsConnection(policy, "wss://127.0.0.1:47831/rpc")).toBe(true)
    expect(allowsConnection(policy, "ws://localhost:47831/rpc")).toBe(true)
    expect(allowsConnection(policy, "ws://192.168.1.10:47831/rpc")).toBe(false)
  })

  it("allows a loopback IPv6 endpoint through the localhost name the renderer is handed", () => {
    const policy = rendererContentSecurityPolicy("wss://[::1]:50123/rpc")

    expect(connectSources(policy)).toContain("wss://localhost:50123")
    expect(allowsConnection(policy, rendererEndpointUrl("wss://[::1]:50123/rpc"))).toBe(true)
    expect(rendererContentSecurityPolicy("wss://[::ffff:127.0.0.1]:50123/rpc")).toBe(policy)
  })

  it("ignores an endpoint that is not a websocket URL or that CSP cannot name", () => {
    const baseline = rendererContentSecurityPolicy(undefined)

    expect(rendererContentSecurityPolicy("http://build-box.tail.net:47831/rpc")).toBe(baseline)
    expect(rendererContentSecurityPolicy("wss://[fe80::1]:50123/rpc")).toBe(baseline)
    expect(allowsConnection(baseline, "wss://[fe80::1]:50123/rpc")).toBe(false)
    expect(rendererContentSecurityPolicy("not a url")).toBe(baseline)
  })

  it("carries the rest of the renderer policy", () => {
    const policy = rendererContentSecurityPolicy(undefined)

    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
    expect(policy).toContain("font-src 'self' data:")
    expect(policy).toContain("img-src 'self' data:")
  })
})

const bundledRendererPath = "/opt/domovoi/out/renderer/index.html"
const expectedBundledRendererPath = resolve(bundledRendererPath)

describe("resolveRendererTarget", () => {
  it("always uses the bundled renderer in packaged builds", () => {
    expect(resolveRendererTarget({
      isPackaged: true,
      rendererUrl: "http://127.0.0.1:5173/app",
      bundledRendererPath,
    })).toEqual({ kind: "file", path: expectedBundledRendererPath })
  })

  it.each([
    "http://localhost:5173/app",
    "http://127.0.0.1:5173/app",
    "http://[::1]:5173/app",
  ])("uses a valid loopback renderer URL while unpackaged: %s", (rendererUrl) => {
    expect(resolveRendererTarget({
      isPackaged: false,
      rendererUrl,
      bundledRendererPath,
    })).toEqual({ kind: "url", url: rendererUrl })
  })

  it.each([
    undefined,
    "not a URL",
    "https://example.com/app",
    "http://192.168.1.10:5173/app",
    "file:///tmp/hostile.html",
    "data:text/html,hostile",
    "http://user:password@127.0.0.1:5173/app",
  ])("falls back to the bundle for an invalid development override: %s", (rendererUrl) => {
    expect(resolveRendererTarget({
      isPackaged: false,
      rendererUrl,
      bundledRendererPath,
    })).toEqual({ kind: "file", path: expectedBundledRendererPath })
  })
})

describe("trusted renderer frames", () => {
  it("trusts only the bundled renderer file path for a file target", () => {
    const target = { kind: "file" as const, path: bundledRendererPath }

    expect(isTrustedRendererFrameUrl(pathToFileURL(bundledRendererPath).href, target)).toBe(true)
    expect(isTrustedRendererFrameUrl(`${pathToFileURL(bundledRendererPath).href}#session`, target)).toBe(true)
    expect(isTrustedRendererFrameUrl("file:///opt/domovoi/out/renderer/hostile.html", target)).toBe(false)
    expect(isTrustedRendererFrameUrl("data:text/html,hostile", target)).toBe(false)
  })

  it("requires the exact development origin and pathname", () => {
    const target = { kind: "url" as const, url: "http://127.0.0.1:5173/app/" }

    expect(isTrustedRendererFrameUrl("http://127.0.0.1:5173/app/?session=1#review", target)).toBe(true)
    expect(isTrustedRendererFrameUrl("http://localhost:5173/app/", target)).toBe(false)
    expect(isTrustedRendererFrameUrl("http://127.0.0.1:5174/app/", target)).toBe(false)
    expect(isTrustedRendererFrameUrl("http://127.0.0.1:5173/hostile", target)).toBe(false)
    expect(isTrustedRendererFrameUrl("about:blank", target)).toBe(false)
  })

  it("binds authorization to the expected webContents, main frame, and trusted URL", () => {
    const mainFrame = { url: pathToFileURL(bundledRendererPath).href }
    const expectedWebContents = { mainFrame }
    const target = { kind: "file" as const, path: bundledRendererPath }

    expect(isAuthorizedRendererEvent({ sender: expectedWebContents, senderFrame: mainFrame }, expectedWebContents, target))
      .toBe(true)
    expect(isAuthorizedRendererEvent({ sender: {}, senderFrame: mainFrame }, expectedWebContents, target))
      .toBe(false)
    expect(isAuthorizedRendererEvent({
      sender: expectedWebContents,
      senderFrame: { url: mainFrame.url },
    }, expectedWebContents, target)).toBe(false)
    expect(isAuthorizedRendererEvent({
      sender: expectedWebContents,
      senderFrame: { url: "https://attacker.example/" },
    }, expectedWebContents, target)).toBe(false)
    expect(isAuthorizedRendererEvent({ sender: expectedWebContents, senderFrame: null }, expectedWebContents, target))
      .toBe(false)
  })
})
