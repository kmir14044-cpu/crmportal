import type { SupabaseClient } from "@supabase/supabase-js";
import { loadUmrahPlannerDataForAccount } from "@/lib/umrah-planner/quote";

export type UmrahDynamicSource =
  | "makkah_hotels"
  | "madinah_hotels"
  | "transport_sectors"
  | "ziyarat_places";

export interface UmrahDynamicOption {
  id: string;
  title: string;
  description?: string;
  value: string;
}

type JsonRecord = Record<string, unknown>;

function rows(data: JsonRecord, key: string): JsonRecord[] {
  return Array.isArray(data[key]) ? (data[key] as JsonRecord[]) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function active(row: JsonRecord): boolean {
  return row.active !== false;
}

function normalize(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function categoryMatches(row: JsonRecord, requested: string): boolean {
  if (!requested) return true;
  return normalize(row.category) === normalize(requested);
}

function routeSectors(route: string): string[] {
  const normalized = normalize(route);
  if (normalized.includes("md mk md") || normalized.includes("madinah makkah madinah")) {
    return ["MED APT-MED HTL", "MED HTL-MAK HTL", "MAK HTL-MED HTL", "MED HTL-MED APT"];
  }
  if (normalized.includes("mk md mk") || normalized.includes("makkah madinah makkah")) {
    return ["JED APT-MAK HTL", "MAK HTL-MED HTL", "MED HTL-MAK HTL", "MAK HTL-JED APT"];
  }
  if (normalized.includes("md mk") || normalized.includes("madinah makkah")) {
    return ["MED APT-MED HTL", "MED HTL-MAK HTL", "MAK HTL-JED APT"];
  }
  return ["JED APT-MAK HTL", "MAK HTL-MED HTL", "MED HTL-MED APT"];
}

export async function loadUmrahDynamicOptions(args: {
  db: SupabaseClient;
  accountId: string;
  source: UmrahDynamicSource;
  vars: Record<string, unknown>;
}): Promise<UmrahDynamicOption[]> {
  const data = await loadUmrahPlannerDataForAccount(args.db, args.accountId);
  const category = text(args.vars.umrah_hotel_category ?? args.vars.hotel_category);

  if (args.source === "makkah_hotels" || args.source === "madinah_hotels") {
    const city = args.source === "makkah_hotels" ? "makkah" : "madinah";
    return rows(data, "hotels")
      .filter(active)
      .filter((hotel) => normalize(hotel.city) === city)
      .filter((hotel) => categoryMatches(hotel, category))
      .map((hotel) => ({
        id: text(hotel.id),
        value: text(hotel.id),
        title: text(hotel.name) || "Hotel",
        description: [text(hotel.distance), text(hotel.meal)].filter(Boolean).join(" • ").slice(0, 72),
      }))
      .filter((item) => item.id && item.title);
  }

  if (args.source === "transport_sectors") {
    const route = text(args.vars.umrah_route ?? args.vars.route_preset_id ?? args.vars.route);
    const allowed = new Set(routeSectors(route));
    return rows(data, "transportRates")
      .filter(active)
      .filter((row) => allowed.has(text(row.sector)))
      .map((row) => ({
        id: text(row.sector),
        value: text(row.sector),
        title: text(row.label ?? row.name ?? row.sector).slice(0, 24),
        description: text(row.description).slice(0, 72),
      }))
      .filter((item) => item.id);
  }

  return rows(data, "ziyarats")
    .filter(active)
    .map((row) => ({
      id: text(row.id),
      value: text(row.id),
      title: text(row.name ?? row.label).slice(0, 24),
      description: [text(row.city), text(row.description)].filter(Boolean).join(" • ").slice(0, 72),
    }))
    .filter((item) => item.id && item.title);
}
