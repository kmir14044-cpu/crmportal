import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { loadUmrahPlannerDataForAccount, quoteUmrah } from '@/lib/umrah-planner/quote'

type AdminClient = ReturnType<typeof supabaseAdmin>

const DEFAULT_AI_LEAD_STAGES = [
  { name: 'New Lead', color: '#3b82f6', position: 0 },
  { name: 'Qualified', color: '#eab308', position: 1 },
  { name: 'Proposal Sent', color: '#f97316', position: 2 },
  { name: 'Negotiation', color: '#8b5cf6', position: 3 },
  { name: 'Won', color: '#22c55e', position: 4 },
]

const TRAVEL_INTENT_PATTERNS = [
  /\bumrah\b/i,
  /\bhajj\b/i,
  /\btour\b/i,
  /\btrip\b/i,
  /\bpackage\b/i,
  /\bbooking\b/i,
  /\bhunza\b/i,
  /\bskardu\b/i,
  /\bnaran\b/i,
  /\bkaghan\b/i,
  /\bswat\b/i,
  /\bkashmir\b/i,
  /\bmurree\b/i,
  /\bgaliyat\b/i,
  /\bfairy\s+meadows\b/i,
]

const UMRAH_INTAKE_MESSAGE = [
  'Thank you for contacting us. To help us prepare a customized Umrah package for you, kindly share the following details:',
  '',
  '💰 Budget',
  '📅 Travel Dates',
  '🗓️ No. of Days',
  '👥 No. of Travelers (Adults / Kids / Infants / Elderly with ages)',
  '🏨 Hotel Category (Economy / Economy Plus / 4⭐ / 5⭐)',
  '🛏️ No. of Hotel Rooms (Please mention room sharing)',
  '🕌 Makkah & Madinah Ziyarat (Required / Not Required)',
  '✈️ Special Requirements (Flight, transport, hotel distance, or any other preference)',
  '',
  "We'll share the best package according to your requirements. Thank you! 😊",
].join('\n')

const UMRAH_REQUIRED_FIELDS = [
  'budget',
  'travelDate',
  'days',
  'travelers',
  'hotelCategory',
  'rooms',
  'ziyarat',
] as const

type UmrahRequiredField = (typeof UMRAH_REQUIRED_FIELDS)[number]

interface ParsedUmrahDetails {
  budget: string | null
  travelDate: string | null
  days: number | null
  adults: number | null
  children: number | null
  infants: number | null
  elderly: string | null
  hotelCategory: string | null
  rooms: number | null
  roomSharing: string | null
  ziyarat: boolean | null
  specialRequirements: string | null
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

function travelLeadTopic(text: string): string | null {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return null
  if (/\bumrah\b/i.test(normalized)) return 'Umrah'
  if (/\bhajj\b/i.test(normalized)) return 'Hajj'

  const destinationMatch = normalized.match(
    /\b(hunza|skardu|naran(?:\/kaghan)?|kaghan|swat|azad kashmir|kashmir|murree(?:\/galiyat)?|galiyat|fairy meadows|lahore)\b/i,
  )
  if (destinationMatch) {
    return destinationMatch[1]
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .replace('Naran/kaghan', 'Naran/Kaghan')
      .replace('Murree/galiyat', 'Murree/Galiyat')
  }

  if (TRAVEL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'Travel Package'
  }
  return null
}

function parseIntText(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function titleCase(value: string | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function latestTopicStartIndex(
  messages: { role: string; content: string }[],
  topic: string,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const messageTopic = travelLeadTopic(message.content)
    if (messageTopic === topic) return i
  }
  return Math.max(0, messages.length - 8)
}

function compactLeadPatch<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  ) as Partial<T>
}

function looksLikeTravelDetailAnswer(text: string): boolean {
  return /\b(\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}|from\s+[a-z]|persons?|people|pax|passengers?|adults?|children|kids|days?|nights?|rooms?|budget|standard|deluxe|luxury|sedan|suv|hiace|coaster|coach)\b/i.test(
    text,
  )
}

function conversationText(messages: { role: string; content: string }[]): string {
  return messages.map((message) => message.content).join('\n')
}

function parseDateText(text: string): string | null {
  const iso = text.match(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/)
  if (iso) return iso[1]
  const natural = text.match(
    /\b(\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2})\b/i,
  )
  return natural?.[1] ?? null
}

function parseBoolPreference(value: string): boolean | null {
  if (/\b(not required|no|none|without|skip)\b/i.test(value)) return false
  if (/\b(required|yes|include|needed|need)\b/i.test(value)) return true
  return null
}

