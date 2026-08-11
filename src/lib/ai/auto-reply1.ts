import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'
import { loadUmrahPlannerDataForAccount, quoteUmrah } from '@/lib/umrah-planner/quote'
import type { UmrahQuoteResult } from '@/lib/umrah-planner/quote'
import { buildUmrahQuotePdf } from '@/lib/umrah-planner/pdf'
import type { AiConfig } from './types'

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
  '🏨 Hotel Category (Economy / Standard / Executive)',
  '🛏️ No. of Hotel Rooms (Please mention room sharing)',
  '🕌 Makkah & Madinah Ziyarat (Required / Not Required)',
  '✈️ Special Requirements (Flight, transport, hotel distance, or any other preference)',
  '',
  "We'll share the best package according to your requirements. Thank you! 😊",
].join('\n')

const UMRAH_REQUIRED_FIELDS = [
  'travelDate',
  'travelers',
  'hotelCategory',
] as const

type UmrahRequiredField = (typeof UMRAH_REQUIRED_FIELDS)[number]

interface ParsedUmrahDetails {
  budget: string | null
  travelDate: string | null
  days: number | null
  makkahNights: number | null
  madinahNights: number | null
  adults: number | null
  children: number | null
  infants: number | null
  elderly: string | null
  hotelCategory: string | null
  rooms: number | null
  roomSharing: string | null
  vehicle: string | null
  includeTransport: boolean | null
  ziyarat: boolean | null
  selectedZiyarats: string[] | null
  makkahHotelQuery: string | null
  madinahHotelQuery: string | null
  hotelPreference: 'cheapest' | null
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

interface AiReplyDocument {
  /** Stored Supabase URL for CRM/history only. WhatsApp delivery does not use this URL. */
  link: string
  /** Exact generated PDF bytes; uploaded directly to Meta before sending. */
  bytes: Uint8Array
  filename: string
  caption?: string
}

type AiReplyPayload = string | { text: string; document?: AiReplyDocument }

interface UmrahAiDecision {
  action: 'send_quote' | 'answer_question' | 'booking_follow_up' | 'handoff'
  answer: string | null
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
  if (iso) {
    const [year, month, day] = iso[1].split('-').map(Number)
    return validIsoDate(year, month, day)
  }
  const natural = text.match(
    /\b(\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2})\b/i,
  )
  if (!natural) return null
  const match = natural[1].match(/^(\d{1,2})\s+([a-z]+)\s+(20\d{2})$/i)
  if (!match) return natural[1]
  const months: Record<string, string> = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  }
  const month = months[match[2].toLowerCase()]
  return month ? validIsoDate(Number(match[3]), Number(month), Number(match[1])) : null
}

function validIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isPastDate(value: string | null): boolean {
  if (!value) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return date < today
}

function latestValidDate(messages: { role: string; content: string }[], fallbackText: string): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const parsed = parseDateText(message.content)
    if (parsed && !isPastDate(parsed)) return parsed
  }
  const fallback = parseDateText(fallbackText)
  return fallback && !isPastDate(fallback) ? fallback : null
}

function hasDateLikeText(text: string): boolean {
  return /\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\s+[a-z]{3,}\s+20\d{2})\b/i.test(text)
}

function parseBoolPreference(value: string): boolean | null {
  if (/\b(not required|not|no|none|without|skip)\b/i.test(value)) return false
  if (/\b(required|yes|include|needed|need)\b/i.test(value)) return true
  return null
}

function latestUmrahIntakeIndex(messages: { role: string; content: string }[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && message.content.includes('customized Umrah package')) return i
  }
  return -1
}

function umrahDetailMessages(messages: { role: string; content: string }[]): { role: string; content: string }[] {
  const intakeIndex = latestUmrahIntakeIndex(messages)
  return intakeIndex >= 0 ? messages.slice(intakeIndex + 1) : messages
}

function userDetailLines(messages: { role: string; content: string }[]): string[] {
  return umrahDetailMessages(messages)
    .filter((message) => message.role === 'user' && !/^\s*umrah\s*$/i.test(message.content))
    .flatMap((message) => message.content.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/\bchange\b/i.test(line))
}

function firstNumber(value: string | undefined): number | null {
  return parseIntText(value?.match(/\b(\d{1,4})\b/)?.[1])
}

function wordNumber(value: string | undefined | null): number | null {
  const text = value?.toLowerCase() ?? ''
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  }
  for (const [word, number] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return number
  }
  return null
}

function latestBudgetFromMessages(messages: { role: string; content: string }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const explicit = message.content.match(/\b(?:budget|range)\s*[:\-]?\s*(?:pkr|rs\.?|₨)?\s*([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)/i)?.[1] ??
      message.content.match(/\b([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)\s*(?:budget|range)\b/i)?.[1] ??
      message.content.match(/\b(?:pkr|rs\.?|₨)\s*([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)/i)?.[1]
    if (explicit) return explicit.trim()
    const lines = message.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const firstMoneyLike = lines
      .map((line) => {
        if (/^\s*20\d{2}[-/]/.test(line)) return null
        const match = line.match(/^\s*([0-9][0-9,.]*(?:\s*(?:k|lac|lakh|million|m))?)(?=\s|$)/i)?.[1]
        if (!match) return null
        const amount = budgetAmount(match)
        return amount !== null && amount >= 10000 ? match.trim() : null
      })
      .find(Boolean)
    if (firstMoneyLike) return firstMoneyLike
    const bare = lines.find((line) => {
      if (!/^\d[\d,.\s]*(?:k|lac|lakh|million|m)?$/i.test(line)) return false
      const amount = budgetAmount(line)
      return amount !== null && amount >= 10000
    })
    if (bare) return bare
  }
  return null
}

function latestDaysOverride(text: string): number | null {
  if (!/\b(reduce|change|set|update|duration|days?|nights?)\b/i.test(text)) return null
  return parseIntText(
    text.match(/\b(?:increase|extend|make)[^\d]{0,40}(\d{1,3})\b/i)?.[1] ??
    text.match(/\b(?:reduce|change|set|update|duration|days?|nights?)[^\d]{0,40}(\d{1,3})\b/i)?.[1] ??
    text.match(/\b(\d{1,3})\s*(?:days?|nights?)\b/i)?.[1],
  )
}

function latestDaysFromMessages(messages: { role: string; content: string }[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const value = latestDaysOverride(message.content)
    if (value !== null) return value
  }
  return null
}

function validHotelCategory(value: string | undefined | null): string | null {
  const match = value?.match(/\b(economy plus|economy|4\s*⭐|4\s*star|four\s*star|5\s*⭐|5\s*star|five\s*star|standard|executive)\b/i)?.[1]
  return match ? titleCase(match) : null
}

function latestHotelCategoryFromMessages(messages: { role: string; content: string }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const value = validHotelCategory(message.content)
    if (value) return value
  }
  return null
}

function validUmrahVehicle(value: string | undefined | null): string | null {
  const match = value?.match(/\b(shared shuttle|suv|staria|gmc|hiace|coaster|car)\b/i)?.[1]
  return match ? titleCase(match) : null
}

function latestVehicleFromMessages(messages: { role: string; content: string }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (!/\b(add|change|set|vehicle|vehcile|transport|car|suv|staria|gmc|hiace|coaster|shared shuttle)\b/i.test(message.content)) continue
    const value = validUmrahVehicle(message.content)
    if (value) return value
  }
  return null
}


