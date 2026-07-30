/**
 * Starter flow templates.
 *
 * Three pre-canned flows users can clone with one click instead of
 * building from scratch. Each template is a plain JS object describing
 * the same shape `/api/flows` PUT accepts — name, trigger config,
 * entry_node_id, fallback_policy, nodes[] — keyed by a stable
 * `slug`.
 *
 * The clone path (`/api/flows` POST with `template_slug`) creates a
 * NEW flow_row + flow_nodes rows for the user. `node_key`s are kept
 * verbatim (they're stable strings, not UUIDs, so cloning never
 * needs to rewrite edge references).
 *
 * Choosing a single static module over a DB-backed gallery for v1
 * because: (a) the set is small and changes with code releases, not
 * data; (b) keeps templates portable across self-hosted instances
 * without migrations; (c) editing in source is the lowest-friction
 * way to add the next template.
 */

import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  StartFlowNodeConfig,
  StartNodeConfig,
} from "./types";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "start_flow"
  | "handoff"
  | "end";

export interface FlowTemplateNode {
  node_key: string;
  node_type: FlowTemplateNodeType;
  config:
    | StartNodeConfig
    | SendMessageNodeConfig
    | StartFlowNodeConfig
    | SendButtonsNodeConfig
    | SendListNodeConfig
    | CollectInputNodeConfig
    | ConditionNodeConfig
    | HandoffNodeConfig
    | Record<string, unknown>;
}

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: KeywordTriggerConfig | Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
}