function parseUmrahDetails(messages: { role: string; content: string }[]): ParsedUmrahDetails {
  const text = conversationText(messages)
  const latest = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const budget = text.match(/\b(?:budget|range)\s*[:\-]?\s*(?:pkr|rs\.?|₨)?\s*([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)/i)?.[1]
    ?? text.match(/\b(?:pkr|rs\.?|₨)\s*([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)/i)?.[1]
    ?? null
  const days = parseIntText(text.match(/\b(\d{1,3})\s*(?:days?|nights?)\b/i)?.[1])
  const adults = parseIntText(text.match(/\b(\d{1,3})\s*(?:adults?|persons?|people|pax|passengers?)\b/i)?.[1])
  const children = parseIntText(text.match(/\b(\d{1,3})\s*(?:kids?|children|child)\b/i)?.[1])
  const infants = parseIntText(text.match(/\b(\d{1,3})\s*(?:infants?|babies|baby)\b/i)?.[1])
  const rooms = parseIntText(text.match(/\b(\d{1,3})\s*(?:rooms?|room)\b/i)?.[1])
  const hotelCategory =
    text.match(/\b(economy plus|economy|4\s*⭐|4\s*star|four\s*star|5\s*⭐|5\s*star|five\s*star|standard|executive)\b/i)?.[1] ?? null
  const ziyarat = parseBoolPreference(
    text.match(/\b(?:ziyarat|ziyarats)\s*[:\-]?\s*([a-z\s/]+)\b/i)?.[1] ?? latest,
  )
  const elderly = text.match(/\b(?:elderly|senior)[^,\n.]*/i)?.[0] ?? null
  const roomSharing = text.match(/\b(?:sharing|double|triple|quad|single)[^,\n.]*/i)?.[0] ?? null
  const specialRequirements =
    text.match(/\b(?:special requirements?|requirements?|preference)\s*[:\-]\s*([^\n]+)/i)?.[1] ??
    text.match(/\b(flight|transport|near haram|walking distance|wheelchair|hotel distance)[^.\n]*/i)?.[0] ??
    null

  return {
    budget: budget?.trim() ?? null,
    travelDate: parseDateText(text),
    days,
    adults,
    children,
    infants,
    elderly,
    hotelCategory: hotelCategory ? titleCase(hotelCategory) : null,
    rooms,
    roomSharing,
    ziyarat,
    specialRequirements: specialRequirements?.trim() ?? null,
  }
}

function missingUmrahFields(details: ParsedUmrahDetails): UmrahRequiredField[] {
  return UMRAH_REQUIRED_FIELDS.filter((field) => {
    if (field === 'travelers') return !details.adults && !details.children && !details.infants && !details.elderly
    if (field === 'ziyarat') return details.ziyarat === null
    return !details[field]
  })
}

function formatMissingUmrahPrompt(missing: UmrahRequiredField[]): string {
  const labels: Record<UmrahRequiredField, string> = {
    budget: '💰 Budget',
    travelDate: '📅 Travel Dates',
    days: '🗓️ No. of Days',
    travelers: '👥 No. of Travelers (Adults / Kids / Infants / Elderly with ages)',
    hotelCategory: '🏨 Hotel Category (Economy / Economy Plus / 4⭐ / 5⭐)',
    rooms: '🛏️ No. of Hotel Rooms (Please mention room sharing)',
    ziyarat: '🕌 Makkah & Madinah Ziyarat (Required / Not Required)',
  }
  return [
    'Thank you. I have noted your details.',
    '',
    'Please share the missing details below so we can prepare your Umrah package:',
    '',
    ...missing.map((field) => labels[field]),
  ].join('\n')
}

function normalizedUmrahHotelCategory(value: string | null): string {
  const text = value?.toLowerCase() ?? ''
  if (text.includes('5') || text.includes('executive')) return 'Executive'
  if (text.includes('4') || text.includes('plus') || text.includes('standard')) return 'Standard'
  return 'Economy'
}

function umrahLeadNotes(details: ParsedUmrahDetails, latestText: string): string {
  return [
    'AI Umrah request from WhatsApp.',
    details.budget ? `Budget: ${details.budget}` : null,
    details.travelDate ? `Travel Dates: ${details.travelDate}` : null,
    details.days ? `No. of Days: ${details.days}` : null,
    details.adults !== null ? `Adults: ${details.adults}` : null,
    details.children !== null ? `Kids: ${details.children}` : null,
    details.infants !== null ? `Infants: ${details.infants}` : null,
    details.elderly ? `Elderly: ${details.elderly}` : null,
    details.hotelCategory ? `Hotel Category: ${details.hotelCategory}` : null,
    details.rooms ? `Rooms: ${details.rooms}` : null,
    details.roomSharing ? `Room Sharing: ${details.roomSharing}` : null,
    details.ziyarat !== null ? `Ziyarat: ${details.ziyarat ? 'Required' : 'Not Required'}` : null,
    details.specialRequirements ? `Special Requirements: ${details.specialRequirements}` : null,
    `Latest customer message: ${latestText}`,
  ].filter(Boolean).join('\n')
}

function parseAiLeadDetails(messages: { role: string; content: string }[], topic: string) {
  const segment = messages.slice(latestTopicStartIndex(messages, topic))
  const transcript = segment.map((message) => message.content).join('\n')
  const latestCustomerText =
    [...segment].reverse().find((message) => message.role === 'user')?.content ?? ''
  const dateMatch = transcript.match(
    /\b(\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4})\b/i,
  )
  const fromMatch = transcript.match(/\bfrom\s+([a-z][a-z\s/-]{1,40}?)(?:\s+(?:on|in|with|for|to)\b|$|[,.])/i)
  const peopleMatch = transcript.match(/\b(\d{1,3})\s*(?:persons?|people|pax|passengers?|adults?)\b/i)
  const childrenMatch = transcript.match(/\b(\d{1,3})\s*(?:children|kids|child)\b/i)
  const daysMatch = transcript.match(/\b(\d{1,2})\s*(?:days?|nights?)\b/i)
  const roomsMatch = transcript.match(/\b(\d{1,2})\s*(?:rooms?|room)\b/i)
  const hotelMatch = transcript.match(/\b(budget|standard|deluxe|luxury|no hotel needed|without hotel)\b/i)
  const transportMatch = transcript.match(/\b(sedan|suv|hiace|coaster|coach|without transport|no transport)\b/i)

  return {
    lead_source: 'AI Detected',
    lead_destination: topic,
    lead_trip_start_date: dateMatch?.[1] ?? null,
    lead_starting_city: titleCase(fromMatch?.[1]),
    lead_days: parseIntText(daysMatch?.[1]),
    lead_hotel_category: titleCase(hotelMatch?.[1]),
    lead_adults: parseIntText(peopleMatch?.[1]),
    lead_children: parseIntText(childrenMatch?.[1]) ?? 0,
    lead_rooms: parseIntText(roomsMatch?.[1]),
    lead_transport: titleCase(transportMatch?.[1]),
    lead_query: latestCustomerText || null,
  }
}

async function ensureAiSalesPipeline(
  db: AdminClient,
  accountId: string,
  userId: string,
): Promise<{ pipelineId: string; stageId: string } | null> {
  const { data: existing } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', 'Sales Pipeline')
    .limit(1)
  let pipelineId = (existing?.[0] as { id: string } | undefined)?.id

  if (!pipelineId) {
    const { data: pipeline, error } = await db
      .from('pipelines')
      .insert({
        account_id: accountId,
        user_id: userId,
        name: 'Sales Pipeline',
      })
      .select('id')
      .single()
    if (error || !pipeline) {
      console.error('[ai auto-reply] lead pipeline create failed:', error)
      return null
    }
    pipelineId = (pipeline as { id: string }).id
    await db.from('pipeline_stages').insert(
      DEFAULT_AI_LEAD_STAGES.map((stage) => ({
        pipeline_id: pipelineId,
        name: stage.name,
        color: stage.color,
        position: stage.position,
      })),
    )
  }

  const { data: stageRows } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipelineId)
    .eq('name', 'New Lead')
    .limit(1)
  let stageId = (stageRows?.[0] as { id: string } | undefined)?.id

  if (!stageId) {
    const { data: stage, error } = await db
      .from('pipeline_stages')
      .insert({
        pipeline_id: pipelineId,
        name: 'New Lead',
        color: '#3b82f6',
        position: 0,
      })
      .select('id')
      .single()
    if (error || !stage) {
      console.error('[ai auto-reply] lead stage create failed:', error)
      return null
    }
    stageId = (stage as { id: string }).id
  }

  return { pipelineId, stageId }
}

