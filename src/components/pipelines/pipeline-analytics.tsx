"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import {
  BarChart3,
  CircleDot,
  Info,
  Target,
  Trophy,
  XCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const stats = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = (deal: Deal) => {
      const ts = deal.updated_at ?? deal.created_at;
      return ts ? new Date(ts) >= monthStart : false;
    };

    return {
      totalCount: deals.length,
      openCount: deals.filter((deal) => deal.status === "open").length,
      stageCount: stages.length,
      wonThisMonth: deals.filter(
        (deal) => deal.status === "won" && thisMonth(deal),
      ).length,
      lostThisMonth: deals.filter(
        (deal) => deal.status === "lost" && thisMonth(deal),
      ).length,
    };
  }, [deals, stages.length]);

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 xl:grid-cols-5">
        <Metric
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          label="Total Leads"
          value={String(stats.totalCount)}
          tooltip="Every lead currently shown in this pipeline."
        />
        <Metric
          icon={<CircleDot className="h-4 w-4 text-primary" />}
          label="Open Leads"
          value={String(stats.openCount)}
          tooltip="Leads still open for follow-up."
        />
        <Metric
          icon={<Target className="h-4 w-4 text-blue-400" />}
          label="Stages"
          value={String(stats.stageCount)}
          tooltip="Active pipeline stages available for organizing leads."
        />
        <Metric
          icon={<Trophy className="h-4 w-4 text-primary" />}
          label="Won This Month"
          value={String(stats.wonThisMonth)}
          tooltip="Leads marked as Won since the first day of the current month."
        />
        <Metric
          icon={<XCircle className="h-4 w-4 text-red-400" />}
          label="Lost This Month"
          value={String(stats.lostThisMonth)}
          tooltip="Leads marked as Lost since the first day of the current month."
        />
      </div>
    </TooltipProvider>
  );
}

function Metric({
  icon,
  label,
  value,
  tooltip,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tooltip: string;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`How ${label} is calculated`}
                className="ml-auto text-muted-foreground hover:text-foreground focus:outline-none"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
    </div>
  );
}
