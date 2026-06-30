import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { OfficeFilterToggle, useOfficeFilter } from "@/components/OfficeFilterContext";
import { Radio, Users, FileSearch, X, Link2, Copy, Check } from "lucide-react";


type Profile = {
  id: string;
  display_name: string | null;
  office_location: string | null;
  team_id: string | null;
};

type Metric = {
  id: string;
  canvasser_id: string;
  metric_date: string;
  leads_submitted: number;
  leads_confirmed: number;
  no_answers: number;
  killed: number;
  pending: number;
  office_location: string;
};

function todayLA(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export function LiveDispatch() {
  const qc = useQueryClient();
  const today = todayLA();
  const { matches } = useOfficeFilter();

  const { data: canvassers = [] } = useQuery({
    queryKey: ["dispatch-canvassers"],
    queryFn: async () => {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "canvasser");
      const ids = (roles ?? []).map((r) => r.user_id);
      if (ids.length === 0) return [] as Profile[];
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, office_location, team_id")
        .in("id", ids);
      return ((profs ?? []) as Profile[]).sort((a, b) =>
        (a.display_name ?? "").localeCompare(b.display_name ?? ""),
      );
    },
  });

  const { data: metrics = [] } = useQuery({
    queryKey: ["daily-metrics", today],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_metrics")
        .select(
          "id, canvasser_id, metric_date, leads_submitted, leads_confirmed, no_answers, killed, pending, office_location",
        )
        .eq("metric_date", today);
      return (data ?? []) as Metric[];
    },
  });

  // Realtime subscription — instant updates when Monday webhook upserts.
  useEffect(() => {
    const channel = supabase
      .channel("dispatch-daily-metrics")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_metrics" },
        () => qc.invalidateQueries({ queryKey: ["daily-metrics", today] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc, today]);

  const metricMap = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m.canvasser_id, m])),
    [metrics],
  );

  const visible = useMemo(
    () => canvassers.filter((c) => matches(c.office_location)),
    [canvassers, matches],
  );

  const totals = useMemo(() => {
    let sub = 0, conf = 0, na = 0, kil = 0, pen = 0;
    visible.forEach((c) => {
      const m = metricMap[c.id];
      if (!m) return;
      sub += m.leads_submitted ?? 0;
      conf += m.leads_confirmed ?? 0;
      na += m.no_answers ?? 0;
      kil += m.killed ?? 0;
      pen += m.pending ?? 0;
    });
    const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
    return { sub, conf, na, kil, pen, conv };
  }, [visible, metricMap]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-victory animate-pulse" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Live Dispatch · {today}
            </div>
            <div className="font-display text-sm text-neon mt-0.5">
              READ-ONLY · MONDAY.COM FEED
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WebhookLogsButton />
          <OfficeFilterToggle />
        </div>
      </div>


      <WebhookUrlBanner />

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">

        <TotalTile label="Submitted" value={totals.sub} accent="neon" />
        <TotalTile label="Pending" value={totals.pen} accent="warning" />
        <TotalTile label="N/A" value={totals.na} accent="muted" />
        <TotalTile label="Confirmed" value={totals.conf} accent="victory" />
        <TotalTile label="Killed" value={totals.kil} accent="danger" />
        <TotalTile label="Conversion" value={`${totals.conv}%`} accent="accent" />
      </div>

      <div className="arcade-card overflow-hidden">
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <Users className="w-5 h-5" />
            No canvassers in this office yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border bg-surface">
                  <th className="text-left py-2.5 px-3">Canvasser</th>
                  <th className="text-left py-2.5 px-3">Office</th>
                  <th className="text-right py-2.5 px-3">Submitted</th>
                  <th className="text-right py-2.5 px-3">Pending</th>
                  <th className="text-right py-2.5 px-3">N/A</th>
                  <th className="text-right py-2.5 px-3">Confirmed</th>
                  <th className="text-right py-2.5 px-3">Killed</th>
                  <th className="text-right py-2.5 px-3">Conversion %</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const m = metricMap[c.id];
                  const sub = m?.leads_submitted ?? 0;
                  const conf = m?.leads_confirmed ?? 0;
                  const na = m?.no_answers ?? 0;
                  const kil = m?.killed ?? 0;
                  const pen = m?.pending ?? 0;
                  const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
                  return (
                    <tr key={c.id} className="border-b border-border/40 hover:bg-surface-elevated">
                      <td className="py-2.5 px-3 font-medium">{c.display_name ?? "—"}</td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground">
                        {c.office_location ?? "—"}
                      </td>
                      <td className="py-2.5 px-3 text-right font-display text-neon">{sub}</td>
                      <td className="py-2.5 px-3 text-right font-display text-warning">{pen}</td>
                      <td className="py-2.5 px-3 text-right font-display text-muted-foreground">{na}</td>
                      <td className="py-2.5 px-3 text-right font-display text-victory">{conf}</td>
                      <td className="py-2.5 px-3 text-right font-display text-destructive">{kil}</td>
                      <td className="py-2.5 px-3 text-right font-display text-accent">{conv}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function TotalTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: "neon" | "victory" | "accent" | "warning" | "danger" | "muted";
}) {
  const color =
    accent === "victory"
      ? "text-victory"
      : accent === "accent"
        ? "text-accent"
        : accent === "warning"
          ? "text-warning"
          : accent === "danger"
            ? "text-destructive"
            : accent === "muted"
              ? "text-muted-foreground"
              : "text-neon";
  return (
    <div className="arcade-card p-4">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`font-display text-2xl mt-1 ${color}`}>{value}</div>
    </div>
  );
}

type WebhookLog = {
  id: string;
  created_at: string;
  source: string | null;
  raw_payload: unknown;
};

function WebhookLogsButton() {
  const [open, setOpen] = useState(false);
  const { data: logs = [], refetch, isFetching } = useQuery({
    queryKey: ["webhook-logs"],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from("webhook_logs")
        .select("id, created_at, source, raw_payload")
        .order("created_at", { ascending: false })
        .limit(25);
      return (data ?? []) as WebhookLog[];
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="arcade-card px-3 py-2 text-[10px] font-display uppercase tracking-widest text-accent hover:bg-surface-elevated flex items-center gap-2"
      >
        <FileSearch className="w-3.5 h-3.5" />
        Webhook Logs
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="arcade-card w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div>
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  X-Ray · Raw Incoming Payloads
                </div>
                <div className="font-display text-sm text-neon mt-0.5">
                  WEBHOOK LOGS (LAST 25)
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="text-[10px] font-display uppercase tracking-widest text-accent px-2 py-1 hover:bg-surface-elevated rounded"
                >
                  {isFetching ? "…" : "Refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-4 space-y-3">
              {logs.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  No webhook payloads received yet.
                </div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} className="border border-border rounded p-3 bg-surface">
                    <div className="flex justify-between text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                      <span>{l.source ?? "unknown"}</span>
                      <span>{new Date(l.created_at).toLocaleString()}</span>
                    </div>
                    <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-all max-h-64 overflow-auto">
                      {JSON.stringify(l.raw_payload, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

