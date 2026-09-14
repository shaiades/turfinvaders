import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";

/**
 * RepCard 2026 season board — a read-only ops view of imported RepCard field
 * activity, ranked per rep. Self-contained: it queries only
 * `repcard_canvasser_results` (RLS: owner/office_staff/captain) and never
 * touches daily_logs / leads / the points-pay engine. RepCard data is a single
 * yearly aggregate (Jan 1 – Sep 14 2026, no per-day), so this board is always
 * all-2026 regardless of the dispatch board's Day/Week/Month tab.
 */

type Row = {
  rep_name: string;
  office: string | null;
  team: string | null;
  active: boolean | null;
  doors_knocked: number | null;
  verified_door_knock: number | null;
  talked_to: number | null;
  appts_set: number | null;
  door_knocked_days: number | null;
};

type RepAgg = {
  name: string;
  team: string | null;
  office: string | null;
  active: boolean;
  doors: number;
  verified: number;
  talked: number;
  appts: number;
  days: number;
};

const OFFICE_FILTERS = [
  { id: "all", label: "All", match: () => true },
  { id: "sd", label: "SD", match: (o: string | null) => (o ?? "").toLowerCase().includes("sd corporate") },
  { id: "oc", label: "OC", match: (o: string | null) => (o ?? "").toLowerCase().includes("orange county") },
] as const;

function aggregate(rows: Row[]): RepAgg[] {
  const byRep = new Map<string, RepAgg>();
  for (const r of rows) {
    const key = r.rep_name.trim().toLowerCase();
    const cur =
      byRep.get(key) ??
      ({
        name: r.rep_name,
        team: r.team,
        office: r.office,
        active: false,
        doors: 0,
        verified: 0,
        talked: 0,
        appts: 0,
        days: 0,
      } satisfies RepAgg);
    // Primary team/office = the row contributing the most doors.
    if ((r.doors_knocked ?? 0) > cur.doors && (r.team || r.office)) {
      cur.team = r.team ?? cur.team;
      cur.office = r.office ?? cur.office;
    }
    cur.active = cur.active || r.active === true;
    cur.doors += Number(r.doors_knocked ?? 0);
    cur.verified += Number(r.verified_door_knock ?? 0);
    cur.talked += Number(r.talked_to ?? 0);
    cur.appts += Number(r.appts_set ?? 0);
    cur.days += Number(r.door_knocked_days ?? 0);
    byRep.set(key, cur);
  }
  return [...byRep.values()].sort((a, b) => b.doors - a.doors);
}

const num = (n: number) => n.toLocaleString();
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

export function RepcardSeasonBoard() {
  const [office, setOffice] = useState<(typeof OFFICE_FILTERS)[number]["id"]>("all");

  const query = useQuery({
    // Distinct key from the profile page's ["repcard_results_all"] — that query
    // selects fewer columns, and a shared key would let its rows (missing
    // office/team/active) satisfy this board from cache.
    queryKey: ["repcard_results_full"],
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("repcard_canvasser_results")
        .select(
          "rep_name, office, team, active, doors_knocked, verified_door_knock, talked_to, appts_set, door_knocked_days",
        );
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const filter = OFFICE_FILTERS.find((f) => f.id === office)!;
  const reps = aggregate(query.data ?? []).filter((r) => filter.match(r.office));
  const totals = reps.reduce(
    (a, r) => ({
      doors: a.doors + r.doors,
      talked: a.talked + r.talked,
      appts: a.appts + r.appts,
    }),
    { doors: 0, talked: 0, appts: 0 },
  );

  return (
    <ArcadePanel
      title="2026 Season · RepCard"
      action={
        <div className="flex items-center gap-1.5">
          {OFFICE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setOffice(f.id)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-display uppercase tracking-widest border transition-colors ${
                office === f.id
                  ? "bg-neon text-background border-neon"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-neon/40"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      {query.isPending ? (
        <div className="text-sm text-muted-foreground">Loading RepCard season…</div>
      ) : query.isError ? (
        <div className="text-sm text-muted-foreground">Couldn't load RepCard history.</div>
      ) : reps.length === 0 ? (
        <div className="text-sm text-muted-foreground">No RepCard activity for this office.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm border-collapse">
            <thead>
              <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <th className="text-left font-normal py-2 pr-2">#</th>
                <th className="text-left font-normal py-2 pr-2">Rep</th>
                <th className="text-right font-normal py-2 px-2 text-neon">Doors</th>
                <th className="text-right font-normal py-2 px-2">Verified</th>
                <th className="text-right font-normal py-2 px-2 text-victory">Talked</th>
                <th className="text-right font-normal py-2 px-2">Talk%</th>
                <th className="text-right font-normal py-2 px-2 text-accent">Appts</th>
                <th className="text-right font-normal py-2 pl-2">Days</th>
              </tr>
            </thead>
            <tbody>
              {reps.map((r, i) => (
                <tr key={r.name} className="border-t border-border/40">
                  <td className="py-2 pr-2 text-muted-foreground tabular-nums">{i + 1}</td>
                  <td className="py-2 pr-2">
                    <span className={r.active ? "" : "text-muted-foreground"}>
                      {r.active ? "" : "❌ "}
                      {r.name}
                    </span>
                    {r.team ? (
                      <span className="ml-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                        {r.team}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-neon">{num(r.doors)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{num(r.verified)}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-victory">{num(r.talked)}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                    {pct(r.talked, r.doors)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-accent">{num(r.appts)}</td>
                  <td className="py-2 pl-2 text-right tabular-nums">{num(r.days)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-display text-[11px] uppercase tracking-widest">
                <td className="py-2 pr-2" />
                <td className="py-2 pr-2 text-muted-foreground">{reps.length} reps</td>
                <td className="py-2 px-2 text-right tabular-nums text-neon">{num(totals.doors)}</td>
                <td className="py-2 px-2" />
                <td className="py-2 px-2 text-right tabular-nums text-victory">{num(totals.talked)}</td>
                <td className="py-2 px-2" />
                <td className="py-2 px-2 text-right tabular-nums text-accent">{num(totals.appts)}</td>
                <td className="py-2 pl-2" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Imported from RepCard · Jan 1 – Sep 14, 2026. Team-split reps are summed; ❌ = deactivated in
        RepCard. Historical field activity shown for context only — <strong>not</strong> counted
        toward points, standings, or pay, and independent of the Day/Week/Month tab above.
      </p>
    </ArcadePanel>
  );
}
