// Regenerate every icon derivative from the brand SSOT (build/icon.svg).
//
//   node scripts/generate-icons.mjs          # (re)generate all derivatives
//   node scripts/generate-icons.mjs --check  # verify derivatives are in sync
//
// build/icon.svg is the single source of truth for the Repotory app brand
// mark. Everything else — the Wails appicon, the Windows .ico, the size
// ladder in build/icons/ and the docs favicons — is a derived artifact.
// When the SSOT changes without regenerating, `--check` fails (wired into
// CI), so a rebrand can never ship half-applied.
//
// The plugin stores get their own master, build/plugin-icon.svg: same
// letterform, editorial paper-card field (see the comment in that file).
// The VS Code marketplace icon AND the activity-bar icon are derived from
// it; the JetBrains marketplace icons are hand-scaled 40×40 SVGs of the
// same mark.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'

const SIZES = [512, 256, 128, 64, 48, 32, 16]

const root = process.cwd()
const svgPath = path.join(root, 'build/icon.svg')
const pluginSvgPath = path.join(root, 'build/plugin-icon.svg')
const outDir = path.join(root, 'build/icons')

// Marketplace-facing bitmap: the VS Code extension icon (media/icon.png)
// is the plugin mark at 128×128, the size the marketplace requires.
const PLUGIN_ICON_SIZE = 128
const pluginIconPng = path.join(outDir, `plugin-icon-${PLUGIN_ICON_SIZE}.png`)

// Every derived artifact: how it is produced, plus (for bitmaps) a pixel
// diff tolerance for --check. sharp upgrades can shift anti-aliased edges
// by a level, so the check compares pixel content with a small allowance
// instead of bytes — enough to catch a stale derivative, tolerant of
// renderer micro-drift.
const DERIVED = [
  { file: 'build/icons/icon.ico', rel: 'docs/favicon.ico', copy: true },
  { file: 'build/icons/icon.ico', rel: 'web/public/favicon.ico', copy: true },
  { file: 'docs/favicon.svg', rel: 'web/public/favicon.svg', copy: true },
]

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function renderPng(svg, size) {
  return sharp(svg).resize(size, size).png().toBuffer()
}

function buildIco(svg) {
  // ICO container: 6-byte header, one 16-byte directory entry per size,
  // then the embedded PNGs. Sizes >=256 are recorded as 0 per spec.
  const icoSizes = [256, 128, 64, 48, 32, 16]
  return Promise.all(icoSizes.map((s) => renderPng(svg, s))).then((bufs) => {
    const entries = bufs.map((buf, i) => ({ size: icoSizes[i], buf }))
    const headerSize = 6 + entries.length * 16
    let offset = headerSize
    let total = headerSize
    for (const e of entries) total += e.buf.length
    const ico = Buffer.alloc(total)
    ico.writeUInt16LE(0, 0)
    ico.writeUInt16LE(1, 2) // type: icon
    ico.writeUInt16LE(entries.length, 4)
    let at = 6
    for (const e of entries) {
      ico.writeUInt8(e.size >= 256 ? 0 : e.size, at)
      ico.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1)
      ico.writeUInt16LE(1, at + 4) // planes
      ico.writeUInt16LE(32, at + 6) // bpp
      ico.writeUInt32LE(e.buf.length, at + 8)
      ico.writeUInt32LE(offset, at + 12)
      e.buf.copy(ico, offset)
      offset += e.buf.length
      at += 16
    }
    return ico
  })
}

async function pixelDiff(bufA, bufB) {
  // Both buffers are PNG encodings of the same dimensions from the same
  // encoder family. Compare raw pixels; return the share of pixels whose
  // channels differ beyond the allowance.
  const [a, b] = await Promise.all([
    sharp(bufA).raw().toBuffer({ resolveWithObject: true }),
    sharp(bufB).raw().toBuffer({ resolveWithObject: true }),
  ])
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return 1 // dimension drift = totally stale
  }
  const ch = Math.min(a.info.channels, b.info.channels)
  let diff = 0
  const total = a.info.width * a.info.height
  for (let p = 0; p < total; p++) {
    for (let c = 0; c < ch; c++) {
      if (Math.abs(a.data[p * a.info.channels + c] - b.data[p * b.info.channels + c]) > 3) {
        diff++
        break
      }
    }
  }
  return diff / total
}