async function upsertAiUmrahLead(args: {
  db: AdminClient
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  details: ParsedUmrahDetails
  latestText: string
  quoteText?: string | null
}): Promise<void> {
  const pipeline = await ensureAiSalesPipeline(args.db, args.accountId, args.userId)
  if (!pipeline) return

  const { data: existingDeals } = await args.db
    .from('deals')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('pipeline_id', pipeline.pipelineId)
    .eq('status', 'open')
    .eq('lead_destination', 'Umrah')
    .order('created_at', { ascending: false })
    .limit(1)
  const existingDeal = existingDeals?.[0] as { id: string } | undefined
  const patch = compactLeadPatch({
    lead_source: 'AI Umrah',
    lead_destination: 'Umrah',
    lead_trip_start_date: args.details.travelDate,
    lead_days: args.details.days,
    lead_hotel_category: args.details.hotelCategory,
    lead_adults: args.details.adults,
    lead_children: args.details.children ?? 0,
    lead_rooms: args.details.rooms,
    lead_transport: args.details.specialRequirements?.match(/\b(car|staria|gmc|hiace|coaster|shared shuttle|transport)\b/i)?.[1],
    lead_query: [
      args.details.budget ? `Budget: ${args.details.budget}` : null,
      args.details.infants !== null ? `Infants: ${args.details.infants}` : null,
      args.details.elderly ? `Elderly: ${args.details.elderly}` : null,
      args.details.roomSharing ? `Room Sharing: ${args.details.roomSharing}` : null,
      args.details.ziyarat !== null ? `Ziyarat: ${args.details.ziyarat ? 'Required' : 'Not Required'}` : null,
      args.details.specialRequirements ? `Special Requirements: ${args.details.specialRequirements}` : null,
    ].filter(Boolean).join('\n'),
  })
  const notes = [
    umrahLeadNotes(args.details, args.latestText),
    args.quoteText ? `\nGenerated Quote:\n${args.quoteText}` : null,
  ].filter(Boolean).join('\n')

  if (existingDeal?.id) {
    await args.db
      .from('deals')
      .update({
        title: `Umrah request - ${args.details.days ?? ''} days${args.details.travelDate ? ` - ${args.details.travelDate}` : ''}`.trim(),
        conversation_id: args.conversationId,
        notes,
        ...patch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingDeal.id)
      .eq('account_id', args.accountId)
    return
  }

  await args.db.from('deals').insert({
    account_id: args.accountId,
    user_id: args.userId,
    pipeline_id: pipeline.pipelineId,
    stage_id: pipeline.stageId,
    contact_id: args.contactId,
    conversation_id: args.conversationId,
    title: `Umrah request - ${args.details.days ?? 'new'} days`,
    value: 0,
    currency: 'PKR',
    ...patch,
    notes,
    status: 'open',
  })
}

async function buildAiUmrahReply(args: {
  db: AdminClient
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  latestText: string
  messages: { role: string; content: string }[]
}): Promise<string | null> {
  const isUmrah = /\bumrah\b/i.test(conversationText(args.messages))
  if (!isUmrah) return null

  const alreadyAsked = args.messages.some((message) =>
    message.role === 'assistant' && message.content.includes('customized Umrah package'),
  )
  const details = parseUmrahDetails(args.messages)
  const missing = missingUmrahFields(details)

  if (!alreadyAsked && missing.length > 0) {
    await upsertAiUmrahLead({ ...args, details })
    return UMRAH_INTAKE_MESSAGE
  }

  if (missing.length > 0) {
    await upsertAiUmrahLead({ ...args, details })
    return formatMissingUmrahPrompt(missing)
  }

  try {
    const quote = quoteUmrah({
      name: 'WhatsApp lead',
      phone: '',
      start_date: details.travelDate!,
      route_preset_id: 'mk-md',
      nights: details.days!,
      adults: details.adults ?? 1,
      children: details.children ?? 0,
      infants: details.infants ?? 0,
      rooms: details.rooms ?? 1,
      room_type: details.roomSharing?.match(/\b(single|double|triple|quad)\b/i)?.[1] ?? 'Double',
      hotel_category: normalizedUmrahHotelCategory(details.hotelCategory),
      vehicle: details.specialRequirements?.match(/\b(shared shuttle|car|staria|gmc|hiace|coaster)\b/i)?.[1] ?? 'Car',
      include_visa: true,
      include_ziyarat: details.ziyarat ?? false,
    }, await loadUmrahPlannerDataForAccount(args.db, args.accountId))
    await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
    return quote.whatsappText
  } catch (err) {
    console.error('[ai auto-reply] umrah quote failed:', err)
    await upsertAiUmrahLead({ ...args, details })
    return 'Thank you. I have received your Umrah details. Our team will verify the latest hotel availability and share the final package shortly.'
  }
}

async function captureAiTravelLead(args: {
  db: AdminClient
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  latestText: string
  messages: { role: string; content: string }[]
}): Promise<void> {
  let topic =
    travelLeadTopic(args.latestText) ??
    [...args.messages]
      .reverse()
      .map((message) => (message.role === 'user' ? travelLeadTopic(message.content) : null))
      .find(Boolean) ??
    null

  try {
    if (!topic && !looksLikeTravelDetailAnswer(args.latestText)) return

    const { data: recentAiDeals } = await args.db
      .from('deals')
      .select('id, lead_destination, title')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .eq('status', 'open')
      .eq('lead_source', 'AI Detected')
      .order('created_at', { ascending: false })
      .limit(1)
    const recentAiDeal = recentAiDeals?.[0] as
      | { id: string; lead_destination?: string | null; title?: string | null }
      | undefined

    if (!topic && recentAiDeal) {
      topic =
        recentAiDeal.lead_destination?.trim() ||
        recentAiDeal.title?.replace(/^Travel request - /i, '').trim() ||
        null
    }
    if (!topic) return

    const pipeline = await ensureAiSalesPipeline(args.db, args.accountId, args.userId)
    if (!pipeline) return

    const title = `Travel request - ${topic}`
    const structuredDetails = parseAiLeadDetails(args.messages, topic)
    const { data: matchingStructuredDeals } = await args.db
      .from('deals')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .eq('pipeline_id', pipeline.pipelineId)
      .eq('status', 'open')
      .neq('lead_source', 'AI Detected')
      .ilike('lead_destination', topic)
      .limit(1)
    const matchingStructuredDeal = matchingStructuredDeals?.[0] as { id: string } | undefined
    if (matchingStructuredDeal?.id) {
      await args.db
        .from('deals')
        .update({
          ...compactLeadPatch({
            lead_query: structuredDetails.lead_query,
            lead_trip_start_date: structuredDetails.lead_trip_start_date,
            lead_starting_city: structuredDetails.lead_starting_city,
            lead_days: structuredDetails.lead_days,
            lead_hotel_category: structuredDetails.lead_hotel_category,
            lead_adults: structuredDetails.lead_adults,
            lead_children: structuredDetails.lead_children,
            lead_rooms: structuredDetails.lead_rooms,
            lead_transport: structuredDetails.lead_transport,
          }),
          updated_at: new Date().toISOString(),
        })
        .eq('id', matchingStructuredDeal.id)
        .eq('account_id', args.accountId)
      return
    }

    const { data: existingDeals } = await args.db
      .from('deals')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .eq('pipeline_id', pipeline.pipelineId)
      .eq('status', 'open')
      .ilike('title', title)
      .limit(1)
    const existingDeal =
      (existingDeals?.[0] as { id: string } | undefined) ??
      (recentAiDeal?.lead_destination?.toLowerCase() === topic.toLowerCase()
        ? { id: recentAiDeal.id }
        : undefined)
    if (existingDeal?.id) {
      await args.db
        .from('deals')
        .update({
          ...compactLeadPatch(structuredDetails),
          notes: [
            'AI-detected travel request from WhatsApp.',
            `Topic: ${topic}`,
            `Latest customer message: ${args.latestText}`,
          ].join('\n'),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingDeal.id)
        .eq('account_id', args.accountId)
      return
    }

    await args.db.from('deals').insert({
      account_id: args.accountId,
      user_id: args.userId,
      pipeline_id: pipeline.pipelineId,
      stage_id: pipeline.stageId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      title,
      value: 0,
      currency: 'PKR',
      ...structuredDetails,
      notes: [
        'AI-detected travel request from WhatsApp.',
        `Topic: ${topic}`,
        `Customer message: ${args.latestText}`,
      ].join('\n'),
      status: 'open',
    })
  } catch (err) {
    console.error('[ai auto-reply] travel lead capture failed:', err)
  }
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return
    const latestText = latestUserMessage(messages)

    const umrahReply = await buildAiUmrahReply({
      db,
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      latestText,
      messages,
    })
    if (umrahReply) {
      const { data: claimed, error: claimErr } = await db.rpc(
        'claim_ai_reply_slot',
        {
          conversation_id: conversationId,
          max_replies: config.autoReplyMaxPerConversation,
        },
      )
      if (claimErr) {
        console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
        return
      }
      if (claimed !== true) return
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: umrahReply,
      })
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestText,
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and leave the inbound unanswered so it surfaces in
      // the inbox for a human. Sticky until an admin re-enables.
      await db
        .from('conversations')
        .update({
          status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId)
      await captureAiTravelLead({
        db,
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        latestText,
        messages,
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await captureAiTravelLead({
      db,
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      latestText,
      messages,
    })

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