// ============================================================
// 1. Welcome menu — the example from the owner's brief
// ============================================================
const WELCOME_MENU: FlowTemplate = {
  slug: "welcome_menu",
  name: "Welcome menu",
  description:
    "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.",
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["support", "help", "hi"],
    match_type: "whole_word",
    start_when: "new_or_inactive",
    inactive_hours: 24,
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_buttons",
      config: {
        text: "Hi! 👋 Welcome to support. Are you an existing customer or new here?",
        footer_text: "Tap a button below to continue.",
        buttons: [
          {
            reply_id: "existing",
            title: "Existing customer",
            next_node_key: "existing_handoff",
          },
          {
            reply_id: "new",
            title: "New customer",
            next_node_key: "new_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "existing_handoff",
      node_type: "handoff",
      config: {
        note: "Existing customer needs assistance — please check account history before replying.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "new_handoff",
      node_type: "handoff",
      config: {
        note: "New customer — share pricing + onboarding link.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 2. FAQ bot — list-message answers, fully automated
// ============================================================
const FAQ_BOT: FlowTemplate = {
  slug: "faq_bot",
  name: "FAQ bot",
  description:
    "Answer common questions automatically. Customer picks a topic from a list; the bot replies with the answer and ends.",
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["faq", "question", "info"],
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" },
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: "What can I help you with?",
        button_label: "View topics",
        sections: [
          {
            title: "Common questions",
            rows: [
              {
                reply_id: "hours",
                title: "Opening hours",
                next_node_key: "answer_hours",
              },
              {
                reply_id: "pricing",
                title: "Pricing",
                next_node_key: "answer_pricing",
              },
              {
                reply_id: "refunds",
                title: "Refund policy",
                next_node_key: "answer_refunds",
              },
            ],
          },
          {
            title: "Other",
            rows: [
              {
                reply_id: "human",
                title: "Talk to a human",
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "answer_hours",
      node_type: "send_message",
      config: {
        text: "We're open Mon–Fri, 9am–6pm local time. Weekend support is limited to urgent issues.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_pricing",
      node_type: "send_message",
      config: {
        text: "Our pricing starts at $9/mo. Visit https://example.com/pricing for the full breakdown.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_refunds",
      node_type: "send_message",
      config: {
        text: "Refunds are honored within 30 days of purchase. Reply with your order number and we'll process it.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        note: "Customer asked to talk to a human from the FAQ bot.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 3. Lead capture — collect_input chain, ends in a handoff
// ============================================================
const LEAD_CAPTURE: FlowTemplate = {
  slug: "lead_capture",
  name: "Lead capture",
  description:
    "Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.",
  icon: "UserPlus",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: "Welcome! 👋 I'll ask a few quick questions so we can get you to the right person.",
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: "What's your name?",
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: "Thanks {{vars.name}}! What's your work email?",
        var_key: "email",
        next_node_key: "ask_company",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_company",
      node_type: "collect_input",
      config: {
        prompt_text: "Almost done — what's your company name?",
        var_key: "company",
        next_node_key: "handoff",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: "New lead — name={{vars.name}}, email={{vars.email}}, company={{vars.company}}.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 4. Local Pakistan travel menu — PKR-only tour intake
// ============================================================
const LOCAL_PAKISTAN_TRAVEL_MENU: FlowTemplate = {
  slug: "local_pakistan_travel_menu",
  name: "Local Pakistan Welcome Intake",
  description:
    "Welcomes local Pakistan tour customers, then collects Trip Designer details one by one for a PKR quote.",
  icon: "MessageSquare",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_message",
      config: {
        text: "Assalam o Alaikum! Welcome to Tours in Pakistan.\n\nI can help you design a local Pakistan tour package in PKR. I will ask a few quick details like date, starting city, destination, days, guests, hotel category, and transport. After that our team can share the latest itinerary/package details.\n\nWe do not use USD or inbound traveler rates for local Pakistan customers.",
        next_node_key: "start_custom_trip",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "local_packages",
      node_type: "send_message",
      config: {
        text: "For local Pakistan tours, we can help with Hunza, Skardu, Naran/Kaghan, Swat, Azad Kashmir, Murree/Galiyat, Fairy Meadows, Lahore culture tours, and customized private tours.\n\nPlease share your preferred destination, travel date, number of days, adults/children, hotel category, and transport type. I will collect the details and share a PKR quote only when available from our catalog/team.",
        next_node_key: "start_custom_trip",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "group_tours",
      node_type: "send_message",
      config: {
        text: "Our fixed departure group tours depart regularly from Pakistan. Final group tour prices are confirmed in PKR based on current fuel, hotel, and transport costs.\n\nPlease share destination, date, adults/children, and starting city so we can check the matching group tour.",
        next_node_key: "start_custom_trip",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "umrah_info",
      node_type: "send_message",
      config: {
        text: "For Umrah, Tours in Pakistan can help with private package support including visa processing, accommodation arrangements, transportation, and guidance. Exact PKR rates depend on dates, airline, hotel availability, and room sharing.\n\nPlease share travel month, passengers, passport status, hotel preference, and budget so our team can confirm the latest PKR quote.",
        next_node_key: "handoff",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "start_custom_trip",
      node_type: "start_flow",
      config: {
        target_flow: "Local Pakistan Trip Designer",
      },
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: "Travel lead asked for a human expert from Local Pakistan Welcome Intake. Do not quote USD/inbound prices; use local PKR pricing only.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 5. Local Pakistan trip designer — collects portal-like fields
// ============================================================
const LOCAL_PAKISTAN_TRIP_DESIGNER: FlowTemplate = {
  slug: "local_pakistan_trip_designer",
  name: "Local Pakistan Trip Designer",
  description:
    "Collects the Trip Designer fields from WhatsApp and hands off a complete local PKR quote request to sales.",
  icon: "UserPlus",
  trigger_type: "manual",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: "Sure, I will design a local Pakistan trip request for you. I will ask a few quick questions one by one. Prices will be shared in PKR only after matching the latest available package/quote.",
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: "Your full name?",
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: "Email address? If you do not want to share, reply 'skip'.",
        var_key: "email",
        next_node_key: "ask_date",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_date",
      node_type: "collect_input",
      config: {
        prompt_text: "Trip start date? Example: 15 September 2026",
        var_key: "trip_start_date",
        next_node_key: "ask_starting_city",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_starting_city",
      node_type: "collect_input",
      config: {
        prompt_text: "Starting city? Example: Karachi, Lahore, Islamabad, Faisalabad, Multan.",
        var_key: "starting_city",
        next_node_key: "ask_destination",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_destination",
      node_type: "collect_input",
      config: {
        prompt_text: "Destination? Example: Hunza, Skardu, Naran/Kaghan, Swat, Azad Kashmir, Murree/Galiyat, Fairy Meadows, Lahore.",
        var_key: "destination",
        next_node_key: "ask_days",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_days",
      node_type: "collect_input",
      config: {
        prompt_text: "Number of days?",
        var_key: "number_of_days",
        next_node_key: "ask_hotel",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_hotel",
      node_type: "collect_input",
      config: {
        prompt_text: "Hotel category? Budget, standard, deluxe, luxury, or no hotel needed?",
        var_key: "hotel_category",
        next_node_key: "ask_adults",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_adults",
      node_type: "collect_input",
      config: {
        prompt_text: "How many adults?",
        var_key: "adults",
        next_node_key: "ask_children",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_children",
      node_type: "collect_input",
      config: {
        prompt_text: "How many children? Reply 0 if none.",
        var_key: "children",
        next_node_key: "ask_rooms",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_rooms",
      node_type: "collect_input",
      config: {
        prompt_text: "How many rooms are required?",
        var_key: "rooms",
        next_node_key: "ask_transport",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_transport",
      node_type: "collect_input",
      config: {
        prompt_text: "Transport type? Sedan, SUV, Hiace, Coaster, Coach, or without transport?",
        var_key: "transport_type",
        next_node_key: "ask_query",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_query",
      node_type: "collect_input",
      config: {
        prompt_text: "Any special requirement? Example: family trip, honeymoon, sightseeing, adventure, meals, flight/tickets, elderly passengers, budget range.",
        var_key: "query",
        next_node_key: "summary",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "summary",
      node_type: "send_message",
      config: {
        text: "Thank you {{vars.name}}. Your local Pakistan trip request is received:\n\nDate: {{vars.trip_start_date}}\nStarting City: {{vars.starting_city}}\nDestination: {{vars.destination}}\nDays: {{vars.number_of_days}}\nHotel: {{vars.hotel_category}}\nAdults: {{vars.adults}}\nChildren: {{vars.children}}\nRooms: {{vars.rooms}}\nTransport: {{vars.transport_type}}\nRequest: {{vars.query}}\n\nI will now send this to our travel team for the latest PKR itinerary/package details. We do not use USD or inbound package rates for local Pakistan customers.",
        next_node_key: "handoff",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: "Local Pakistan custom trip request. Name={{vars.name}}, email={{vars.email}}, date={{vars.trip_start_date}}, starting_city={{vars.starting_city}}, destination={{vars.destination}}, days={{vars.number_of_days}}, hotel={{vars.hotel_category}}, adults={{vars.adults}}, children={{vars.children}}, rooms={{vars.rooms}}, transport={{vars.transport_type}}, query={{vars.query}}. Quote in PKR only. Do not use inbound/USD package prices.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// Registry
// ============================================================

const TEMPLATES: Record<string, FlowTemplate> = {
  welcome_menu: WELCOME_MENU,
  faq_bot: FAQ_BOT,
  lead_capture: LEAD_CAPTURE,
  local_pakistan_travel_menu: LOCAL_PAKISTAN_TRAVEL_MENU,
  local_pakistan_trip_designer: LOCAL_PAKISTAN_TRIP_DESIGNER,
};

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return TEMPLATES[slug] ?? null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}
