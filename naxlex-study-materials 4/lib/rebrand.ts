/**
 * Batch rebranding engine.
 * All coordinates are expressed relative to a 612px-wide reference page
 * (US Letter at 72dpi, matching the source PNGs) and scaled to the actual
 * image size, so it works on any resolution export of the same layout.
 */

export type RebrandSettings = {
  brandUrl: string
  headerHeightPct: number // fraction of page height covered by old header (incl. the @url tag)
  footerHeightPct: number // fraction of page height covered by old footer
  replaceTipsTitle: boolean
  tipsTitle: string
  tipsTitleFind: string // the word(s) to strip from OCR'd title, e.g. "NCLEX"
  titleOverride?: string
}

export type ProcessedPage = {
  id: string
  fileName: string
  title: string
  ocrTitle: string
  originalUrl: string
  outputUrl: string | null
  outputBlob: Blob | null
  status: "queued" | "ocr" | "rendering" | "done" | "error"
  error?: string
  tipsBoxFound: boolean
}

export const DEFAULT_SETTINGS: RebrandSettings = {
  brandUrl: "WWW.CAMBRIDGENURSE.COM",
  headerHeightPct: 0.098, // ~78px of 792
  footerHeightPct: 0.045, // ~36px of 792
  replaceTipsTitle: true,
  tipsTitle: "Success Tips",
  tipsTitleFind: "NCLEX",
}

const REF_W = 612

/* ---------- colour helpers ---------- */

// Teal used by the "Success Tips" box in the source files (#00A79D)
const TEAL = { r: 0, g: 167, b: 157 }
function isTeal(r: number, g: number, b: number, tol = 22) {
  return (
    Math.abs(r - TEAL.r) < tol &&
    Math.abs(g - TEAL.g) < tol &&
    Math.abs(b - TEAL.b) < tol
  )
}

/**
 * Finds the top edge and horizontal extent of the teal tips box.
 * Scans rows; the first row where >35% of pixels are teal is the top.
 */
export function detectTealBox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  const data = ctx.getImageData(0, 0, w, h).data
  let top = -1
  let left = w
  let right = 0
  const step = 2
  // skip the header zone entirely so its gradient can't be mistaken for the box
  const startY = Math.round(h * 0.12)
  for (let y = startY; y < h; y += step) {
    let count = 0
    let rowLeft = w
    let rowRight = 0
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      if (isTeal(data[i], data[i + 1], data[i + 2])) {
        count++
        if (x < rowLeft) rowLeft = x
        if (x > rowRight) rowRight = x
      }
    }
    if (count / (w / step) > 0.35) {
      top = y
      left = rowLeft
      right = rowRight
      break
    }
  }
  if (top < 0) return null
  return { top, left, right }
}

/* ---------- drawing ---------- */

/* ---------- header geometry (all in 612px reference units) ---------- */

// The ribbon graphic in /templates/header-ribbon.png is 340x173. Inside it the
// horizontal bar occupies rows 54-130 and the diagonal ribbon shape ends at
// x≈318, so the last ~20px of the image are pure bar and can overlap the
// bar we draw across the rest of the page without a visible seam.
const RIBBON_SRC = "/templates/header-ribbon.png"
const RIBBON_NATIVE_W = 340
const RIBBON_NATIVE_H = 173
const RIBBON_BAR_TOP = 54
const RIBBON_BAR_BOTTOM = 130
const RIBBON_W = 200 // drawn width at reference scale
const RIBBON_K = RIBBON_W / RIBBON_NATIVE_W
const RIBBON_H = RIBBON_NATIVE_H * RIBBON_K // ≈102
const BAR_TOP = RIBBON_BAR_TOP * RIBBON_K // ≈32
const BAR_BOTTOM = RIBBON_BAR_BOTTOM * RIBBON_K // ≈76
const BAR_COLOR = "#0050cc"
const URL_BASELINE = RIBBON_H + 12 // ≈114, sits just under the ribbon
/** Total height the new header needs before page content may begin. */
export const HEADER_TOTAL_H = URL_BASELINE + 10
/** Fallback height of the old header (incl. its @url tag) if detection fails. */
const OLD_HEADER_H = 76

