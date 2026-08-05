import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadUmrahPlannerDataForAccount,
  quoteUmrah,
  type UmrahQuoteInput,
  type UmrahQuoteResult,
} from './quote'

type DbClient = SupabaseClient<any, 'public', any>

export interface UmrahQuoteSessionIdentity {
  accountId: string
  userId: string
  contactId: string
  conversationId: string
}

export interface UmrahFollowUpResult {
  consumed: boolean
  reply?: string
  changedFields?: Partial<UmrahQuoteInput>
  quote?: UmrahQuoteResult
  reason?: string
}

const YES_WORDS = /\b(yes|include|included|add|with|chahiye|kar\s*do|laga\s*do)\b/i
const NO_WORDS = /\b(no|remove|without|exclude|nahi|nahin|hata\s*do|mat)\b/i

function cleanNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function normalizeDate(text: string): string | undefined {
  const iso = text.match(/\b(20\d{2})[-\/.](0?[1-9]|1[0-2])[-\/.](0?[1-9]|[12]\d|3[01])\b/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`

  const dayFirst = text.match(/\b(0?[1-9]|[12]\d|3[01])[-\/.](0?[1-9]|1[0-2])[-\/.](20\d{2})\b/)
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2].padStart(2, '0')}-${dayFirst[1].padStart(2, '0')}`
  return undefined
}

function routeFromText(text: string): string | undefined {
  const value = text.toLowerCase().replace(/madinah/g, 'madina')
  if (/madina\s*(?:-|to|then|→|>)\s*makkah/.test(value)) return 'md-mk'
  if (/makkah\s*(?:-|to|then|→|>)\s*madina\s*(?:-|to|then|→|>)\s*makkah/.test(value)) return 'mk-md-mk'
  if (/madina\s*(?:-|to|then|→|>)\s*makkah\s*(?:-|to|then|→|>)\s*madina/.test(value)) return 'md-mk-md'
  if (/makkah\s*(?:-|to|then|→|>)\s*madina/.test(value)) return 'mk-md'
  return undefined
}

function roomTypeFromText(text: string): string | undefined {
  if (/\b(single)\b/i.test(text)) return 'Single'
  if (/\b(double|2\s*sharing|two\s*sharing)\b/i.test(text)) return 'Double'
  if (/\b(triple|3\s*sharing|three\s*sharing)\b/i.test(text)) return 'Triple'
  if (/\b(quad|4\s*sharing|four\s*sharing)\b/i.test(text)) return 'Quad'
  if (/\b(quint|5\s*sharing|five\s*sharing)\b/i.test(text)) return 'Quint'
  return undefined
}

function categoryFromText(text: string): string | undefined {
  if (/\b(economy|budget|normal)\b/i.test(text)) return 'Economy'
  if (/\b(standard|premium)\b/i.test(text)) return 'Standard'
  if (/\b(executive|luxury|vip|5\s*star)\b/i.test(text)) return 'Executive'
  return undefined
}

function vehicleFromText(text: string): string | undefined {
  if (/\b(hiace|hi-ace)\b/i.test(text)) return 'Hiace'
  if (/\b(staria)\b/i.test(text)) return 'Staria'
  if (/\b(coaster)\b/i.test(text)) return 'Coaster'
  if (/\b(bus)\b/i.test(text)) return 'Bus'
  if (/\b(suv|gmc)\b/i.test(text)) return 'SUV'
  if (/\b(car|sedan)\b/i.test(text)) return 'Car'
  return undefined
}

function boolChange(text: string, topic: RegExp): boolean | undefined {
  if (!topic.test(text)) return undefined
  if (NO_WORDS.test(text)) return false
  if (YES_WORDS.test(text) || topic.test(text)) return true
  return undefined
}

/**
 * Deterministic parser for follow-up modifications to the latest Umrah quote.
 * It only returns fields explicitly mentioned by the customer.
 */
export function parseUmrahQuoteChanges(message: string): Partial<UmrahQuoteInput> {
  const text = message.trim()
  const changes: Partial<UmrahQuoteInput> = {}

  const date = normalizeDate(text)
  if (date && /\b(date|travel|departure|start|trip|umrah)\b/i.test(text)) changes.start_date = date

  const route = routeFromText(text)
  if (route) changes.route_preset_id = route

  const nights = text.match(/\b(?:change|make|set|duration|stay|total)?\s*(\d{1,2})\s*(?:night|nights|raat|ratain)\b/i)
  if (nights) changes.nights = cleanNumber(nights[1])

  const mappings: Array<[keyof UmrahQuoteInput, RegExp]> = [
    ['adults', /\b(\d{1,2})\s*(?:adult|adults|baray|bare)\b/i],
    ['children', /\b(\d{1,2})\s*(?:child|children|kids|bachay|bache)\b/i],
    ['infants', /\b(\d{1,2})\s*(?:infant|infants|baby|babies)\b/i],
    ['rooms', /\b(\d{1,2})\s*(?:room|rooms|kamray|kamre)\b/i],
  ]
  for (const [key, regex] of mappings) {
    const match = text.match(regex)
    const value = cleanNumber(match?.[1])
    if (value !== undefined) (changes as Record<string, unknown>)[key] = value
  }

  const roomType = roomTypeFromText(text)
  if (roomType && /\b(room|sharing|single|double|triple|quad|quint)\b/i.test(text)) changes.room_type = roomType

  const category = categoryFromText(text)
  if (category && /\b(hotel|category|economy|budget|standard|premium|executive|luxury|vip)\b/i.test(text)) {
    changes.hotel_category = category
  }

  const vehicle = vehicleFromText(text)
  if (vehicle && /\b(vehicle|transport|car|sedan|staria|hiace|hi-ace|coaster|bus|suv|gmc)\b/i.test(text)) {
    changes.vehicle = vehicle
  }

  if (/\b(full\s*transport|all\s*transport|complete\s*transport)\b/i.test(text)) changes.transport_mode = 'full'
  if (/\b(selective\s*transport|selected\s*transport|only\s+.+transport)\b/i.test(text)) changes.transport_mode = 'selective'

  const visa = boolChange(text, /\bvisa\b/i)
  if (visa !== undefined) changes.include_visa = visa

  const ziyarat = boolChange(text, /\b(ziyarat|ziyarah|ziyarats|ziarat)\b/i)
  if (ziyarat !== undefined) changes.include_ziyarat = ziyarat

  return Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<UmrahQuoteInput>
}

export function isLatestQuoteRequest(message: string): boolean {
  return /\b(updated?|latest|revised|new)\b.*\b(quote|quotation|package|itinerary|plan)\b|\b(send|show|share)\b.*\b(quote|quotation|itinerary|package)\b/i.test(message)
}

export async function saveUmrahQuoteSession(
  db: DbClient,
  identity: UmrahQuoteSessionIdentity,
  input: UmrahQuoteInput,
  quote: UmrahQuoteResult,
): Promise<void> {
  const { error } = await db.from('umrah_quote_sessions').upsert(
    {
      account_id: identity.accountId,
      user_id: identity.userId,
      contact_id: identity.contactId,
      conversation_id: identity.conversationId,
      request_payload: input,
      result_payload: quote,
      status: 'quoted',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id,contact_id' },
  )
  if (error) throw error
}

export async function handleUmrahQuoteFollowUp(args: {
  db: DbClient
  identity: UmrahQuoteSessionIdentity
  message: string
}): Promise<UmrahFollowUpResult> {
  const { db, identity, message } = args
  const changes = parseUmrahQuoteChanges(message)
  const wantsLatest = isLatestQuoteRequest(message)
  if (!Object.keys(changes).length && !wantsLatest) return { consumed: false }

  const { data: session, error } = await db
    .from('umrah_quote_sessions')
    .select('id,request_payload,result_payload')
    .eq('account_id', identity.accountId)
    .eq('contact_id', identity.contactId)
    .maybeSingle()

  if (error) throw error
  if (!session) {
    return {
      consumed: true,
      reply: 'I could not find your recent Umrah quotation. Please start the Umrah planner again.',
      reason: 'session_not_found',
    }
  }

  if (!Object.keys(changes).length && wantsLatest) {
    const result = session.result_payload as UmrahQuoteResult | null
    return {
      consumed: true,
      reply: result?.whatsappText || 'Your saved quotation is available, but its WhatsApp summary is missing.',
      quote: result ?? undefined,
    }
  }

  const previous = session.request_payload as UmrahQuoteInput
  const nextInput: UmrahQuoteInput = { ...previous, ...changes }
  const plannerData = await loadUmrahPlannerDataForAccount(db, identity.accountId)
  const quote = quoteUmrah(nextInput, plannerData)

  await saveUmrahQuoteSession(db, identity, nextInput, quote)

  return {
    consumed: true,
    reply: quote.whatsappText,
    changedFields: changes,
    quote,
  }
}