async function main() {
  const check = process.argv.includes('--check')
  const svg = fs.readFileSync(svgPath)

  if (!check) fs.mkdirSync(outDir, { recursive: true })

  const stale = []

  // 1. Size ladder + appicon + ico (from the SSOT)
  for (const size of SIZES) {
    const png = await renderPng(svg, size)
    const file = path.join(outDir, `icon-${size}.png`)
    if (check) {
      if (!fs.existsSync(file)) stale.push(`${file} (missing)`)
      else if ((await pixelDiff(png, fs.readFileSync(file))) > 0.005) stale.push(`${file} (pixel drift)`)
    } else {
      fs.writeFileSync(file, png)
      console.log(`  ✓ icon-${size}.png`)
    }
  }

  const appIcon = path.join(root, 'build/appicon.png')
  const appPng = await renderPng(svg, 512)
  if (check) {
    if (!fs.existsSync(appIcon)) stale.push(`${appIcon} (missing)`)
    else if ((await pixelDiff(appPng, fs.readFileSync(appIcon))) > 0.005) stale.push(`${appIcon} (pixel drift)`)
  } else {
    fs.writeFileSync(appIcon, appPng)
    console.log('  ✓ appicon.png (512x512 for Wails)')
  }

  const ico = await buildIco(svg)
  const icoPath = path.join(outDir, 'icon.ico')
  if (check) {
    if (!fs.existsSync(icoPath) || sha(ico) !== sha(fs.readFileSync(icoPath))) stale.push(`${icoPath} (stale)`)
  } else {
    fs.writeFileSync(icoPath, ico)
    console.log(`  ✓ icon.ico (6 sizes)`)
  }

  // 2. Cross-target derivatives (VS Code media, browser favicons)
  //    The favicon is the SSOT verbatim: the mark has no bevel or gradient
  //    any more, so there is nothing left to simplify for small sizes. One
  //    file, one letterform, no second copy to drift.
  const faviconSvg = svg
  if (check) {
    const favPath = path.join(root, 'docs/favicon.svg')
    if (!fs.existsSync(favPath) || sha(faviconSvg) !== sha(fs.readFileSync(favPath))) {
      stale.push(`${favPath} (stale)`)
    }
  } else {
    fs.writeFileSync(path.join(root, 'docs/favicon.svg'), faviconSvg)
    console.log('  ✓ docs/favicon.svg')
  }

  for (const d of DERIVED) {
    const gen = d.file.endsWith('.ico') ? ico : fs.readFileSync(path.join(root, d.file))
    const target = path.join(root, d.rel)
    if (check) {
      if (!fs.existsSync(target)) stale.push(`${target} (missing)`)
      else if (sha(gen) !== sha(fs.readFileSync(target))) stale.push(`${target} (stale)`)
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, gen)
      console.log(`  ✓ ${d.rel}`)
    }
  }

  // 3. Plugin-store mark → VS Code marketplace icon (media/icon.png)
  const pluginSvg = fs.readFileSync(pluginSvgPath)
  const pluginPng = await renderPng(pluginSvg, PLUGIN_ICON_SIZE)
  const vscodeIcon = path.join(root, 'ide/vscode/media/icon.png')
  if (check) {
    if (!fs.existsSync(pluginIconPng)) stale.push(`${pluginIconPng} (missing)`)
    else if ((await pixelDiff(pluginPng, fs.readFileSync(pluginIconPng))) > 0.005) {
      stale.push(`${pluginIconPng} (pixel drift)`)
    }
    if (!fs.existsSync(vscodeIcon)) stale.push(`${vscodeIcon} (missing)`)
    else if (sha(pluginPng) !== sha(fs.readFileSync(vscodeIcon))) stale.push(`${vscodeIcon} (stale)`)
  } else {
    fs.writeFileSync(pluginIconPng, pluginPng)
    fs.writeFileSync(vscodeIcon, pluginPng)
    console.log(`  ✓ build/icons/plugin-icon-${PLUGIN_ICON_SIZE}.png`)
    console.log('  ✓ ide/vscode/media/icon.png (from build/plugin-icon.svg)')
  }

  // 4. Plugin-store mark → VS Code activity-bar icon (media/repotory.svg)
  //    The same 512-grid SSOT geometry, verbatim, inside a 24 viewBox
  //    (0.046875): the activity bar and the marketplace listing show one
  //    printed card, not two marks. This file used to be a hand-drawn
  //    currentColor glyph with no card at all — when the brand moved to the
  //    paper card it was missed, so every install kept shipping the old
  //    grey R in the activity bar. Generated and sha-checked now, so the
  //    bar cannot drift from build/plugin-icon.svg again. Explicit brand
  //    fills (not currentColor): the card reads the same on light and dark
  //    activity bars, the same "brand face does not follow the theme" rule
  //    the JetBrains tool window band applies.
  const ACTIVITY_BAR_SIZE = 24
  const pluginInner = pluginSvg
    .toString()
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
  const activityBarSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ACTIVITY_BAR_SIZE} ${ACTIVITY_BAR_SIZE}" width="${ACTIVITY_BAR_SIZE}" height="${ACTIVITY_BAR_SIZE}">
  <!-- Activity-bar icon: build/plugin-icon.svg (plugin-store SSOT) verbatim,
       inside a 24 viewBox — the same printed card as the marketplace icon.
       Generated by scripts/generate-icons.mjs; do not edit by hand. -->
  <g transform="scale(${ACTIVITY_BAR_SIZE / 512})">