type OldHeader = {
  /** y where page content may begin (min of url-pill end and left content start) */
  end: number
  /** y where the full-width blue bar ends */
  barEnd: number
  /** y where the dark "@url" pill (right side, under the bar) ends */
  urlEnd: number
  /** x of the url pill's left edge */
  urlLeft: number
}

/**
 * Measure the source page's old header. The old header is a full-width blue
 * bar with a dark "@url" pill hanging under its right end. Topic labels (e.g.
 * the "LEFT-SIDED HEART FAILURE" pill) often start on the LEFT while the url
 * pill is still visible on the RIGHT, so a full-width "first blank row" scan
 * would run past the topic and wipe it. Instead we measure the bar, the url
 * pill and the left-side content independently and let the caller wipe only
 * the url pill's own rectangle.
 * All values are in source pixels.
 */
function detectOldHeader(img: HTMLImageElement, s: number): OldHeader {
  const w = img.naturalWidth
  const scanTo = Math.min(img.naturalHeight, Math.round(140 * s))
  const c = document.createElement("canvas")
  c.width = w
  c.height = scanTo
  const cx = c.getContext("2d")!
  cx.drawImage(img, 0, 0)
  const d = cx.getImageData(0, 0, w, scanTo).data
  const isDark = (x: number, y: number) => {
    const i = (y * w + x) * 4
    return d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200
  }
  // fraction of "dark" pixels in row y between x0 and x1
  const rowDark = (y: number, x0: number, x1: number) => {
    let n = 0
    for (let x = x0; x < x1; x++) if (isDark(x, y)) n++
    return n / (x1 - x0)
  }
  const split = Math.round(w * 0.55)
  const needLight = Math.max(2, Math.round(2 * s))
  const fallback = Math.round(OLD_HEADER_H * s)

  // 1. bar end: first row (below the logo area) that is no longer mostly dark
  let barEnd = Math.round(48 * s)
  for (let y = Math.round(30 * s); y < scanTo; y++) {
    if (rowDark(y, 0, w) < 0.6) {
      barEnd = y
      break
    }
  }

  // 2. url pill end: first blank run in the RIGHT part of the page
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

  // 3. left content start: first row in the LEFT part with any dark pixels
  let contentStart = scanTo
  for (let y = barEnd; y < scanTo; y++) {
    if (rowDark(y, 0, split) >= 0.003) {
      contentStart = y
      break
    }
  }

  // 4. url pill left edge, measured only on rows where no left content exists
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

let ribbonPromise: Promise<HTMLImageElement> | null = null
function getRibbon() {
  if (!ribbonPromise) ribbonPromise = loadImage(RIBBON_SRC)
  return ribbonPromise
}

/** Greedy word-wrap; shrinks the font until the text fits in `maxLines`. */
function fitLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  startPx: number,
  minPx: number,
  fontFamily: string,
) {
  const words = text.split(/\s+/).filter(Boolean)
  for (let px = startPx; px >= minPx; px -= 0.5) {
    ctx.font = `bold ${px}px ${fontFamily}`
    const lines: string[] = []
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

function drawHeader(
  ctx: CanvasRenderingContext2D,
  w: number,
  s: number,
  title: string,
  brandUrl: string,
  ribbon: HTMLImageElement,
  old: OldHeader,
  pad = 0,
) {
  // Wipe the old blue bar (now shifted down by `pad`) and the zone the new
  // header needs, but stop at the first row where LEFT-side content (e.g. a
  // topic pill) begins so it is never clipped. The old "@url" pill hangs
  // lower on the RIGHT, so wipe its own rectangle separately.
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, w, Math.max(old.end + pad, HEADER_TOTAL_H * s))
  if (old.urlEnd > old.end) {
    ctx.fillRect(old.urlLeft - 2 * s, old.barEnd + pad, w - old.urlLeft + 2 * s, old.urlEnd - old.barEnd + 2 * s)
  }

  const barTop = BAR_TOP * s
  const barBottom = BAR_BOTTOM * s
  const barH = barBottom - barTop
  const ribW = RIBBON_W * s
  const ribH = RIBBON_H * s

  // full-width bar, then the ribbon graphic on top of its left end
  ctx.fillStyle = BAR_COLOR
  ctx.fillRect(ribW - 12 * s, barTop, w - ribW + 12 * s, barH)
  ctx.drawImage(ribbon, 0, 0, ribW, ribH)

  // title: left-aligned beside the ribbon, wrapped to at most 2 lines
  const textX = ribW + 10 * s
  const maxWidth = w - textX - 12 * s
  const { lines, px } = fitLines(
    ctx,
    title.toUpperCase(),
    maxWidth,
    2,
    15 * s,
    9 * s,
    "Arial, Helvetica, sans-serif",
  )
  const lineH = px * 1.15
  const blockH = lineH * lines.length
  ctx.fillStyle = "#ffffff"
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  lines.forEach((line, i) => {
    ctx.fillText(line, textX, barTop + barH / 2 - blockH / 2 + lineH * (i + 0.5))
  })

  // url line under the bar, right-aligned
  ctx.fillStyle = "#111111"
  ctx.font = `bold ${13 * s}px Arial, Helvetica, sans-serif`
  ctx.textAlign = "right"
  ctx.textBaseline = "alphabetic"
  ctx.fillText(brandUrl.toUpperCase(), w - 10 * s, URL_BASELINE * s)
}

function drawFooter(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: number,
  brandUrl: string,
  footerPct: number,
) {
  const footerH = Math.max(h * footerPct, 24 * s)
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, h - footerH, w, footerH)
  ctx.fillStyle = "#222222"
  ctx.font = `bold ${9 * s}px Arial, Helvetica, sans-serif`
  ctx.textAlign = "right"
  ctx.textBaseline = "alphabetic"
  ctx.fillText(brandUrl.toUpperCase(), w - 10 * s, h - 12 * s)
}

