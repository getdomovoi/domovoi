import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { registerDomovoiServiceWorker } from "./pwa"

describe("Domovoi PWA", () => {
  it("ships an installable manifest without claiming offline support", async () => {
    const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url))
    const manifest = JSON.parse(await readFile(`${publicDirectory}manifest.webmanifest`, "utf8"))

    expect(manifest).toMatchObject({
      id: "/",
      name: "Domovoi",
      short_name: "Domovoi",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#171719",
      theme_color: "#171719",
    })
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/icons/app-icon-192.png", sizes: "192x192" }),
      expect.objectContaining({ src: "/icons/app-icon-512.png", sizes: "512x512" }),
      expect.objectContaining({ src: "/icons/app-icon-512-maskable.png", purpose: "maskable" }),
    ]))
    expect(JSON.stringify(manifest)).not.toMatch(/offline/i)
    const worker = await readFile(`${publicDirectory}sw.js`, "utf8")
    expect(worker).not.toMatch(/\bcaches\b|["']fetch["']/)

    for (const [file, size] of [
      ["app-icon-192.png", 192],
      ["app-icon-512.png", 512],
      ["app-icon-512-maskable.png", 512],
      ["apple-touch-icon.png", 180],
    ] as const) {
      const icon = await readFile(`${publicDirectory}icons/${file}`)
      expect(icon.subarray(1, 4).toString()).toBe("PNG")
      expect(icon.readUInt32BE(16)).toBe(size)
      expect(icon.readUInt32BE(20)).toBe(size)
    }
  })

  it("registers the network-only worker only in production", async () => {
    const register = vi.fn().mockResolvedValue(undefined)

    await registerDomovoiServiceWorker({ register }, true)
    await registerDomovoiServiceWorker({ register }, false)

    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" })
  })
})
