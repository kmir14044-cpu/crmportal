"use client";

import type { Deal, DealStatus, PipelineStage } from "@/types";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

const EXPORT_COLUMNS = [
  "Lead Status",
  "Stage",
  "Name",
  "Phone",
  "Email",
  "Lead Source",
  "Title",
  "Destination",
  "Trip Start Date",
  "Starting City",
  "Days",
  "Hotel Category",
  "Adults",
  "Children",
  "Rooms",
  "Transport",
  "Query",
  "Created At",
  "Notes",
];

const DETAIL_LABELS: Record<string, string[]> = {
  tripStartDate: ["Trip Start Date"],
  startingCity: ["Starting City"],
  destination: ["Destination", "Topic"],
  days: ["Days"],
  hotelCategory: ["Hotel Category"],
  adults: ["Adults"],
  children: ["Children"],
  rooms: ["Rooms"],
  transport: ["Transport"],
  query: ["Query", "Request", "Latest customer message", "Customer message"],
};

function csvEscape(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function extractDetail(notes: string | undefined, labels: string[]): string {
  if (!notes) return "";
  const lines = notes.split(/\r?\n/);
  for (const label of labels) {
    const prefix = `${label}:`;
    const line = lines.find((entry) =>
      entry.trim().toLowerCase().startsWith(prefix.toLowerCase()),
    );
    if (line) return line.slice(line.indexOf(":") + 1).trim();
  }
  return "";
}

function extractTravelDetailsFromText(text: string): {
  tripStartDate: string;
  startingCity: string;
  days: string;
  hotelCategory: string;
  adults: string;
  children: string;
  rooms: string;
  transport: string;
} {
  const dateMatch = text.match(
    /\b(\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4})\b/i,
  );
  const fromMatch = text.match(
    /\bfrom\s+([a-z][a-z\s/-]{1,40}?)(?:\s+(?:on|in|with|for|to)\b|$|[,.])/i,
  );
  const daysMatch = text.match(/\b(\d{1,2})\s*(?:days?|nights?)\b/i);
  const adultsMatch = text.match(
    /\b(\d{1,3})\s*(?:persons?|people|pax|passengers?|adults?)\b/i,
  );
  const childrenMatch = text.match(/\b(\d{1,3})\s*(?:children|kids|child)\b/i);
  const roomsMatch = text.match(/\b(\d{1,2})\s*(?:rooms?|room)\b/i);
  const hotelMatch = text.match(
    /\b(budget|standard|normal|deluxe|luxury|no hotel needed|without hotel)\b/i,
  );
  const transportMatch = text.match(
    /\b(sedan|suv|hiace|coaster|coach|without transport|no transport)\b/i,
  );
  const titleCase = (value: string | undefined) =>
    value?.trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? "";

  return {
    tripStartDate: dateMatch?.[1] ?? "",
    startingCity: titleCase(fromMatch?.[1]),
    days: daysMatch?.[1] ?? "",
    hotelCategory: titleCase(hotelMatch?.[1]),
    adults: adultsMatch?.[1] ?? "",
    children: childrenMatch?.[1] ?? "",
    rooms: roomsMatch?.[1] ?? "",
    transport: titleCase(transportMatch?.[1]),
  };
}