/* ---------- inline "www.naxlex.com" caption (diagram watermark) ---------- */

// Dark teal-green used by the inline url caption printed under diagrams
function isCaptionGreen(r: number, g: number, b: number) {
  return g > r + 25 && g > b + 5 && g < 200 && r < 140 && b < 170
}

/**
 * Some pages print a green "www.naxlex.com" caption next to a diagram. Find
 * that text by colour (it is the only dark-green ink on the page), cover it
 * and draw the new brand url in the same colour / size / position.
 * Only the body area between header and footer is scanned; a hit needs a
 * compact cluster of green pixels the size of a short line of text.
 */
function replaceInlineCaption(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: number,
  brandUrl: string,
  bodyTop: number,
  bodyBottom: number,
) {
  const d = ctx.getImageData(0, bodyTop, w, bodyBottom - bodyTop).data
  const rows = bodyBottom - bodyTop
  // rows containing green ink
  const rowCount = new Int32Array(rows)
  for (let y = 0; y < rows; y++) {
    let n = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (isCaptionGreen(d[i], d[i + 1], d[i + 2])) n++
    }
    rowCount[y] = n
  }
  // group consecutive inked rows into bands
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
    // a caption is roughly 8–24px tall at reference scale
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
      // text-like: wide (60–220px), not a filled band, ink density moderate
      const density = total / Math.max(1, bandW * bandH)
      if (bandW >= 60 * s && bandW <= 220 * s && density > 0.08 && density < 0.6) {
        const top = bodyTop + y
        const bottom = bodyTop + y1
        // sample the ink colour and the surrounding background
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
        const text = brandUrl.toLowerCase()
        ctx.fillStyle = ink
        ctx.font = `bold ${Math.round(bandH * 1.05)}px "Comic Sans MS", "Comic Neue", Arial, sans-serif`
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(text, (x0 + x1) / 2, (top + bottom) / 2, Math.min(w - 20 * s, bandW * 1.6))
        return true
      }
    }
    y = y1 + 1
  }
  return false
}

