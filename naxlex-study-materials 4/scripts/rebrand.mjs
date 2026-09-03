#!/usr/bin/env node
/**
 * Batch rebrand: swaps the Naxlex header/footer for Cambridge Nurse branding
 * and renames the teal "NCLEX Success Tips" box to "Success Tips".
 *
 * Usage:
 *   node scripts/rebrand.mjs <inputDir> <outputDir> [options]
 *
 * Options:
 *   --url "WWW.CAMBRIDGENURSE.COM"   brand url printed in header + footer
 *   --tips "Success Tips"            new title for the teal box
 *   --no-tips                        leave the teal box untouched
 *   --no-ocr                         use file names as titles instead of OCR
 *   --titles titles.csv              CSV of "filename,title" to override OCR
 *   --footer 0.045                   fraction of page height wiped for footer
 *   --pad 45                         extra space (px at 612-wide scale) added under the header
 *
 * Example:
 *   node scripts/rebrand.mjs ./in ./out --url WWW.CAMBRIDGENURSE.COM
 */

import { readdir, mkdir, writeFile, readFile } from "node:fs/promises"
import { join, extname, basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas"
import { createWorker } from "tesseract.js"

// Bundled fonts so output is identical on any machine (no system fonts needed)
const fontsDir = join(dirname(fileURLToPath(import.meta.url)), "fonts")
GlobalFonts.registerFromPath(join(fontsDir, "Sans-Bold.ttf"), "BrandSans")
GlobalFonts.registerFromPath(join(fontsDir, "ComicNeue-Bold.ttf"), "BrandComic")
const SANS = "BrandSans, Arial, Helvetica, sans-serif"
const COMIC = 'BrandComic, "Comic Sans MS", cursive, sans-serif'

/* ---------- args ---------- */
const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith("--"))
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def
}
const has = (name) => args.includes(`--${name}`)

const [inputDir, outputDir] = positional
if (!inputDir || !outputDir) {
  console.error("Usage: node scripts/rebrand.mjs <inputDir> <outputDir> [--url ...] [--tips ...]")
  process.exit(1)
}

const settings = {
  brandUrl: flag("url", "WWW.CAMBRIDGENURSE.COM"),
  tipsTitle: flag("tips", "Success Tips"),
  replaceTips: !has("no-tips"),
  useOcr: !has("no-ocr"),
  footerPct: Number(flag("footer", "0.045")),
  pad: flag("pad", null) != null ? Number(flag("pad", null)) : null, // override px (612-wide scale) added below the header
  titlesCsv: flag("titles", null),
}

const REF_W = 612
const TEAL = { r: 0, g: 167, b: 157 }
const isTeal = (r, g, b, tol = 22) =>
  Math.abs(r - TEAL.r) < tol && Math.abs(g - TEAL.g) < tol && Math.abs(b - TEAL.b) < tol

/* ---------- detection ---------- */
function detectTealBox(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data
  const step = 2
  for (let y = Math.round(h * 0.12); y < h; y += step) {
    let count = 0
    let left = w
    let right = 0
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      if (isTeal(data[i], data[i + 1], data[i + 2])) {
        count++
        if (x < left) left = x
        if (x > right) right = x
      }
    }
    if (count / (w / step) > 0.35) return { top: y, left, right }
  }
  return null
}

/* ---------- header geometry (612px reference units) ---------- */
// assets/header-ribbon.png is 340x173; its horizontal bar spans rows 54-130
// and the diagonal ribbon shape ends at x≈318, so the right edge is pure bar.
const RIBBON_PATH = join(dirname(fileURLToPath(import.meta.url)), "assets", "header-ribbon.png")
const RIBBON_W = 200
const RIBBON_K = RIBBON_W / 340
const RIBBON_H = 173 * RIBBON_K // ≈102
const BAR_TOP = 54 * RIBBON_K // ≈32
const BAR_BOTTOM = 130 * RIBBON_K // ≈76
const BAR_COLOR = "#0050cc"
const URL_BASELINE = RIBBON_H + 12 // ≈114
const HEADER_TOTAL_H = URL_BASELINE + 10 // content may start below this
const OLD_HEADER_H = 76 // fallback: old header incl. its @url tag

/**
 * Measure the source page's old header: the full-width blue bar plus the dark
 * "@url" pill hanging under its right end. Topic labels (e.g. "LEFT-SIDED
 * HEART FAILURE") often start on the LEFT while the url pill is still visible
 * on the RIGHT, so a full-width "first blank row" scan would run past the
 * topic and wipe it. Measure the bar, the url pill and the left-side content
 * independently so the caller can wipe only the url pill's own rectangle.
 * Returns { end, barEnd, urlEnd, urlLeft } in source pixels.
 */
