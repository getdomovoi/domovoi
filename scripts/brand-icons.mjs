#!/usr/bin/env node
// Generates the app icon, the Android adaptive foreground, the splash screens and the favicon
// from design/assets/mark*.svg. Nothing here is hand drawn: geometry comes from Domovoi App Icon.dc.html
// (mark at 60% of the tile, full-bleed square, no baked radius, no glow, no shadow, no alpha)
// and the colours come from design/design_system_domovoi/tokens/colors.css.
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

export function markPage({ size, mark, ink, ground, fraction }) {
  const glyph = Math.round(size * fraction)
  const svg = readFileSync(join(root, "design/assets", mark), "utf8")
  const data = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`
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

function render(page, size, out, { transparent = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "domovoi-icon-"))
  const html = join(scratch, "page.html")
  const shot = join(scratch, "shot.png")
  writeFileSync(html, page)
  execFileSync(findChromium(), chromiumArgs({ html, shot, size, transparent }))
  mkdirSync(dirname(out), { recursive: true })
  copyFileSync(shot, out)
  rmSync(scratch, { recursive: true, force: true })
  console.log(`${relative(root, out)} ${size}x${size}`)
}

export const targets = [
  {
    out: "apps/mobile/assets/icon.png",
    size: 1024,
    page: { mark: "mark-reduced.svg", ink: DARK.primary, ground: DARK.card, fraction: MARK_FRACTION },
  },
  {
    out: "apps/mobile/assets/adaptive-icon.png",
    size: 1024,
    // Android masks the foreground, so the glyph sits inside the safe circle rather than at 60%.
    page: { mark: "mark-reduced.svg", ink: DARK.primary, ground: "transparent", fraction: 0.45 },
    transparent: true,
  },
  // The splash art is the mark alone on transparency: expo-splash-screen centres it on the
  // background colour and scales it to imageWidth, so a baked ground would be a tile on a tile.
  {
    out: "apps/mobile/assets/splash-dark.png",
    size: 1024,
    page: { mark: "mark.svg", ink: DARK.primary, ground: "transparent", fraction: 1 },
    transparent: true,
  },
  {
    out: "apps/mobile/assets/splash-light.png",
    size: 1024,
    page: { mark: "mark.svg", ink: LIGHT.primary, ground: "transparent", fraction: 1 },
    transparent: true,
  },
  {
    out: "apps/mobile/assets/favicon.png",
    size: 48,
    page: { mark: "mark-reduced.svg", ink: DARK.primary, ground: DARK.card, fraction: MARK_FRACTION },
  },
  {
    out: "apps/desktop/build/icon.png",
    size: 1024,
    page: { mark: "mark-reduced.svg", ink: DARK.primary, ground: DARK.card, fraction: MARK_FRACTION },
  },
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