function latestTransportPreferenceFromMessages(messages: { role: string; content: string }[]): boolean | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const text = message.content
    if (/\b(?:no|without|remove|exclude|skip|dont want|don't want|do not want)\b.{0,25}\b(?:transport|vehicle|vehcile|car)\b/i.test(text) ||
        /\b(?:own|my own)\s+(?:transport|vehicle|car)\b/i.test(text)) return false
    if (validUmrahVehicle(text) || /\b(?:include|add|need|want|required)\b.{0,25}\b(?:transport|vehicle|vehcile)\b/i.test(text)) return true
  }
  return null
}

function selectedZiyaratIdsFromMessages(messages: { role: string; content: string }[]): string[] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (!/\b(ziyarat|badar|taif|makkah|madina|madinah)\b/i.test(message.content)) continue
    if (parseBoolPreference(message.content) === false) return []
    const ids = new Set<string>()
    if (/\bbadar\b/i.test(message.content)) ids.add('badar')
    if (/\btaif\b/i.test(message.content)) ids.add('taif')
    if (/\bmakkah\b/i.test(message.content)) ids.add('makkah')
    if (/\bmadina|madinah\b/i.test(message.content)) ids.add('madina')
    if (parseBoolPreference(message.content) === true && ids.size === 0) {
      ids.add('makkah')
      ids.add('madina')
    }
    if (ids.size > 0) return Array.from(ids)
  }
  return null
}

function latestHotelQueryFromMessages(messages: { role: string; content: string }[], city: 'makkah' | 'madinah'): string | null {
  const cityPattern = city === 'makkah' ? 'makkah' : 'madina|madinah'
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const direct = message.content.match(new RegExp(`\\b(?:${cityPattern})\\b.{0,40}\\b(?:hotel)?\\s*(?:to|as|with)?\\s*([a-z0-9][a-z0-9\\s-]{2,40})`, 'i'))?.[1]
    if (direct) return direct.trim()
    if (/\bvoco\b/i.test(message.content) && city === 'makkah') return 'voco'
  }
  return null
}

function roomCountFromText(value: string | undefined | null): number | null {
  if (!value) return null
  if (/^\s*\d{1,2}\s*$/.test(value)) return firstNumber(value)
  if (!/\b(rooms?|room|single|double|triple|quad|sharing)\b/i.test(value)) return null
  return firstNumber(value) ?? (/single|double|triple|quad/i.test(value) ? 1 : null)
}

function likelyUsefulUmrahAnswer(text: string): boolean {
  return Boolean(
    budgetAmount(text) ||
    hasDateLikeText(text) ||
    /\b(days?|nights?|adults?|persons?|people|pax|passengers?|kids?|children|child|infants?|babies|elderly|senior|rooms?|room|single|double|triple|quad|sharing|economy|standard|executive|ziyarat|required|not required|yes|no|flight|transport|hotel distance|near haram|wheelchair)\b/i.test(text),
  )
}

function latestHotelPreferenceFromMessages(messages: { role: string; content: string }[]): 'cheapest' | null {
  return messages.some((message) =>
    /\b(lower|cheaper|cheap|lowest|less rate|low rate|budget hotel|reduce price|reduce rate)\b/i.test(message.content),
  )
    ? 'cheapest'
    : null
}

