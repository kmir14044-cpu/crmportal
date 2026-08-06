import type { SupabaseClient } from "@supabase/supabase-js";
import { engineSendInteractiveList, engineSendText } from "@/lib/flows/meta-send";
import { loadUmrahDynamicOptions, type UmrahDynamicSource } from "@/lib/flows/umrah-dynamic-options";
import { loadUmrahPlannerDataForAccount, quoteUmrah, type UmrahQuoteInput, type UmrahQuoteResult } from "./quote";
import { saveUmrahQuoteSession } from "./quote-session";

export interface UmrahFollowUpInput {
  db: SupabaseClient;
  accountId: string;
  userId: string;
  contactId: string;
  conversationId: string;
  text?: string;
  interactiveReplyId?: string | null;
}

type PendingEdit = {
  field?: string;
  source?: UmrahDynamicSource;
  page?: number;
  selected?: string[];
  hotelStep?: "makkah" | "madinah";
};

type SessionRow = {
  request_payload: UmrahQuoteInput;
  result_payload: UmrahQuoteResult;
  pending_edit?: PendingEdit;
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstNumber(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

function boolIntent(text: string, word: string): boolean | null {
  if (!normalize(text).includes(word)) return null;
  if (/\b(remove|without|exclude|no|not|nahi|nahin)\b/i.test(text)) return false;
  if (/\b(add|include|with|yes|haan|han)\b/i.test(text)) return true;
  return null;
}

function parseDirectChanges(text: string): Partial<UmrahQuoteInput> {
  const changes: Partial<UmrahQuoteInput> = {};
  const lower = normalize(text);
  const date = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (date) changes.start_date = `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`;

  const adults = firstNumber(lower, [/(?:adult|adults)\s*(?:to|=|is)?\s*(\d+)/, /(?:make|change)\s+(?:it\s+)?(\d+)\s+adults?/]);
  const children = firstNumber(lower, [/(?:child|children)\s*(?:to|=|is)?\s*(\d+)/]);
  const infants = firstNumber(lower, [/(?:infant|infants)\s*(?:to|=|is)?\s*(\d+)/]);
  const rooms = firstNumber(lower, [/(?:room|rooms)\s*(?:to|=|is)?\s*(\d+)/, /(?:make|change)\s+(?:it\s+)?(\d+)\s+rooms?/]);
  const nights = firstNumber(lower, [/(\d+)\s+nights?/, /(?:night|nights)\s*(?:to|=|is)?\s*(\d+)/]);
  if (adults != null) changes.adults = adults;
  if (children != null) changes.children = children;
  if (infants != null) changes.infants = infants;
  if (rooms != null) changes.rooms = rooms;
  if (nights != null) changes.nights = nights;

  if (/\bdouble\b/i.test(text)) changes.room_type = "Double";
  else if (/\btriple\b/i.test(text)) changes.room_type = "Triple";
  else if (/\bquad\b/i.test(text)) changes.room_type = "Quad";

  if (/\beconomy\b/i.test(text)) changes.hotel_category = "Economy";
  else if (/\bstandard\b/i.test(text)) changes.hotel_category = "Standard";
  else if (/\bpremium\b|\bluxury\b/i.test(text)) changes.hotel_category = "Premium";

  if (/\bmadin(?:a|ah)\s*(?:then|to|->|-)\s*makkah\b/i.test(text)) changes.route_preset_id = "md-mk";
  else if (/\bmakkah\s*(?:then|to|->|-)\s*madin(?:a|ah)\b/i.test(text)) changes.route_preset_id = "mk-md";

  const visa = boolIntent(text, "visa");
  if (visa != null) changes.include_visa = visa;
  const ziyarat = boolIntent(text, "ziyarat");
  if (ziyarat === false) {
    changes.include_ziyarat = false;
    changes.selected_ziyarats = [];
  }

  if (/\bfull transport\b/i.test(text)) {
    changes.transport_mode = "full";
    changes.selected_sectors = [];
  } else if (/\bno transport\b|\bremove transport\b/i.test(text)) {
    changes.transport_mode = "selective";
    changes.selected_sectors = [];
  }
  return changes;
}

function replyId(field: string, action: string, value = ""): string {
  return `uedit:${field}:${action}:${encodeURIComponent(value)}`.slice(0, 200);
}

function parseReplyId(value: string): { field: string; action: string; value: string } | null {
  const match = value.match(/^uedit:([^:]+):(select|finish|none|next|prev):(.*)$/);
  return match ? { field: match[1], action: match[2], value: decodeURIComponent(match[3] || "") } : null;
}

async function loadSession(input: UmrahFollowUpInput): Promise<SessionRow | null> {
  const { data, error } = await input.db.from("umrah_quote_sessions")
    .select("request_payload,result_payload,pending_edit")
    .eq("account_id", input.accountId).eq("contact_id", input.contactId).maybeSingle();
  return error || !data ? null : data as SessionRow;
}

async function updatePending(input: UmrahFollowUpInput, pending: PendingEdit): Promise<void> {
  await input.db.from("umrah_quote_sessions").update({ pending_edit: pending, status: "editing", updated_at: new Date().toISOString() })
    .eq("account_id", input.accountId).eq("contact_id", input.contactId);
}

async function sendCatalog(input: UmrahFollowUpInput, session: SessionRow, pending: PendingEdit): Promise<void> {
  if (!pending.source || !pending.field) return;
  const vars: Record<string, unknown> = {
    umrah_hotel_category: session.request_payload.hotel_category,
    umrah_route: session.request_payload.route_preset_id,
  };
  const options = await loadUmrahDynamicOptions({ db: input.db, accountId: input.accountId, source: pending.source, vars });
  const page = Math.max(0, pending.page ?? 0);
  const pageSize = 7;
  const visible = options.slice(page * pageSize, page * pageSize + pageSize);
  const rows = visible.map((option) => ({ id: replyId(pending.field!, "select", option.value), title: option.title.slice(0, 24), description: option.description?.slice(0, 72) }));
  const multi = pending.field === "selected_sectors" || pending.field === "selected_ziyarats";
  if (multi) rows.push({ id: replyId(pending.field, "finish"), title: "Finish selection", description: `${pending.selected?.length ?? 0} selected` });
  rows.push({ id: replyId(pending.field, "none"), title: "None", description: "Clear this selection" });
  if ((page + 1) * pageSize < options.length && rows.length < 10) rows.push({ id: replyId(pending.field, "next"), title: "Next page", description: "Show more options" });
  else if (page > 0 && rows.length < 10) rows.push({ id: replyId(pending.field, "prev"), title: "Previous page", description: "Go back" });

  const title = pending.source === "makkah_hotels" ? "Select Makkah hotel" : pending.source === "madinah_hotels" ? "Select Madinah hotel" : pending.source === "transport_sectors" ? "Select transport sectors" : "Select Ziyarat places";
  await engineSendInteractiveList({ accountId: input.accountId, userId: input.userId, conversationId: input.conversationId, contactId: input.contactId, bodyText: title, buttonLabel: "View options", sections: [{ title: "Available options", rows }] });
}

async function recalculate(input: UmrahFollowUpInput, session: SessionRow, changes: Partial<UmrahQuoteInput>): Promise<void> {
  const request = { ...session.request_payload, ...changes };
  const data = await loadUmrahPlannerDataForAccount(input.db, input.accountId);
  const result = quoteUmrah(request, data);
  await saveUmrahQuoteSession(input.db, { accountId: input.accountId, userId: input.userId, contactId: input.contactId, conversationId: input.conversationId }, request, result);
  await engineSendText({ accountId: input.accountId, userId: input.userId, conversationId: input.conversationId, contactId: input.contactId, text: `Your Umrah quotation has been updated.\n\n${result.whatsappText}` });
}

export async function dispatchInboundToUmrahFollowUp(input: UmrahFollowUpInput): Promise<{ consumed: boolean }> {
  const session = await loadSession(input);
  if (!session) return { consumed: false };

  if (input.interactiveReplyId) {
    const parsed = parseReplyId(input.interactiveReplyId);
    const pending = session.pending_edit ?? {};
    if (!parsed || parsed.field !== pending.field) return { consumed: false };
    if (parsed.action === "next" || parsed.action === "prev") {
      pending.page = Math.max(0, (pending.page ?? 0) + (parsed.action === "next" ? 1 : -1));
      await updatePending(input, pending); await sendCatalog(input, session, pending); return { consumed: true };
    }
    if (parsed.action === "none") {
      if (parsed.field === "selected_sectors") return recalculate(input, session, { transport_mode: "selective", selected_sectors: [] }).then(() => ({ consumed: true }));
      if (parsed.field === "selected_ziyarats") return recalculate(input, session, { include_ziyarat: false, selected_ziyarats: [] }).then(() => ({ consumed: true }));
      return { consumed: true };
    }
    if (parsed.field === "selected_sectors" || parsed.field === "selected_ziyarats") {
      const selected = pending.selected ?? [];
      if (parsed.action === "select") pending.selected = selected.includes(parsed.value) ? selected.filter((v) => v !== parsed.value) : [...selected, parsed.value];
      if (parsed.action === "finish") {
        const changes = parsed.field === "selected_sectors" ? { transport_mode: "selective" as const, selected_sectors: pending.selected ?? [] } : { include_ziyarat: true, selected_ziyarats: pending.selected ?? [] };
        await recalculate(input, session, changes); return { consumed: true };
      }
      await updatePending(input, pending); await sendCatalog(input, session, pending); return { consumed: true };
    }
    if (parsed.action === "select" && parsed.field === "makkah_hotel") {
      const selected = { ...(session.request_payload.selected_hotels ?? {}), "Makkah-0": parsed.value };
      const next: PendingEdit = { field: "madinah_hotel", source: "madinah_hotels", hotelStep: "madinah", page: 0 };
      session.request_payload = { ...session.request_payload, selected_hotels: selected };
      await input.db.from("umrah_quote_sessions").update({ request_payload: session.request_payload, pending_edit: next }).eq("account_id", input.accountId).eq("contact_id", input.contactId);
      await sendCatalog(input, session, next); return { consumed: true };
    }
    if (parsed.action === "select" && parsed.field === "madinah_hotel") {
      const selected = { ...(session.request_payload.selected_hotels ?? {}), "Madinah-1": parsed.value };
      await recalculate(input, session, { selected_hotels: selected }); return { consumed: true };
    }
    return { consumed: false };
  }

  const text = input.text?.trim() ?? "";
  if (!text) return { consumed: false };
  if (/\b(send|show|get)\b.*\b(updated|latest|final)\b.*\b(itinerary|quotation|quote|package)\b/i.test(text)) {
    await engineSendText({ accountId: input.accountId, userId: input.userId, conversationId: input.conversationId, contactId: input.contactId, text: session.result_payload.whatsappText });
    return { consumed: true };
  }

  if (/\b(change|select|show)\b.*\bhotel\b/i.test(text) || /\b(economy|standard|premium|luxury)\b/i.test(text)) {
    const categoryChanges = parseDirectChanges(text);
    session.request_payload = { ...session.request_payload, ...categoryChanges };
    const onlyMadinah = /madin(?:a|ah)/i.test(text) && !/makkah/i.test(text);
    const pending: PendingEdit = onlyMadinah ? { field: "madinah_hotel", source: "madinah_hotels", page: 0 } : { field: "makkah_hotel", source: "makkah_hotels", page: 0 };
    await input.db.from("umrah_quote_sessions").update({ request_payload: session.request_payload, pending_edit: pending, status: "editing" }).eq("account_id", input.accountId).eq("contact_id", input.contactId);
    await sendCatalog(input, session, pending); return { consumed: true };
  }
  if (/\b(selective|separate)\b.*\btransport\b|\bchange transport\b/i.test(text)) {
    const pending: PendingEdit = { field: "selected_sectors", source: "transport_sectors", page: 0, selected: session.request_payload.selected_sectors ?? [] };
    await updatePending(input, pending); await sendCatalog(input, session, pending); return { consumed: true };
  }
  if (/\b(add|change|select|include)\b.*\bziyarat\b/i.test(text)) {
    const pending: PendingEdit = { field: "selected_ziyarats", source: "ziyarat_places", page: 0, selected: session.request_payload.selected_ziyarats ?? [] };
    await updatePending(input, pending); await sendCatalog(input, session, pending); return { consumed: true };
  }

  const changes = parseDirectChanges(text);
  if (Object.keys(changes).length) { await recalculate(input, session, changes); return { consumed: true }; }
  return { consumed: false };
}
