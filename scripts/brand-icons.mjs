#!/usr/bin/env node
// Generates the app icons, the Android adaptive foreground, the splash screens, the favicon, the
// macOS tile and the web app icons from design/assets/mark*.svg. Nothing here is hand drawn.
//
// Sources, per the owner ruling of 2026-09-25:
// - iOS, Android, splash and favicon: Claude Design project a3b4404e-4d0c-451e-8dd2-203116a76c06,
//   root file "Domovoi App Icon.dc.html", read 2026-09-25, candidate "ink" (the file's default):
//   --card ground, --primary reduced mark at 60% of the tile, full-bleed square with no baked
//   radius because the OS masks it, no alpha, no glow, no shadow. Splash is the full mark at 76pt
//   in --primary on --background per theme, exported at 1242 square. The file is not vendored.
// - macOS: design/design_handoff_domovoi_brand/README.md, App icons: squircle at a 22% radius.
//   macOS does not mask app icons, so the tile carries its own shape on Apple's 824 of 1024 grid.
// Colours come from apps/mobile/src/theme/tokens.generated.js, generated from the stylesheet.
//
// Rendering needs a local Chromium. It is a design-time tool, not part of the build or of CI.
//   node scripts/brand-icons.mjs
//   CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/brand-icons.mjs

import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter((value) => typeof value === "string" && value.length > 0)

// The icon is the one place the mark is not currentColor: it carries its own ground. The colours
// come from the generated token module rather than from oklch literals, because a PNG is sRGB and
// the phone already reads that same clipped palette.
const { colors } = createRequire(import.meta.url)(join(root, "apps/mobile/src/theme/tokens.generated.js"))
const DARK = colors.dark
const LIGHT = colors.light
const MARK_FRACTION = 0.6

export function findChromium(candidates = CHROMIUM_CANDIDATES) {
  for (const candidate of candidates) {
    // statSync and accessSync work on every platform, unlike a shelled `test -x`, and a
    // directory (a CHROMIUM pointing at the .app bundle) passes an execute check but cannot run.
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error(`no chromium found, set CHROMIUM to one: tried ${candidates.join(", ")}`)
}

// A page with a tile draws the ground as a rounded tile of `tile.size` of the canvas, with
// `tile.radius` of the tile as its corner radius, on a transparent canvas. The glyph is then a
// fraction of the tile rather than of the canvas.
export function markPage({ size, mark, ink, ground, fraction, tile }) {
  const svg = readFileSync(join(root, "design/assets", mark), "utf8")
  const data = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`
  if (tile) {
    const side = Math.round(size * tile.size)
    const glyph = Math.round(side * fraction)
    return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; }
    body { width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center;
      background: transparent; }
    div { width: ${side}px; height: ${side}px; border-radius: ${Math.round(side * tile.radius)}px;
      display: flex; align-items: center; justify-content: center; background: ${ground}; }
    span { display: block; width: ${glyph}px; height: ${glyph}px; background: ${ink};
      -webkit-mask: url("${data}") center/contain no-repeat; mask: url("${data}") center/contain no-repeat; }
  </style><div><span></span></div>`
  }
  const glyph = Math.round(size * fraction)
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; }
    body { width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center;
      background: ${ground}; }
    span { display: block; width: ${glyph}px; height: ${glyph}px; background: ${ink};
      -webkit-mask: url("${data}") center/contain no-repeat; mask: url("${data}") center/contain no-repeat; }
  </style><span></span>`
}

// The render must not touch the network or a real browser profile. Headless mode already runs
// on a temporary profile it deletes on exit; an explicit fresh --user-data-dir made Brave 1.95
// hang before the screenshot, so none is passed. The background services that phone home are
// off, every host name fails to resolve, and all traffic goes to a proxy on a closed port, so
// anything that still starts cannot fetch.
export function chromiumArgs({ html, shot, size, transparent = false }) {
  return [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--proxy-server=http://127.0.0.1:9",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${size},${size}`,
    ...(transparent ? ["--default-background-color=00000000"] : []),
    `--screenshot=${shot}`,
    pathToFileURL(html).href,
  ]
}

