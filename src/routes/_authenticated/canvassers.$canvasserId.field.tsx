import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel, StatCard } from "@/components/arcade";
import { NeonMap, type FieldPin, type Territory, type LatLng } from "@/components/NeonMap";
import { Home, MessageSquare, Sparkles, DollarSign, AlertTriangle, ArrowLeft } from "lucide-react";
import { commissionRateForPoints } from "@/lib/pay";

export const Route = createFileRoute("/_authenticated/canvassers/$canvasserId/field")({
  head: () => ({ meta: [{ title: "Field Activity — Knockout" }] }),
  component: FieldActivityPage,
});

function isoDay(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x.toISOString().slice(0,10); }
function fmt(n: number) { return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }); }
function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

type PinRow = {
  id: string; pin_type: FieldPin["pin_type"]; lat: number; lng: number;
  is_remote_drop: boolean | null; distance_m: number | null; created_at: string;
};
type SaleRow = { id: string; sale_amount: number | null; customer_name: string | null; address: string | null; reviewed_at: string | null; created_at: string };

function FieldActivityPage() {
  const { canvasserId } = Route.useParams();
  const { role, user } = useAuth();
  const [day, setDay] = useState(isoDay(new Date()));

  const allowed = role === "owner" || role === "office_staff" || role === "captain" || user?.id === canvasserId;

  const profileQuery = useQuery({
    enabled: allowed,
    queryKey: ["profile_min", canvasserId],
    queryFn: async () => (await supabase.from("profiles").select("display_name, team_id").eq("id", canvasserId).maybeSingle()).data,
  });

  const pinsQuery = useQuery({
    enabled: allowed,
    queryKey: ["field_pins_day", canvasserId, day],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_pins")
        .select("id, pin_type, lat, lng, is_remote_drop, distance_m, created_at")
        .eq("canvasser_id", canvasserId).eq("log_date", day)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PinRow[];
    },
  });

  const salesQuery = useQuery({
    enabled: allowed,
    queryKey: ["field_sales_day", canvasserId, day],
    queryFn: async () => {
      const start = new Date(day + "T00:00:00").toISOString();
      const end = new Date(new Date(day + "T00:00:00").getTime() + 86400000).toISOString();
      const { data, error } = await supabase
        .from("leads").select("id, sale_amount, customer_name, address, reviewed_at, created_at")
        .eq("canvasser_id", canvasserId).eq("status", "confirmed").eq("is_sale", true)
        .gte("created_at", start).lt("created_at", end)
        .order("reviewed_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SaleRow[];
    },
  });

  // Weekly points → commission tier (1% vs 2%)
  const weekStart = useMemo(() => {
    const d = new Date(day); d.setHours(0,0,0,0); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0,10);
  }, [day]);
  const pointsQuery = useQuery({
    enabled: allowed,
    queryKey: ["week_points", canvasserId, weekStart],
    queryFn: async () => {
      const { data } = await supabase.from("daily_logs")
        .select("demos_sits, sales").eq("canvasser_id", canvasserId).gte("log_date", weekStart);
      const rows = data ?? [];
      // Sit=1pt, Sale=2pt. demos_sits already includes sale rows, so points = demos_sits + sales.
      return rows.reduce((a, r) => a + (r.demos_sits ?? 0) + (r.sales ?? 0), 0);
    },
  });
  const commissionRate = commissionRateForPoints(pointsQuery.data ?? 0);

  const pins = pinsQuery.data ?? [];
  const sales = salesQuery.data ?? [];

  // Merge timeline: each pin = 1 knock; each confirmed sale = $ event
  type Ev = { t: number; kind: "pin" | "sale"; pin?: PinRow; sale?: SaleRow };
  const timeline: Ev[] = useMemo(() => {
    const evs: Ev[] = [
      ...pins.map<Ev>((p) => ({ t: +new Date(p.created_at), kind: "pin", pin: p })),
      ...sales.map<Ev>((s) => ({ t: +new Date(s.reviewed_at ?? s.created_at), kind: "sale", sale: s })),
    ];
    return evs.sort((a,b) => a.t - b.t);
  }, [pins, sales]);

  // Running totals
  const stats = useMemo(() => {
    let knocks = 0, commission = 0, revenue = 0;
    const series = timeline.map((e) => {
      if (e.kind === "pin" && !e.pin?.is_remote_drop) knocks += 1;
      if (e.kind === "sale") {
        const amt = Number(e.sale?.sale_amount ?? 0);
        revenue += amt;
        commission += amt * commissionRate;
      }
      return {
        ev: e,
        knocks, commission, revenue,
        vpd: knocks > 0 ? commission / knocks : 0,
      };
    });
    return {
      series,
      totalKnocks: knocks,
      totalCommission: commission,
      totalRevenue: revenue,
      vpd: knocks > 0 ? commission / knocks : 0,
      remoteDrops: pins.filter((p) => p.is_remote_drop).length,
    };
  }, [timeline, commissionRate, pins]);

  // Territories overlay
  const territoriesQuery = useQuery({
    enabled: allowed,
    queryKey: ["territories_view", profileQuery.data?.team_id],
    queryFn: async () => {
      const { data } = await supabase.from("territories").select("id, name, color, polygon");
      return data ?? [];
    },
  });
  const territories: Territory[] = (territoriesQuery.data ?? []).map((t) => ({
    id: t.id as string, name: t.name as string, color: (t.color as string) ?? "#39ff14",
    polygon: t.polygon as LatLng[],
  }));

  if (!allowed) {
    return <div className="arcade-card p-8 text-center text-sm text-muted-foreground">Not authorized to view this player's field activity.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link to="/canvassers/$canvasserId" params={{ canvasserId }} className="text-xs text-muted-foreground hover:text-neon inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to profile
          </Link>
          <h1 className="mt-2 font-display text-2xl text-neon">
            FIELD ACTIVITY · {(profileQuery.data?.display_name ?? "PLAYER").toUpperCase()}
          </h1>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mt-1">
            Spectator mode · live pin trail & money per knock
          </div>
        </div>
        <input
          type="date"
          value={day}
          max={isoDay(new Date())}
          onChange={(e) => setDay(e.target.value)}
          className="bg-surface border border-border rounded px-3 py-2 text-sm font-display"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Valid Knocks" value={stats.totalKnocks} accent="neon" sublabel={`${stats.remoteDrops} remote drops excluded`} />
        <StatCard label="Revenue Today" value={fmt(stats.totalRevenue)} accent="victory" />
        <StatCard label={`Commission · ${(commissionRate*100).toFixed(0)}%`} value={fmt(stats.totalCommission)} accent="accent"
          sublabel={`${pointsQuery.data ?? 0} weekly pts · ${commissionRate === 0.02 ? "TIER 2" : "TIER 1"}`} />
        <StatCard label="$ / Knock" value={fmt(stats.vpd)} accent="victory" sublabel="Live value per door" />
      </div>

      <ArcadePanel title="Live Map · Today's Pin Trail">
        <NeonMap
          territories={territories}
          pins={pins.map((p) => ({ ...p, is_remote_drop: p.is_remote_drop ?? false }))}
          height={520}
          mode={{ kind: "view" }}
        />
      </ArcadePanel>

      <ArcadePanel title="Timeline · Money Accumulating Per Knock">
        {stats.series.length === 0 ? (
          <div className="text-sm text-muted-foreground">No activity logged for this day yet.</div>
        ) : (
          <ol className="space-y-2">
            {stats.series.map((s, i) => {
              const e = s.ev;
              if (e.kind === "sale") {
                const amt = Number(e.sale?.sale_amount ?? 0);
                return (
                  <li key={`s-${e.sale!.id}`} className="flex items-center gap-3 rounded border border-victory/40 bg-victory/5 px-3 py-2">
                    <DollarSign className="w-4 h-4 text-victory" />
                    <div className="flex-1 min-w-0">
                      <div className="font-display text-xs uppercase tracking-widest text-victory">SALE CONFIRMED · {fmt(amt)}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {e.sale?.customer_name ?? "—"} · {e.sale?.address ?? ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{timeLabel(new Date(e.t).toISOString())}</div>
                      <div className="font-display text-victory">+{fmt(amt * commissionRate)}</div>
                    </div>
                  </li>
                );
              }
              const p = e.pin!;
              const color = p.is_remote_drop ? "#8a8f99"
                : p.pin_type === "lead" ? "#39ff14"
                : p.pin_type === "talked_to" ? "#ffd60a" : "#ff2d55";
              const Icon = p.pin_type === "lead" ? Sparkles : p.pin_type === "talked_to" ? MessageSquare : Home;
              const label = p.is_remote_drop ? "REMOTE DROP (flagged)"
                : p.pin_type === "lead" ? "LEAD GENERATED"
                : p.pin_type === "talked_to" ? "TALKED TO" : "NOT HOME";
              return (
                <li key={`p-${p.id}`} className="flex items-center gap-3 rounded border border-border bg-surface px-3 py-2">
                  {p.is_remote_drop
                    ? <AlertTriangle className="w-4 h-4" style={{ color }} />
                    : <Icon className="w-4 h-4" style={{ color }} />}
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-xs uppercase tracking-widest" style={{ color }}>
                      #{i + 1} · {label}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                      {p.distance_m != null ? ` · ${Math.round(p.distance_m * 1.0936)} yds from device` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{timeLabel(new Date(e.t).toISOString())}</div>
                    <div className="font-display text-neon text-sm">
                      {s.knocks} knocks · {fmt(s.vpd)}<span className="text-muted-foreground text-[10px]">/door</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </ArcadePanel>
    </div>
  );
}
