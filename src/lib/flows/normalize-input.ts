export type FlowInputType = "text" | "date" | "phone" | "integer";

export interface NormalizedFlowInput {
  matched: boolean;
  value?: string;
  reason?: string;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(year: number, month: number, day: number): string | null {
  return validDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
}

function normalizeDate(raw: string, now = new Date()): string | null {
  const text = raw.trim().toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, "$1");

  let match = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) return formatDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
  if (match) return formatDate(Number(match[3]), Number(match[2]), Number(match[1]));

  match = text.match(/\b(\d{1,2})\s+([a-z]+)\s+(20\d{2})\b/);
  if (match && MONTHS[match[2]]) return formatDate(Number(match[3]), MONTHS[match[2]], Number(match[1]));

  match = text.match(/\b([a-z]+)\s+(\d{1,2})(?:,)?\s+(20\d{2})\b/);
  if (match && MONTHS[match[1]]) return formatDate(Number(match[3]), MONTHS[match[1]], Number(match[2]));

  if (/\btoday\b/.test(text)) {
    return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
  if (/\btomorrow\b/.test(text)) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    return formatDate(next.getFullYear(), next.getMonth() + 1, next.getDate());
  }

  return null;
}

function normalizeInteger(raw: string): string | null {
  const match = raw.match(/\b\d+\b/);
  if (!match) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) && value >= 0 ? String(value) : null;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^03\d{9}$/.test(digits)) return digits;
  if (/^923\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return null;
}

export function normalizeFlowInput(args: {
  inputType: FlowInputType;
  customerMessage: string;
  now?: Date;
}): NormalizedFlowInput {
  const raw = args.customerMessage.trim();
  if (!raw) return { matched: false, reason: "empty" };

  if (args.inputType === "text") return { matched: true, value: raw };

  const value =
    args.inputType === "date"
      ? normalizeDate(raw, args.now)
      : args.inputType === "integer"
        ? normalizeInteger(raw)
        : normalizePhone(raw);

  return value
    ? { matched: true, value }
    : { matched: false, reason: `not_${args.inputType}` };
}