// One render takes a second or two. A browser that has not written its screenshot by this limit
// is stuck, and a stuck run should fail with a message rather than wait forever.
export const RENDER_TIMEOUT_MS = 60_000

export function render(
  page,
  size,
  out,
  { transparent = false, browser, scratchRoot = tmpdir(), timeoutMs = RENDER_TIMEOUT_MS } = {},
) {
  const { file, args = [] } = browser ?? { file: findChromium() }
  mkdirSync(scratchRoot, { recursive: true })
  const scratch = mkdtempSync(join(scratchRoot, "domovoi-icon-"))
  try {
    const html = join(scratch, "page.html")
    const shot = join(scratch, "shot.png")
    writeFileSync(html, page)
    execFileSync(file, [...args, ...chromiumArgs({ html, shot, size, transparent })], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    })
    mkdirSync(dirname(out), { recursive: true })
    copyFileSync(shot, out)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`${relative(root, out)} ${size}x${size}`)
}

// The ink icon: reduced mark at 60% on --card, full bleed. Every OS that masks gets this square.
const INK_SQUARE = { mark: "mark-reduced.svg", ink: DARK.primary, ground: DARK.card, fraction: MARK_FRACTION }
// Masked foregrounds keep the glyph well inside the safe circle (61% of the canvas on Android,
// 80% for a maskable web icon), so the mask never clips the silhouette.
const MASKED_FRACTION = 0.45
// Apple's 824 of 1024 icon grid: an 824 tile centred on a 1024 canvas.
const MACOS_TILE = { size: 824 / 1024, radius: 0.22 }

export const targets = [
  { out: "apps/mobile/assets/icon.png", size: 1024, page: INK_SQUARE },
  {
    out: "apps/mobile/assets/adaptive-icon.png",
    size: 1024,
    // The ground is the adaptive icon's backgroundColor in app.config.ts, not part of this layer.
    page: { ...INK_SQUARE, ground: "transparent", fraction: MASKED_FRACTION },
    transparent: true,
  },
  // The splash art is the mark alone on transparency: expo-splash-screen centres it on the
  // per-theme backgroundColor and scales it to imageWidth (76), so a baked ground would be a tile
  // on a tile. The 1242 square matches the export size the App Icon file lists.
  {
    out: "apps/mobile/assets/splash-dark.png",
    size: 1242,
    page: { mark: "mark.svg", ink: DARK.primary, ground: "transparent", fraction: 1 },
    transparent: true,
  },
  {
    out: "apps/mobile/assets/splash-light.png",
    size: 1242,
    page: { mark: "mark.svg", ink: LIGHT.primary, ground: "transparent", fraction: 1 },
    transparent: true,
  },
  { out: "apps/mobile/assets/favicon.png", size: 48, page: INK_SQUARE },
  // Windows and Linux builds take build/icon.png; electron-builder.yml points macOS at the tile.
  { out: "apps/desktop/build/icon.png", size: 1024, page: INK_SQUARE },
  {
    out: "apps/desktop/build/icon-mac.png",
    size: 1024,
    page: { ...INK_SQUARE, tile: MACOS_TILE },
    transparent: true,
  },
  { out: "apps/web/public/icons/app-icon-192.png", size: 192, page: INK_SQUARE },
  { out: "apps/web/public/icons/app-icon-512.png", size: 512, page: INK_SQUARE },
  {
    out: "apps/web/public/icons/app-icon-512-maskable.png",
    size: 512,
    // A maskable icon is one layer, so it keeps the ground and insets the glyph.
    page: { ...INK_SQUARE, fraction: MASKED_FRACTION },
  },
  { out: "apps/web/public/icons/apple-touch-icon.png", size: 180, page: INK_SQUARE },
]

function main() {
  for (const target of targets) {
    render(markPage({ size: target.size, ...target.page }), target.size, join(root, target.out), {
      transparent: target.transparent === true,
    })
  }
}

// Importing the module for its builders must not render: only a direct run touches the assets.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