function parseUmrahDetails(messages: { role: string; content: string }[]): ParsedUmrahDetails {
  const detailMessages = umrahDetailMessages(messages)
  const userMessages = detailMessages.filter((message) => message.role === 'user')
  const text = conversationText(userMessages)
  const latest = [...userMessages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const lines = userDetailLines(messages)
  const ordered = lines.length >= 5 ? {
    budget: lines[0],
    travelDate: lines[1],
    days: lines[2],
    travelers: lines[3],
    hotelCategory: lines[4],
    rooms: lines[5],
    ziyarat: lines[6],
    specialRequirements: lines.slice(7).join(' '),
  } : null
  const parsedBudget = latestBudgetFromMessages(userMessages)
    ?? text.match(/\b(?:budget|range)\s*[:\-]?\s*(?:pkr|rs\.?|₨)?\s*([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)/i)?.[1]
    ?? text.match(/\b([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)\s*(?:budget|range)\b/i)?.[1]
    ?? text.match(/\b(?:pkr|rs\.?|₨)\s*([0-9][0-9,.\s]*(?:k|lac|lakh|million|m)?)/i)?.[1]
    ?? (/^\d[\d,.\s]*(?:k|lac|lakh|million|m)?$/i.test(ordered?.budget ?? '') ? ordered?.budget : null)
    ?? (/^\d[\d,.\s]*(?:k|lac|lakh|million|m)?$/i.test(lines[0] ?? '') ? lines[0] : null)
    ?? null
  const parsedDays =
    latestDaysFromMessages(detailMessages) ??
    parseIntText(text.match(/\b(\d{1,3})\s*(?:days?|nights?)\b/i)?.[1]) ??
    firstNumber(ordered?.days)
  const parsedAdults = parseIntText(text.match(/\b(\d{1,3})\s*(?:adults?|persons?|people|pax|passengers?)\b/i)?.[1])
    ?? wordNumber(text.match(/\b([a-z]+)\s+(?:adults?|persons?|people|pax|passengers?)\b/i)?.[1])
    ?? (/\bcouple\b/i.test(text) ? 2 : null)
    ?? firstNumber(ordered?.travelers)
  const parsedChildren = parseIntText(text.match(/\b(\d{1,3})\s*(?:kids?|children|child)\b/i)?.[1])
  const parsedInfants = parseIntText(text.match(/\b(\d{1,3})\s*(?:infants?|babies|baby)\b/i)?.[1])
  const parsedRooms = parseIntText(text.match(/\b(\d{1,3})\s*(?:\w+\s+){0,3}(?:rooms?|room)\b/i)?.[1])
    ?? roomCountFromText(latest)
    ?? roomCountFromText(ordered?.rooms)
  const parsedHotelCategory = latestHotelCategoryFromMessages(detailMessages) ?? validHotelCategory(ordered?.hotelCategory)
  const parsedZiyarat =
    parseBoolPreference(latest) ??
    parseBoolPreference(text.match(/\b(?:ziyarat|ziyarats)\s*[:\-]?\s*([a-z\s/]+)\b/i)?.[1] ?? '') ??
    parseBoolPreference(ordered?.ziyarat ?? '')
  const selectedZiyarats = selectedZiyaratIdsFromMessages(userMessages)
  const parsedElderly = text.match(/\b(?:elderly|senior)[^,\n.]*/i)?.[0] ?? null
  const parsedRoomSharing = text.match(/\b(?:sharing|double|triple|quad|single)[^,\n.]*/i)?.[0] ?? (/^\s*(single|double|triple|quad)\s*$/i.test(latest) ? latest : null) ?? ordered?.rooms ?? null
  const parsedSpecialRequirements =
    (text.match(/\b(?:special requirements?|requirements?|preference)\s*[:\-]\s*([^\n]+)/i)?.[1] ??
    text.match(/\b(flight|transport|near haram|walking distance|wheelchair|hotel distance)[^.\n]*/i)?.[0] ??
    ordered?.specialRequirements) ||
    null
  const madinahNights = parseIntText(latest.match(/\b(?:madina|madinah)[^\d]{0,30}(\d{1,3})\b/i)?.[1])
  const makkahNights = parseIntText(latest.match(/\bmakkah[^\d]{0,30}(\d{1,3})\b/i)?.[1])

  return {
    budget: parsedBudget?.trim() ?? null,
    travelDate: latestValidDate(detailMessages, ordered?.travelDate ?? text),
    days: parsedDays,
    makkahNights,
    madinahNights,
    adults: parsedAdults,
    children: parsedChildren,
    infants: parsedInfants,
    elderly: parsedElderly,
    hotelCategory: parsedHotelCategory,
    rooms: parsedRooms,
    roomSharing: parsedRoomSharing,
    vehicle: latestVehicleFromMessages(userMessages),
    includeTransport: latestTransportPreferenceFromMessages(userMessages),
    ziyarat: selectedZiyarats ? selectedZiyarats.length > 0 : parsedZiyarat,
    selectedZiyarats,
    makkahHotelQuery: latestHotelQueryFromMessages(userMessages, 'makkah'),
    madinahHotelQuery: latestHotelQueryFromMessages(userMessages, 'madinah'),
    hotelPreference: latestHotelPreferenceFromMessages(userMessages),
    specialRequirements: parsedSpecialRequirements?.trim() ?? null,
  }

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
    makkahNights: null,
    madinahNights: null,
    adults,
    children,
    infants,
    elderly,
    hotelCategory: hotelCategory ? titleCase(hotelCategory ?? undefined) : null,
    rooms,
    roomSharing,
    vehicle: null,
    includeTransport: null,
    ziyarat,
    selectedZiyarats: null,
    makkahHotelQuery: null,
    madinahHotelQuery: null,
    hotelPreference: null,
    specialRequirements: specialRequirements?.trim() ?? null,
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValueFromAi(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') return parseIntText(value.match(/\d{1,4}/)?.[0])
  return null
}

function booleanValueFromAi(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return parseBoolPreference(value)
  return null
}

function stringArrayFromAi(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items = value.map((item) => stringValue(item)).filter(Boolean) as string[]
  return items.length ? items : null
}

function normalizeAiUmrahDetails(raw: Record<string, unknown>): Partial<ParsedUmrahDetails> {
  const travelDate = parseDateText(stringValue(raw.travelDate) ?? stringValue(raw.travel_date) ?? '')
  const hotelCategory = validHotelCategory(stringValue(raw.hotelCategory) ?? stringValue(raw.hotel_category))
  return {
    budget: stringValue(raw.budget),
    travelDate: travelDate && !isPastDate(travelDate) ? travelDate : null,
    days: numberValueFromAi(raw.days ?? raw.nights ?? raw.duration),
    makkahNights: numberValueFromAi(raw.makkahNights ?? raw.makkah_nights),
    madinahNights: numberValueFromAi(raw.madinahNights ?? raw.madinaNights ?? raw.madinah_nights ?? raw.madina_nights),
    adults: numberValueFromAi(raw.adults),
    children: numberValueFromAi(raw.children ?? raw.kids),
    infants: numberValueFromAi(raw.infants),
    elderly: stringValue(raw.elderly),
    hotelCategory,
    rooms: numberValueFromAi(raw.rooms),
    roomSharing: stringValue(raw.roomSharing ?? raw.room_sharing ?? raw.roomType ?? raw.room_type),
    vehicle: validUmrahVehicle(stringValue(raw.vehicle ?? raw.transport)),
    includeTransport: booleanValueFromAi(raw.includeTransport ?? raw.include_transport ?? raw.transportIncluded ?? raw.transport_included),
    ziyarat: booleanValueFromAi(raw.ziyarat),
    selectedZiyarats: stringArrayFromAi(raw.selectedZiyarats ?? raw.selected_ziyarats),
    makkahHotelQuery: stringValue(raw.makkahHotelQuery ?? raw.makkah_hotel ?? raw.makkahHotel),
    madinahHotelQuery: stringValue(raw.madinahHotelQuery ?? raw.madinaHotelQuery ?? raw.madinah_hotel ?? raw.madina_hotel),
    hotelPreference: /\b(lower|cheaper|cheap|lowest|less rate|low rate|budget hotel|reduce price|reduce rate)\b/i.test(
      stringValue(raw.hotelPreference ?? raw.hotel_preference ?? raw.specialRequirements ?? raw.special_requirements) ?? '',
    ) ? 'cheapest' : null,
    specialRequirements: stringValue(raw.specialRequirements ?? raw.special_requirements),
  }
}

function mergeUmrahDetails(base: ParsedUmrahDetails, ai: Partial<ParsedUmrahDetails>): ParsedUmrahDetails {
  return {
    budget: ai.budget ?? base.budget,
    travelDate: ai.travelDate ?? base.travelDate,
    days: ai.days ?? base.days,
    makkahNights: ai.makkahNights ?? base.makkahNights,
    madinahNights: ai.madinahNights ?? base.madinahNights,
    adults: ai.adults ?? base.adults,
    children: ai.children ?? base.children,
    infants: ai.infants ?? base.infants,
    elderly: ai.elderly ?? base.elderly,
    hotelCategory: ai.hotelCategory ?? base.hotelCategory,
    rooms: ai.rooms ?? base.rooms,
    roomSharing: ai.roomSharing ?? base.roomSharing,
    // Transport changes are parsed deterministically from the latest user messages.
    // Prefer them over the AI extraction so old transport preferences cannot override a new 'no transport' / 'Hiace' command.
    vehicle: base.vehicle ?? ai.vehicle ?? null,
    includeTransport: base.includeTransport ?? ai.includeTransport ?? null,
    ziyarat: ai.ziyarat ?? base.ziyarat,
    selectedZiyarats: ai.selectedZiyarats ?? base.selectedZiyarats,
    makkahHotelQuery: ai.makkahHotelQuery ?? base.makkahHotelQuery,
    madinahHotelQuery: ai.madinahHotelQuery ?? base.madinahHotelQuery,
    hotelPreference: ai.hotelPreference ?? base.hotelPreference,
    specialRequirements: ai.specialRequirements ?? base.specialRequirements,
  }
}

async function extractUmrahDetailsWithAi(
  config: AiConfig,
  messages: { role: string; content: string }[],
): Promise<Partial<ParsedUmrahDetails>> {
  const detailMessages = umrahDetailMessages(messages)
    .filter((message) => message.role === 'user')
    .slice(-12)
  if (detailMessages.length === 0) return {}

  const systemPrompt = [
    'Extract structured Umrah package details from WhatsApp customer messages.',
    'Return JSON only. Do not include markdown, explanations, or missing-field prompts.',
    'Use null for unknown fields. Never invent unavailable details.',
    'Understand flexible wording: couple=2 adults, kids/children, babies/infants, "add staria" means vehicle Staria, "SUV" means vehicle SUV, "no transport" or "no vehicle" means includeTransport false, "add Hiace" means includeTransport true and vehicle Hiace, "add badar and taif ziyarat" means selected ziyarats ["badar","taif"], "change Makkah hotel to voco" means makkahHotelQuery "voco".',
    'Normalize hotelCategory to Economy, Standard, or Executive. Normalize travelDate to yyyy-mm-dd when present. Use selectedZiyarats values from: makkah, madina, badar, taif.',
    'Fields: budget, travelDate, days, makkahNights, madinahNights, adults, children, infants, elderly, hotelCategory, rooms, roomSharing, vehicle, includeTransport, ziyarat, selectedZiyarats, makkahHotelQuery, madinahHotelQuery, hotelPreference, specialRequirements.',
  ].join('\n')

  try {
    const result = await generateReply({
      config,
      systemPrompt,
      messages: [{
        role: 'user',
        content: detailMessages.map((message) => message.content).join('\n---\n'),
      }],
    })
    const json = extractJsonObject(result.text)
    return json ? normalizeAiUmrahDetails(json) : {}
  } catch (err) {
    console.error('[ai auto-reply] umrah detail extraction failed:', err)
    return {}
  }
}

function missingUmrahFields(details: ParsedUmrahDetails): UmrahRequiredField[] {
  return UMRAH_REQUIRED_FIELDS.filter((field) => {
    if (field === 'travelers') return !details.adults && !details.children && !details.infants && !details.elderly
    return !details[field]
  })
}

function formatMissingUmrahPrompt(missing: UmrahRequiredField[]): string {
  const labels: Record<UmrahRequiredField, string> = {
    travelDate: 'Travel date',
    travelers: 'Number of travelers',
    hotelCategory: 'Hotel category: Economy / Standard / Executive',
  }
  return [
    missing.length === 1 ? 'Just one thing needed:' : 'Please share these details so I can prepare the package:',
    '',
    ...missing.map((field) => labels[field]),
  ].join('\n')
}

function formatInvalidUmrahAnswerPrompt(missing: UmrahRequiredField[]): string {
  return [
    'I could not match that to the required Umrah detail.',
    missing.length ? formatMissingUmrahPrompt(missing) : 'If you want to change something, please mention the exact field and new value.',
  ].join('\n')
}
function invalidLatestUmrahDateMessage(latestText: string): string | null {
  if (!hasDateLikeText(latestText)) return null
  const parsed = parseDateText(latestText)
  if (!parsed) return 'Please enter a valid travel date in yyyy-mm-dd format, for example 2026-09-15.'
  if (isPastDate(parsed)) return 'This travel date is in the past. Please enter a current or future travel date in yyyy-mm-dd format.'
  return null
}

function normalizedUmrahHotelCategory(value: string | null): string {
  const text = value?.toLowerCase() ?? ''
  if (text.includes('5') || text.includes('executive')) return 'Executive'
  if (text.includes('4') || text.includes('plus') || text.includes('standard')) return 'Standard'
  return 'Economy'
}

function budgetAmount(value: string | null): number | null {
  if (!value) return null
  const normalized = value.toLowerCase().replace(/,/g, '').trim()
  const raw = normalized.match(/\d+(?:\.\d+)?/)?.[0]
  const amount = raw ? Number.parseFloat(raw) : Number.NaN
  if (!Number.isFinite(amount)) return null
  if (/\b(lac|lakh)\b/.test(normalized)) return Math.round(amount * 100000)
  if (/\b(m|million)\b/.test(normalized)) return Math.round(amount * 1000000)
  if (/\bk\b/.test(normalized)) return Math.round(amount * 1000)
  return Math.round(amount)
}

function plannerRows(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = data[key]
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
}

function availableUmrahVehicles(data: Record<string, unknown>): string[] {
  const vehicles = new Set<string>()
  for (const row of plannerRows(data, 'transportRates')) {
    const rates = row.rates
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) continue
    for (const key of Object.keys(rates)) {
      if (key.trim()) vehicles.add(key.trim())
    }
  }
  return Array.from(vehicles).slice(0, 8)
}

function availableUmrahHotelsText(data: Record<string, unknown>, categoryValue: string): string {
  const categoryName = normalizedUmrahHotelCategory(categoryValue)
  const hotels = plannerRows(data, 'hotels')
    .filter((hotel) => normalizedUmrahHotelCategory(String(hotel.category ?? '')) === categoryName)
  const byCity = (city: string) => hotels
    .filter((hotel) => String(hotel.city ?? '').toLowerCase().includes(city.toLowerCase()))
    .slice(0, 6)
    .map((hotel) => {
      const name = String(hotel.name ?? 'Hotel')
      const distance = String(hotel.distance ?? '').trim()
      return distance ? `- ${name} (${distance})` : `- ${name}`
    })
  const makkah = byCity('makkah')
  const madinah = byCity('mad')
  return [
    `Available ${categoryName} hotels from current portal data:`,
    '',
    'Makkah:',
    ...(makkah.length ? makkah : ['- No matching Makkah hotel found']),
    '',
    'Madina:',
    ...(madinah.length ? madinah : ['- No matching Madina hotel found']),
    '',
    'Reply with the hotel name if you want to use one of these.',
  ].join('\n')
}

function findUmrahHotelId(data: Record<string, unknown>, city: string, query: string | null): string | null {
  const needle = query?.trim().toLowerCase()
  if (!needle) return null
  const hotel = plannerRows(data, 'hotels').find((item) => {
    const itemCity = String(item.city ?? '').toLowerCase()
    const name = String(item.name ?? '').toLowerCase()
    return itemCity.includes(city) && name.includes(needle)
  })
  return hotel?.id ? String(hotel.id) : null
}

function availableUmrahZiyaratsText(data: Record<string, unknown>): string {
  const ziyarats = plannerRows(data, 'ziyarats')
    .map((item) => String(item.name ?? item.id ?? '').trim())
    .filter(Boolean)
  const names = ziyarats.length ? ziyarats : ['Makkah Ziyarat', 'Madina Ziyarat']
  return [
    'Yes, ziyarats are available.',
    `Options: ${names.join(', ')}.`,
    'Reply "Ziyarat required" to include them, or "Ziyarat not required" to keep them out of the package.',
  ].join('\n')
}

function umrahHotelCategoriesText(): string {
  return [
    'Available hotel categories are:',
    '',
    '- Economy',
    '- Standard',
    '- Executive',
    '',
    'Reply for example: Change category to Standard.',
  ].join('\n')
}

function isUmrahPackageUpdate(text: string): boolean {
  return /\b(budget|date|travel date|days?|nights?|duration|adults?|persons?|people|pax|passengers?|couple|kids?|children|child|infants?|rooms?|room|single|double|triple|quad|sharing|economy|standard|executive|ziyarat required|ziyarat not required|vehicle|transport|car|staria|gmc|hiace|coaster|lower|cheaper|lowest|book it|confirm|proceed|reserve|change|update|set|increase|reduce)\b/i.test(text)
}

function isInformationalQuestion(text: string): boolean {
  return /\?/.test(text) || /^(what|which|tell me|can you|do you|is there|are there|how|why)\b/i.test(text.trim())
}

function inferredRoomSetup(details: ParsedUmrahDetails): { rooms: number; roomType: string } {
  const travelers = Math.max(1, (details.adults ?? 0) + (details.children ?? 0))
  const explicitType = details.roomSharing?.match(/\b(single|double|triple|quad)\b/i)?.[1]
  if (details.rooms || explicitType) {
    return {
      rooms: details.rooms ?? 1,
      roomType: explicitType ? titleCase(explicitType) ?? 'Double' : 'Double',
    }
  }
  if (travelers <= 1) return { rooms: 1, roomType: 'Single' }
  if (travelers === 2) return { rooms: 1, roomType: 'Double' }
  if (travelers === 3) return { rooms: 1, roomType: 'Triple' }
  return { rooms: Math.ceil(travelers / 4), roomType: 'Quad' }
}

function buildCurrentUmrahQuote(
  details: ParsedUmrahDetails,
  plannerData: Record<string, unknown>,
  options: { hotelCategory?: string; hotelPreference?: 'cheapest' } = {},
): { quote: UmrahQuoteResult; vehicle: string } {
  const stopNights = details.madinahNights && details.days
    ? [Math.max(0, details.days - details.madinahNights), details.madinahNights]
    : details.makkahNights && details.days
      ? [details.makkahNights, Math.max(0, details.days - details.makkahNights)]
      : undefined
  const vehicle = details.specialRequirements?.match(/\b(shared shuttle|car|suv|staria|gmc|hiace|coaster)\b/i)?.[1] ?? 'Car'
  const roomSetup = inferredRoomSetup(details)
  const selectedHotels = {
    ...(findUmrahHotelId(plannerData, 'makkah', details.makkahHotelQuery) ? {
      'Makkah-0': findUmrahHotelId(plannerData, 'makkah', details.makkahHotelQuery)!,
    } : {}),
    ...(findUmrahHotelId(plannerData, 'mad', details.madinahHotelQuery) ? {
      'Madinah-1': findUmrahHotelId(plannerData, 'mad', details.madinahHotelQuery)!,
    } : {}),
  }
  return {
    vehicle: details.vehicle ?? vehicle,
    quote: quoteUmrah({
      name: 'WhatsApp lead',
      phone: '',
      start_date: details.travelDate!,
      route_preset_id: 'mk-md',
      nights: details.days ?? 10,
      stop_nights: stopNights,
      adults: details.adults ?? 1,
      children: details.children ?? 0,
      infants: details.infants ?? 0,
      rooms: roomSetup.rooms,
      room_type: roomSetup.roomType,
      hotel_category: normalizedUmrahHotelCategory(options.hotelCategory ?? details.hotelCategory),
      budget: details.budget ?? undefined,
      hotel_preference: options.hotelPreference ?? details.hotelPreference ?? 'cheapest',
      selected_hotels: selectedHotels,
      vehicle: details.vehicle ?? vehicle,
      transport_mode: details.includeTransport === false ? 'selective' : 'full',
      selected_sectors: details.includeTransport === false ? [] : undefined,
      include_visa: true,
      include_ziyarat: details.ziyarat ?? false,
      selected_ziyarats: details.selectedZiyarats?.length ? details.selectedZiyarats : undefined,
    }, plannerData),
  }
}

function umrahQuoteContext(quote: UmrahQuoteResult): Record<string, unknown> {
  return {
    total: quote.priceText,
    totalNumber: quote.total,
    perPerson: Math.ceil(quote.total / Math.max(1, quote.travelers)),
    currency: quote.currency,
    route: quote.route,
    travelDate: quote.startDate,
    nights: quote.nights,
    travelers: quote.travelers,
    visaTravelers: quote.visaTravelers,
    rooms: quote.rooms,
    roomType: quote.roomType,
    hotelCategory: quote.packageCategory,
    vehicle: quote.vehicle,
    hotels: quote.hotelLines.map((line) => ({
      city: line.city,
      hotel: line.hotel,
      nights: line.nights,
      checkIn: line.checkIn,
      checkOut: line.checkOut,
      category: line.category,
      distance: line.distance,
      meal: line.meal,
    })),
    transportSectors: quote.transportSectors.map((sector) => sector.label),
    visaIncluded: quote.visaTotal > 0,
    ziyarats: quote.ziyarats.map((item) => item.name),
    hasMissingRates: quote.hasMissingRates,
    formula: 'hotel room-night total + transport sectors + visa per traveler + selected ziyarats + category profit = final PKR total',
  }
}

async function decideAiUmrahAction(args: {
  db: AdminClient
  accountId: string
  config: AiConfig
  latestText: string
  messages: { role: string; content: string }[]
  details: ParsedUmrahDetails
  quote: UmrahQuoteResult
}): Promise<UmrahAiDecision | null> {
  try {
    const knowledge = await retrieveKnowledge(args.db, args.accountId, args.config, args.latestText)
    const systemPrompt = [
      'You are the routing brain for a Tours in Pakistan WhatsApp Umrah sales assistant.',
      'Decide what the assistant should do with the latest customer message.',
      'Return JSON only. No markdown. No explanations.',
      '',
      'Actions:',
      '- send_quote: customer gave package details, changed package details, asked for cheaper/lower option, changed hotel/category/days/travelers/budget/ziyarat/vehicle, or wants a new quotation.',
      '- answer_question: customer asks about the current quote, total, per-person price, what is included, visa, hotels, transport, ziyarats, availability options, or any normal follow-up that can be answered from the quote/context.',
      '- booking_follow_up: customer clearly wants to book/confirm/proceed.',
      '- handoff: customer is upset, asks for human, or asks for facts unavailable in quote/knowledge.',
      '',
      'When action is answer_question, write a short WhatsApp-ready answer using only the quote context and knowledge. Do not repeat the full quotation. Do not invent availability or prices.',
      'When action is send_quote, answer must be null because code will generate the quote from backend data.',
      'When action is booking_follow_up, answer should confirm team follow-up without promising final availability.',
      'When action is handoff, answer must be null.',
      '',
      `Current quote context:\n${JSON.stringify(umrahQuoteContext(args.quote))}`,
      `Extracted customer details:\n${JSON.stringify(args.details)}`,
      knowledge.length ? `Knowledge base:\n${knowledge.join('\n---\n')}` : 'Knowledge base: none',
      '',
      'JSON shape: {"action":"send_quote|answer_question|booking_follow_up|handoff","answer":string|null}',
    ].join('\n')

    const recentMessages = args.messages
      .slice(-12)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      }))
    const result = await generateReply({
      config: args.config,
      systemPrompt,
      messages: recentMessages,
    })
    const json = extractJsonObject(result.text)
    const action = String(json?.action ?? '')
    if (!['send_quote', 'answer_question', 'booking_follow_up', 'handoff'].includes(action)) return null
    return {
      action: action as UmrahAiDecision['action'],
      answer: stringValue(json?.answer),
    }
  } catch (err) {
    console.error('[ai auto-reply] umrah action decision failed:', err)
    return null
  }
}