function detectOldHeader(img, s) {
  const w = img.width
  const scanTo = Math.min(img.height, Math.round(140 * s))
  const c = createCanvas(w, scanTo)
  const cx = c.getContext("2d")
  cx.drawImage(img, 0, 0)
  const d = cx.getImageData(0, 0, w, scanTo).data
  const isDark = (x, y) => {
    const i = (y * w + x) * 4
    return d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200
  }
  const rowDark = (y, x0, x1) => {
    let n = 0
    for (let x = x0; x < x1; x++) if (isDark(x, y)) n++
    return n / (x1 - x0)
  }
  const split = Math.round(w * 0.55)
  const needLight = Math.max(2, Math.round(2 * s))
  const fallback = Math.round(OLD_HEADER_H * s)

  // bar end: first row (below the logo area) that is no longer mostly dark
  let barEnd = Math.round(48 * s)
  for (let y = Math.round(30 * s); y < scanTo; y++) {
    if (rowDark(y, 0, w) < 0.6) {
      barEnd = y
      break
    }
  }

  // url pill end: first blank run on the RIGHT side
  let urlEnd = fallback
  let lightRun = 0
  for (let y = barEnd; y < scanTo; y++) {
    if (rowDark(y, split, w) < 0.003) {
      lightRun++
      if (lightRun >= needLight) {
        urlEnd = y - needLight + 1
        break
      }
    } else {
      lightRun = 0
    }
  }

  // left content start: first row on the LEFT side with any dark pixels
  let contentStart = scanTo
  for (let y = barEnd; y < scanTo; y++) {
    if (rowDark(y, 0, split) >= 0.003) {
      contentStart = y
      break
    }
  }

  // url pill left edge, measured only on rows without left content
  let urlLeft = w
  const pureEnd = Math.min(urlEnd, contentStart)
  for (let y = barEnd; y < pureEnd; y++) {
    for (let x = Math.round(w * 0.5); x < urlLeft; x++) {
      if (isDark(x, y)) {
        urlLeft = x
        break
      }
    }
  }
  if (urlLeft >= w) urlLeft = Math.round(w * 0.65)

  return { end: Math.min(urlEnd, contentStart), barEnd, urlEnd, urlLeft }
}

/** Greedy word-wrap; shrinks the font until the text fits in `maxLines`. */
function fitLines(ctx, text, maxWidth, maxLines, startPx, minPx, fontFamily) {
  const words = text.split(/\s+/).filter(Boolean)
  for (let px = startPx; px >= minPx; px -= 0.5) {
    ctx.font = `bold ${px}px ${fontFamily}`
    const lines = []
    let cur = ""
    let tooLong = false
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word
      if (ctx.measureText(next).width <= maxWidth) {
        cur = next
      } else {
        if (!cur || ctx.measureText(word).width > maxWidth) {
          tooLong = true
          break
        }
        lines.push(cur)
        cur = word
      }
    }
    if (cur) lines.push(cur)
    if (!tooLong && lines.length <= maxLines) return { lines, px }
  }
  ctx.font = `bold ${minPx}px ${fontFamily}`
  return { lines: [text], px: minPx }
}

/* ---------- drawing ---------- */
function drawHeader(ctx, w, s, title, brandUrl, ribbon, old, pad = 0) {
  // wipe the old bar (now `pad` px lower) plus the new header zone, stopping
  // where left-side content (e.g. a topic pill) begins; the old "@url" pill
  // hangs lower on the right, so wipe its own rectangle separately
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, w, Math.max(old.end + pad, HEADER_TOTAL_H * s))
  if (old.urlEnd > old.end) {
    ctx.fillRect(old.urlLeft - 2 * s, old.barEnd + pad, w - old.urlLeft + 2 * s, old.urlEnd - old.barEnd + 2 * s)
  }

  const barTop = BAR_TOP * s
  const barH = (BAR_BOTTOM - BAR_TOP) * s
  const ribW = RIBBON_W * s
  const ribH = RIBBON_H * s

  // full-width bar, then the ribbon graphic over its left end
  ctx.fillStyle = BAR_COLOR
  ctx.fillRect(ribW - 12 * s, barTop, w - ribW + 12 * s, barH)
  ctx.drawImage(ribbon, 0, 0, ribW, ribH)

  // title: left-aligned beside the ribbon, wrapped to at most 2 lines
  const textX = ribW + 10 * s
  const maxWidth = w - textX - 12 * s
  const { lines, px } = fitLines(ctx, title.toUpperCase(), maxWidth, 2, 15 * s, 9 * s, SANS)
  const lineH = px * 1.15
  const blockH = lineH * lines.length
  ctx.fillStyle = "#ffffff"
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  lines.forEach((line, i) => {
    ctx.fillText(line, textX, barTop + barH / 2 - blockH / 2 + lineH * (i + 0.5))
  })

  // url line under the bar
  ctx.fillStyle = "#111111"
  ctx.font = `bold ${13 * s}px ${SANS}`
  ctx.textAlign = "right"
  ctx.textBaseline = "alphabetic"
  ctx.fillText(brandUrl.toUpperCase(), w - 10 * s, URL_BASELINE * s)
}

