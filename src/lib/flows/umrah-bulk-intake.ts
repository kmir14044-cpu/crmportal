import { normalizeFlowInput } from "./normalize-input";

export interface UmrahBulkParseResult {
  fields: Record<string, unknown>;
  missing: string[];
  prompt: string;
}

function integer(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return null;
}

function budgetValue(text: string): number | null {
  const match = text.match(/(?:budget|range|around|under|upto|up to|max(?:imum)?)\s*(?:is|of|:|-)?\s*(?:pkr|rs\.?|rupees?)?\s*([\d,.]+)\s*(k|thousand|lac|lakh|million|m)?/i);
  if (!match) return null;
  let value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") value *= 1_000;
  if (unit === "lac" || unit === "lakh") value *= 100_000;
  if (unit === "m" || unit === "million") value *= 1_000_000;
  return Math.round(value);
}

function routeValue(text: string): string | null {
  if (/madin(?:a|ah)\s*(?:then|to|->|-|and)\s*makkah/i.test(text)) return "md-mk";
  if (/makkah\s*(?:then|to|->|-|and)\s*madin(?:a|ah)/i.test(text)) return "mk-md";
  if (/makkah.*madin(?:a|ah).*makkah/i.test(text)) return "mk-md-mk";
  if (/madin(?:a|ah).*makkah.*madin(?:a|ah)/i.test(text)) return "md-mk-md";
  return null;
}

function categoryValue(text: string): string | null {
  if (/\bexecutive\b|\bluxury\b|\b5\s*star\b/i.test(text)) return "Executive";
  if (/\bstandard\b|\beconomy plus\b|\b4\s*star\b/i.test(text)) return "Standard";
  if (/\beconomy\b|\bbudget hotel\b|\b3\s*star\b/i.test(text)) return "Economy";
  return null;
}

function roomTypeValue(text: string): string | null {
  if (/\bquad\b|\b4\s*(?:bed|sharing)/i.test(text)) return "Quad";
  if (/\btriple\b|\b3\s*(?:bed|sharing)/i.test(text)) return "Triple";
  if (/\bdouble\b|\b2\s*(?:bed|sharing)/i.test(text)) return "Double";
  return null;
}

function vehicleValue(text: string): string | null {
  for (const vehicle of ["Coaster", "Hiace", "Staria", "GMC", "Car"]) {
    if (new RegExp(`\\b${vehicle}\\b`, "i").test(text)) return vehicle;
  }
  return null;
}

function yesNo(text: string, subject: RegExp): boolean | null {
  if (!subject.test(text)) return null;
  if (/\b(no|not required|without|exclude|remove|nahi|nahin)\b/i.test(text)) return false;
  if (/\b(yes|required|include|with|add|haan|han)\b/i.test(text)) return true;
  return null;
}

function missingPrompt(missing: string[]): string {
  const labels: Record<string, string> = {
    umrah_start_date: "travel date",
    umrah_nights: "number of nights",
    umrah_route: "route (Makkah–Madinah or Madinah–Makkah)",
    umrah_adults: "number of adults",
    umrah_rooms: "number of rooms",
    umrah_room_type: "room sharing (Double, Triple, or Quad)",
    umrah_hotel_category: "hotel category (Economy, Standard, or Executive)",
    umrah_transport_mode: "transport preference (Full, Selective, or No Transport)",
    umrah_vehicle: "preferred vehicle",
    umrah_include_ziyarat: "whether Ziyarat is required",
  };
  return `Thank you. Please also share: ${missing.map((key) => labels[key] ?? key).join(", ")}. You can send everything in one message.`;
}

export function parseUmrahBulkMessage(
  text: string,
  existing: Record<string, unknown> = {},
): UmrahBulkParseResult {
  const fields: Record<string, unknown> = { ...existing };
  const date = normalizeFlowInput({ inputType: "date", customerMessage: text });
  if (date.matched && date.value) fields.umrah_start_date = date.value;

  const route = routeValue(text);
  if (route) fields.umrah_route = route;

  const nights = integer(text, [/(\d+)\s*(?:nights?|days?)/i]);
  const adults = integer(text, [/(\d+)\s*adults?/i, /adults?\s*[:=-]?\s*(\d+)/i]);
  const children = integer(text, [/(\d+)\s*(?:children|child|kids?)/i, /(?:children|kids?)\s*[:=-]?\s*(\d+)/i]);
  const infants = integer(text, [/(\d+)\s*infants?/i, /infants?\s*[:=-]?\s*(\d+)/i]);
  const rooms = integer(text, [/(\d+)\s*(?:hotel\s*)?rooms?/i, /rooms?\s*[:=-]?\s*(\d+)/i]);
  if (nights != null) fields.umrah_nights = String(nights);
  if (adults != null) fields.umrah_adults = String(adults);
  if (children != null) fields.umrah_children = String(children);
  if (infants != null) fields.umrah_infants = String(infants);
  if (rooms != null) fields.umrah_rooms = String(rooms);

  const roomType = roomTypeValue(text);
  const category = categoryValue(text);
  const vehicle = vehicleValue(text);
  if (roomType) fields.umrah_room_type = roomType;
  if (category) fields.umrah_hotel_category = category;
  if (vehicle) fields.umrah_vehicle = vehicle;

  if (/\bselective\b|\bseparate transport\b/i.test(text)) fields.umrah_transport_mode = "selective";
  else if (/\bno transport\b|\bwithout transport\b/i.test(text)) {
    fields.umrah_transport_mode = "selective";
    fields.umrah_selected_transport_sector_ids = [];
  } else if (/\bfull transport\b|\ball transport\b|\bcomplete transport\b/i.test(text)) fields.umrah_transport_mode = "full";

  const ziyarat = yesNo(text, /ziyarat|ziyarats|ziyarah/i);
  if (ziyarat != null) fields.umrah_include_ziyarat = ziyarat ? "yes" : "no";
  const visa = yesNo(text, /\bvisa\b/i);
  if (visa != null) fields.umrah_include_visa = visa ? "yes" : "no";

  const budget = budgetValue(text);
  if (budget != null) fields.umrah_budget = String(budget);
  fields.umrah_bulk_details = text;
  fields.umrah_special_requirements = text;

  // Safe defaults for optional passenger groups and standard services.
  if (!fields.umrah_children) fields.umrah_children = "0";
  if (!fields.umrah_infants) fields.umrah_infants = "0";
  if (!fields.umrah_vehicle && fields.umrah_transport_mode === "full") fields.umrah_vehicle = "Car";
  if (!fields.umrah_include_ziyarat) fields.umrah_include_ziyarat = "no";

  const required = [
    "umrah_start_date",
    "umrah_nights",
    "umrah_route",
    "umrah_adults",
    "umrah_rooms",
    "umrah_room_type",
    "umrah_hotel_category",
    "umrah_transport_mode",
  ];
  if (fields.umrah_transport_mode !== "selective" || !Array.isArray(fields.umrah_selected_transport_sector_ids)) {
    if (!fields.umrah_vehicle) required.push("umrah_vehicle");
  }
  const missing = required.filter((key) => fields[key] === undefined || fields[key] === null || String(fields[key]).trim() === "");
  return { fields, missing, prompt: missingPrompt(missing) };
}
