import defaultData from './default-data.json'
import type { SupabaseClient } from '@supabase/supabase-js'

type JsonRecord = Record<string, unknown>

const RECORD_TYPES = ['settings', 'routePresets', 'hotels', 'transportVehicles', 'transportRates', 'ziyarats']
const PORTAL_STORAGE_KEYS = [
  'umrahSettings',
  'umrahHotelOverrides',
  'umrahTransportOverrides',
  'umrahVehicleOverrides',
  'umrahZiyaratOverrides',
].join(',')

const CATEGORY_RANK: Record<string, number> = { Economy: 0, Standard: 1, Executive: 2 }
const DEFAULT_SECTOR_NAMES: Record<string, string> = {
  'JED APT-MAK HTL': 'Jeddah Airport to Makkah Hotel',
  'MAK HTL-JED APT': 'Makkah Hotel to Jeddah Airport',
  'MAK HTL-MED HTL': 'Makkah Hotel to Madina Hotel',
  'MED HTL-MAK HTL': 'Madina Hotel to Makkah Hotel',
  'JED APT-MED HTL': 'Jeddah Airport to Madina Hotel',
  'MED APT-MED HTL': 'Madina Airport to Madina Hotel',
  'MED HTL-MED APT': 'Madina Hotel to Madina Airport',
  'MAKKAH ZIYARAT': 'Makkah Ziyarat Tour',
  'MADINA ZIYARAT': 'Madina Ziyarat Tour',
}

export interface UmrahQuoteInput {
  name?: string
  phone?: string
  email?: string
  start_date: string
  route_preset_id?: string
  route_sequence?: string[]
  nights: string | number
  stop_nights?: Array<string | number>
  adults?: string | number
  children?: string | number
  infants?: string | number
  child_ages?: Array<string | number>
  rooms?: string | number
  room_type?: string
  hotel_category?: string
  budget?: string | number
  hotel_preference?: 'cheapest'
  selected_hotels?: Record<string, string>
  vehicle?: string
  transport_mode?: 'full' | 'selective'
  selected_sectors?: string[]
  include_visa?: boolean
  include_ziyarat?: boolean
  selected_ziyarats?: string[]
}

export interface UmrahQuoteResult {
  ok: true
  currency: 'PKR'
  total: number
  priceText: string
  route: string
  routeSequence: string[]
  startDate: string
  nights: number
  travelers: number
  visaTravelers: number
  rooms: number
  roomType: string
  hotelCategory: string
  vehicle: string
  hotelTotal: number
  transportTotal: number
  visaTotal: number
  ziyaratTotal: number
  profitTotal: number
  packageCategory: string
  hasMissingRates: boolean
  hotelLines: Array<{
    city: string
    nights: number
    checkIn: string
    checkOut: string
    hotel: string
    hotelId: string
    category: string
    distance: string
    meal: string
    total: number
    avgSar: number
    hasMissingRates: boolean
  }>
  transportSectors: Array<{ sector: string; label: string; amount: number }>
  ziyarats: Array<{ id: string; name: string; amount: number }>
  itinerary: Array<{
    title: string
    details: string[]
  }>
  summary: string
  whatsappText: string
}

function rows(data: JsonRecord, key: string): JsonRecord[] {
  const value = data[key]
  return Array.isArray(value) ? (value as JsonRecord[]) : []
}

function objectValues(value: unknown): JsonRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.values(value as JsonRecord).filter(
    (item): item is JsonRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item)),
  )
}

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function intValue(value: unknown, fallback = 0): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function money(value: number): string {
  return `PKR ${Math.round(value).toLocaleString()}`
}

function category(value: unknown): string {
  const key = norm(value)
  if (['budget', 'economy', 'normal', 'deluxe'].includes(key)) return 'Economy'
  if (['standard', 'premium'].includes(key)) return 'Standard'
  if (['executive', 'luxury', 'vip', '5 star', '5-star'].includes(key)) return 'Executive'
  return String(value || 'Economy')
}

function settings(data: JsonRecord): JsonRecord {
  const raw = data.settings
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as JsonRecord
  return {
    exchangeRate: numberValue(data.exchangeRate, 76),
    profitEconomySar: 200,
    profitStandardSar: 250,
    profitExecutiveSar: 300,
    visaPrice: 566,
  }
}

function exchangeRate(data: JsonRecord): number {
  return numberValue(settings(data).exchangeRate, numberValue(data.exchangeRate, 76))
}

function sarToPkr(data: JsonRecord, value: number): number {
  return Math.round(value * exchangeRate(data))
}

