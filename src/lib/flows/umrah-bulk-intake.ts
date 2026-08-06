import { normalizeFlowInput } from "./normalize-input";

export interface UmrahBulkParseResult {
  fields: Record<string, unknown>;
  missing: string[];
  prompt: string;
  confirmation: string;
  extractedKeys: string[];
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

function numericValue(raw: string): number | null {
  const normalized = raw.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function budgetValue(text: string): number | null {
  const explicit = text.match(/(?:change|update|set|make)?\s*(?:the\s+)?budget\s*(?:is|to|of|:|-)?\s*(?:pkr|rs\.?|rupees?)?\s*([\d,.]+)\s*(k|thousand|lac|lakh|million|m)?/i);
  const match = explicit ?? text.match(/(?:pkr|rs\.?|rupees?)\s*([\d,.]+)\s*(k|thousand|lac|lakh|million|m)?/i);
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
  if (/makkah.*madin(?:a|ah).*makkah/i.test(text)) return "mk-md-mk";
  if (/madin(?:a|ah).*makkah.*madin(?:a|ah)/i.test(text)) return "md-mk-md";
  if (/madin(?:a|ah)\s*(?:then|to|->|-|and)\s*makkah/i.test(text)) return "md-mk";
  if (/makkah\s*(?:then|to|->|-|and)\s*madin(?:a|ah)/i.test(text)) return "mk-md";
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

function routeLabel(value: unknown): string {
  const map: Record<string, string> = {
    "mk-md": "Makkah → Madinah",
    "md-mk": "Madinah → Makkah",
    "mk-md-mk": "Makkah → Madinah → Makkah",
    "md-mk-md": "Madinah → Makkah → Madinah",
  };
  return map[String(value ?? "")] ?? String(value ?? "Not provided");
}

function missingPrompt(missing: string[]): string {
  const labels: Record<string, string> = {
    umrah_budget: "budget in PKR",
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
  return `Thank you. Please also share: ${missing.map((key) => labels[key] ?? key).join(", ")}. You can send the remaining details together or separately.`;
}

export function buildUmrahConfirmation(fields: Record<string, unknown>): string {
  return [
    "Please verify your Umrah requirements:",
    "",
    fields.umrah_budget ? `Budget: PKR ${Number(fields.umrah_budget).toLocaleString("en-PK")}` : null,
    `Travel date: ${fields.umrah_start_date}`,
    `Duration: ${fields.umrah_nights} nights`,
    `Route: ${routeLabel(fields.umrah_route)}`,
    `Travelers: ${fields.umrah_adults} adult(s), ${fields.umrah_children ?? 0} child(ren), ${fields.umrah_infants ?? 0} infant(s)`,
    `Rooms: ${fields.umrah_rooms} × ${fields.umrah_room_type}`,
    `Hotel category: ${fields.umrah_hotel_category}`,
    `Transport: ${String(fields.umrah_transport_mode).toLowerCase() === "none" ? "No transport" : fields.umrah_transport_mode}`,
    fields.umrah_vehicle ? `Vehicle: ${fields.umrah_vehicle}` : null,
    `Ziyarat: ${String(fields.umrah_include_ziyarat).toLowerCase() === "yes" ? "Required" : "Not required"}`,
    fields.umrah_special_requirements ? `Special requirements: ${fields.umrah_special_requirements}` : null,
    "",
    "Reply *Confirm* to generate your quotation, or tell me any change such as “make it 14 nights”, “2 adults”, or “change budget to 500000”.",
  ].filter(Boolean).join("\n");
}

export function parseUmrahBulkMessage(text: string, existing: Record<string, unknown> = {}): UmrahBulkParseResult {
  const fields: Record<string, unknown> = { ...existing };
  const extractedKeys = new Set<string>();
  const setField = (key: string, value: unknown) => {
    fields[key] = value;
    extractedKeys.add(key);
  };
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const date = normalizeFlowInput({ inputType: "date", customerMessage: text });
  if (date.matched && date.value) setField("umrah_start_date", date.value);

  const route = routeValue(text);
  if (route) setField("umrah_route", route);

  let nights = integer(text, [/(\d+)\s*(?:nights?|days?)/i, /(?:nights?|duration)\s*(?:to|=|is|:)?\s*(\d+)/i]);
  const adults = integer(text, [/(\d+)\s*adults?/i, /adults?\s*(?:to|=|is|:)?\s*(\d+)/i]);
  const children = integer(text, [/(\d+)\s*(?:children|child|kids?)/i, /(?:children|kids?)\s*(?:to|=|is|:)?\s*(\d+)/i]);
  const infants = integer(text, [/(\d+)\s*infants?/i, /infants?\s*(?:to|=|is|:)?\s*(\d+)/i]);
  const rooms = integer(text, [/(\d+)\s*(?:hotel\s*)?rooms?/i, /rooms?\s*(?:to|=|is|:)?\s*(\d+)/i]);

  let budget = budgetValue(text);
  const standaloneNumbers = lines.map(numericValue).filter((value): value is number => value !== null);
  if (budget == null && !fields.umrah_budget) {
    const likelyBudget = standaloneNumbers.find((value) => value >= 50_000);
    if (likelyBudget != null) budget = Math.round(likelyBudget);
  }
  if (nights == null && !fields.umrah_nights) {
    const likelyNights = standaloneNumbers.find((value) => value >= 1 && value <= 45);
    if (likelyNights != null) nights = Math.round(likelyNights);
  }

  if (nights != null) setField("umrah_nights", String(nights));
  if (adults != null) setField("umrah_adults", String(adults));
  if (children != null) setField("umrah_children", String(children));
  if (infants != null) setField("umrah_infants", String(infants));
  if (rooms != null) setField("umrah_rooms", String(rooms));

  const roomType = roomTypeValue(text);
  const category = categoryValue(text);
  const vehicle = vehicleValue(text);
  if (roomType) setField("umrah_room_type", roomType);
  if (category) setField("umrah_hotel_category", category);
  if (vehicle) setField("umrah_vehicle", vehicle);

  if (/\bselective\b|\bseparate transport\b/i.test(text)) setField("umrah_transport_mode", "selective");
  else if (/\bno transport\b|\bwithout transport\b|\bremove transport\b/i.test(text)) {
    setField("umrah_transport_mode", "none");
    fields.umrah_selected_transport_sector_ids = [];
    delete fields.umrah_vehicle;
  } else if (/\bfull transport\b|\ball transport\b|\bcomplete transport\b/i.test(text)) setField("umrah_transport_mode", "full");

  const ziyarat = yesNo(text, /ziyarat|ziyarats|ziyarah/i);
  if (ziyarat != null) setField("umrah_include_ziyarat", ziyarat ? "yes" : "no");
  const visa = yesNo(text, /\bvisa\b/i);
  if (visa != null) setField("umrah_include_visa", visa ? "yes" : "no");
  if (budget != null) setField("umrah_budget", String(budget));

  const requirementMatch = text.match(/(?:special requirements?|requirements?|notes?)\s*[:=-]\s*(.+)/i);
  if (requirementMatch) setField("umrah_special_requirements", requirementMatch[1].trim());

  if (!fields.umrah_children) fields.umrah_children = "0";
  if (!fields.umrah_infants) fields.umrah_infants = "0";
  if (!fields.umrah_include_visa) fields.umrah_include_visa = "yes";

  const required = [
    "umrah_budget", "umrah_start_date", "umrah_nights", "umrah_route", "umrah_adults",
    "umrah_rooms", "umrah_room_type", "umrah_hotel_category",
    "umrah_transport_mode", "umrah_include_ziyarat",
  ];
  if (fields.umrah_transport_mode !== "none" && !fields.umrah_vehicle) required.push("umrah_vehicle");

  const missing = required.filter((key) => fields[key] === undefined || fields[key] === null || String(fields[key]).trim() === "");
  const prompt = missing.length ? missingPrompt(missing) : "";
  return { fields, missing, prompt, confirmation: buildUmrahConfirmation(fields), extractedKeys: [...extractedKeys] };
}