async function uploadUmrahQuotePdf(args: {
  db: AdminClient
  accountId: string
  quote: UmrahQuoteResult
}): Promise<AiReplyDocument | null> {
  const bucket = process.env.QUOTE_PDF_BUCKET || 'quotes'
  const safeDate = args.quote.startDate.replace(/[^a-zA-Z0-9_-]+/g, '-')
  const path = `account-${args.accountId}/umrah-${safeDate}-${Date.now()}.pdf`
  const pdf = buildUmrahQuotePdf(args.quote)
  const pdfBody = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
  const { error: uploadError } = await args.db.storage
    .from(bucket)
    .upload(path, new Blob([pdfBody], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      cacheControl: '3600',
      upsert: false,
    })
  if (uploadError) {
    console.error('[ai auto-reply] quote PDF upload failed:', uploadError)
    return null
  }

  const { data } = args.db.storage.from(bucket).getPublicUrl(path)
  if (!data.publicUrl) {
    console.error('[ai auto-reply] quote PDF public URL failed')
    return null
  }

  return {
    link: data.publicUrl,
    bytes: pdf,
    filename: 'Umrah Quotation.pdf',
    caption: 'Your Umrah quotation PDF is attached.',
  }
}

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

async function metaErrorText(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string; code?: number; error_subcode?: number } }
    if (payload.error?.message) {
      return `${payload.error.message}${payload.error.code ? ` (code ${payload.error.code}${payload.error.error_subcode ? `/${payload.error.error_subcode}` : ''})` : ''}`
    }
  } catch {
    // Keep the HTTP fallback when Meta did not return JSON.
  }
  return fallback
}

