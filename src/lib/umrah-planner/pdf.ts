import type { UmrahQuoteResult } from './quote'

// Brand-style PDF matching the supplied Tours in Pakistan quotation layout.
// Self-contained: no external PDF library or network asset is required.

const LOGO_JPEG_BASE64 = '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'

function pdfEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/[\\()]/g, '\\$&')
    .replace(/[^\x20-\x7E]/g, '')
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function base64Bytes(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    if (char === '=') break
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

function combineBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function writePdfObjects(objects: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')]
  const offsets = [0]
  let length = parts[0].length

  objects.forEach((object, index) => {
    offsets.push(length)
    const prefix = ascii(`${index + 1} 0 obj\n`)
    const suffix = ascii('\nendobj\n')
    parts.push(prefix, object, suffix)
    length += prefix.length + object.length + suffix.length
  })

  const xrefOffset = length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach((offset) => {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  xref += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  parts.push(ascii(xref))
  return combineBytes(parts)
}

function money(value: number): string {
  return `Rs. ${Math.round(value).toLocaleString('en-PK')}`
}

function displayDate(value: string): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return value
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function preparedDate(): string {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function wrap(value: string, maxChars: number): string[] {
  const words = pdfEscape(value).split(/\s+/).filter(Boolean)
  if (!words.length) return ['']
  const rows: string[] = []
  let row = ''
  for (const word of words) {
    const next = row ? `${row} ${word}` : word
    if (next.length > maxChars && row) {
      rows.push(row)
      row = word
    } else {
      row = next
    }
  }
  if (row) rows.push(row)
  return rows
}

function streamObject(content: Uint8Array, dict = ''): Uint8Array {
  return combineBytes([
    ascii(`<< /Length ${content.length}${dict ? ` ${dict}` : ''} >>\nstream\n`),
    content,
    ascii('\nendstream'),
  ])
}

export function buildUmrahQuotePdf(quote: UmrahQuoteResult): Uint8Array {
  const PAGE_W = 595
  const PAGE_H = 842
  const M = 22
  const RIGHT = PAGE_W - M

  const GREEN = '0.075 0.345 0.180'
  const DARK = '0.105 0.125 0.145'
  const GRAY = '0.360 0.390 0.430'
  const LIGHT_LINE = '0.830 0.875 0.850'
  const PALE_GREEN = '0.955 0.975 0.962'

  const pages: string[] = []

  const page1: string[] = []
  const add1 = (cmd: string) => page1.push(cmd)
  const text1 = (value: string, x: number, y: number, size = 9, font = 'F1', color = DARK) =>
    add1(`${color} rg BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(value)}) Tj ET`)
  const rect1 = (x: number, y: number, w: number, h: number, fill: string | null = null, stroke = LIGHT_LINE, lineWidth = 0.7) => {
    if (fill) add1(`${fill} rg ${x} ${y} ${w} ${h} re f`)
    add1(`${stroke} RG ${lineWidth} w ${x} ${y} ${w} ${h} re S`)
  }
  const line1 = (x1: number, y1: number, x2: number, y2: number, color = GREEN, width = 1.8) =>
    add1(`${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`)

  // Logo image (same logo extracted from the supplied reference PDF).
  add1('q 92 0 0 45 20 767 cm /Im1 Do Q')
  line1(20, 736, 123, 736, LIGHT_LINE, 1)
  text1('Prepared quotation', 420, 792, 9, 'F1', GRAY)
  text1(preparedDate(), 420, 777, 9, 'F1', GRAY)
  text1('Umrah Package Quotation', M, 708, 11, 'F1', GRAY)

  // Total / customer summary card.
  rect1(M, 619, RIGHT - M, 76, PALE_GREEN, LIGHT_LINE, 0.7)
  text1('Estimated Total', M + 7, 675, 10, 'F2', DARK)
  text1(money(quote.total), M + 7, 635, 26, 'F2', GREEN)
  text1('Prepared for: WhatsApp Customer', 294, 675, 8.8, 'F2', GRAY)
  text1('Final price may vary based on availability and confirmation.', 294, 651, 7.8, 'F1', GRAY)
  text1('Agency WhatsApp: +923148148469', 294, 625, 7.8, 'F1', GRAY)

  // Duration / travelers / rooms grid.
  const gridY = 554
  const gridH = 49
  const gridW = RIGHT - M
  rect1(M, gridY, gridW, gridH, null, LIGHT_LINE, 0.7)
  const c1 = M + gridW / 3
  const c2 = M + (gridW * 2) / 3
  line1(c1, gridY, c1, gridY + gridH, LIGHT_LINE, 0.7)
  line1(c2, gridY, c2, gridY + gridH, LIGHT_LINE, 0.7)
  text1('Duration', M + 7, 586, 8.5, 'F2', GRAY)
  text1('Travelers', c1 + 7, 586, 8.5, 'F2', GRAY)
  text1('Rooms', c2 + 7, 586, 8.5, 'F2', GRAY)
  text1(`${quote.nights} nights`, M + 7, 565, 9, 'F1', DARK)
  text1(`${quote.travelers} pax`, c1 + 7, 565, 9, 'F1', DARK)
  text1(`${quote.rooms} x ${quote.roomType}`, c2 + 7, 565, 9, 'F1', DARK)

  // Section helper.
  const sectionTitle1 = (title: string, y: number) => {
    text1(title, M, y, 14, 'F2', GREEN)
    line1(M, y - 10, RIGHT, y - 10, GREEN, 1.8)
  }

  sectionTitle1('Package Route', 535)
  rect1(M, 486, gridW, 39, null, LIGHT_LINE, 0.7)
  text1(quote.route.replace(/->/g, '->'), M + 7, 510, 9, 'F1', DARK)
  text1(`Travel date: ${quote.startDate}`, M + 7, 494, 8.4, 'F1', GRAY)

  sectionTitle1('Selected Hotels', 465)
  const hotelRows = quote.hotelLines.slice(0, 3)
  const rowH = 42
  const tableTop = 450
  const tableBottom = tableTop - rowH * Math.max(1, hotelRows.length)
  rect1(M, tableBottom, gridW, tableTop - tableBottom, null, LIGHT_LINE, 0.7)
  line1(M + 112, tableBottom, M + 112, tableTop, LIGHT_LINE, 0.7)
  line1(M + 400, tableBottom, M + 400, tableTop, LIGHT_LINE, 0.7)
  add1(`${GREEN} rg ${M - 2} ${tableBottom} 4 ${tableTop - tableBottom} re f`)
  hotelRows.forEach((hotel, index) => {
    const top = tableTop - index * rowH
    if (index > 0) line1(M, top, RIGHT, top, LIGHT_LINE, 0.7)
    const base = top - 17
    text1(hotel.city.replace(/Madinah/g, 'Madina'), M + 7, base, 8.6, 'F1', DARK)
    text1(hotel.hotel, M + 120, base, 8.4, 'F1', DARK)
    text1(`${hotel.nights} nights | ${displayDate(hotel.checkIn)} to ${displayDate(hotel.checkOut)}`, M + 120, base - 14, 7.6, 'F1', GRAY)
    text1(hotel.category || quote.hotelCategory, M + 408, base, 8.2, 'F1', DARK)
    text1(hotel.hasMissingRates ? 'Rate confirmation needed' : 'Rates included', M + 408, base - 14, 7.4, 'F1', GRAY)
  })

  const transportTitleY = tableBottom - 25
  sectionTitle1('Transport', transportTitleY)
  const transportBoxTop = transportTitleY - 22
  rect1(M, transportBoxTop - 45, gridW, 45, null, LIGHT_LINE, 0.7)
  text1(quote.vehicle, M + 7, transportBoxTop - 17, 8.6, 'F1', DARK)
  text1(quote.transportSectors.length > 1 ? 'Full transport' : 'Selected transport', M + 7, transportBoxTop - 33, 7.5, 'F1', GRAY)
  const sectorsText = quote.transportSectors.map((item) => item.label).join(', ') || 'Transport details to be confirmed'
  wrap(sectorsText, 72).slice(0, 2).forEach((row, index) =>
    text1(row, M + 182, transportBoxTop - 17 - index * 14, 7.5, 'F1', DARK),
  )

  const extrasTitleY = transportBoxTop - 68
  sectionTitle1('Extras', extrasTitleY)
  const extrasTop = extrasTitleY - 22
  rect1(M, extrasTop - 52, gridW, 52, null, LIGHT_LINE, 0.7)
  text1('Visa Processing', M + 7, extrasTop - 17, 8.2, 'F1', DARK)
  text1(`${quote.visaTravelers} traveler${quote.visaTravelers === 1 ? '' : 's'} included`, M + 144, extrasTop - 17, 8.0, 'F1', DARK)
  text1('Ziyarat', M + 7, extrasTop - 39, 8.2, 'F1', DARK)
  const ziyaratNames = quote.ziyarats.length ? quote.ziyarats.map((item) => item.name).join(', ') : 'Not included'
  wrap(ziyaratNames, 78).slice(0, 2).forEach((row, index) =>
    text1(row, M + 144, extrasTop - 39 - index * 12, 7.7, 'F1', DARK),
  )

  text1('Tours in Pakistan | WhatsApp +923148148469 | toursinpakistan.com', M, 26, 7.2, 'F1', GRAY)
  text1('Final booking subject to availability, supplier confirmation and payment clearance.', M, 14, 6.9, 'F1', GRAY)
  pages.push(page1.join('\n'))

  // Page 2 - Rules & Regulations.
  const page2: string[] = []
  const add2 = (cmd: string) => page2.push(cmd)
  const text2 = (value: string, x: number, y: number, size = 9, font = 'F1', color = DARK) =>
    add2(`${color} rg BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(value)}) Tj ET`)
  const line2 = (x1: number, y1: number, x2: number, y2: number, color = GREEN, width = 1.8) =>
    add2(`${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`)

  add2('q 92 0 0 45 20 767 cm /Im1 Do Q')
  line2(20, 736, 123, 736, LIGHT_LINE, 1)
  text2('Quotation details', 420, 792, 9, 'F1', GRAY)
  text2(preparedDate(), 420, 777, 9, 'F1', GRAY)
  text2('Rules & Regulations', M, 708, 15, 'F2', GREEN)
  line2(M, 695, RIGHT, 695, GREEN, 1.8)

  const rules = [
    'Rates are subject to availability at the time of final booking and may change without prior notice.',
    'Hotel check-in and check-out policies are controlled by the selected hotel.',
    'Room bedding, view, floor and exact allocation remain subject to hotel confirmation.',
    'Saudi weekend pricing is applied for Friday and Saturday where weekend rates are supplied.',
    'Transport waiting time, parking, luggage handling and route changes may create extra charges.',
    'Jeddah Hajj terminal parking or airport parking charges are not included unless stated in writing.',
    'Visa approval is subject to Saudi authorities and passport validity requirements.',
    'Passport bio page copy must be clear and passport should normally have at least 6 months validity.',
    'Any force majeure, airline schedule change, hotel overbooking, government rule change or road closure is outside agency control.',
    'Final confirmation is issued only after payment clearance and supplier confirmation.',
  ]

  let ry = 666
  for (const rule of rules) {
    const lines = wrap(rule, 100)
    text2('-', M + 4, ry, 9, 'F2', GREEN)
    lines.forEach((row, index) => text2(row, M + 16, ry - index * 14, 8.2, 'F1', DARK))
    ry -= lines.length * 14 + 10
  }

  text2('Tours in Pakistan | WhatsApp +923148148469 | toursinpakistan.com', M, 26, 7.2, 'F1', GRAY)
  text2('Final booking subject to availability, supplier confirmation and payment clearance.', M, 14, 6.9, 'F1', GRAY)
  pages.push(page2.join('\n'))

  // PDF objects: catalog, pages, fonts, logo, then page content/page objects.
  // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 logo image.
  const logo = base64Bytes(LOGO_JPEG_BASE64)
  const imageObject = combineBytes([
    ascii('<< /Type /XObject /Subtype /Image /Width 215 /Height 105 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + logo.length + ' >>\nstream\n'),
    logo,
    ascii('\nendstream'),
  ])

  const pageObjects: Uint8Array[] = []
  const pageRefs: string[] = []
  let nextObject = 6

  pages.forEach((content) => {
    const contentIndex = nextObject
    const pageIndex = nextObject + 1
    nextObject += 2
    pageRefs.push(`${pageIndex} 0 R`)
    pageObjects.push(streamObject(ascii(content)))
    pageObjects.push(ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im1 5 0 R >> >> ` +
      `/Contents ${contentIndex} 0 R >>`,
    ))
  })

  const objects: Uint8Array[] = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`),
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'),
    imageObject,
    ...pageObjects,
  ]

  return writePdfObjects(objects)
}
