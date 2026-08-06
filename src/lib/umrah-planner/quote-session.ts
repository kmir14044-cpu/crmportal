import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadUmrahPlannerDataForAccount,
  quoteUmrah,
  type UmrahQuoteInput,
  type UmrahQuoteResult,
} from "./quote";

export interface QuoteSessionIdentity {
  accountId: string;
  userId: string;
  contactId: string;
  conversationId?: string | null;
}

export async function saveUmrahQuoteSession(
  db: SupabaseClient,
  identity: QuoteSessionIdentity,
  request: UmrahQuoteInput,
  result: UmrahQuoteResult,
): Promise<void> {
  const { error } = await db.from("umrah_quote_sessions").upsert({
    account_id: identity.accountId,
    user_id: identity.userId,
    contact_id: identity.contactId,
    conversation_id: identity.conversationId ?? null,
    request_payload: request,
    result_payload: result,
    pending_edit: {},
    status: "quoted",
    updated_at: new Date().toISOString(),
  }, { onConflict: "account_id,contact_id" });
  if (error) throw new Error(error.message);
}

export async function recalculateUmrahQuoteSession(args: {
  db: SupabaseClient;
  identity: QuoteSessionIdentity;
  changes: Partial<UmrahQuoteInput>;
}): Promise<UmrahQuoteResult | null> {
  const { data, error } = await args.db
    .from("umrah_quote_sessions")
    .select("request_payload")
    .eq("account_id", args.identity.accountId)
    .eq("contact_id", args.identity.contactId)
    .maybeSingle();
  if (error || !data) return null;

  const request = { ...(data.request_payload as UmrahQuoteInput), ...args.changes };
  const plannerData = await loadUmrahPlannerDataForAccount(args.db, args.identity.accountId);
  const result = quoteUmrah(request, plannerData);
  await saveUmrahQuoteSession(args.db, args.identity, request, result);
  return result;
}
