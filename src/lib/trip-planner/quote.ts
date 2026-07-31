import defaultData from './default-data.json'

type TripData = Record<string, unknown>
type TripRecord = Record<string, unknown>

export interface TripQuoteInput {
  name?: string
  email?: string
  phone?: string
  trip_start_date?: string
  starting_city: string
  destination: string
  number_of_days: string | number
  hotel_category: string
  adults?: string | number
  children?: string | number
  rooms?: string | number
  transport_type: string
  query?: string
}

export interface TripQuoteResult {
  ok: true
  currency: string
  estimatedPrice: number
  priceText: string
  destination: string
  days: number
  startingCity: string
  startDate: string
  hotelCategory: string
  selectedHotel: string
  selectedRoom: string
  transport: string
  tourTitle: string
  summary: string
  itinerary: Array<{
    day: number
    title: string
    items: Array<{ time: string; activity: string }>
    hotel: string
  }>
}

function asRows(data: TripData, key: string): TripRecord[] {
  const value = data[key]
  return Array.isArray(value) ? (value as TripRecord[]) : []
}

function active(rows: TripRecord[]): TripRecord[] {
  return rows.filter((row) => row.active !== false)
}

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function titleValue(row: TripRecord): string {
  return String(row.name ?? row.title ?? '').trim()
}