/**
 * Auto-reply-owned PDF sender.
 *
 * There is intentionally ONE document delivery path for Umrah quotations:
 *   generated PDF bytes -> Meta /media -> media_id -> Meta /messages.
 *
 * The Supabase URL is retained only for CRM history (`messages.media_url`).
 * It is never used by Meta to fetch the PDF.
 */
async function sendUmrahQuotePdfDirect(args: {
  db: AdminClient
  accountId: string
  conversationId: string
  contactId: string
  document: AiReplyDocument
}): Promise<{ whatsapp_message_id: string }> {
  const { data: contact, error: contactErr } = await args.db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await args.db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config?.phone_number_id || !config?.access_token) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)
  const pdfBody = args.document.bytes.buffer.slice(
    args.document.bytes.byteOffset,
    args.document.bytes.byteOffset + args.document.bytes.byteLength,
  ) as ArrayBuffer

  // Step 1: upload the actual generated PDF bytes to WhatsApp Cloud API.
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', 'application/pdf')
  form.append('file', new Blob([pdfBody], { type: 'application/pdf' }), args.document.filename)

  const uploadResponse = await fetch(`${META_API_BASE}/${config.phone_number_id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  })
  if (!uploadResponse.ok) {
    throw new Error(await metaErrorText(
      uploadResponse,
      `Meta PDF upload failed: HTTP ${uploadResponse.status}`,
    ))
  }
  const uploadData = await uploadResponse.json() as { id?: string }
  if (!uploadData.id) {
    throw new Error('Meta PDF upload succeeded but no media id was returned')
  }

  // Step 2: send the uploaded media id. Retry only recipient-format failures.
  const attempt = async (phone: string): Promise<string> => {
    const sendResponse = await fetch(`${META_API_BASE}/${config.phone_number_id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'document',
        document: {
          id: uploadData.id,
          filename: args.document.filename,
          ...(args.document.caption ? { caption: args.document.caption } : {}),
        },
      }),
    })
    if (!sendResponse.ok) {
      throw new Error(await metaErrorText(
        sendResponse,
        `Meta PDF send failed: HTTP ${sendResponse.status}`,
      ))
    }
    const sendData = await sendResponse.json() as { messages?: Array<{ id?: string }> }
    const messageId = sendData.messages?.[0]?.id
    if (!messageId) throw new Error('Meta PDF send succeeded but no message id was returned')
    return messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null

  for (const phone of variants) {
    try {
      waMessageId = await attempt(phone)
      workingPhone = phone
      lastError = null
      break
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(message)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError
  if (!waMessageId) throw new Error('Meta PDF send returned no WhatsApp message id')

  if (workingPhone !== sanitized) {
    await args.db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Keep the CRM inbox/history in sync with the document that actually went to Meta.
  const { error: msgErr } = await args.db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'document',
    content_text: args.document.caption ?? null,
    media_url: args.document.link,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`PDF sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await args.db
    .from('conversations')
    .update({
      last_message_text: args.document.caption?.trim() || '[document]',
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

function umrahLeadNotes(details: ParsedUmrahDetails, latestText: string): string {
  return [
    'AI Umrah request from WhatsApp.',
    details.budget ? `Budget: ${details.budget}` : null,
    details.travelDate ? `Travel Dates: ${details.travelDate}` : null,
    details.days ? `No. of Days: ${details.days}` : null,
    details.makkahNights ? `Makkah Nights: ${details.makkahNights}` : null,
    details.madinahNights ? `Madina Nights: ${details.madinahNights}` : null,
    details.adults !== null ? `Adults: ${details.adults}` : null,
    details.children !== null ? `Kids: ${details.children}` : null,
    details.infants !== null ? `Infants: ${details.infants}` : null,
    details.elderly ? `Elderly: ${details.elderly}` : null,
    details.hotelCategory ? `Hotel Category: ${details.hotelCategory}` : null,
    details.rooms ? `Rooms: ${details.rooms}` : null,
    details.roomSharing ? `Room Sharing: ${details.roomSharing}` : null,
    details.vehicle ? `Vehicle: ${details.vehicle}` : null,
    details.ziyarat !== null ? `Ziyarat: ${details.ziyarat ? 'Required' : 'Not Required'}` : null,
    details.selectedZiyarats?.length ? `Selected Ziyarats: ${details.selectedZiyarats.join(', ')}` : null,
    details.makkahHotelQuery ? `Requested Makkah Hotel: ${details.makkahHotelQuery}` : null,
    details.madinahHotelQuery ? `Requested Madina Hotel: ${details.madinahHotelQuery}` : null,
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
  config: AiConfig
  latestText: string
  messages: { role: string; content: string }[]
}): Promise<AiReplyPayload | null> {
  const isUmrah = /\bumrah\b/i.test(conversationText(args.messages))
  if (!isUmrah) return null

  const alreadyAsked = args.messages.some((message) =>
    message.role === 'assistant' && message.content.includes('customized Umrah package'),
  )
  const details = mergeUmrahDetails(
    parseUmrahDetails(args.messages),
    await extractUmrahDetailsWithAi(args.config, args.messages),
  )
  const missing = missingUmrahFields(details)
  const invalidDateMessage = invalidLatestUmrahDateMessage(args.latestText)
  if (invalidDateMessage) {
    await upsertAiUmrahLead({ ...args, details })
    return invalidDateMessage
  }
  const wantsHotelChange = /\bchange\b.*\bhotel\b|\bhotel\b.*\bchange\b/i.test(args.latestText)
  if (wantsHotelChange && !/\b(al\s+|hotel|tower|towers|makkah|madina|madinah)\b.{0,80}\b(to|as|with)\b/i.test(args.latestText)) {
    await upsertAiUmrahLead({ ...args, details })
    return [
      'Sure. Please tell me which hotel you want to change.',
      '',
      'Example:',
      'Makkah hotel: hotel name or preferred area',
      'Madina hotel: hotel name or preferred area',
      '',
      'If you only want to change the category, reply with Economy / Standard / Executive.',
    ].join('\n')
  }

  if (!alreadyAsked && missing.length > 0) {
    await upsertAiUmrahLead({ ...args, details })
    return UMRAH_INTAKE_MESSAGE
  }

  if (missing.length > 0) {
    await upsertAiUmrahLead({ ...args, details })
    if (alreadyAsked && !likelyUsefulUmrahAnswer(args.latestText)) {
      return formatInvalidUmrahAnswerPrompt(missing)
    }
    return formatMissingUmrahPrompt(missing)
  }

  try {
    const plannerData = await loadUmrahPlannerDataForAccount(args.db, args.accountId)
    const { quote, vehicle: currentVehicle } = buildCurrentUmrahQuote(details, plannerData)
    const aiDecision = await decideAiUmrahAction({
      db: args.db,
      accountId: args.accountId,
      config: args.config,
      latestText: args.latestText,
      messages: args.messages,
      details,
      quote,
    })

    if (aiDecision?.action === 'handoff') {
      await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
      return null
    }

    if (aiDecision?.action === 'booking_follow_up') {
      await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
      return aiDecision.answer || [
        'Great, I have marked this Umrah package for booking follow-up.',
        `Current package total: ${quote.priceText}.`,
        'Our team will confirm hotel availability, payment details, and required documents before final booking.',
      ].join('\n')
    }

    if (aiDecision?.action === 'answer_question' && aiDecision.answer) {
      await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
      return aiDecision.answer
    }

    if (/\b(book it|confirm|proceed|go ahead|reserve|final|great book)\b/i.test(args.latestText)) {
      await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
      return [
        'Great, I have marked this Umrah package for booking follow-up.',
        `Current package total: ${quote.priceText}`,
        'Our team will confirm hotel availability, payment details, and required documents before final booking.',
      ].join('\n')
    }

    if (/\bvisa\b/i.test(args.latestText) && /\b(fee|fees|price|cost|charges|tell|about)\b/i.test(args.latestText)) {
      await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
      return [
        `Visa fee included in this quotation: PKR ${Math.round(quote.visaTotal).toLocaleString('en-PK')}.`,
        `This is calculated for ${quote.visaTravelers} traveler${quote.visaTravelers === 1 ? '' : 's'}.`,
        'Final visa charges can vary if supplier or government fees change before booking.',
      ].join('\n')
    }

    if (/\bziyarat/i.test(args.latestText) && /\b(available|option|options|include|tell|what|which|\?)/i.test(args.latestText)) {
      await upsertAiUmrahLead({ ...args, details })
      return availableUmrahZiyaratsText(plannerData)
    }

    if (/\b(category|categories|hotel type|hotel types)\b/i.test(args.latestText) && /\b(what|which|other|available|options|\?)/i.test(args.latestText)) {
      await upsertAiUmrahLead({ ...args, details })
      return umrahHotelCategoriesText()
    }

    if (/\b(lower|cheaper|cheap|lowest|less rate|low rate|reduce price|reduce rate)\b/i.test(args.latestText) && /\b(hotel|package|rate|price)\b/i.test(args.latestText)) {
      const lowerDetails = { ...details, hotelCategory: 'Economy', hotelPreference: 'cheapest' as const }
      const lowerQuote = buildCurrentUmrahQuote(lowerDetails, plannerData, {
        hotelCategory: 'Economy',
        hotelPreference: 'cheapest',
      }).quote
      const reply = [
        'I checked the lower-rate available hotel option for these dates.',
        '',
        lowerQuote.whatsappText,
      ].join('\n')
      await upsertAiUmrahLead({ ...args, details: lowerDetails, quoteText: reply })
      return {
        text: reply,
        document: await uploadUmrahQuotePdf({ db: args.db, accountId: args.accountId, quote: lowerQuote }) ?? undefined,
      }
    }

    if (
      /\b(?:1|one|single|per)\s*(?:person|adult|traveller|traveler|pax)\s*(?:price|rate|cost|charges?)?\b/i.test(args.latestText) ||
      /\b(?:price|rate|cost|charges?)\s*(?:for|of|per)\s*(?:1|one|single|per)\s*(?:person|adult|traveller|traveler|pax)\b/i.test(args.latestText) ||
      /\bper\s*(?:person|adult|traveller|traveler|pax)\b/i.test(args.latestText)
    ) {
      const perPerson = Math.ceil(quote.total / Math.max(1, quote.travelers))
      await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
      return [
        `Approx per person price is PKR ${perPerson.toLocaleString('en-PK')}.`,
        `Total package: ${quote.priceText} for ${quote.travelers} traveler${quote.travelers === 1 ? '' : 's'}.`,
        'This is an estimate based on the selected hotels, transport, visa, and current live package data.',
      ].join('\n')
    }

    if (
      /\b(rate|price|total|quote|quotation|package)\b.{0,80}\b(include|included|includes|for|cover|covers)\b.{0,80}\b(all|people|persons|adults|travellers|travelers|pax)\b/i.test(args.latestText) ||
      /\b(include|included|includes|cover|covers)\b.{0,80}\b(all|people|persons|adults|travellers|travelers|pax)\b/i.test(args.latestText)
    ) {
      await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
      return [
        `Yes, this estimated total is for ${quote.travelers} traveler${quote.travelers === 1 ? '' : 's'}.`,
        `It is calculated for ${quote.rooms} x ${quote.roomType} room, ${quote.vehicle} transport, visa, and the selected hotels shown in the quotation.`,
        quote.ziyarats.length
          ? `Ziyarat included: ${quote.ziyarats.map((item) => item.name).join(', ')}.`
          : 'Ziyarat is not included in this quotation.',
        `Estimated total: ${quote.priceText}.`,
      ].join('\n')
    }

    if (/\b(which|what).{0,40}\b(vehicle|transport|car)\b|\b(vehicle|transport).{0,40}\bwith us\b/i.test(args.latestText)) {
      const options = availableUmrahVehicles(plannerData)
      await upsertAiUmrahLead({ ...args, details })
      return [
        `Your current package is calculated with ${currentVehicle}.`,
        options.length ? `Available vehicle options: ${options.join(', ')}.` : null,
        'If you want to change it, reply for example: Change vehicle to Hiace.',
      ].filter(Boolean).join('\n')
    }

    if (/\b(available hotels|which hotels|hotel options|show hotels|list hotels)\b/i.test(args.latestText)) {
      await upsertAiUmrahLead({ ...args, details })
      return availableUmrahHotelsText(plannerData, details.hotelCategory ?? 'Economy')
    }

    if (isInformationalQuestion(args.latestText) && !isUmrahPackageUpdate(args.latestText)) {
      await upsertAiUmrahLead({ ...args, details })
      return null
    }

    const budget = budgetAmount(details.budget)
    const hasPreviousQuote = args.messages.some((message) =>
      message.role === 'assistant' && /Tours in Pakistan Umrah quotation/i.test(message.content),
    )

    // First completed request gets the full quotation. Later package changes get a
    // short, contextual WhatsApp response matching exactly what the customer changed;
    // the full recalculated details remain in the attached PDF.
    const quoteText = hasPreviousQuote
      ? formatUmrahPackageUpdateReply({ latestText: args.latestText, quote, budget })
      : budget !== null && budget < quote.total
        ? [
            'I’ve prepared your Umrah quotation according to the details you shared.',
            `Estimated package: ${quote.priceText}.`,
            `Your budget is PKR ${budget.toLocaleString('en-PK')}, so the current available package is above your budget.`,
            '',
            quote.whatsappText,
          ].join('\n')
        : quote.whatsappText

    await upsertAiUmrahLead({ ...args, details, quoteText: quote.whatsappText })
    return {
      text: quoteText,
      document: await uploadUmrahQuotePdf({ db: args.db, accountId: args.accountId, quote }) ?? undefined,
    }
  } catch (err) {
    console.error('[ai auto-reply] umrah quote failed:', err)
    await upsertAiUmrahLead({ ...args, details })
    return 'Thank you. I have received your Umrah details. Our team will verify the latest hotel availability and share the final package shortly.'
  }
}


function formatUmrahPackageUpdateReply(args: {
  latestText: string
  quote: UmrahQuoteResult
  budget: number | null
}): string {
  const { latestText, quote, budget } = args
  const text = latestText.trim()
  const lines: Array<string | null> = []
  const makkah = quote.hotelLines.find((line) => /makkah/i.test(line.city))
  const madina = quote.hotelLines.find((line) => /madina|madinah/i.test(line.city))
  const transportIncluded = quote.transportSectors.length > 0 && !/^not included$/i.test(quote.vehicle)

  if (/\b(?:days?|nights?|duration)\b/i.test(text) || /^\s*\d{1,3}\s*(?:days?|nights?)?\s*$/i.test(text)) {
    lines.push(`Done — I’ve updated your package duration to ${quote.nights} nights.`)
    if (makkah || madina) {
      lines.push([
        makkah ? `Makkah: ${makkah.nights} nights` : null,
        madina ? `Madina: ${madina.nights} nights` : null,
      ].filter(Boolean).join(' | '))
    }
  } else if (/\b(date|travel date|departure|start)\b/i.test(text) || /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text)) {
    lines.push(`Done — I’ve updated the travel date to ${quote.startDate}.`)
    if (makkah && madina) lines.push(`Stay: ${makkah.nights} nights Makkah + ${madina.nights} nights Madina.`)
  } else if (/\b(?:people|persons?|pax|travellers?|travelers?|adults?|children|kids|infants?|babies)\b/i.test(text)) {
    lines.push(`Done — I’ve updated the passenger details to ${quote.travelers} traveler${quote.travelers === 1 ? '' : 's'}.`)
    lines.push(`Room setup: ${quote.rooms} x ${quote.roomType}.`)
  } else if (/\b(?:executive|standard|economy|hotel category|category)\b/i.test(text)) {
    lines.push(`Done — I’ve updated the hotel category to ${quote.packageCategory}.`)
    if (makkah) lines.push(`Makkah: ${makkah.hotel}.`)
    if (madina) lines.push(`Madina: ${madina.hotel}.`)
  } else if (/\bhotel\b/i.test(text)) {
    lines.push('Done — I’ve updated the hotel selection.')
    if (makkah) lines.push(`Makkah: ${makkah.hotel}.`)
    if (madina) lines.push(`Madina: ${madina.hotel}.`)
  } else if (/\b(?:no|without|remove|skip|dont|don't|do not)\b.{0,35}\b(?:transport|vehicle|car|vehcile)\b|\b(?:transport|vehicle|vehcile)\b.{0,25}\b(?:no|off|remove|without)\b/i.test(text)) {
    lines.push(transportIncluded
      ? `Done — transport has been updated to ${quote.vehicle}.`
      : 'Done — I’ve removed transport from your Umrah package.')
  } else if (/\b(?:vehicle|transport|vehcile|suv|car|staria|gmc|hiace|coaster|shared shuttle)\b/i.test(text)) {
    lines.push(transportIncluded
      ? `Done — I’ve updated the transport vehicle to ${quote.vehicle}.`
      : 'Done — transport is not included in this package.')
  } else if (/\b(?:ziyarat|ziyarats|badar|taif)\b/i.test(text)) {
    lines.push(quote.ziyarats.length
      ? `Done — I’ve updated the Ziyarat selection: ${quote.ziyarats.map((item) => item.name).join(', ')}.`
      : 'Done — Ziyarat has been removed from the package.')
  } else if (/\b(?:budget|pkr|rs\.?|lakh|lac)\b/i.test(text)) {
    lines.push('Done — I’ve updated your budget and recalculated the available package.')
  } else {
    lines.push('Done — I’ve updated your Umrah package according to your latest request.')
  }

  lines.push(`Updated estimated total: ${quote.priceText}.`)

  if (budget !== null && budget < quote.total) {
    lines.push(`Your budget is PKR ${budget.toLocaleString('en-PK')}, so the currently available package is above budget by PKR ${Math.round(quote.total - budget).toLocaleString('en-PK')}.`)
  }

  lines.push('I’ve attached the updated quotation PDF.')
  return lines.filter(Boolean).join('\n')
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
      config,
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
      const replyText = typeof umrahReply === 'string' ? umrahReply : umrahReply.text
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: replyText,
      })
      const document = typeof umrahReply === 'string' ? null : umrahReply.document
      if (document) {
        try {
          await sendUmrahQuotePdfDirect({
            db,
            accountId,
            conversationId,
            contactId,
            document,
          })
        } catch (err) {
          // No URL fallback and no alternate media sender: one PDF path only.
          console.error('[ai auto-reply] direct Meta quote PDF send failed:', err)
        }
      }
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




