// Field standings — the video app's leaderboard, on our map screen (owner ask
// 2026-09-10): SALE / DK / PTT / CL% per rep, vans as expandable groups, a
// Totals row, and the "Stats Key" legend dialog. Numbers ride the same
// transparency contract as /leaderboard: getDispatchProduction aggregates
// (owner 2026-07-28, every viewer sees everyone's production); SALE = the
// dispatch board's Sal column (daily_logs.sales), DK = doors_knocked,
// PTT = people_talked_to, CL% = SALE ÷ PTT.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleHelp } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useDateRange } from "@/hooks/useDateRange";
import { useDispatchRoster, useDispatchVans } from "@/hooks/useFleetRoster";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { getDispatchProduction, type DispatchResults } from "@/lib/dispatch.functions";
import { RangeTabs } from "@/components/RangeTabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

type MemberRow = {
  id: string;
  name: string;
  sale: number;
  dk: number;
  ptt: number;
  former: boolean;
};

type VanGroup = {
  id: string;
  name: string;
  color: string | null;
  rows: MemberRow[];
  totals: { sale: number; dk: number; ptt: number };
};

const clPct = (sale: number, ptt: number) => (ptt > 0 ? Math.round((sale / ptt) * 100) : 0);

function Cells({
  sale,
  dk,
  ptt,
  strong,
}: {
  sale: number;
  dk: number;
  ptt: number;
  strong?: boolean;
}) {
  const cls = `text-right tabular-nums ${strong ? "font-display text-xs" : "text-sm"}`;
  return (
    <>
      <div className={`${cls} text-victory`}>{sale}</div>
      <div className={`${cls}`}>{dk}</div>
      <div className={`${cls}`}>{ptt}</div>
      <div className={`${cls} text-neon`}>{clPct(sale, ptt)}%</div>
    </>
  );
}