function drawFooter(ctx, w, h, s, brandUrl, footerPct) {
  const footerH = Math.max(h * footerPct, 24 * s)
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, h - footerH, w, footerH)
  ctx.fillStyle = "#222222"
  ctx.font = `bold ${9 * s}px ${SANS}`
  ctx.textAlign = "right"
  ctx.textBaseline = "alphabetic"
  ctx.fillText(brandUrl.toUpperCase(), w - 10 * s, h - 12 * s)
}

/* ---------- inline "www.naxlex.com" caption (diagram watermark) ---------- */

function isCaptionGreen(r, g, b) {
  return g > r + 25 && g > b + 5 && g < 200 && r < 140 && b < 170
}

/**
 * Some pages print a green "www.naxlex.com" caption next to a diagram. Find
 * it by colour (the only dark-green ink on the page), cover it and draw the
 * new brand url in the same colour / size / position.
 */
function replaceInlineCaption(ctx, w, h, s, brandUrl, bodyTop, bodyBottom) {
  const d = ctx.getImageData(0, bodyTop, w, bodyBottom - bodyTop).data
  const rows = bodyBottom - bodyTop
  const rowCount = new Int32Array(rows)
  for (let y = 0; y < rows; y++) {
    let n = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (isCaptionGreen(d[i], d[i + 1], d[i + 2])) n++
    }
    rowCount[y] = n
  }
  const minRow = Math.max(2, Math.round(2 * s))
  let y = 0
  while (y < rows) {
    if (rowCount[y] < minRow) {
      y++
      continue
    }
    let y1 = y
    while (y1 < rows && (rowCount[y1] >= minRow || (y1 + 1 < rows && rowCount[y1 + 1] >= minRow))) y1++
    const bandH = y1 - y
    if (bandH >= 7 * s && bandH <= 26 * s) {
      let x0 = w
      let x1 = 0
      let total = 0
      for (let yy = y; yy < y1; yy++) {
        for (let x = 0; x < w; x++) {
          const i = (yy * w + x) * 4
          if (isCaptionGreen(d[i], d[i + 1], d[i + 2])) {
            total++
            if (x < x0) x0 = x
            if (x > x1) x1 = x
          }
        }
      }
      const bandW = x1 - x0
      const density = total / Math.max(1, bandW * bandH)
      if (bandW >= 60 * s && bandW <= 220 * s && density > 0.08 && density < 0.6) {
        const top = bodyTop + y
        const bottom = bodyTop + y1
        let cr = 0,
          cg = 0,
          cb = 0,
          cn = 0
        for (let yy = y; yy < y1; yy++) {
          for (let x = x0; x <= x1; x++) {
            const i = (yy * w + x) * 4
            if (isCaptionGreen(d[i], d[i + 1], d[i + 2])) {
              cr += d[i]
              cg += d[i + 1]
              cb += d[i + 2]
              cn++
            }
          }
        }
        const bgI = (Math.max(0, y - 3) * w + Math.max(0, x0 - 4)) * 4
        const bg = `rgb(${d[bgI]},${d[bgI + 1]},${d[bgI + 2]})`
        const ink = `rgb(${Math.round(cr / cn)},${Math.round(cg / cn)},${Math.round(cb / cn)})`
        const padX = 6 * s
        const padY = 3 * s
        ctx.fillStyle = bg
        ctx.fillRect(x0 - padX, top - padY, bandW + padX * 2, bottom - top + padY * 2)
        ctx.fillStyle = ink
        ctx.font = `bold ${Math.round(bandH * 1.05)}px ${SANS}`
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(brandUrl.toLowerCase(), (x0 + x1) / 2, (top + bottom) / 2, Math.min(w - 20 * s, bandW * 1.6))
        return true
      }
    }
    y = y1 + 1
  }
  return false
}

