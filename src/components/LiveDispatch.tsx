import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OfficeFilterToggle, useOfficeFilter } from "@/components/OfficeFilterContext";
import { Minus, Plus, Radio, Users } from "lucide-react";

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
  leads_called_in: number;
  leads_confirmed: number;
  sits_ran_today: number;
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
        .select("*")
        .eq("metric_date", today);
      return (data ?? []) as Metric[];
    },
  });

  const { data: clockedIds = new Set<string>() } = useQuery({
    queryKey: ["dispatch-clocked-in", today],
    queryFn: async () => {
      const { data } = await supabase
        .from("time_entries")
        .select("user_id, clock_out")
        .eq("log_date", today);
      const set = new Set<string>();
      (data ?? []).forEach((r: { user_id: string; clock_out: string | null }) => {
        if (!r.clock_out) set.add(r.user_id);
      });
      return set;
    },
  });

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel("dispatch-daily-metrics")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_metrics" },
        () => qc.invalidateQueries({ queryKey: ["daily-metrics", today] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "time_entries" },
        () => qc.invalidateQueries({ queryKey: ["dispatch-clocked-in", today] }),
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

  // Totals
  const totals = useMemo(() => {
    let called = 0,
      conf = 0,
      sits = 0;
    visible.forEach((c) => {
      const m = metricMap[c.id];
      if (!m) return;
      called += m.leads_called_in;
      conf += m.leads_confirmed;
      sits += m.sits_ran_today;
    });
    return { called, conf, sits };
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
              REAL-TIME LEADERBOARD
            </div>
          </div>
        </div>
        <OfficeFilterToggle />
      </div>

      {/* Totals strip */}
      <div className="grid grid-cols-3 gap-3">
        <TotalTile label="Called In" value={totals.called} accent="neon" />
        <TotalTile label="Confirmed" value={totals.conf} accent="victory" />
        <TotalTile label="Sits Today" value={totals.sits} accent="accent" />
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
                  <th className="text-center py-2.5 px-3">Status</th>
                  <th className="text-center py-2.5 px-3">Called In</th>
                  <th className="text-center py-2.5 px-3">Confirmed</th>
                  <th className="text-center py-2.5 px-3">Sits</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <DispatchRow
                    key={c.id}
                    canvasser={c}
                    metric={metricMap[c.id]}
                    team={c.team_id ? teamMap[c.team_id] : undefined}
                    clockedIn={clockedIds.has(c.id)}
                    today={today}
                  />
                ))}
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
  value: number;
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

type Field = "leads_called_in" | "leads_confirmed" | "sits_ran_today";

function DispatchRow({
  canvasser,
  metric,
  team,
  clockedIn,
  today,
}: {
  canvasser: Profile;
  metric: Metric | undefined;
  team: Team | undefined;
  clockedIn: boolean;
  today: string;
}) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Field | null>(null);

  const setValue = async (field: Field, value: number) => {
    const safe = Math.max(0, Math.floor(value));
    setPending(field);
    // Optimistic
    qc.setQueryData<Metric[]>(["daily-metrics", today], (prev) => {
      const list = prev ? [...prev] : [];
      const idx = list.findIndex((m) => m.canvasser_id === canvasser.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], [field]: safe };
      } else {
        list.push({
          id: `tmp-${canvasser.id}`,
          canvasser_id: canvasser.id,
          metric_date: today,
          leads_called_in: field === "leads_called_in" ? safe : 0,
          leads_confirmed: field === "leads_confirmed" ? safe : 0,
          sits_ran_today: field === "sits_ran_today" ? safe : 0,
          office_location: canvasser.office_location ?? "San Diego",
        });
      }
      return list;
    });

    const payload = {
      canvasser_id: canvasser.id,
      metric_date: today,
      office_location: canvasser.office_location ?? "San Diego",
      leads_called_in: field === "leads_called_in" ? safe : metric?.leads_called_in ?? 0,
      leads_confirmed: field === "leads_confirmed" ? safe : metric?.leads_confirmed ?? 0,
      sits_ran_today: field === "sits_ran_today" ? safe : metric?.sits_ran_today ?? 0,
    };

    const { error } = await supabase
      .from("daily_metrics")
      .upsert(payload, { onConflict: "canvasser_id,metric_date" });
    setPending(null);
    if (error) {
      qc.invalidateQueries({ queryKey: ["daily-metrics", today] });
      console.error("dispatch upsert failed", error);
    }
  };

  const called = metric?.leads_called_in ?? 0;
  const confirmed = metric?.leads_confirmed ?? 0;
  const sits = metric?.sits_ran_today ?? 0;

  return (
    <tr className="border-b border-border/40 hover:bg-surface-elevated">
      <td className="py-2.5 px-3 font-medium">{canvasser.display_name ?? "—"}</td>
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
      <td className="py-2.5 px-3 text-center">
        <span
          className={`text-[9px] font-display uppercase tracking-widest px-2 py-0.5 rounded border ${
            clockedIn
              ? "border-victory text-victory"
              : "border-border text-muted-foreground"
          }`}
        >
          {clockedIn ? "ON CLOCK" : "OFF"}
        </span>
      </td>
      <Stepper
        value={called}
        onChange={(v) => setValue("leads_called_in", v)}
        loading={pending === "leads_called_in"}
      />
      <Stepper
        value={confirmed}
        onChange={(v) => setValue("leads_confirmed", v)}
        loading={pending === "leads_confirmed"}
        accent="victory"
      />
      <Stepper
        value={sits}
        onChange={(v) => setValue("sits_ran_today", v)}
        loading={pending === "sits_ran_today"}
        accent="accent"
      />
    </tr>
  );
}

function Stepper({
  value,
  onChange,
  loading,
  accent = "neon",
}: {
  value: number;
  onChange: (v: number) => void;
  loading?: boolean;
  accent?: "neon" | "victory" | "accent";
}) {
  const color =
    accent === "victory" ? "text-victory" : accent === "accent" ? "text-accent" : "text-neon";
  return (
    <td className="py-2 px-2">
      <div className="flex items-center justify-center gap-1">
        <Button
          size="icon"
          variant="outline"
          className="h-7 w-7"
          onClick={() => onChange(Math.max(0, value - 1))}
          disabled={loading || value <= 0}
          aria-label="decrement"
        >
          <Minus className="w-3 h-3" />
        </Button>
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className={`h-7 w-14 text-center font-display ${color}`}
        />
        <Button
          size="icon"
          variant="outline"
          className="h-7 w-7"
          onClick={() => onChange(value + 1)}
          disabled={loading}
          aria-label="increment"
        >
          <Plus className="w-3 h-3" />
        </Button>
      </div>
    </td>
  );
}
