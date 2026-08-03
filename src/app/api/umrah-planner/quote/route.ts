import { NextResponse } from 'next/server'
import { quoteUmrah, type UmrahQuoteInput } from '@/lib/umrah-planner/quote'

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Partial<UmrahQuoteInput> | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const missing = ['start_date', 'nights'].filter((key) => !String(body[key as keyof UmrahQuoteInput] ?? '').trim())
  if (missing.length) {
    return NextResponse.json({ error: `Missing fields: ${missing.join(', ')}` }, { status: 400 })
  }

  return NextResponse.json(
    quoteUmrah({
      name: body.name,
      phone: body.phone,
      email: body.email,
      start_date: String(body.start_date),
      route_preset_id: body.route_preset_id ? String(body.route_preset_id) : 'mk-md',
      route_sequence: body.route_sequence,
      nights: body.nights!,
      stop_nights: body.stop_nights,
      adults: body.adults ?? 2,
      children: body.children ?? 0,
      infants: body.infants ?? 0,
      child_ages: body.child_ages,
      rooms: body.rooms ?? 1,
      room_type: body.room_type ? String(body.room_type) : 'Double',
      hotel_category: body.hotel_category ? String(body.hotel_category) : 'Economy',
      selected_hotels: body.selected_hotels,
      vehicle: body.vehicle ? String(body.vehicle) : 'Car',
      transport_mode: body.transport_mode ?? 'full',
      selected_sectors: body.selected_sectors,
      include_visa: body.include_visa ?? true,
      include_ziyarat: body.include_ziyarat ?? false,
      selected_ziyarats: body.selected_ziyarats,
    }),
  )
}