function drawTipsTitle(
  ctx: CanvasRenderingContext2D,
  s: number,
  box: { top: number; left: number; right: number },
  title: string,
) {
  // The title band sits in the first ~30px (ref scale) of the box.
  // Leave room for the pushpins at both ends.
  const bandTop = box.top + 2 * s
  const bandH = 28 * s
  const inset = 55 * s
  ctx.fillStyle = `rgb(${TEAL.r},${TEAL.g},${TEAL.b})`
  ctx.fillRect(box.left + inset, bandTop, box.right - box.left - inset * 2, bandH)

  const cx = (box.left + box.right) / 2
  const cy = bandTop + bandH / 2 + 2 * s
  ctx.fillStyle = "#ffffff"
  ctx.font = `bold ${16 * s}px "Comic Sans MS", "Comic Neue", cursive, sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(title, cx, cy)
  const tw = ctx.measureText(title).width
  ctx.fillRect(cx - tw / 2, cy + 10 * s, tw, 1.5 * s)
}

/* ---------- OCR ---------- */

let workerPromise: Promise<import("tesseract.js").Worker> | null = null
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js")
      return createWorker("eng")
    })()
  }
  return workerPromise
}

/** OCR the right half of the old header where the page title lives. */
export async function ocrHeaderTitle(img: HTMLImageElement): Promise<string> {
  const s = img.naturalWidth / REF_W
  const crop = document.createElement("canvas")
  // Title sits in the right ~45% of the header, between y≈18 and y≈50 (ref px)
  const cw = Math.round(img.naturalWidth * 0.45)
  const cy = Math.round(18 * s)
  const ch = Math.round(34 * s)
  // upscale 3x for better OCR on small text
  crop.width = cw * 3
  crop.height = ch * 3
  const cctx = crop.getContext("2d")!
  cctx.drawImage(img, img.naturalWidth - cw, cy, cw, ch, 0, 0, crop.width, crop.height)
  // invert so white-on-teal becomes dark-on-light
  const d = cctx.getImageData(0, 0, crop.width, crop.height)
  for (let i = 0; i < d.data.length; i += 4) {
    const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]
    const v = lum > 200 ? 0 : 255
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v
  }
  cctx.putImageData(d, 0, 0)
  const worker = await getWorker()
  const {
    data: { text },
  } = await worker.recognize(crop)
  return text
    .replace(/[^A-Za-z0-9 &'()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // drop leading junk tokens like "EE" / "|" picked up from the logo edge
    .replace(/^(?:[A-Za-z]{1,2}\s+)+(?=[A-Za-z]{3,})/, "")
    .trim()
}

/* ---------- main ---------- */

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Could not load image"))
    img.src = src
  })
}

export async function renderRebrand(
  img: HTMLImageElement,
  title: string,
  settings: RebrandSettings,
): Promise<{ blob: Blob; tipsBoxFound: boolean }> {
  const w = img.naturalWidth
  const s = w / REF_W
  const ribbon = await getRibbon()
  // Measure the old header (bar + @url pill) and where the first content
  // (e.g. a topic pill on the left) starts, then shift the page down just
  // enough that the new header (bar + url line) finishes above that content.
  const old = detectOldHeader(img, s)
  const pad = Math.max(0, Math.round(HEADER_TOTAL_H * s - old.end))
  const h = img.naturalHeight + pad
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, pad)

  let tipsBoxFound = false
  if (settings.replaceTipsTitle) {
    const box = detectTealBox(ctx, w, h)
    if (box) {
      tipsBoxFound = true
      drawTipsTitle(ctx, s, box, settings.tipsTitle)
    }
  }

  drawHeader(ctx, w, s, title, settings.brandUrl, ribbon, old, pad)
  drawFooter(ctx, w, h, s, settings.brandUrl, settings.footerHeightPct)

  // swap any green "www.naxlex.com" caption printed beside a diagram
  const footerH = Math.max(h * settings.footerHeightPct, 24 * s)
  replaceInlineCaption(ctx, w, h, s, settings.brandUrl, Math.round(HEADER_TOTAL_H * s), Math.round(h - footerH))

  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
  )
  return { blob, tipsBoxFound }
}

export function titleFromFileName(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\d+\s*$/, "")
    .trim()
}
