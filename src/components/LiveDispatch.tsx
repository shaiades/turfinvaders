import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { OfficeFilterToggle, useOfficeFilter } from "@/components/OfficeFilterContext";
import { Radio, Users } from "lucide-react";

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
  office_location: string;
};

type Team = { id: string; name: string; color: string | null };

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

  const { data: teams = [] } = useQuery({
    queryKey: ["dispatch-teams"],
    queryFn: async () => {
      const { data } = await supabase.from("teams").select("id, name, color");
      return (data ?? []) as Team[];
    },
  });

  const { data: metrics = [] } = useQuery({
    queryKey: ["daily-metrics", today],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_metrics")
        .select("id, canvasser_id, metric_date, leads_submitted, leads_confirmed, office_location")
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

  const teamMap = useMemo(() => Object.fromEntries(teams.map((t) => [t.id, t])), [teams]);
  const metricMap = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m.canvasser_id, m])),
    [metrics],
  );

  const visible = useMemo(
    () => canvassers.filter((c) => matches(c.office_location)),
    [canvassers, matches],
  );

  const totals = useMemo(() => {
    let sub = 0,
      conf = 0;
    visible.forEach((c) => {
      const m = metricMap[c.id];
      if (!m) return;
      sub += m.leads_submitted ?? 0;
      conf += m.leads_confirmed ?? 0;
    });
    const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
    return { sub, conf, conv };
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
        <OfficeFilterToggle />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <TotalTile label="Submitted" value={totals.sub} accent="neon" />
        <TotalTile label="Confirmed" value={totals.conf} accent="victory" />
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
                  <th className="text-left py-2.5 px-3 hidden md:table-cell">Van</th>
                  <th className="text-right py-2.5 px-3">Submitted</th>
                  <th className="text-right py-2.5 px-3">Confirmed</th>
                  <th className="text-right py-2.5 px-3">Conversion %</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const m = metricMap[c.id];
                  const sub = m?.leads_submitted ?? 0;
                  const conf = m?.leads_confirmed ?? 0;
                  const conv = sub > 0 ? Math.round((conf / sub) * 100) : 0;
                  const team = c.team_id ? teamMap[c.team_id] : undefined;
                  return (
                    <tr key={c.id} className="border-b border-border/40 hover:bg-surface-elevated">
                      <td className="py-2.5 px-3 font-medium">{c.display_name ?? "—"}</td>
                      <td className="py-2.5 px-3 hidden md:table-cell">
                        {team ? (
                          <span
                            className="inline-flex items-center gap-1.5 text-xs"
                            style={{ color: team.color ?? undefined }}
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ background: team.color ?? "#10b981" }}
                            />
                            {team.name}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-display text-neon">{sub}</td>
                      <td className="py-2.5 px-3 text-right font-display text-victory">{conf}</td>
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
  accent: "neon" | "victory" | "accent";
}) {
  const color =
    accent === "victory" ? "text-victory" : accent === "accent" ? "text-accent" : "text-neon";
  return (
    <div className="arcade-card p-4">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`font-display text-2xl mt-1 ${color}`}>{value}</div>
    </div>
  );
}