function firstFilled(...values: unknown[]): string {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function dealToLeadRow(deal: Deal, stages: PipelineStage[]) {
  const stage = stages.find((s) => s.id === deal.stage_id);
  const notes = deal.notes ?? "";
  const query =
    deal.lead_query ?? extractDetail(notes, DETAIL_LABELS.query);
  const parsedFromQuery = extractTravelDetailsFromText(query || notes);
  return {
    status: deal.status ?? "open",
    stage: stage?.name ?? "",
    name: deal.contact?.name ?? "",
    phone: deal.contact?.phone ?? "",
    email: deal.contact?.email ?? "",
    leadSource: deal.lead_source ?? "",
    title: deal.title,
    destination: deal.lead_destination ?? extractDetail(notes, DETAIL_LABELS.destination),
    tripStartDate: firstFilled(deal.lead_trip_start_date, extractDetail(notes, DETAIL_LABELS.tripStartDate), parsedFromQuery.tripStartDate),
    startingCity: firstFilled(deal.lead_starting_city, extractDetail(notes, DETAIL_LABELS.startingCity), parsedFromQuery.startingCity),
    days: firstFilled(deal.lead_days, extractDetail(notes, DETAIL_LABELS.days), parsedFromQuery.days),
    hotelCategory: firstFilled(deal.lead_hotel_category, extractDetail(notes, DETAIL_LABELS.hotelCategory), parsedFromQuery.hotelCategory),
    adults: firstFilled(deal.lead_adults, extractDetail(notes, DETAIL_LABELS.adults), parsedFromQuery.adults),
    children: firstFilled(deal.lead_children, extractDetail(notes, DETAIL_LABELS.children), parsedFromQuery.children),
    rooms: firstFilled(deal.lead_rooms, extractDetail(notes, DETAIL_LABELS.rooms), parsedFromQuery.rooms),
    transport: firstFilled(deal.lead_transport, extractDetail(notes, DETAIL_LABELS.transport), parsedFromQuery.transport),
    query,
    createdAt: deal.created_at,
    notes,
  };
}

function statusLabel(status: DealStatus | undefined) {
  if (status === "won") return "Won";
  if (status === "lost") return "Lost";
  return "Open";
}

interface LeadsTableProps {
  deals: Deal[];
  stages: PipelineStage[];
  onStatusChange: (dealId: string, status: DealStatus) => void;
  onEditDeal: (deal: Deal) => void;
}

export function LeadsTable({
  deals,
  stages,
  onStatusChange,
  onEditDeal,
}: LeadsTableProps) {
  const rows = deals.map((deal) => ({ deal, lead: dealToLeadRow(deal, stages) }));

  function exportCsv() {
    const body = rows.map(({ lead }) =>
      [
        statusLabel(lead.status),
        lead.stage,
        lead.name,
        lead.phone,
        lead.email,
        lead.leadSource,
        lead.title,
        lead.destination,
        lead.tripStartDate,
        lead.startingCity,
        lead.days,
        lead.hotelCategory,
        lead.adults,
        lead.children,
        lead.rooms,
        lead.transport,
        lead.query,
        lead.createdAt,
        lead.notes,
      ]
        .map(csvEscape)
        .join(","),
    );
    const csv = [EXPORT_COLUMNS.map(csvEscape).join(","), ...body].join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tours-in-pakistan-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Leads</h2>
          <p className="text-xs text-muted-foreground">
            Trip details captured from WhatsApp and pipeline status.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="border-border bg-card text-foreground hover:bg-muted"
        >
          <Download className="mr-2 h-4 w-4" />
          Export Excel
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card/60">
        <table className="min-w-[1120px] w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Lead Status</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Destination</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">Days</th>
              <th className="px-3 py-2">Guests</th>
              <th className="px-3 py-2">Hotel</th>
              <th className="px-3 py-2">Transport</th>
              <th className="px-3 py-2">Query</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  No leads yet
                </td>
              </tr>
            ) : (
              rows.map(({ deal, lead }) => (
                <tr key={deal.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <select
                      value={lead.status}
                      onChange={(e) =>
                        onStatusChange(deal.id, e.target.value as DealStatus)
                      }
                      className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                    >
                      <option value="open">Open</option>
                      <option value="won">Won</option>
                      <option value="lost">Lost</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onEditDeal(deal)}
                      className="max-w-40 truncate font-medium text-primary hover:underline"
                    >
                      {lead.name || lead.title}
                    </button>
                    {lead.email ? (
                      <div className="max-w-40 truncate text-xs text-muted-foreground">
                        {lead.email}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {lead.phone || "-"}
                  </td>
                  <td className="px-3 py-2">{lead.destination || "-"}</td>
                  <td className="px-3 py-2">{lead.tripStartDate || "-"}</td>
                  <td className="px-3 py-2">{lead.startingCity || "-"}</td>
                  <td className="px-3 py-2">{lead.days || "-"}</td>
                  <td className="px-3 py-2">
                    {lead.adults || lead.children
                      ? `${lead.adults || 0} adults, ${lead.children || 0} children`
                      : "-"}
                  </td>
                  <td className="px-3 py-2">{lead.hotelCategory || "-"}</td>
                  <td className="px-3 py-2">{lead.transport || "-"}</td>
                  <td className="px-3 py-2">
                    <span className="line-clamp-2 max-w-64 text-muted-foreground">
                      {lead.query || lead.notes || "-"}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
