import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { inflateSync } from "node:zlib"

import { chromiumArgs, findChromium, markPage, render, targets } from "./brand-icons.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const scratch = join(tmpdir(), "domovoi-icon-test", "page dir")
const html = join(scratch, "page.html")
const shot = join(scratch, "shot.png")

test("the browser stays on the temporary profile headless mode creates", () => {
  const args = chromiumArgs({ html, shot, size: 64 })
  // A named profile would be a real one, and a fresh explicit one hangs Brave before the shot.
  assert.equal(args.some((arg) => /^--(user-data-dir|profile-directory)=/.test(arg)), false)
  assert.equal(args[0], "--headless=new")
})

test("the browser cannot reach the network while it renders", () => {
  const args = chromiumArgs({ html, shot, size: 64 })
  // Every host fails to resolve, so a background service cannot fetch even if it starts.
  assert.ok(args.includes("--host-resolver-rules=MAP * ~NOTFOUND"))
  // An address literal skips the resolver, so traffic also goes to a proxy on a closed port.
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:9"))
  for (const flag of [
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
})

test("the page is addressed by a file URL that survives spaces and Windows paths", () => {
  const args = chromiumArgs({ html, shot, size: 64 })
  assert.equal(args.at(-1), pathToFileURL(html).href)
})

test("every page inlines the mark and loads nothing from a host", () => {
  for (const target of targets) {
    const page = markPage({ size: target.size, ...target.page })
    assert.doesNotMatch(page, /\b(?:https?|wss?|ftp):/i, target.out)
    assert.match(page, /url\("data:image\/svg\+xml;base64,/, target.out)
  }
})

test("a directory is not taken for a browser executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-dir-"))
  try {
    assert.equal(findChromium([directory, process.execPath]), process.execPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a missing browser names every path it tried", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-missing-"))
  try {
    const missing = join(directory, "no-such-browser")
    assert.throws(() => findChromium([missing]), (error) => error.message.includes(missing))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Node stands in for the browser on every platform: `--` hands the browser arguments to the
// stand-in script instead of letting Node parse them as its own options.
function standIn(source) {
  return { file: process.execPath, args: ["-e", source, "--"] }
}

test("a browser that fails leaves no scratch files and writes no asset", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-render-"))
  try {
    const scratchRoot = join(directory, "scratch")
    const out = join(directory, "out", "icon.png")
    assert.throws(() =>
      render("<p>page</p>", 16, out, { browser: standIn("process.exit(3)"), scratchRoot }),
    )
    assert.deepEqual(readdirSync(scratchRoot), [])
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a browser that hangs is stopped at the render time limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "domovoi-icon-render-"))
  try {
    const scratchRoot = join(directory, "scratch")
    const out = join(directory, "out", "icon.png")
    const started = Date.now()
    assert.throws(
      () =>
        render("<p>page</p>", 16, out, {
          browser: standIn("setInterval(() => {}, 1000)"),
          scratchRoot,
          timeoutMs: 500,
        }),
      /ETIMEDOUT|timed out/i,
    )
    assert.ok(Date.now() - started < 10_000)
    assert.deepEqual(readdirSync(scratchRoot), [])
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// The owner ruled on 2026-09-25 that the live "Domovoi App Icon.dc.html" (candidate "ink") governs
// iOS, Android, splash and favicon, and the brand handoff's macOS rule governs the desktop tile.
const require = createRequire(import.meta.url)
const { colors } = require("../apps/mobile/src/theme/tokens.generated.js")
const INK = { ink: colors.dark.primary, ground: colors.dark.card }

function target(out) {
  const found = targets.find((candidate) => candidate.out === out)
  assert.ok(found, `no target writes ${out}`)
  return found
}

test("square icons are the reduced mark at 60% on the ink ground, full bleed and opaque", () => {
  for (const [out, size] of [
    ["apps/mobile/assets/icon.png", 1024],
    ["apps/mobile/assets/favicon.png", 48],
    ["apps/desktop/build/icon.png", 1024],
    ["apps/web/public/icons/app-icon-192.png", 192],
    ["apps/web/public/icons/app-icon-512.png", 512],
    ["apps/web/public/icons/apple-touch-icon.png", 180],
  ]) {
    const { size: actual, page, transparent } = target(out)
    assert.equal(actual, size, out)
    assert.deepEqual(
      { mark: page.mark, ink: page.ink, ground: page.ground, fraction: page.fraction, tile: page.tile },
      { mark: "mark-reduced.svg", ...INK, fraction: 0.6, tile: undefined },
      out,
    )
    assert.notEqual(transparent, true, out)
  }
})

test("masked foregrounds keep the reduced mark inside the safe zone", () => {
  const adaptive = target("apps/mobile/assets/adaptive-icon.png")
  assert.equal(adaptive.transparent, true)
  assert.equal(adaptive.page.ground, "transparent")
  const maskable = target("apps/web/public/icons/app-icon-512-maskable.png")
  assert.equal(maskable.size, 512)
  // A maskable icon has no separate background layer, so it carries the ground itself.
  assert.equal(maskable.page.ground, INK.ground)
  for (const { page } of [adaptive, maskable]) {
    assert.equal(page.mark, "mark-reduced.svg")
    assert.equal(page.ink, INK.ink)
    assert.ok(page.fraction <= 0.5, "the glyph must sit inside the mask's safe circle")
  }
})

test("splash art is the full mark per theme at the file's 1242 export size", () => {
  for (const [out, ink] of [
    ["apps/mobile/assets/splash-dark.png", colors.dark.primary],
    ["apps/mobile/assets/splash-light.png", colors.light.primary],
  ]) {
    const { size, page, transparent } = target(out)
    assert.equal(size, 1242, out)
    assert.equal(page.mark, "mark.svg", out)
    assert.equal(page.ink, ink, out)
    // Expo lays the image on the per-theme backgroundColor; a baked ground would be a tile on a tile.
    assert.equal(transparent, true, out)
  }
})

test("the macOS icon is an ink squircle on Apple's 824 of 1024 grid with a 22% radius", () => {
  const mac = target("apps/desktop/build/icon-mac.png")
  assert.equal(mac.size, 1024)
  assert.equal(mac.transparent, true)
  assert.equal(mac.page.mark, "mark-reduced.svg")
  assert.equal(mac.page.ink, INK.ink)
  assert.equal(mac.page.ground, INK.ground)
  const page = markPage({ size: mac.size, ...mac.page })
  assert.match(page, /width: 824px; height: 824px;/)
  assert.match(page, /border-radius: 181px;/)
  // The glyph is 60% of the tile, not of the canvas.
  assert.match(page, /width: 494px; height: 494px;/)
})

test("the macOS build uses the squircle and the other platforms keep the square", async () => {
  const config = await readFile(join(root, "apps/desktop/electron-builder.yml"), "utf8")
  const mac = config.slice(config.indexOf("\nmac:"), config.indexOf("\ndmg:"))
  assert.match(mac, /^ {2}icon: build\/icon-mac\.png$/m)
  assert.doesNotMatch(config.replace(mac, ""), /^\s*icon:/m)
})

// The checks above hold the spec. These read the committed PNGs, so an asset that was not
// regenerated after a spec change fails here without a browser.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RGB = 2
const RGBA = 6

function readPng(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), "not a PNG")
  const chunks = []
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("latin1", offset + 4, offset + 8)
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  const header = chunks[0]
  assert.equal(header?.type, "IHDR")
  return {
    width: header.data.readUInt32BE(0),
    height: header.data.readUInt32BE(4),
    bitDepth: header.data[8],
    colourType: header.data[9],
    interlace: header.data[12],
    idat: Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)),
  }
}

// Undoes the five PNG row filters for an 8-bit, non-interlaced image and returns the rows.
function decodeRows(png) {
  assert.equal(png.bitDepth, 8)
  assert.equal(png.interlace, 0)
  const channels = png.colourType === RGBA ? 4 : 3
  const stride = png.width * channels
  const raw = inflateSync(png.idat)
  const rows = []
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < png.height; y += 1) {
    const start = y * (stride + 1)
    const filter = raw[start]
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + stride))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const toLeft = Math.abs(estimate - left)
        const toUp = Math.abs(estimate - up)
        const toUpLeft = Math.abs(estimate - upLeft)
        predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
      } else assert.equal(filter, 0, `unknown filter ${filter} on row ${y}`)
      row[x] = (row[x] + predictor) & 0xff
    }
    rows.push(row)
    previous = row
  }
  return { rows, channels }
}

test("every committed asset has the size and alpha its target declares", async () => {
  for (const { out, size, transparent } of targets) {
    const png = readPng(await readFile(join(root, out)))
    assert.deepEqual(
      { width: png.width, height: png.height, colourType: png.colourType },
      { width: size, height: size, colourType: transparent === true ? RGBA : RGB },
      out,
    )
  }
})

test("the committed macOS tile is transparent at the corner and opaque at the centre", async () => {
  const png = readPng(await readFile(join(root, "apps/desktop/build/icon-mac.png")))
  const { rows, channels } = decodeRows(png)
  const alpha = (x, y) => rows[y][x * channels + 3]
  assert.equal(alpha(0, 0), 0)
  const centre = png.width / 2
  assert.equal(alpha(centre, centre), 255)
})
