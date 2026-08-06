/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { normalizeFlowInput } from "./normalize-input";
import { parseUmrahBulkMessage } from "./umrah-bulk-intake";
import { quoteTrip } from "@/lib/trip-planner/quote";
import { loadUmrahPlannerDataForAccount, quoteUmrah, type UmrahQuoteInput, type UmrahQuoteResult } from "@/lib/umrah-planner/quote";
import { saveUmrahQuoteSession } from "@/lib/umrah-planner/quote-session";
import { loadUmrahDynamicOptions } from "./umrah-dynamic-options";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type DynamicUmrahListNodeConfig,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartFlowNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

function interactiveVarPatch(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): Record<string, string> {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.var_key ? { [hit.var_key]: hit.value ?? hit.title ?? reply_id } : {};
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit?.var_key) return { [hit.var_key]: hit.value ?? hit.title ?? reply_id };
    }
  }
  return {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeToken(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}_])`, "u").test(
    haystack,
  );
}

/**
 * Case-insensitive keyword matching. `contains` still supports phrases,
 * but very short alphanumeric keywords are token-bounded so "hi" does
 * not match inside "this", "shipping", or "high".
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const needle = cfg.case_sensitive ? trimmed : trimmed.toLowerCase();
    if (matchType === "exact" && haystack.trim() === needle) {
      return true;
    }
    if (matchType === "whole_word" && containsWholeToken(haystack, needle)) {
      return true;
    }
    const isShortToken = /^[\p{L}\p{N}_]{1,3}$/u.test(needle);
    if (
      matchType === "contains" &&
      (isShortToken ? containsWholeToken(haystack, needle) : haystack.includes(needle))
    ) {
      return true;
    }
  }
  return false;
}

export function canStartFlowForConversation(args: {
  config: KeywordTriggerConfig | Record<string, unknown>;
  isFirstInbound: boolean;
  lastCustomerMessageAt?: string | null;
  now?: Date;
}): boolean {
  const config = args.config as KeywordTriggerConfig;
  const startWhen = config.start_when ?? "anytime";
  if (startWhen === "anytime") return true;
  if (args.isFirstInbound) return true;
  if (startWhen === "new_only") return false;

  const inactiveHours =
    typeof config.inactive_hours === "number" && config.inactive_hours > 0
      ? config.inactive_hours
      : 24;
  if (!args.lastCustomerMessageAt) return false;
  const last = new Date(args.lastCustomerMessageAt).getTime();
  if (!Number.isFinite(last)) return false;
  const now = args.now?.getTime() ?? Date.now();
  return now - last >= inactiveHours * 60 * 60 * 1000;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "start_flow"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "dynamic_umrah_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

export function startFlowTargetRef(cfg: StartFlowNodeConfig): string {
  return (
    cfg.target_flow?.trim() ||
    cfg.flow_id?.trim() ||
    cfg.flow_name?.trim() ||
    ""
  );
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

const DEFAULT_LEAD_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 },
  { name: "Qualified", color: "#eab308", position: 1 },
  { name: "Proposal Sent", color: "#f97316", position: 2 },
  { name: "Negotiation", color: "#8b5cf6", position: 3 },
  { name: "Won", color: "#22c55e", position: 4 },
];

const LEAD_QUERY_FIELD = "Lead Query";

interface TripDesignerDetails {
  name: string;
  email: string;
  phone: string;
  trip_start_date: string;
  starting_city: string;
  destination: string;
  number_of_days: string;
  hotel_category: string;
  adults: string;
  children: string;
  rooms: string;
  transport_type: string;
  query: string;
}

interface TripDesignerQuote {
  ok?: boolean;
  currency?: string;
  estimatedPrice?: number;
  priceText?: string;
  summary?: string;
  selectedHotel?: string;
  selectedRoom?: string;
  transport?: string;
  tourTitle?: string;
  itinerary?: Array<{
    day?: number;
    title?: string;
    items?: Array<{ time?: string; activity?: string }>;
    hotel?: string;
  }>;
  lead?: { id?: number; saved?: boolean };
}

interface UmrahPlannerDetails {
  name: string;
  email: string;
  phone: string;
  start_date: string;
  route_preset_id: string;
  nights: string;
  adults: string;
  children: string;
  infants: string;
  rooms: string;
  room_type: string;
  hotel_category: string;
  vehicle: string;
  transport_mode: "full" | "selective";
  include_visa: boolean;
  include_ziyarat: boolean;
  selected_hotels: Record<string, string>;
  selected_sectors: string[];
  selected_ziyarats: string[];
  query: string;
}

interface UmrahPlannerQuote {
  ok?: boolean;
  priceText?: string;
  whatsappText?: string;
  route?: string;
  nights?: number;
  hotelLines?: Array<{
    city?: string;
    nights?: number;
    hotel?: string;
    checkIn?: string;
    checkOut?: string;
    hasMissingRates?: boolean;
  }>;
  transportSectors?: Array<{ label?: string; amount?: number }>;
  hasMissingRates?: boolean;
}

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  lastCustomerMessageAt?: string | null,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      const config = flow.trigger_config as KeywordTriggerConfig;
      if (
        canStartFlowForConversation({
          config,
          isFirstInbound,
          lastCustomerMessageAt,
        }) &&
        matchesKeywordTrigger(message.text, config)
      ) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================


function dynamicReplyId(nodeKey: string, action: "select" | "finish" | "none" | "next" | "prev", value = ""): string {
  return `udyn:${nodeKey}:${action}:${encodeURIComponent(value)}`.slice(0, 200);
}

function parseDynamicReplyId(replyId: string): { nodeKey: string; action: string; value: string } | null {
  const match = replyId.match(/^udyn:([^:]+):(select|finish|none|next|prev):(.*)$/);
  if (!match) return null;
  return { nodeKey: match[1], action: match[2], value: decodeURIComponent(match[3] || "") };
}

async function sendDynamicUmrahListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as unknown as DynamicUmrahListNodeConfig;
  const pageVar = `__dynamic_page_${node.node_key}`;
  const page = Math.max(0, Number(run.vars[pageVar] ?? 0) || 0);
  const all = await loadUmrahDynamicOptions({
    db,
    accountId: run.account_id,
    source: cfg.source,
    vars: run.vars,
  });
  const pageSize = Math.min(8, Math.max(1, cfg.page_size ?? 7));
  const start = page * pageSize;
  const visible = all.slice(start, start + pageSize);
  const rows = visible.map((option) => ({
    id: dynamicReplyId(node.node_key, "select", option.value),
    title: option.title.slice(0, 24),
    description: option.description?.slice(0, 72),
  }));
  if (cfg.selection_mode === "multiple") {
    rows.push({ id: dynamicReplyId(node.node_key, "finish"), title: "Finish selection", description: "Continue with selected items" });
  }
  if (cfg.allow_none) {
    rows.push({ id: dynamicReplyId(node.node_key, "none"), title: "None", description: "Clear selection and continue" });
  }
  if (start + pageSize < all.length && rows.length < 10) {
    rows.push({ id: dynamicReplyId(node.node_key, "next"), title: "Next page", description: `More ${cfg.source.replaceAll("_", " ")}` });
  } else if (page > 0 && rows.length < 10) {
    rows.push({ id: dynamicReplyId(node.node_key, "prev"), title: "Previous page", description: "Go back" });
  }
  if (!visible.length && !rows.length) {
    await engineSendText({ accountId: run.account_id, userId: run.user_id, conversationId: run.conversation_id!, contactId: run.contact_id!, text: "No matching options are currently available. Our team will confirm this manually." });
    return;
  }
  await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: [{ title: "Available options", rows }],
  });
}

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    ai_autoreply_disabled: false,
    updated_at: new Date().toISOString(),
  };
  convUpdate.assigned_agent_id = cfg.assign_to ?? null;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await persistLeadCapture(db, run);
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function firstVar(vars: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = vars[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizedLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseBulkFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:[-*]|\d+[.)])?\s*([^:=\-]+?)\s*[:=\-]\s*(.+)$/);
    if (!match) continue;
    const label = normalizedLabel(match[1]);
    const value = match[2].trim();
    if (label && value) out[label] = value;
  }
  return out;
}

function bulkValue(fields: Record<string, string>, labels: string[]): string {
  for (const label of labels) {
    const value = fields[normalizedLabel(label)];
    if (value) return value;
  }
  return "";
}

function nonEmptyBulkLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isSkipValue(value: string | undefined): boolean {
  return ["skip", "no", "none", "n/a", "na", "-"].includes(String(value ?? "").trim().toLowerCase());
}

function looksLikeDateValue(value: string | undefined): boolean {
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(value ?? "").trim());
}

function parseOrderedTripDetails(text: string): Record<string, string> {
  const lines = nonEmptyBulkLines(text);
  if (lines.length < 7 || lines.some((line) => /[:=]/.test(line))) return {};
  let index = 0;
  let name = "";
  let email = "";
  if (!looksLikeDateValue(lines[index])) {
    name = isSkipValue(lines[index]) ? "" : lines[index];
    index += 1;
  }
  if (!looksLikeDateValue(lines[index])) {
    email = isSkipValue(lines[index]) ? "" : lines[index];
    index += 1;
  }
  const core = lines.slice(index);
  const [trip_start_date, starting_city, destination, number_of_days, adults] = core;
  const tail = core.slice(5);
  let children = "0";
  let rooms = "1";
  let hotel_category = "";
  let transport_type = "";
  let rest: string[] = [];

  if (tail.length >= 4) {
    [children, rooms, hotel_category, transport_type, ...rest] = tail;
  } else if (tail.length === 3) {
    [children, hotel_category, transport_type, ...rest] = tail;
  } else if (tail.length >= 2) {
    [hotel_category, transport_type, ...rest] = tail;
  }

  if (!trip_start_date || !starting_city || !destination || !number_of_days || !hotel_category || !transport_type) {
    return {};
  }
  return {
    name,
    email,
    trip_start_date,
    starting_city,
    destination,
    number_of_days,
    adults,
    children,
    rooms,
    hotel_category,
    transport_type,
    query: rest.join(" "),
  };
}

function parseOrderedUmrahDetails(text: string): Record<string, string> {
  const lines = nonEmptyBulkLines(text);
  if (lines.length < 10 || lines.some((line) => /[:=]/.test(line))) return {};
  let index = 0;
  let name = "";
  let email = "";
  if (!looksLikeDateValue(lines[index])) {
    name = isSkipValue(lines[index]) ? "" : lines[index];
    index += 1;
  }
  if (!looksLikeDateValue(lines[index])) {
    email = isSkipValue(lines[index]) ? "" : lines[index];
    index += 1;
  }
  const [
    umrah_start_date,
    umrah_route,
    umrah_nights,
    umrah_adults,
    umrah_children,
    umrah_infants,
    umrah_rooms,
    umrah_room_type,
    umrah_hotel_category,
    umrah_vehicle,
    umrah_include_ziyarat,
    ...rest
  ] = lines.slice(index);
  if (!umrah_start_date || !umrah_route || !umrah_nights || !umrah_rooms || !umrah_room_type || !umrah_hotel_category || !umrah_vehicle) {
    return {};
  }
  return {
    name,
    email,
    umrah_start_date,
    umrah_route,
    umrah_nights,
    umrah_adults,
    umrah_children,
    umrah_infants,
    umrah_rooms,
    umrah_room_type,
    umrah_hotel_category,
    umrah_vehicle,
    umrah_include_ziyarat,
    query: rest.join(" "),
  };
}

function bulkDetailsLookComplete(text: string, kind: "bulk_trip" | "bulk_umrah"): boolean {
  const fields = parseBulkFields(text);
  if (kind === "bulk_trip") {
    const ordered = parseOrderedTripDetails(text);
    return Boolean(
      ordered.trip_start_date ||
      bulkValue(fields, ["date", "travel date", "trip date", "start date", "trip start date"]) &&
        bulkValue(fields, ["from", "starting city", "departure city", "city"]) &&
        bulkValue(fields, ["destination", "place", "tour", "package"]) &&
        bulkValue(fields, ["days", "duration", "number of days"]) &&
        bulkValue(fields, ["hotel", "hotel category", "category"]) &&
        bulkValue(fields, ["transport", "vehicle", "car"]),
    );
  }
  const ordered = parseOrderedUmrahDetails(text);
  return Boolean(
    ordered.umrah_start_date ||
    bulkValue(fields, ["date", "travel date", "start date", "umrah date", "departure date"]) &&
      bulkValue(fields, ["route", "umrah route"]) &&
      bulkValue(fields, ["nights", "total nights", "duration"]) &&
      bulkValue(fields, ["rooms", "room"]) &&
      bulkValue(fields, ["room type", "sharing", "room sharing"]) &&
      bulkValue(fields, ["hotel category", "category", "hotel"]) &&
      bulkValue(fields, ["vehicle", "transport", "car"]),
  );
}

function varsFromBulkDetails(vars: Record<string, unknown>): Record<string, string> {
  const tripBulk = firstVar(vars, ["trip_bulk_details", "pakistan_bulk_details", "tour_bulk_details"]);
  const umrahBulk = firstVar(vars, ["umrah_bulk_details"]);
  const genericBulk = firstVar(vars, ["bulk_details", "quote_details"]);
  const out: Record<string, string> = {};

  if (tripBulk || genericBulk) {
    const fields = parseBulkFields(tripBulk || genericBulk);
    const ordered = parseOrderedTripDetails(tripBulk || genericBulk);
    out.name = bulkValue(fields, ["name", "full name", "customer name"]) || ordered.name;
    out.email = bulkValue(fields, ["email", "email address"]) || ordered.email;
    out.trip_start_date = bulkValue(fields, ["date", "travel date", "trip date", "start date", "trip start date"]) || ordered.trip_start_date;
    out.starting_city = bulkValue(fields, ["from", "starting city", "departure city", "city"]) || ordered.starting_city;
    out.destination = bulkValue(fields, ["destination", "place", "tour", "package"]) || ordered.destination;
    out.number_of_days = bulkValue(fields, ["days", "duration", "number of days"]) || ordered.number_of_days;
    out.hotel_category = bulkValue(fields, ["hotel", "hotel category", "category"]) || ordered.hotel_category;
    out.adults = bulkValue(fields, ["adults", "adult"]) || ordered.adults;
    out.children = bulkValue(fields, ["children", "child"]) || ordered.children;
    out.rooms = bulkValue(fields, ["rooms", "room"]) || ordered.rooms;
    out.transport_type = bulkValue(fields, ["transport", "vehicle", "car"]) || ordered.transport_type;
    out.query = bulkValue(fields, ["query", "requirement", "requirements", "special requirement", "notes"]) || ordered.query;
  }

  if (umrahBulk || genericBulk) {
    const fields = parseBulkFields(umrahBulk || genericBulk);
    const ordered = parseOrderedUmrahDetails(umrahBulk || genericBulk);
    out.name ||= bulkValue(fields, ["name", "full name", "customer name"]) || ordered.name;
    out.email ||= bulkValue(fields, ["email", "email address"]) || ordered.email;
    out.umrah_start_date = bulkValue(fields, ["date", "travel date", "start date", "umrah date", "departure date"]) || ordered.umrah_start_date;
    out.umrah_route = bulkValue(fields, ["route", "umrah route"]) || ordered.umrah_route;
    out.umrah_nights = bulkValue(fields, ["nights", "total nights", "duration"]) || ordered.umrah_nights;
    out.umrah_adults = bulkValue(fields, ["adults", "adult"]) || ordered.umrah_adults;
    out.umrah_children = bulkValue(fields, ["children", "child"]) || ordered.umrah_children;
    out.umrah_infants = bulkValue(fields, ["infants", "infant"]) || ordered.umrah_infants;
    out.umrah_rooms = bulkValue(fields, ["rooms", "room"]) || ordered.umrah_rooms;
    out.umrah_room_type = bulkValue(fields, ["room type", "sharing", "room sharing"]) || ordered.umrah_room_type;
    out.umrah_hotel_category = bulkValue(fields, ["hotel category", "category", "hotel"]) || ordered.umrah_hotel_category;
    out.umrah_vehicle = bulkValue(fields, ["vehicle", "transport", "car"]) || ordered.umrah_vehicle;
    out.umrah_include_ziyarat = bulkValue(fields, ["ziyarat", "ziyarats", "include ziyarat"]) || ordered.umrah_include_ziyarat;
    out.query ||= bulkValue(fields, ["query", "requirement", "requirements", "special requirement", "notes"]) || ordered.query;
  }

  return Object.fromEntries(Object.entries(out).filter(([, value]) => value.trim()));
}

function optionalInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function buildTripDesignerDetails(args: {
  run: FlowRunRow;
  contact: Record<string, unknown> | null;
  name: string;
  email: string;
  tripStartDate: string;
  startingCity: string;
  destination: string;
  numberOfDays: string;
  hotelCategory: string;
  adults: string;
  children: string;
  rooms: string;
  transportType: string;
  query: string;
}): TripDesignerDetails {
  const contactName =
    typeof args.contact?.name === "string" ? args.contact.name.trim() : "";
  const contactEmail =
    typeof args.contact?.email === "string" ? args.contact.email.trim() : "";
  const contactPhone =
    typeof args.contact?.phone === "string" ? args.contact.phone.trim() : "";

  return {
    name: args.name || contactName || "WhatsApp lead",
    email: args.email || contactEmail,
    phone: contactPhone,
    trip_start_date: args.tripStartDate,
    starting_city: args.startingCity,
    destination: args.destination,
    number_of_days: args.numberOfDays,
    hotel_category: args.hotelCategory,
    adults: args.adults || "1",
    children: args.children || "0",
    rooms: args.rooms || "1",
    transport_type: args.transportType,
    query: args.query,
  };
}

function boolFromVar(value: string, fallback = false): boolean {
  if (!value) return fallback;
  return ["yes", "true", "1", "include", "included", "with"].includes(value.trim().toLowerCase());
}

function routePresetFromValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["madinah then makkah", "madina then makkah", "md-mk", "medina-makkah", "madina-makkah", "madinah-makkah"].includes(normalized)) {
    return "md-mk";
  }
  if (["makkah madinah makkah", "makkah madina makkah", "makkah-madina-makkah", "makkah-madinah-makkah", "mk-md-mk"].includes(normalized)) {
    return "mk-md-mk";
  }
  if (["madinah makkah madinah", "madina makkah madina", "madina-makkah-madina", "madinah-makkah-madinah", "md-mk-md"].includes(normalized)) {
    return "md-mk-md";
  }
  return "mk-md";
}


function buildSelectedHotelsForRoute(
  routePresetId: string,
  makkahHotelId: string,
  madinahHotelId: string,
): Record<string, string> {
  const selected: Record<string, string> = {};
  const add = (key: string, value: string) => {
    if (value) selected[key] = value;
  };

  switch (routePresetId) {
    case "md-mk":
      add("Madinah-0", madinahHotelId);
      add("Makkah-1", makkahHotelId);
      break;
    case "mk-md-mk":
      add("Makkah-0", makkahHotelId);
      add("Madinah-1", madinahHotelId);
      add("Makkah-2", makkahHotelId);
      break;
    case "md-mk-md":
      add("Madinah-0", madinahHotelId);
      add("Makkah-1", makkahHotelId);
      add("Madinah-2", madinahHotelId);
      break;
    case "mk-md":
    default:
      add("Makkah-0", makkahHotelId);
      add("Madinah-1", madinahHotelId);
      break;
  }
  return selected;
}

function stringArrayFromVars(
  vars: Record<string, unknown>,
  keys: string[],
): string[] {
  for (const key of keys) {
    const value = vars[key];
    if (Array.isArray(value)) {
      return value.map(String).map((item) => item.trim()).filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      const raw = value.trim();
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map(String).map((item) => item.trim()).filter(Boolean);
        }
      } catch {
        // Dynamic list selections may be persisted as comma-separated text.
      }
      return raw.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function buildUmrahPlannerDetails(args: {
  contact: Record<string, unknown> | null;
  name: string;
  email: string;
  query: string;
  vars: Record<string, unknown>;
}): UmrahPlannerDetails {
  const contactName =
    typeof args.contact?.name === "string" ? args.contact.name.trim() : "";
  const contactEmail =
    typeof args.contact?.email === "string" ? args.contact.email.trim() : "";
  const contactPhone =
    typeof args.contact?.phone === "string" ? args.contact.phone.trim() : "";
  const route = firstVar(args.vars, ["umrah_route", "route", "route_preset_id"]);
  const phone = firstVar(args.vars, ["phone", "whatsapp_number", "customer_phone"]);
  const transportMode = firstVar(args.vars, ["umrah_transport_mode", "transport_mode"]);
  const routePresetId = routePresetFromValue(route);
  const selectedHotels = buildSelectedHotelsForRoute(
    routePresetId,
    firstVar(args.vars, ["umrah_makkah_hotel_id"]),
    firstVar(args.vars, ["umrah_madinah_hotel_id"]),
  );

  return {
    name: args.name || contactName || "WhatsApp lead",
    email: args.email || contactEmail,
    phone: phone || contactPhone,
    start_date: firstVar(args.vars, ["umrah_start_date", "start_date", "travel_date"]),
    route_preset_id: routePresetId,
    nights: firstVar(args.vars, ["umrah_nights", "nights", "number_of_nights", "days"]) || "6",
    adults: firstVar(args.vars, ["umrah_adults", "adults"]) || "2",
    children: firstVar(args.vars, ["umrah_children", "children"]) || "0",
    infants: firstVar(args.vars, ["umrah_infants", "infants"]) || "0",
    rooms: firstVar(args.vars, ["umrah_rooms", "rooms", "number_of_rooms"]) || "1",
    room_type: firstVar(args.vars, ["umrah_room_type", "room_type"]) || "Double",
    hotel_category: firstVar(args.vars, ["umrah_hotel_category", "hotel_category", "hotel"]) || "Economy",
    vehicle: firstVar(args.vars, ["umrah_vehicle", "vehicle", "transport_type", "transport"]) || "Car",
    transport_mode: transportMode === "selective" ? "selective" : "full",
    include_visa: boolFromVar(firstVar(args.vars, ["umrah_include_visa", "include_visa"]), true),
    include_ziyarat: boolFromVar(firstVar(args.vars, ["umrah_include_ziyarat", "include_ziyarat"]), false),
    selected_hotels: selectedHotels,
    selected_sectors: stringArrayFromVars(args.vars, [
      "umrah_selected_transport_sector_ids",
      "umrah_selected_sectors",
      "selected_sectors",
    ]),
    selected_ziyarats: stringArrayFromVars(args.vars, [
      "umrah_selected_ziyarat_ids",
      "umrah_selected_ziyarats",
      "selected_ziyarats",
    ]),
    query: args.query || firstVar(args.vars, ["umrah_query", "query", "requirement"]),
  };
}

async function submitTripDesignerQuote(
  db: AdminClient,
  accountId: string,
  details: TripDesignerDetails,
): Promise<TripDesignerQuote | null> {
  try {
    void db;
    void accountId;
    return quoteTrip(details);
  } catch (err) {
    console.error("[flows] local trip designer quote failed:", err);
  }

  const quoteUrl = envValue("TDP_TRIP_PLANNER_QUOTE_URL");
  if (!quoteUrl) return null;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const apiKey = envValue("TDP_TRIP_PLANNER_API_KEY");
  if (apiKey) headers["x-tdp-api-key"] = apiKey;

  try {
    const response = await fetch(quoteUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(details),
    });
    const json = (await response.json().catch(() => null)) as TripDesignerQuote | null;
    if (!response.ok) {
      console.error("[flows] trip designer quote failed:", response.status, json);
      return null;
    }
    return json?.ok ? json : null;
  } catch (err) {
    console.error("[flows] trip designer quote request failed:", err);
    return null;
  }
}

async function submitUmrahPlannerQuote(
  db: AdminClient,
  accountId: string,
  details: UmrahPlannerDetails,
): Promise<UmrahPlannerQuote | null> {
  try {
    return quoteUmrah(details, await loadUmrahPlannerDataForAccount(db, accountId));
  } catch (err) {
    console.error("[flows] local umrah planner quote failed:", err);
    return null;
  }
}

function formatUmrahPlannerNotes(quote: UmrahPlannerQuote | null): string {
  if (!quote) return "";
  const hotelLines = (quote.hotelLines ?? [])
    .map((line) => `${line.city}: ${line.hotel} (${line.nights} nights, ${line.checkIn} to ${line.checkOut})`)
    .join("\n");
  const sectors = (quote.transportSectors ?? [])
    .map((sector) => `${sector.label}: ${sector.amount ?? 0}`)
    .join("\n");
  return [
    "Umrah Planner Result:",
    quote.priceText ? `Estimated Price: ${quote.priceText}` : null,
    quote.route ? `Route: ${quote.route}` : null,
    hotelLines ? `Hotels:\n${hotelLines}` : null,
    sectors ? `Transport:\n${sectors}` : null,
    quote.hasMissingRates ? "Manual rate confirmation required for one or more hotel nights." : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTripDesignerNotes(quote: TripDesignerQuote | null): string {
  if (!quote) return "";
  const itinerary = (quote.itinerary ?? [])
    .slice(0, 10)
    .map((day) => {
      const lines = (day.items ?? [])
        .map((item) => `${item.time || "Plan"}: ${item.activity || ""}`.trim())
        .filter(Boolean)
        .join(" | ");
      return `Day ${day.day ?? ""}: ${day.title ?? ""}${lines ? ` - ${lines}` : ""}`.trim();
    })
    .filter(Boolean)
    .join("\n");

  return [
    "Trip Designer Result:",
    quote.priceText ? `Estimated Price: ${quote.priceText}` : null,
    quote.selectedHotel ? `Hotel: ${quote.selectedHotel}${quote.selectedRoom ? ` - ${quote.selectedRoom}` : ""}` : null,
    quote.transport ? `Transport: ${quote.transport}` : null,
    quote.tourTitle ? `Matched Package: ${quote.tourTitle}` : null,
    itinerary ? `Itinerary:\n${itinerary}` : null,
    quote.lead?.id ? `WordPress Lead ID: ${quote.lead.id}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTripDesignerWhatsappReply(
  quote: TripDesignerQuote,
  details: TripDesignerDetails,
): string {
  const itineraryLines = (quote.itinerary ?? [])
    .slice(0, Number(details.number_of_days) || quote.itinerary?.length || 7)
    .map((day) => {
      const itemLines = (day.items ?? [])
        .map((item) => `${item.time || "Plan"}: ${item.activity || ""}`.trim())
        .filter(Boolean)
        .join(" | ");
      return `Day ${day.day ?? ""}: ${day.title || "Trip activity"}${itemLines ? ` - ${itemLines}` : ""}`;
    })
    .filter(Boolean);

  return [
    `Your ${details.number_of_days || quote.itinerary?.length || ""} days ${details.destination} package is ready.`,
    quote.priceText ? `Estimated total: ${quote.priceText}` : null,
    quote.selectedHotel ? `Hotel: ${quote.selectedHotel}${quote.selectedRoom ? ` - ${quote.selectedRoom}` : ""}` : null,
    quote.transport ? `Transport: ${quote.transport}` : null,
    "",
    itineraryLines.length ? "Itinerary:" : null,
    ...itineraryLines,
    "",
    "This is based on your selected dates and preferences. Our team can now confirm availability and any customization.",
  ]
    .filter((line) => line !== null)
    .join("\n")
    .trim();
}