function drawTipsTitle(ctx, s, box, title) {
  const bandTop = box.top + 2 * s
  const bandH = 28 * s
  const inset = 55 * s
  ctx.fillStyle = `rgb(${TEAL.r},${TEAL.g},${TEAL.b})`
  ctx.fillRect(box.left + inset, bandTop, box.right - box.left - inset * 2, bandH)

  const cx = (box.left + box.right) / 2
  const cy = bandTop + bandH / 2 + 2 * s
  ctx.fillStyle = "#ffffff"
  ctx.font = `bold ${16 * s}px ${COMIC}`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(title, cx, cy)
  const tw = ctx.measureText(title).width
  ctx.fillRect(cx - tw / 2, cy + 10 * s, tw, 1.5 * s)
}

/* ---------- OCR ---------- */
let worker = null
async function ocrTitle(img) {
  if (!worker) worker = await createWorker("eng")
  const s = img.width / REF_W
  const cw = Math.round(img.width * 0.45)
  const cy = Math.round(18 * s)
  const ch = Math.round(34 * s)
  const crop = createCanvas(cw * 3, ch * 3)
  const cctx = crop.getContext("2d")
  cctx.drawImage(img, img.width - cw, cy, cw, ch, 0, 0, crop.width, crop.height)
  const d = cctx.getImageData(0, 0, crop.width, crop.height)
  for (let i = 0; i < d.data.length; i += 4) {
    const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]
    const v = lum > 200 ? 0 : 255
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v
  }
  cctx.putImageData(d, 0, 0)
  const { data } = await worker.recognize(await crop.encode("png"))
  return data.text
    .replace(/[^A-Za-z0-9 &'()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[A-Za-z]{1,2}\s+)+(?=[A-Za-z]{3,})/, "")
    .trim()
}

const titleFromFileName = (name) =>
  basename(name, extname(name)).replace(/[-_]+/g, " ").replace(/\d+\s*$/, "").trim()

/* ---------- main ---------- */
async function main() {
  await mkdir(outputDir, { recursive: true })
  const ribbon = await loadImage(RIBBON_PATH)

  const overrides = new Map()
  if (settings.titlesCsv) {
    const csv = await readFile(settings.titlesCsv, "utf8")
    for (const line of csv.split(/\r?\n/)) {
      const [file, ...rest] = line.split(",")
      if (file && rest.length) overrides.set(file.trim(), rest.join(",").trim())
    }
  }

  const files = (await readdir(inputDir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
  console.log(`Processing ${files.length} file(s) from ${inputDir} -> ${outputDir}`)

  const report = ["file,title,tips_box_found"]
  let i = 0
  for (const file of files) {
    i++
    try {
      const img = await loadImage(join(inputDir, file))
      const w = img.width
      const h = img.height
      const s = w / REF_W

      let title = overrides.get(file)
      if (!title) title = settings.useOcr ? await ocrTitle(img) : titleFromFileName(file)
      if (!title) title = titleFromFileName(file)

      // Shift the page down so the new header (bar + url line) ends above the
      // content. Default is derived from the header geometry; --pad overrides.
      const old = detectOldHeader(img, s)
      const pad =
        settings.pad != null
          ? Math.round(settings.pad * s)
          : Math.max(0, Math.round(HEADER_TOTAL_H * s - old.end))
      const outH = h + pad
      const canvas = createCanvas(w, outH)
      const ctx = canvas.getContext("2d")
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, w, outH)
      ctx.drawImage(img, 0, pad)

      let tipsFound = false
      if (settings.replaceTips) {
        const box = detectTealBox(ctx, w, outH)
        if (box) {
          tipsFound = true
          drawTipsTitle(ctx, s, box, settings.tipsTitle)
        }
      }
      drawHeader(ctx, w, s, title, settings.brandUrl, ribbon, old, pad)
      drawFooter(ctx, w, outH, s, settings.brandUrl, settings.footerPct)
      const footerH = Math.max(outH * settings.footerPct, 24 * s)
      const captionSwapped = replaceInlineCaption(
        ctx, w, outH, s, settings.brandUrl,
        Math.round(HEADER_TOTAL_H * s), Math.round(outH - footerH),
      )
      if (captionSwapped) console.log(`  swapped inline url caption`)

      const outName = basename(file, extname(file)) + ".png"
      await writeFile(join(outputDir, outName), await canvas.encode("png"))
      report.push(`${file},"${title.replace(/"/g, '""')}",${tipsFound}`)
      console.log(`[${i}/${files.length}] ${file} -> "${title}"${tipsFound ? "" : "  (no tips box)"}`)
    } catch (err) {
      report.push(`${file},ERROR,${false}`)
      console.error(`[${i}/${files.length}] ${file} FAILED: ${err.message}`)
    }
  }

  await writeFile(join(outputDir, "_report.csv"), report.join("\n"))
  if (worker) await worker.terminate()
  console.log(`Done. Report written to ${join(outputDir, "_report.csv")}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