function parseDate(value: string): Date | null {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function formatDate(date: Date | null): string {
  if (!date) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function displayDate(value: string): string {
  const date = parseDate(value)
  if (!date) return value || 'date pending'
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function addDays(date: Date | null, days: number): Date | null {
  if (!date) return null
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function isSaudiWeekend(date: Date | null): boolean {
  return Boolean(date && (date.getDay() === 5 || date.getDay() === 6))
}

function routeSequence(data: JsonRecord, input: UmrahQuoteInput): string[] {
  if (input.route_sequence?.length) return input.route_sequence
  const routeId = input.route_preset_id || 'mk-md'
  const route = rows(data, 'routePresets').find((item) => item.id === routeId)
  const sequence = route?.sequence
  return Array.isArray(sequence) ? sequence.map(String) : ['Makkah', 'Madinah']
}

function distributedNights(total: number, stops: number): number[] {
  if (!stops) return []
  const base = Math.floor(Math.max(total, 0) / stops)
  const remainder = Math.max(total, 0) % stops
  return Array.from({ length: stops }, (_, index) => base + (index < remainder ? 1 : 0))
}

function stopPlan(data: JsonRecord, input: UmrahQuoteInput) {
  const sequence = routeSequence(data, input)
  const nights = intValue(input.nights, 6)
  const supplied = input.stop_nights?.map((value) => intValue(value, 0)) ?? []
  const stopNights = supplied.length === sequence.length && supplied.reduce((sum, value) => sum + value, 0) === nights
    ? supplied
    : distributedNights(nights, sequence.length)
  let cursor = parseDate(input.start_date)
  return sequence.map((city, index) => {
    const itemNights = stopNights[index] ?? 0
    const checkIn = cursor
    const checkOut = addDays(cursor, itemNights)
    cursor = checkOut
    return { city, index, nights: itemNights, checkIn, checkOut }
  })
}

function rateFromSet(rateSet: unknown, roomType: string, extraBed = 0): number {
  if (!rateSet || typeof rateSet !== 'object') return 0
  const set = rateSet as JsonRecord
  const rates = (set.rates && typeof set.rates === 'object' ? set.rates : set) as JsonRecord
  const direct = rates[roomType]
  if (direct !== undefined) return numberValue(direct)
  const fallback = rates.Double ?? rates.Triple ?? rates.Quad ?? rates.Single
  return numberValue(fallback) + extraBed
}

function rateForSeason(season: JsonRecord, roomType: string, date: Date | null, hotel: JsonRecord): number {
  const selectedSet = season.weekday || season.weekend
    ? (isSaudiWeekend(date) ? season.weekend || season.weekday : season.weekday || season.weekend)
    : season.rates
  return rateFromSet(selectedSet, roomType, numberValue(season.extraBed, numberValue(hotel.extraBed)))
}

function daysBetween(from: unknown, to: unknown): number {
  const start = parseDate(String(from ?? ''))
  const end = parseDate(String(to ?? ''))
  if (!start || !end) return Number.MAX_SAFE_INTEGER
  return Math.abs(end.getTime() - start.getTime())
}

function matchingSeason(hotel: JsonRecord, date: Date | null, roomType: string): JsonRecord | null {
  const iso = formatDate(date)
  if (!iso) return null
  const seasons = Array.isArray(hotel.seasonRates) ? (hotel.seasonRates as JsonRecord[]) : []
  return seasons
    .filter((season) => iso >= String(season.from ?? '') && iso < String(season.to ?? ''))
    .filter((season) => rateForSeason(season, roomType, date, hotel) > 0)
    .sort((a, b) => daysBetween(a.from, a.to) - daysBetween(b.from, b.to))[0] ?? null
}

function hotelStayCost(data: JsonRecord, hotel: JsonRecord | null, roomType: string, checkIn: Date | null, nights: number, childAges: number[]) {
  if (!hotel) return { totalSar: 0, avgSar: 0, hasMissingRates: true }
  let totalSar = 0
  let hasMissingRates = false
  const extraBedChildren = childAges.filter((age) => age >= 5).length
  for (let night = 0; night < nights; night += 1) {
    const date = addDays(checkIn, night)
    const season = matchingSeason(hotel, date, roomType)
    const rate = season ? rateForSeason(season, roomType, date, hotel) : 0
    const extraBedSar = extraBedChildren * numberValue(season?.extraBed, numberValue(hotel.extraBed))
    if (!rate) hasMissingRates = true
    totalSar += rate + extraBedSar
  }
  return { totalSar, avgSar: nights ? Math.round(totalSar / nights) : 0, hasMissingRates }
}

function stableIndex(seed: string, size: number): number {
  if (size <= 1) return 0
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % size
}

function selectHotel(
  data: JsonRecord,
  city: string,
  categoryValue: string,
  roomType: string,
  checkIn: Date | null,
  nights: number,
  childAges: number[],
  seed: string,
  hotelPreference?: 'cheapest',
  hotelId?: string,
): JsonRecord | null {
  const hotels = rows(data, 'hotels').filter((hotel) => norm(hotel.city) === norm(city))
  if (hotelId) return hotels.find((hotel) => hotel.id === hotelId) ?? null
  const preferred = hotels
    .filter((hotel) => category(hotel.category) === categoryValue && (hotel.seasonRates as unknown[] | undefined)?.length)
    .map((hotel) => ({
      hotel,
      stay: hotelStayCost(data, hotel, roomType, checkIn, nights, childAges),
    }))
  const available = preferred.filter((item) => item.stay.totalSar > 0 && !item.stay.hasMissingRates)
  const pool = (available.length ? available : preferred)
    .sort((a, b) => a.stay.totalSar - b.stay.totalSar)
  if (pool.length && hotelPreference === 'cheapest') return pool[0].hotel
  if (pool.length) return pool[stableIndex(seed, pool.length)].hotel
  const fallback = hotels.filter((hotel) => (hotel.seasonRates as unknown[] | undefined)?.length)
  return fallback[stableIndex(seed, fallback.length)] ?? hotels[stableIndex(seed, hotels.length)] ?? null
}

function defaultTransportSectors(sequence: string[]): string[] {
  const sectors: string[] = []
  if (sequence[0] === 'Makkah') sectors.push('JED APT-MAK HTL')
  if (sequence[0] === 'Madinah') sectors.push('MED APT-MED HTL')
  for (let index = 0; index < sequence.length - 1; index += 1) {
    if (sequence[index] === 'Makkah' && sequence[index + 1] === 'Madinah') sectors.push('MAK HTL-MED HTL')
    if (sequence[index] === 'Madinah' && sequence[index + 1] === 'Makkah') sectors.push('MED HTL-MAK HTL')
  }
  if (sequence[sequence.length - 1] === 'Makkah') sectors.push('MAK HTL-JED APT')
  if (sequence[sequence.length - 1] === 'Madinah') sectors.push('MED HTL-MED APT')
  return [...new Set(sectors)]
}

function sectorLabel(sector: string): string {
  return DEFAULT_SECTOR_NAMES[sector] ?? sector
    .replace(/\bAPT\b/g, 'Airport')
    .replace(/\bHTL\b/g, 'Hotel')
    .replace(/\bMED\b/g, 'Madina')
    .replace(/\bMAK\b/g, 'Makkah')
}

function profitSar(packageCategory: string, data: JsonRecord): number {
  const s = settings(data)
  if (packageCategory === 'Economy') return numberValue(s.profitEconomySar, 200)
  if (packageCategory === 'Executive') return numberValue(s.profitExecutiveSar, 300)
  return numberValue(s.profitStandardSar, numberValue(s.profitSar, 250))
}

function visaPriceSar(data: JsonRecord): number {
  const value = numberValue(settings(data).visaPrice, 566)
  const rate = exchangeRate(data)
  return value > 5000 && rate ? Math.round(value / rate) : value
}

export function quoteUmrah(input: UmrahQuoteInput, data: JsonRecord = defaultData): UmrahQuoteResult {
  const normalizedCategory = category(input.hotel_category)
  const roomType = String(input.room_type || 'Double')
  const roomsCount = Math.max(1, intValue(input.rooms, 1))
  const adults = Math.max(1, intValue(input.adults, 1))
  const children = Math.max(0, intValue(input.children, 0))
  const infants = Math.max(0, intValue(input.infants, 0))
  const childAges = (input.child_ages ?? []).map((age) => intValue(age, 0))
  const sequence = routeSequence(data, input)
  const stops = stopPlan(data, input)
  const selectedHotels = input.selected_hotels ?? {}

  const hotelLines = stops.map((stop) => {
    const hotelKey = `${stop.city}-${stop.index}`
    const hotel = selectHotel(
      data,
      stop.city,
      normalizedCategory,
      roomType,
      stop.checkIn,
      stop.nights,
      childAges,
      [
        stop.city,
        stop.index,
        input.start_date,
        input.nights,
        adults,
        children,
        infants,
        roomsCount,
        roomType,
        input.hotel_category,
        input.budget,
      ].join('|'),
      input.hotel_preference,
      selectedHotels[hotelKey],
    )
    const stay = hotelStayCost(data, hotel, roomType, stop.checkIn, stop.nights, childAges)
    return {
      city: stop.city,
      nights: stop.nights,
      checkIn: formatDate(stop.checkIn),
      checkOut: formatDate(stop.checkOut),
      hotel: String(hotel?.name ?? 'Hotel to be confirmed'),
      hotelId: String(hotel?.id ?? ''),
      category: category(hotel?.category ?? normalizedCategory),
      distance: String(hotel?.distance ?? ''),
      meal: String(hotel?.meal ?? ''),
      total: sarToPkr(data, stay.totalSar) * roomsCount,
      avgSar: stay.avgSar,
      hasMissingRates: stay.hasMissingRates,
    }
  })

  const hotelTotal = hotelLines.reduce((sum, line) => sum + line.total, 0)
  const vehicle = String(input.vehicle || 'Car')
  const sectors = input.transport_mode === 'selective' ? input.selected_sectors ?? [] : defaultTransportSectors(sequence)
  const transportSectors = sectors.map((sector) => {
    const row = rows(data, 'transportRates').find((item) => item.sector === sector)
    const rates = row?.rates && typeof row.rates === 'object' ? row.rates as JsonRecord : {}
    return { sector, label: sectorLabel(sector), amount: sarToPkr(data, numberValue(rates[vehicle])) }
  })
  const transportTotal = transportSectors.reduce((sum, sector) => sum + sector.amount, 0)

  const includeVisa = input.include_visa ?? true
  const visaTravelers = adults + children + infants
  const visaTotal = includeVisa ? sarToPkr(data, visaTravelers * visaPriceSar(data)) : 0
  const selectedZiyaratIds = input.selected_ziyarats?.length
    ? input.selected_ziyarats
    : ['makkah', 'madina']
  const ziyarats = (input.include_ziyarat ? selectedZiyaratIds : [])
    .map((id) => {
      const source = rows(data, 'ziyarats').find((item) => {
        const itemId = norm(item.id)
        const itemName = norm(item.name)
        return itemId === norm(id) || itemName.includes(norm(id))
      })
      const fallbackName = id === 'madina' ? 'Madina Ziyarat' : id === 'makkah' ? 'Makkah Ziyarat' : `${id} Ziyarat`
      const amountSar = numberValue(source?.price ?? source?.price_sar, id === 'madina' ? 1200 : 250)
      return { id, name: String(source?.name ?? fallbackName), amount: sarToPkr(data, amountSar) }
    })
  const ziyaratTotal = ziyarats.reduce((sum, item) => sum + item.amount, 0)

  const packageCategory = hotelLines.reduce((best, line) => {
    return CATEGORY_RANK[line.category] > CATEGORY_RANK[best] ? line.category : best
  }, 'Economy')
  const subtotal = hotelTotal + transportTotal + visaTotal + ziyaratTotal
  const profitTotal = subtotal ? sarToPkr(data, profitSar(packageCategory, data)) : 0
  const total = subtotal + profitTotal
  const route = sequence.join(' -> ').replace(/Madinah/g, 'Madina')
  const hasMissingRates = hotelLines.some((line) => line.hasMissingRates)
  const summary = `${intValue(input.nights, 0)} nights ${route} Umrah package for ${adults + children} travelers, ${roomsCount} ${roomType} room(s), ${vehicle} transport.`
  const itinerary = hotelLines.map((line, index) => ({
    title: `Stop ${index + 1}: ${line.city}`,
    details: [
      `${line.nights} night${line.nights === 1 ? '' : 's'} stay from ${displayDate(line.checkIn)} to ${displayDate(line.checkOut)}`,
      `Hotel: ${line.hotel}${line.category ? ` (${line.category})` : ''}`,
      line.distance ? `Location/distance: ${line.distance}` : '',
      line.meal ? `Meal plan: ${line.meal}` : '',
      line.hasMissingRates ? 'Some hotel nights need manual rate confirmation.' : 'Hotel season rates included.',
    ].filter(Boolean),
  }))
  if (ziyarats.length) {
    itinerary.push({
      title: 'Ziyarat tours',
      details: ziyarats.map((item) => `${item.name} included`),
    })
  }

  const hotelText = hotelLines
    .map((line) => `- ${line.city}: ${line.hotel} (${line.nights} nights, ${displayDate(line.checkIn)} to ${displayDate(line.checkOut)})`)
    .join('\n')
  const itineraryText = itinerary
    .map((item) => `${item.title}\n${item.details.map((detail) => `- ${detail}`).join('\n')}`)
    .join('\n\n')
  const whatsappText = [
    `Tours in Pakistan Umrah quotation`,
    ``,
    `Route: ${route}`,
    `Travel date: ${displayDate(input.start_date)}`,
    `Duration: ${input.nights} nights`,
    `Passengers: ${adults} adults, ${children} children, ${infants} infants`,
    `Rooms: ${roomsCount} x ${roomType}`,
    `Hotel category: ${packageCategory}`,
    `Vehicle: ${vehicle}`,
    ``,
    `Hotels:`,
    hotelText,
    ``,
    `Itinerary:`,
    itineraryText,
    ``,
    `Estimated total: ${money(total)}`,
    hasMissingRates ? `Some nights need manual rate confirmation before final booking.` : `Rates are based on available hotel season data.`,
    `Final price may vary based on availability and supplier confirmation.`,
  ].filter(Boolean).join('\n')

  return {
    ok: true,
    currency: 'PKR',
    total,
    priceText: money(total),
    route,
    routeSequence: sequence,
    startDate: input.start_date,
    nights: intValue(input.nights, 0),
    travelers: adults + children,
    visaTravelers,
    rooms: roomsCount,
    roomType,
    hotelCategory: normalizedCategory,
    vehicle,
    hotelTotal,
    transportTotal,
    visaTotal,
    ziyaratTotal,
    profitTotal,
    packageCategory,
    hasMissingRates,
    hotelLines,
    transportSectors,
    ziyarats,
    itinerary,
    summary,
    whatsappText,
  }
}

export async function loadUmrahPlannerDataForAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<JsonRecord> {
  const portalData = await loadUmrahPortalData()
  if (portalData) return portalData

  const { data, error } = await db
    .from('umrah_planner_records')
    .select('record_type,payload,active')
    .eq('account_id', accountId)
    .in('record_type', RECORD_TYPES)
    .order('created_at')

  if (error) {
    console.error('[umrah planner] failed to load account records:', error.message)
    return defaultData
  }
  if (!data?.length) return defaultData

  const out: JsonRecord = { ...defaultData }
  for (const recordType of RECORD_TYPES) {
    out[recordType] = recordType === 'settings' ? settings(defaultData) : []
  }

  for (const row of data as Array<{ record_type: string; payload: unknown; active: boolean }>) {
    if (!row.payload || typeof row.payload !== 'object') continue
    if (row.record_type === 'settings') {
      out.settings = { ...(out.settings as JsonRecord), ...(row.payload as JsonRecord) }
      continue
    }
    const target = out[row.record_type]
    if (!Array.isArray(target)) continue
    target.push({ ...(row.payload as JsonRecord), active: row.active })
  }
  return out
}

async function loadUmrahPortalData(): Promise<JsonRecord | null> {
  const baseUrl = process.env.UMRAH_PORTAL_API_URL || process.env.UMRAH_PORTAL_STORAGE_URL
  if (!baseUrl) return null

  try {
    const url = new URL(baseUrl)
    if (!url.searchParams.has('action')) url.searchParams.set('action', 'storage')
    if (!url.searchParams.has('keys')) url.searchParams.set('keys', PORTAL_STORAGE_KEYS)

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error('[umrah planner] portal data fetch failed:', res.status, res.statusText)
      return null
    }
    const payload = await res.json() as { ok?: boolean; items?: JsonRecord }
    if (!payload.ok || !payload.items) return null
    return normalizePortalStorageData(payload.items)
  } catch (err) {
    console.error('[umrah planner] portal data fetch failed:', err)
    return null
  }
}

function normalizePortalStorageData(items: JsonRecord): JsonRecord {
  const settingsValue = items.umrahSettings && typeof items.umrahSettings === 'object'
    ? items.umrahSettings as JsonRecord
    : {}
  const hotels = objectValues(items.umrahHotelOverrides)
  const transportRates = objectValues(items.umrahTransportOverrides)
  const vehicles = objectValues(items.umrahVehicleOverrides)
  const ziyarats = objectValues(items.umrahZiyaratOverrides)

  return {
    ...defaultData,
    settings: {
      ...settings(defaultData),
      ...settingsValue,
    },
    hotels: hotels.length ? hotels : rows(defaultData, 'hotels'),
    transportRates: transportRates.length ? transportRates : rows(defaultData, 'transportRates'),
    transportVehicles: vehicles.length
      ? vehicles.map((vehicle) => String(vehicle.id ?? vehicle.name ?? '')).filter(Boolean)
      : defaultData.transportVehicles,
    ziyarats: ziyarats.length ? ziyarats : rows(defaultData, 'ziyarats'),
  }
}