async function ensureSalesPipeline(
  db: AdminClient,
  run: FlowRunRow,
): Promise<{ pipelineId: string; stageId: string } | null> {
  const { data: existing } = await db
    .from("pipelines")
    .select("id")
    .eq("account_id", run.account_id)
    .eq("name", "Sales Pipeline")
    .limit(1);
  let pipelineId = (existing?.[0] as { id: string } | undefined)?.id;

  if (!pipelineId) {
    const { data: pipeline, error } = await db
      .from("pipelines")
      .insert({
        account_id: run.account_id,
        user_id: run.user_id,
        name: "Sales Pipeline",
      })
      .select("id")
      .single();
    if (error || !pipeline) {
      console.error("[flows] lead pipeline create failed:", error);
      return null;
    }
    pipelineId = (pipeline as { id: string }).id;
    await db.from("pipeline_stages").insert(
      DEFAULT_LEAD_STAGES.map((stage) => ({
        pipeline_id: pipelineId,
        name: stage.name,
        color: stage.color,
        position: stage.position,
      })),
    );
  }

  const { data: stageRows } = await db
    .from("pipeline_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .eq("name", "New Lead")
    .limit(1);
  let stageId = (stageRows?.[0] as { id: string } | undefined)?.id;

  if (!stageId) {
    const { data: stage, error } = await db
      .from("pipeline_stages")
      .insert({
        pipeline_id: pipelineId,
        name: "New Lead",
        color: "#3b82f6",
        position: 0,
      })
      .select("id")
      .single();
    if (error || !stage) {
      console.error("[flows] lead stage create failed:", error);
      return null;
    }
    stageId = (stage as { id: string }).id;
  }

  return { pipelineId, stageId };
}

async function upsertLeadCustomValue(
  db: AdminClient,
  run: FlowRunRow,
  fieldName: string,
  value: string,
): Promise<void> {
  if (!run.contact_id || !value) return;
  const { data: existing } = await db
    .from("custom_fields")
    .select("id")
    .eq("account_id", run.account_id)
    .eq("field_name", fieldName)
    .limit(1);
  let fieldId = (existing?.[0] as { id: string } | undefined)?.id;

  if (!fieldId) {
    const { data: field, error } = await db
      .from("custom_fields")
      .insert({
        account_id: run.account_id,
        user_id: run.user_id,
        field_name: fieldName,
        field_type: "text",
      })
      .select("id")
      .single();
    if (error || !field) {
      console.error("[flows] lead custom field create failed:", error);
      return;
    }
    fieldId = (field as { id: string }).id;
  }

  await db.from("contact_custom_values").upsert(
    {
      contact_id: run.contact_id,
      custom_field_id: fieldId,
      value,
    },
    { onConflict: "contact_id,custom_field_id" },
  );
}

async function persistLeadCapture(db: AdminClient, run: FlowRunRow): Promise<void> {
  if (!run.contact_id || !run.conversation_id) return;

  const vars = { ...varsFromBulkDetails(run.vars), ...run.vars };
  const name = firstVar(vars, ["name", "full_name", "customer_name"]);
  const email = firstVar(vars, ["email", "contact_email", "work_email"]);
  const company = firstVar(vars, [
    "business_name",
    "business",
    "company",
    "company_name",
  ]);
  const query = firstVar(vars, [
    "query",
    "requirement",
    "requirements",
    "message",
    "question",
    "need",
  ]);
  const tripStartDate = firstVar(vars, ["trip_start_date", "travel_date", "start_date"]);
  const startingCity = firstVar(vars, ["starting_city", "origin_city", "from_city"]);
  const destination = firstVar(vars, ["destination", "trip_destination"]);
  const numberOfDays = firstVar(vars, ["number_of_days", "days", "duration"]);
  const hotelCategory = firstVar(vars, ["hotel_category", "hotel"]);
  const adults = firstVar(vars, ["adults"]);
  const children = firstVar(vars, ["children"]);
  const rooms = firstVar(vars, ["rooms", "number_of_rooms"]);
  const transportType = firstVar(vars, ["transport_type", "transport"]);
  const umrahStartDate = firstVar(vars, ["umrah_start_date"]);
  const umrahNights = firstVar(vars, ["umrah_nights", "number_of_nights"]);
  const umrahRoute = firstVar(vars, ["umrah_route", "route_preset_id"]);
  const umrahVehicle = firstVar(vars, ["umrah_vehicle", "vehicle"]);
  const umrahAdults = firstVar(vars, ["umrah_adults"]);
  const umrahRooms = firstVar(vars, ["umrah_rooms"]);
  const umrahHotelCategory = firstVar(vars, ["umrah_hotel_category"]);
  const hasUmrahPlannerDetails = Boolean(
    umrahStartDate &&
      umrahNights &&
      umrahRoute &&
      umrahAdults &&
      umrahRooms &&
      umrahHotelCategory &&
      umrahVehicle,
  );
  const hasTripDesignerDetails = Boolean(
    tripStartDate ||
      startingCity ||
      destination ||
      numberOfDays ||
      hotelCategory ||
      adults ||
      children ||
      rooms ||
      transportType,
  );

  if (!name && !email && !company && !query && !hasTripDesignerDetails && !hasUmrahPlannerDetails) return;

  try {
    const { data: contact } = await db
      .from("contacts")
      .select("name,email,phone,company")
      .eq("id", run.contact_id)
      .eq("account_id", run.account_id)
      .maybeSingle();

    const contactPatch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (name) contactPatch.name = name;
    if (email) contactPatch.email = email;
    if (company) contactPatch.company = company;

    if (Object.keys(contactPatch).length > 1) {
      await db
        .from("contacts")
        .update(contactPatch)
        .eq("id", run.contact_id)
        .eq("account_id", run.account_id);
    }

    const tripDetails = [
      tripStartDate ? `Trip Start Date: ${tripStartDate}` : null,
      startingCity ? `Starting City: ${startingCity}` : null,
      destination ? `Destination: ${destination}` : null,
      numberOfDays ? `Days: ${numberOfDays}` : null,
      hotelCategory ? `Hotel Category: ${hotelCategory}` : null,
      adults ? `Adults: ${adults}` : null,
      children ? `Children: ${children}` : null,
      rooms ? `Rooms: ${rooms}` : null,
      transportType ? `Transport: ${transportType}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await upsertLeadCustomValue(
      db,
      run,
      LEAD_QUERY_FIELD,
      [query, tripDetails].filter(Boolean).join("\n\n"),
    );

    const pipeline = await ensureSalesPipeline(db, run);
    if (!pipeline) return;

    const tripDesignerDetails = hasTripDesignerDetails
      ? buildTripDesignerDetails({
          run,
          contact: (contact as Record<string, unknown> | null) ?? null,
          name,
          email,
          tripStartDate,
          startingCity,
          destination,
          numberOfDays,
          hotelCategory,
          adults,
          children,
          rooms,
          transportType,
          query,
        })
      : null;
    const tripDesignerQuote = tripDesignerDetails
      ? await submitTripDesignerQuote(db, run.account_id, tripDesignerDetails)
      : null;
    const tripDesignerNotes = formatTripDesignerNotes(tripDesignerQuote);
    const umrahPlannerDetails = hasUmrahPlannerDetails
      ? buildUmrahPlannerDetails({
          contact: (contact as Record<string, unknown> | null) ?? null,
          name,
          email,
          query,
          vars,
        })
      : null;
    const umrahPlannerQuote = umrahPlannerDetails
      ? await submitUmrahPlannerQuote(db, run.account_id, umrahPlannerDetails)
      : null;
    const umrahPlannerNotes = formatUmrahPlannerNotes(umrahPlannerQuote);

    let existingDeal: { id: string } | undefined;
    if (!hasTripDesignerDetails && !hasUmrahPlannerDetails) {
      const { data: existingDeals } = await db
        .from("deals")
        .select("id")
        .eq("account_id", run.account_id)
        .eq("contact_id", run.contact_id)
        .eq("pipeline_id", pipeline.pipelineId)
        .eq("status", "open")
        .limit(1);
      existingDeal = existingDeals?.[0] as { id: string } | undefined;
    }

    const titleName = name || company || destination || "WhatsApp lead";
    const title = hasUmrahPlannerDetails
      ? [
          "Umrah request",
          umrahPlannerDetails?.route_preset_id?.toUpperCase() || "package",
          umrahPlannerDetails?.nights ? `${umrahPlannerDetails.nights} nights` : null,
          umrahPlannerDetails?.start_date || null,
        ]
          .filter(Boolean)
          .join(" - ")
      : hasTripDesignerDetails
      ? [
          "Trip request",
          destination || titleName,
          numberOfDays ? `${numberOfDays} days` : null,
          tripStartDate || null,
        ]
          .filter(Boolean)
          .join(" - ")
      : `Lead from WhatsApp - ${titleName}`;
    const notes = [
      hasUmrahPlannerDetails ? "Umrah package request - quote in PKR only." : null,
      hasTripDesignerDetails ? "Local Pakistan trip request - quote in PKR only." : null,
      tripDetails || null,
      query ? `Query: ${query}` : null,
      company ? `Business: ${company}` : null,
      email ? `Email: ${email}` : null,
      tripDesignerNotes || null,
      umrahPlannerNotes || null,
    ]
      .filter(Boolean)
      .join("\n");

    const leadDetailsPatch = hasUmrahPlannerDetails && umrahPlannerDetails
      ? {
          lead_source: "Umrah Planner",
          lead_destination: "Umrah",
          lead_trip_start_date: umrahPlannerDetails.start_date || null,
          lead_starting_city: "Pakistan",
          lead_days: optionalInt(umrahPlannerDetails.nights),
          lead_hotel_category: umrahPlannerDetails.hotel_category || null,
          lead_adults: optionalInt(umrahPlannerDetails.adults),
          lead_children: optionalInt(umrahPlannerDetails.children),
          lead_rooms: optionalInt(umrahPlannerDetails.rooms),
          lead_transport: umrahPlannerDetails.vehicle || null,
          lead_query: [
            `Route: ${umrahPlannerQuote?.route ?? umrahPlannerDetails.route_preset_id}`,
            umrahPlannerDetails.query || null,
          ].filter(Boolean).join("\n"),
        }
      : hasTripDesignerDetails
      ? {
          lead_source: "Trip Designer",
          lead_destination: destination || null,
          lead_trip_start_date: tripStartDate || null,
          lead_starting_city: startingCity || null,
          lead_days: optionalInt(numberOfDays),
          lead_hotel_category: hotelCategory || null,
          lead_adults: optionalInt(adults),
          lead_children: optionalInt(children),
          lead_rooms: optionalInt(rooms),
          lead_transport: transportType || null,
          lead_query: query || null,
        }
      : {};

    if (existingDeal?.id) {
      await db
        .from("deals")
        .update({
          title,
          conversation_id: run.conversation_id,
          notes,
          ...leadDetailsPatch,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingDeal.id)
        .eq("account_id", run.account_id);
    } else {
      const { data: acct } = await db
        .from("accounts")
        .select("default_currency")
        .eq("id", run.account_id)
        .maybeSingle();
      await db.from("deals").insert({
        account_id: run.account_id,
        user_id: run.user_id,
        pipeline_id: pipeline.pipelineId,
        stage_id: pipeline.stageId,
        contact_id: run.contact_id,
        conversation_id: run.conversation_id,
        title,
        value: 0,
        currency: hasTripDesignerDetails || hasUmrahPlannerDetails
          ? "PKR"
          : (acct as { default_currency?: string } | null)?.default_currency ?? "USD",
        notes,
        ...leadDetailsPatch,
        status: "open",
      });
    }

    if (tripDesignerQuote && tripDesignerDetails) {
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id,
          contactId: run.contact_id,
          text: formatTripDesignerWhatsappReply(tripDesignerQuote, tripDesignerDetails),
        });
      } catch (err) {
        console.error("[flows] trip designer WhatsApp reply failed:", err);
      }
    }
    if (umrahPlannerQuote?.whatsappText && umrahPlannerDetails) {
      try {
        await saveUmrahQuoteSession(
          db,
          {
            accountId: run.account_id,
            userId: run.user_id,
            contactId: run.contact_id,
            conversationId: run.conversation_id,
          },
          umrahPlannerDetails as UmrahQuoteInput,
          umrahPlannerQuote as UmrahQuoteResult,
        );
      } catch (err) {
        console.error("[flows] saving Umrah quote session failed:", err);
      }
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id,
          contactId: run.contact_id,
          text: umrahPlannerQuote.whatsappText,
        });
      } catch (err) {
        console.error("[flows] umrah planner WhatsApp reply failed:", err);
      }
    }
  } catch (err) {
    console.error("[flows] persistLeadCapture failed:", err);
  }
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  initialNodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  let nodes = initialNodes;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      const text = interpolateVars(cfg.text, run.vars).trim();
      try {
        if (text) {
          const { whatsapp_message_id } = await engineSendText({
            accountId: run.account_id,
      userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text,
          });
          await logEvent(db, run.id, "message_sent", node.node_key, {
            node_type: "send_message",
            whatsapp_message_id,
          });
        }
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await db
            .from("contact_tags")
            .upsert(
              { contact_id: run.contact_id!, tag_id: cfg.tag_id },
              { onConflict: "contact_id,tag_id" },
            );
        } else {
          await db
            .from("contact_tags")
            .delete()
            .eq("contact_id", run.contact_id!)
            .eq("tag_id", cfg.tag_id);
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "start_flow") {
      const cfg = node.config as unknown as StartFlowNodeConfig;
      const targetRef = startFlowTargetRef(cfg);
      let targetQuery = db
        .from("flows")
        .select("*")
        .eq("account_id", run.account_id)
        .eq("status", "active")
        .limit(2);
      targetQuery = looksLikeUuid(targetRef)
        ? targetQuery.eq("id", targetRef)
        : targetQuery.eq("name", targetRef);
      const { data: targetRows, error: flowErr } = await targetQuery;
      const rows = (targetRows as FlowRow[] | null) ?? [];
      if (flowErr || rows.length === 0) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "target_flow_not_found",
          target_flow_ref: targetRef,
          detail: flowErr?.message ?? null,
        });
        await endRun(db, run.id, "failed", "target_flow_not_found");
        return { outcome: "completed" };
      }

      if (rows.length > 1) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "target_flow_ambiguous",
          target_flow_ref: targetRef,
        });
        await endRun(db, run.id, "failed", "target_flow_ambiguous");
        return { outcome: "completed" };
      }

      const flow = rows[0];
      if (!flow.entry_node_id) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "target_flow_missing_entry",
          target_flow_id: flow.id,
        });
        await endRun(db, run.id, "failed", "target_flow_missing_entry");
        return { outcome: "completed" };
      }

      nodes = await loadAllNodes(db, flow.id);
      await db
        .from("flow_runs")
        .update({
          flow_id: flow.id,
          current_node_key: flow.entry_node_id,
          last_advanced_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      await logEvent(db, run.id, "node_entered", node.node_key, {
        node_type: "start_flow",
        target_flow_id: flow.id,
        target_entry_node_key: flow.entry_node_id,
      });
      run.flow_id = flow.id;
      run.current_node_key = flow.entry_node_id;
      currentKey = flow.entry_node_id;
      continue;
    }
    if (node.node_type === "dynamic_umrah_list") {
      await sendDynamicUmrahListAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key);
      if (!advanced) await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, node);
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await persistLeadCapture(db, run);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & {
    isFirstInboundMessage: boolean;
    lastCustomerMessageAt?: string | null;
  },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
      input.lastCustomerMessageAt,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (message.kind === "interactive_reply" && currentNode.node_type === "dynamic_umrah_list") {
    const cfg = currentNode.config as unknown as DynamicUmrahListNodeConfig;
    const parsed = parseDynamicReplyId(message.reply_id);
    if (parsed?.nodeKey === currentNode.node_key) {
      const pageVar = `__dynamic_page_${currentNode.node_key}`;
      if (parsed.action === "next" || parsed.action === "prev") {
        const page = Math.max(0, Number(run.vars[pageVar] ?? 0) || 0) + (parsed.action === "next" ? 1 : -1);
        const newVars = { ...run.vars, [pageVar]: page };
        await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
        run.vars = newVars;
        await sendDynamicUmrahListAndSuspend(db, run, currentNode);
        return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
      }
      if (parsed.action === "none") {
        const newVars = { ...run.vars, [cfg.output_var]: cfg.selection_mode === "multiple" ? [] : "", [pageVar]: 0 };
        await db.from("flow_runs").update({ vars: newVars, reprompt_count: 0 }).eq("id", run.id);
        run.vars = newVars;
        matched = cfg.next_node_key;
      } else if (parsed.action === "finish" && cfg.selection_mode === "multiple") {
        matched = cfg.next_node_key;
      } else if (parsed.action === "select" && parsed.value) {
        if (cfg.selection_mode === "multiple") {
          const current = Array.isArray(run.vars[cfg.output_var]) ? run.vars[cfg.output_var] as unknown[] : [];
          const values = current.map(String);
          const next = values.includes(parsed.value) ? values.filter((v) => v !== parsed.value) : [...values, parsed.value];
          const newVars = { ...run.vars, [cfg.output_var]: next, [pageVar]: 0 };
          await db.from("flow_runs").update({ vars: newVars, reprompt_count: 0 }).eq("id", run.id);
          run.vars = newVars;
          await engineSendText({ accountId: run.account_id, userId: run.user_id, conversationId: run.conversation_id!, contactId: run.contact_id!, text: `${values.includes(parsed.value) ? "Removed" : "Added"}. ${next.length} item(s) selected. Choose another option or tap Finish selection.` });
          await sendDynamicUmrahListAndSuspend(db, run, currentNode);
          return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
        }
        const newVars = { ...run.vars, [cfg.output_var]: parsed.value, [pageVar]: 0 };
        await db.from("flow_runs").update({ vars: newVars, reprompt_count: 0 }).eq("id", run.id);
        run.vars = newVars;
        matched = cfg.next_node_key;
      }
    }
  } else if (

    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
    if (matched) {
      const patch = interactiveVarPatch(currentNode, message.reply_id);
      if (Object.keys(patch).length) {
        const newVars = { ...run.vars, ...patch };
        const { error } = await db
          .from("flow_runs")
          .update({ vars: newVars, reprompt_count: 0 })
          .eq("id", run.id);
        if (!error) {
          run.vars = newVars;
          run.reprompt_count = 0;
          await logEvent(db, run.id, "node_entered", currentNode.node_key, {
            captured_keys: Object.keys(patch),
          });
        }
      }
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const rawCaptured = message.text.trim();

    if (rawCaptured.length > 0 && cfg.validation === "bulk_umrah_ai") {
      const parsed = parseUmrahBulkMessage(rawCaptured, run.vars);
      const newVars = { ...run.vars, ...parsed.fields };
      await db.from("flow_runs").update({ vars: newVars, reprompt_count: 0 }).eq("id", run.id);
      run.vars = newVars;

      if (parsed.missing.length > 0) {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: parsed.prompt,
        });
        await logEvent(db, run.id, "fallback_fired", currentNode.node_key, {
          action: "collect_missing_bulk_umrah",
          missing: parsed.missing,
        });
        return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
      }

      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        captured_keys: Object.keys(parsed.fields),
        bulk_intake_complete: true,
      });
      matched = cfg.next_node_key;
    }
    if (
      !matched &&
      rawCaptured.length > 0 &&
      (cfg.validation === "bulk_trip" || cfg.validation === "bulk_umrah") &&
      !bulkDetailsLookComplete(rawCaptured, cfg.validation)
    ) {
      await logEvent(db, run.id, "fallback_fired", currentNode.node_key, {
        action: "ignore",
        reason: "bulk_details_incomplete",
      });
      return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
    }

    let captured = rawCaptured;
    if (!matched && cfg.ai_normalize && cfg.input_type && rawCaptured) {
      const normalized = normalizeFlowInput({
        inputType: cfg.input_type,
        customerMessage: rawCaptured,
      });
      if (!normalized.matched || !normalized.value) {
        // Let the normal AI responder answer genuine questions while
        // keeping this flow suspended on the same field. If the text is
        // simply an invalid value, the AI can explain the expected format.
        await logEvent(db, run.id, "fallback_fired", currentNode.node_key, {
          action: "ai_assist",
          reason: normalized.reason ?? "normalization_failed",
          expected_input_type: cfg.input_type,
          validation_error: cfg.validation_error ?? null,
        });
        return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
      }
      captured = normalized.value;
    }

    if (!matched && captured.length > 0 && cfg.var_key) {
      // Persist normalized value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "dynamic_umrah_list") {
      await sendDynamicUmrahListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({
          status: "pending",
          assigned_agent_id: null,
          ai_autoreply_disabled: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await persistLeadCapture(db, run);
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await persistLeadCapture(db, run);
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: contactRow } = await db
    .from("contacts")
    .select("phone")
    .eq("id", input.contactId)
    .eq("account_id", flow.account_id)
    .maybeSingle();
  const contactPhone = (contactRow as { phone?: string } | null)?.phone?.trim() ?? "";

  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
      vars: contactPhone
        ? { phone: contactPhone, whatsapp_number: contactPhone }
        : {},
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
