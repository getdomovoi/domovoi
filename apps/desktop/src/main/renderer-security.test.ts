import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import {
  isAuthorizedRendererEvent,
  isTrustedRendererFrameUrl,
  resolveRendererTarget,
} from "./renderer-security.js"

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
