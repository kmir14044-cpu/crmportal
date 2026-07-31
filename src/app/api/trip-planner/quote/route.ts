import { NextResponse } from 'next/server'
import { quoteTrip, type TripQuoteInput } from '@/lib/trip-planner/quote'

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Partial<TripQuoteInput> | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const required: Array<keyof TripQuoteInput> = [
    'starting_city',
    'destination',
    'number_of_days',
    'hotel_category',
    'transport_type',
  ]
  const missing = required.filter((key) => !String(body[key] ?? '').trim())
  if (missing.length) {
    return NextResponse.json({ error: `Missing fields: ${missing.join(', ')}` }, { status: 400 })
  }

  return NextResponse.json(
    quoteTrip({
      name: body.name,
      email: body.email,
      phone: body.phone,
      trip_start_date: body.trip_start_date,
      starting_city: String(body.starting_city),
      destination: String(body.destination),
      number_of_days: body.number_of_days!,
      hotel_category: String(body.hotel_category),
      adults: body.adults ?? 1,
      children: body.children ?? 0,
      rooms: body.rooms ?? 1,
      transport_type: String(body.transport_type),
      query: body.query,
    }),
  )
}