export function FieldStandingsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useAuth();
  const controls = useDateRange({ initialTab: "day" });
  const { range } = controls;
  const [keyOpen, setKeyOpen] = useState(false);
  // null = "use the default" (the viewer's own van open, others collapsed).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const roster = useDispatchRoster({ enabled: open });
  const vansQ = useDispatchVans({ enabled: open });

  const production = useQuery({
    enabled: open,
    queryKey: ["field_standings", range.startISO, range.endISO],
    queryFn: async () =>
      getDispatchProduction({
        data: {
          log_start: range.startISO,
          log_end: range.endISO,
          vol_start: range.startUtcISO,
          vol_end: range.endUtcExclusiveISO,
        },
      }),
  });

  useRealtimeInvalidate({
    channel: "field-standings-live",
    tables: ["daily_logs"],
    invalidateKeys: [["field_standings"]],
    enabled: open,
  });

  const myTeamId = useMemo(() => {
    if (!user?.id) return null;
    return roster.data?.profiles.find((p) => p.id === user.id)?.team_id ?? null;
  }, [roster.data, user?.id]);

  const { groups, totals } = useMemo(() => {
    const results = (production.data?.results ?? {}) as Record<string, DispatchResults>;
    const snapshotTeam = (production.data?.snapshotTeam ?? {}) as Record<string, string>;
    const rolesByUser = roster.data?.rolesByUser ?? new Map<string, string[]>();
    const byTeam = new Map<string, MemberRow[]>();

    for (const p of roster.data?.profiles ?? []) {
      const roles = rolesByUser.get(p.id) ?? [];
      // Canvasser-tier board membership, FleetDispatch semantics: captains
      // knock too; confirmers ride as canvasser-tier rows.
      if (!roles.some((r) => r === "captain" || r === "canvasser" || r === "confirmer")) continue;
      const r = results[p.id];
      const former = p.is_active !== true;
      // Former members and invite placeholders appear only with in-range
      // production; the active roster always shows (zeros included — the
      // board is honest about a slow day).
      if ((former || p.is_placeholder) && !r) continue;
      const row: MemberRow = {
        id: p.id,
        name: p.display_name ?? "Player",
        sale: r?.sal ?? 0,
        dk: r?.drs ?? 0,
        ptt: r?.tlk ?? 0,
        former,
      };
      // Former reps bucket under the van their in-range rows were stamped
      // with (live team_id was nulled at removal) — same rule as dispatch.
      const teamKey = (former ? (snapshotTeam[p.id] ?? p.team_id) : p.team_id) ?? "none";
      const list = byTeam.get(teamKey) ?? [];
      list.push(row);
      byTeam.set(teamKey, list);
    }

    const sortRows = (a: MemberRow, b: MemberRow) =>
      b.sale - a.sale || b.dk - a.dk || a.name.localeCompare(b.name);

    const groups: VanGroup[] = [];
    for (const v of vansQ.data ?? []) {
      const rows = (byTeam.get(v.id) ?? []).sort(sortRows);
      byTeam.delete(v.id);
      if (rows.length === 0) continue;
      groups.push({
        id: v.id,
        name: v.name,
        color: v.color,
        rows,
        totals: rows.reduce(
          (t, r) => ({ sale: t.sale + r.sale, dk: t.dk + r.dk, ptt: t.ptt + r.ptt }),
          { sale: 0, dk: 0, ptt: 0 },
        ),
      });
    }
    // Anyone left (no live van, no snapshot) still counts — never hide production.
    const leftovers = [...byTeam.values()].flat().sort(sortRows);
    if (leftovers.length > 0) {
      groups.push({
        id: "none",
        name: "No Van",
        color: null,
        rows: leftovers,
        totals: leftovers.reduce(
          (t, r) => ({ sale: t.sale + r.sale, dk: t.dk + r.dk, ptt: t.ptt + r.ptt }),
          { sale: 0, dk: 0, ptt: 0 },
        ),
      });
    }
    const totals = groups.reduce(
      (t, g) => ({
        sale: t.sale + g.totals.sale,
        dk: t.dk + g.totals.dk,
        ptt: t.ptt + g.totals.ptt,
      }),
      { sale: 0, dk: 0, ptt: 0 },
    );
    return { groups, totals };
  }, [roster.data, vansQ.data, production.data]);

  const isOpenGroup = (g: VanGroup) => expanded[g.id] ?? g.id === (myTeamId ?? "__own__");
  const loading = roster.isPending || production.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} className="max-h-[88dvh]">
        <SheetHeader className="pr-10">
          <div className="flex items-center gap-2">
            <SheetTitle className="font-display text-neon text-base uppercase tracking-widest">
              Standings
            </SheetTitle>
            <button
              type="button"
              aria-label="Stats key"
              onClick={() => setKeyOpen(true)}
              className="min-h-8 min-w-8 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            >
              <CircleHelp className="w-4 h-4" />
            </button>
          </div>
        </SheetHeader>

        <div className="px-4 pt-2">
          <RangeTabs controls={controls} />
        </div>

        <div
          className={`overflow-y-auto px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] ${production.isFetching ? "opacity-60" : ""}`}
        >
          {/* Column header — the video's vocabulary exactly */}
          <div className="grid grid-cols-[minmax(0,1fr)_2.75rem_3.25rem_3.25rem_3rem] gap-x-2 border-b border-border pb-1.5 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
            <div>Player</div>
            <div className="text-right">Sale</div>
            <div className="text-right">DK</div>
            <div className="text-right">PTT</div>
            <div className="text-right">CL%</div>
          </div>

          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Counting…</div>
          ) : production.isError ? (
            <div className="py-6 text-center text-sm text-destructive">
              Couldn't load standings — check your signal and reopen.
            </div>
          ) : groups.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No production in this range yet.
            </div>
          ) : (
            <>
              {groups.map((g) => {
                const openG = isOpenGroup(g);
                return (
                  <div key={g.id} className="border-b border-border/60">
                    <button
                      type="button"
                      onClick={() => setExpanded((e) => ({ ...e, [g.id]: !openG }))}
                      className="grid w-full grid-cols-[minmax(0,1fr)_2.75rem_3.25rem_3.25rem_3rem] items-center gap-x-2 py-2.5 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        {openG ? (
                          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: g.color ?? "var(--muted-foreground)" }}
                        />
                        <span className="truncate font-display text-[11px] uppercase tracking-widest">
                          {g.name}
                        </span>
                      </div>
                      <Cells strong sale={g.totals.sale} dk={g.totals.dk} ptt={g.totals.ptt} />
                    </button>
                    {openG &&
                      g.rows.map((r) => {
                        const mine = r.id === user?.id;
                        return (
                          <div
                            key={r.id}
                            className={`grid grid-cols-[minmax(0,1fr)_2.75rem_3.25rem_3.25rem_3rem] items-center gap-x-2 py-2 pl-5 ${mine ? "rounded bg-neon/10" : ""}`}
                          >
                            <div
                              className={`truncate text-sm ${r.former ? "text-muted-foreground/70" : ""} ${mine ? "text-neon" : ""}`}
                            >
                              {r.name}
                              {r.former ? " · former" : ""}
                            </div>
                            <Cells sale={r.sale} dk={r.dk} ptt={r.ptt} />
                          </div>
                        );
                      })}
                  </div>
                );
              })}
              <div className="grid grid-cols-[minmax(0,1fr)_2.75rem_3.25rem_3.25rem_3rem] items-center gap-x-2 py-3">
                <div className="font-display text-[11px] uppercase tracking-widest">Totals</div>
                <Cells strong sale={totals.sale} dk={totals.dk} ptt={totals.ptt} />
              </div>
            </>
          )}
        </div>

        {/* Stats Key — the video's legend dialog, arcade-skinned */}
        {keyOpen && (
          <div
            className="absolute inset-0 z-[10000] flex items-center justify-center bg-black/60 p-6"
            onClick={() => setKeyOpen(false)}
          >
            <div
              className="w-full max-w-xs rounded-xl border border-neon/60 bg-surface p-5 text-center shadow-[0_0_30px_-8px_var(--neon)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="font-display text-sm uppercase tracking-widest text-neon">
                Stats Key
              </div>
              <div className="mt-3 space-y-1.5 text-sm">
                <div>
                  <b>SALE</b> — Sales (self-reported, Mission Log)
                </div>
                <div>
                  <b>DK</b> — Doors Knocked
                </div>
                <div>
                  <b>PTT</b> — People Talked To
                </div>
                <div>
                  <b>CL%</b> — Closing Ratio (Sales ÷ Talked To)
                </div>
              </div>
              <button
                type="button"
                onClick={() => setKeyOpen(false)}
                className="mt-4 w-full rounded-md bg-victory px-4 py-2.5 font-display text-[11px] uppercase tracking-widest text-black"
              >
                Okay
              </button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