${pluginInner}
  </g>
</svg>
`
  const activityBarIcon = path.join(root, 'ide/vscode/media/repotory.svg')
  if (check) {
    if (!fs.existsSync(activityBarIcon)) stale.push(`${activityBarIcon} (missing)`)
    else if (sha(Buffer.from(activityBarSvg)) !== sha(fs.readFileSync(activityBarIcon))) {
      stale.push(`${activityBarIcon} (stale)`)
    }
  } else {
    fs.writeFileSync(activityBarIcon, activityBarSvg)
    console.log('  ✓ ide/vscode/media/repotory.svg (activity bar, 24px from build/plugin-icon.svg)')
  }

  // 5. Plugin-store mark → JetBrains tool-window icon (icons/repotory.svg)
  //    Same rewrap as the VS Code activity bar, at the IntelliJ tool-window
  //    idiom's 13×13. This was the JetBrains twin of the missed activity-bar
  //    icon: a hand-drawn grey R with no card, so the tool window kept the
  //    pre-rebrand mark while the Marketplace listing showed the card.
  //    Generated and sha-checked now. (The 40×40 Marketplace pair stays
  //    hand-scaled — the dark variant is a colour inversion, not a resize.)
  const TOOL_WINDOW_SIZE = 13
  const toolWindowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TOOL_WINDOW_SIZE}" height="${TOOL_WINDOW_SIZE}" viewBox="0 0 ${TOOL_WINDOW_SIZE} ${TOOL_WINDOW_SIZE}">
  <!-- Tool-window icon: build/plugin-icon.svg (plugin-store SSOT) verbatim,
       inside a 13 viewBox — the same printed card as the Marketplace icon.
       Generated by scripts/generate-icons.mjs; do not edit by hand. -->
  <g transform="scale(${TOOL_WINDOW_SIZE / 512})">
${pluginInner}
  </g>
</svg>
`
  const toolWindowIcon = path.join(root, 'ide/jetbrains/src/main/resources/icons/repotory.svg')
  if (check) {
    if (!fs.existsSync(toolWindowIcon)) stale.push(`${toolWindowIcon} (missing)`)
    else if (sha(Buffer.from(toolWindowSvg)) !== sha(fs.readFileSync(toolWindowIcon))) {
      stale.push(`${toolWindowIcon} (stale)`)
    }
  } else {
    fs.writeFileSync(toolWindowIcon, toolWindowSvg)
    console.log('  ✓ ide/jetbrains/src/main/resources/icons/repotory.svg (tool window, 13px from build/plugin-icon.svg)')
  }

  if (check) {
    if (stale.length) {
      console.error(`✗ ${stale.length} icon derivative(s) out of sync with build/icon.svg:`)
      for (const s of stale) console.error(`  - ${s}`)
      console.error('\nRun: node scripts/generate-icons.mjs')
      process.exit(1)
    }
    console.log('✓ all icon derivatives are in sync with build/icon.svg')
  } else {
    console.log(`\nAll icons generated (SSOT: build/icon.svg)`)
  }
}

main().catch((err) => {
  console.error('Failed to generate icons:', err)
  process.exit(1)
})