function findByName(rows: TripRecord[], name: string): TripRecord | null {
  const target = norm(name)
  if (!target) return null
  return active(rows).find((row) => norm(row.name) === target || norm(row.title) === target) ?? null
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function intValue(value: unknown, fallback = 0): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

function matchingHotels(data: TripData, input: TripQuoteInput): TripRecord[] {
  return active(asRows(data, 'hotels')).filter(
    (hotel) =>
      norm(hotel.destination) === norm(input.destination) &&
      norm(hotel.category) === norm(input.hotel_category),
  )
}

function selectedHotel(data: TripData, input: TripQuoteInput): TripRecord | null {
  return matchingHotels(data, input)[0] ?? null
}

function selectedRoom(hotel: TripRecord | null): TripRecord | null {
  const rooms = Array.isArray(hotel?.rooms) ? (hotel.rooms as TripRecord[]) : []
  return rooms[0] ?? null
}

function selectedTour(data: TripData, input: TripQuoteInput): TripRecord | null {
  const days = intValue(input.number_of_days, 1)
  const tours = active(asRows(data, 'tours')).filter(
    (tour) =>
      norm(tour.destination) === norm(input.destination) &&
      intValue(tour.days) === days &&
      (!input.hotel_category || norm(tour.style) === norm(input.hotel_category)),
  )
  return (
    tours.find((tour) => !input.starting_city || norm(tour.startPoint) === norm(input.starting_city)) ??
    tours[0] ??
    null
  )
}

function calcPrice(
  data: TripData,
  input: TripQuoteInput,
  hotel: TripRecord | null,
  room: TripRecord | null,
  transport: TripRecord | null,
  tour: TripRecord | null,
): number {
  const days = intValue(input.number_of_days, 1)
  const adults = intValue(input.adults, 1)
  const children = intValue(input.children, 0)
  const rooms = intValue(input.rooms, 1)

  if (tour) {
    const defaultTransport = active(asRows(data, 'transports'))[0]
    const vehicleDelta =
      (numberValue(transport?.pricePerDay, numberValue(defaultTransport?.pricePerDay)) -
        numberValue(defaultTransport?.pricePerDay)) *
      days
    const adultDelta = Math.max(0, adults - 1) * 3500 * days
    const childDelta = Math.max(0, children) * 2200 * days
    const roomDelta = Math.max(0, rooms - 1) * numberValue(room?.price, 10000) * days
    return Math.max(0, numberValue(tour.price) + vehicleDelta + adultDelta + childDelta + roomDelta)
  }

  const category = findByName(asRows(data, 'hotelCategories'), input.hotel_category)
  const hotelRate = numberValue(category?.multiplier, 12000)
  const hotelPrices = matchingHotels(data, input).map((item) => numberValue(item.price)).filter(Boolean)
  const hotelFloor = numberValue(room?.price) || (hotelPrices.length ? Math.min(...hotelPrices) : hotelRate)
  const effectiveHotelRate = Math.max(hotelFloor, hotelRate)
  const transportRate = numberValue(transport?.pricePerDay, 8000)
  return ((effectiveHotelRate * rooms) + transportRate + 4000 * (adults + children)) * days
}

function buildItinerary(
  data: TripData,
  input: TripQuoteInput,
  hotel: TripRecord | null,
  room: TripRecord | null,
  tour: TripRecord | null,
): TripQuoteResult['itinerary'] {
  const days = intValue(input.number_of_days, 1)
  const destination = input.destination
  const destRecord = findByName(asRows(data, 'destinations'), destination)
  const image = String(destRecord?.image ?? '')
  const stayLine = hotel
    ? `${titleValue(hotel)}${room ? ` - ${titleValue(room)}` : ''}`.trim()
    : ''

  const byDestination = asRows(data, 'itineraries').filter(
    (row) => norm(row.destination) === norm(destination),
  )
  const exactRows = tour
    ? byDestination.filter((row) => String(row.tourTitle ?? '') === String(tour.title ?? ''))
    : []
  const sourceRows = (exactRows.length ? exactRows : byDestination)
    .slice()
    .sort((a, b) => intValue(a.day) - intValue(b.day) || intValue(a.id) - intValue(b.id))

  const uniqueRows = new Map<number, TripRecord>()
  for (const row of sourceRows) {
    const day = intValue(row.day)
    if (day && !uniqueRows.has(day)) uniqueRows.set(day, row)
  }

  const activities = active(asRows(data, 'activities'))
    .filter((row) => norm(row.destination) === norm(destination))
    .map((row) => titleValue(row))
    .filter(Boolean)
  const fallbacks = [
    `Departure from ${input.starting_city || 'starting city'} and travel toward ${destination}`,
    activities[0] ? `Visit ${activities[0]} and nearby viewpoints` : `Sightseeing in ${destination}`,
    activities[1] ? `Explore ${activities[1]} with photography stops` : 'Scenic valley excursion',
    activities[2] ? `Visit ${activities[2]} and local market` : 'Culture, food and leisure time',
    activities[3] ? `Adventure day around ${activities[3]}` : 'Nature walk and optional activities',
    `Return journey to ${input.starting_city || 'starting city'} and end of trip`,
  ]

  return Array.from({ length: days }, (_, index) => {
    const day = index + 1
    const row =
      uniqueRows.get(day) ??
      ({
        day,
        title: day === days ? `${input.starting_city || 'Return'} Departure` : `${destination} Experience`,
        image,
        time1: '09:00 AM',
        activity1: day === days ? fallbacks[fallbacks.length - 1] : fallbacks[Math.min(index, fallbacks.length - 2)],
        time2: day === days ? '' : '02:00 PM',
        activity2: day === days ? '' : activities[day] ? `Continue to ${activities[day]}` : 'Free time, meals and scenic stops',
      } satisfies TripRecord)

    const items = [
      ['time1', 'activity1'],
      ['time2', 'activity2'],
      ['time3', 'activity3'],
    ]
      .map(([timeKey, activityKey]) => {
        const time = String(row[timeKey] ?? '')
        const activity = String(row[activityKey] ?? '')
        if (!activity) return null
        return {
          time: norm(time) === 'hotel' ? 'Hotel' : time || 'Plan',
          activity: norm(time) === 'hotel' && stayLine ? stayLine : activity,
        }
      })
      .filter((item): item is { time: string; activity: string } => Boolean(item))

    if (stayLine && day < days && !items.some((item) => item.time === 'Hotel')) {
      items.push({ time: 'Hotel', activity: stayLine })
    }

    return {
      day,
      title: String(row.title ?? `${destination} Experience`),
      items,
      hotel: stayLine,
    }
  })
}

export function quoteTrip(input: TripQuoteInput, data: TripData = defaultData): TripQuoteResult {
  const transport = findByName(asRows(data, 'transports'), input.transport_type)
  const hotel = selectedHotel(data, input)
  const room = selectedRoom(hotel)
  const tour = selectedTour(data, input)
  const estimatedPrice = Math.round(calcPrice(data, input, hotel, room, transport, tour))
  const currency = String((data.settings as { currency?: string } | undefined)?.currency ?? 'PKR')
  const itinerary = buildItinerary(data, input, hotel, room, tour)
  const transportName = titleValue(transport ?? {}) || input.transport_type
  const hotelName = titleValue(hotel ?? {}) || 'Hotel to be confirmed'
  const roomName = titleValue(room ?? {})
  const days = intValue(input.number_of_days, itinerary.length || 1)

  return {
    ok: true,
    currency,
    estimatedPrice,
    priceText: `${currency} ${estimatedPrice.toLocaleString()}`,
    destination: input.destination,
    days,
    startingCity: input.starting_city,
    startDate: input.trip_start_date ?? '',
    hotelCategory: input.hotel_category,
    selectedHotel: hotelName,
    selectedRoom: roomName,
    transport: transportName,
    tourTitle: String(tour?.title ?? ''),
    summary: `${days} days ${input.destination} trip from ${input.starting_city} with ${input.hotel_category} hotel and ${transportName}.`,
    itinerary,
  }
}
