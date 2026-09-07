import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FleetOriginAdmission } from "./fleet-origin.js"
import { rendererResource } from "./renderer-resources.js"

describe("bundled renderer protocol", () => {
  it("serves policy on the response and refuses paths outside its own directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-renderer-resource-"))
    try {
      await writeFile(join(directory, "index.html"), "<html></html>")
      await writeFile(join(directory, "fleet-socket.js"), "close()")
      const origins = new FleetOriginAdmission(async () => ({ outcome: "refused", reason: "not-enrolled" }))
      const request = (url: string) => rendererResource({ url, directory, method: "GET", endpoint: undefined, origins })
      const response = await request("domovoi-app://desktop/index.html")
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self'")
      expect((await request("domovoi-app://desktop/fleet-socket.js?route=invented")).headers.get("Content-Security-Policy"))
        .toBe("default-src 'none'; connect-src 'none'")
      for (const url of ["domovoi-app://other/index.html", "domovoi-app://desktop/%2e%2e%2fsecret.js", "domovoi-app://desktop/%5csecret.js", "domovoi-app://desktop/private.sqlite"]) {
        expect((await request(url)).status).toBe(403)
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
