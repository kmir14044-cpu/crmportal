import type { UmrahQuoteResult } from './quote'

function pdfEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/[\\()]/g, '\\$&')
    .replace(/[^\x20-\x7E]/g, '')
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
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
  const parts: Uint8Array[] = [ascii('%PDF-1.4\n')]
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
  return `PKR ${Math.round(value).toLocaleString('en-PK')}`
}

function wrapText(value: string, maxChars: number): string[] {
  const words = pdfEscape(value).split(/\s+/)
  const rows: string[] = []
  let row = ''
  for (const word of words) {
    if (`${row} ${word}`.trim().length > maxChars) {
      if (row) rows.push(row)
      row = word
    } else {
      row = `${row} ${word}`.trim()
    }
  }
  if (row) rows.push(row)
  return rows
}

export function buildUmrahQuotePdf(quote: UmrahQuoteResult): Uint8Array {
  const pages: string[] = []
  let commands: string[] = []
  let y = 760
  const left = 44

  const add = (cmd: string) => commands.push(cmd)
  const text = (value: string, x: number, yy: number, size = 10, font = 'F1') => {
    add(`0.06 0.09 0.14 rg BT /${font} ${size} Tf ${x} ${yy} Td (${pdfEscape(value)}) Tj ET`)
  }
  const line = (yy: number) => add(`0.82 0.86 0.84 RG ${left} ${yy} m 551 ${yy} l S`)
  const newPage = () => {
    pages.push(commands.join('\n'))
    commands = []
    y = 760
  }
  const ensure = (height: number) => {
    if (y - height < 70) newPage()
  }
  const row = (label: string, value: string) => {
    ensure(18)
    text(label, left, y, 9, 'F2')
    text(value, 190, y, 9)
    y -= 18
  }
  const paragraph = (value: string, maxChars = 92) => {
    for (const lineText of wrapText(value, maxChars)) {
      ensure(14)
      text(lineText, left, y, 9)
      y -= 14
    }
  }
  const section = (title: string) => {
    ensure(30)
    y -= 10
    text(title, left, y, 12, 'F2')
    y -= 10
    line(y)
    y -= 16
  }

  add('0.05 0.36 0.26 rg 0 792 595 50 re f')
  text('TOURS IN PAKISTAN', left, 816, 18, 'F2')
  text('Umrah Package Quotation', left, 798, 10)
  y = 740

  row('Route', quote.route)
  row('Travel date', quote.startDate)
  row('Duration', `${quote.nights} nights`)
  row('Passengers', `${quote.travelers} traveler${quote.travelers === 1 ? '' : 's'}`)
  row('Rooms', `${quote.rooms} x ${quote.roomType}`)
  row('Hotel category', quote.hotelCategory)
  row('Vehicle', quote.vehicle)
  row('Estimated total', money(quote.total))

  section('Hotels')
  quote.hotelLines.forEach((hotel) => {
    paragraph(`${hotel.city}: ${hotel.hotel} (${hotel.nights} nights, ${hotel.checkIn} to ${hotel.checkOut})`)
    if (hotel.distance) paragraph(`Location / distance: ${hotel.distance}`)
    if (hotel.meal) paragraph(`Meal plan: ${hotel.meal}`)
    y -= 4
  })

  section('Itinerary')
  quote.itinerary.forEach((item) => {
    paragraph(item.title, 82)
    item.details.forEach((detail) => paragraph(`- ${detail}`, 88))
    y -= 4
  })

  section('Terms');
  [
    'This quotation is an estimate, not a confirmed booking.',
    'Rates are subject to availability at the time of final booking and may change without prior notice.',
    'Final booking is issued only after supplier confirmation and payment clearance.',
    'Visa approval is subject to Saudi authorities and passport validity requirements.',
    'Final price may vary based on availability and confirmation.',
  ].forEach((item) => paragraph(`- ${item}`, 88));

  pages.push(commands.join('\n'))

  const pageObjects: Uint8Array[] = []
  const pageRefs: string[] = []
  const fontObjects = [
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'),
  ]
  const catalogIndex = 1
  const pagesIndex = 2
  const fontStart = 3
  let nextObject = 5

  pages.forEach((content) => {
    const contentIndex = nextObject
    const pageIndex = nextObject + 1
    nextObject += 2
    pageRefs.push(`${pageIndex} 0 R`)
    pageObjects.push(ascii(`<< /Length ${ascii(content).length} >>\nstream\n${content}\nendstream`))
    pageObjects.push(ascii(`<< /Type /Page /Parent ${pagesIndex} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontStart} 0 R /F2 ${fontStart + 1} 0 R >> >> /Contents ${contentIndex} 0 R >>`))
  })

  const objects = [
    ascii(`<< /Type /Catalog /Pages ${pagesIndex} 0 R >>`),
    ascii(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`),
    ...fontObjects,
    ...pageObjects,
  ]
  void catalogIndex
  return writePdfObjects(objects)
}
