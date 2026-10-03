// Kombat Month tab (owner directive 2026-10-02): the October contest screen
// inside Close Kombat. Every number on this page is a SUM OF LEDGER ROWS
// (contest_ledger) — never a stored total — and every row opens to show
// exactly where it came from (the Monday card or the approved proof).
// Admin extras (rules editor, bounties, projection, CSV) live in
// KombatMonthAdmin.tsx; the proof review queue lives on /confirmation-desk.
//
// Identity: ledger rows carry BOARD rep names; the viewer binds to them via
// buildRepMatcher, same as the Stats tab. Pool = the whole month's ledger
// (both offices — the contest is company-wide, no office filter here).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { usePurposeProfile } from "@/hooks/usePurposeProfile";
import { useActivityTests } from "@/hooks/useActivityTests";
import { buildRepMatcher } from "@/lib/rep-identity";
import { rewardToast } from "@/lib/reward-toast";
import { laTodayISO, nextMonthStartISO } from "@/lib/dates";
import { CARD_COLUMNS, type BlockCard } from "@/lib/close-kombat";
import { ArcadePanel, ArcadePill, NeonButton } from "@/components/arcade";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CATEGORY_LABELS,
  DEFAULT_KOMBAT_RULES,
  PROOF_CATEGORIES,
  PROOF_LABELS,
  SALE_CATEGORIES,
  companyWritten,
  eligibilityStatus,
  fmtPts,
  liveBlockVolumeDollars,
  mergeKombatRules,
  tierFor,
  totalsFromLedger,
  type KombatBounty,
  type KombatReportRow,
  type KombatRules,
  type LedgerStatus,
  type ProofCategory,
} from "@/lib/kombat-month";
import { KombatMonthAdmin } from "@/components/KombatMonthAdmin";
import { KombatBeltLadder } from "@/components/KombatBeltLadder";
import { KombatPrizeFlyer } from "@/components/KombatPrizeFlyer";
import { KombatScorecard } from "@/components/KombatScorecard";
import { KombatLeaderboard } from "@/components/KombatLeaderboard";
import { KombatBeltUpFx, type BeltUpFx } from "@/components/KombatBeltUpFx";
import { ArenaBackdrop } from "@/components/KombatArena";
import { makeBeeper } from "@/components/intro-fx";
import { refreshKombatLedger } from "@/lib/kombat-month.functions";
import { RepAvatar } from "@/components/RepAvatar";
import { KombatNextFight, type Fighter } from "@/components/KombatNextFight";
import { KombatCartoonAdmin } from "@/components/KombatCartoonAdmin";
import { CanvasserCartoonAdmin } from "@/components/CanvasserCartoonAdmin";
import { KombatKoFlash } from "@/components/KombatKoFlash";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";

const MONDAY_HOST = "https://tidal-remodeling.monday.com";

export type LedgerRow = {
  id: string;
  month: string;
  rep_name: string;
  category: string;
  points: number;
  status: LedgerStatus;
  source_kind: string;
  source_id: string;
  occurred_on: string | null;
  locked_at: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

/** Points threshold of a tier key (0 if unknown) — guards the belt-up test
 *  so a RETUNED ladder (a belt's threshold lowered) can't read as a climb. */
function beltPoints(key: string, rules: KombatRules): number {
  return rules.prizes.tiers.find((t) => t.key === key)?.points ?? 0;
}

async function pageLedger(month: string): Promise<LedgerRow[]> {
  const out: LedgerRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("contest_ledger")
      .select(
        "id, month, rep_name, category, points, status, source_kind, source_id, occurred_on, locked_at, meta, created_at, updated_at",
      )
      .eq("month", month)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as LedgerRow[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export function useKombatRules() {
  return useQuery({
    queryKey: ["contest_rules"],
    queryFn: async (): Promise<KombatRules> => {
      const { data, error } = await supabase.from("contest_rules").select("rules").maybeSingle();
      // Pre-migration (or transient) failure: the defaults keep the tab
      // rendering; writes are gated elsewhere.
      if (error) return DEFAULT_KOMBAT_RULES;
      return mergeKombatRules(data?.rules ?? {});
    },
    staleTime: 60_000,
  });
}

export function KombatMonthTab({
  userId,
  displayName,
  isAdmin,
  isPreview,
}: {
  userId: string | null;
  displayName: string | null;
  isAdmin: boolean;
  isPreview: boolean;
}) {
  const qc = useQueryClient();
  const rulesQuery = useKombatRules();
  const rules = rulesQuery.data ?? DEFAULT_KOMBAT_RULES;
  const month = rules.contest.month;

  const ledgerQuery = useQuery({
    queryKey: ["contest_ledger", month],
    queryFn: () => pageLedger(month),
  });

  const bountiesQuery = useQuery({
    queryKey: ["contest_bounties"],
    queryFn: async (): Promise<KombatBounty[]> => {
      const { data, error } = await supabase
        .from("contest_bounties")
        .select("id, label, categories, multiplier, starts_on, ends_on, active");
      if (error) return [];
      return data as KombatBounty[];
    },
  });

  // Company progress to the unlock: October written volume, SD + OC. The
  // office zeroes a cancelled row's Sale Amt, so the report sum is already net.
  // Live-volume parity (owner 2026-10-02): the report only counts a sale once
  // the monthly Sales Report syncs it, so the bar used to sit a day behind the
  // belt points. We now ADD the block-price dollars of sold cards the report
  // hasn't covered yet — the exact same cards the belt points count live,
  // through the shared Shark Tank pending rule (liveBlockVolumeDollars) — so a
  // sale lands on the team goal the moment it's marked. A report row is still
  // the authority: once it covers a customer the block estimate drops and the
  // book number takes over (no double count).
  const writtenQuery = useQuery({
    queryKey: ["kombat_company_written", month],
    queryFn: async (): Promise<number> => {
      const PAGE = 1000;
      // Report rows: sale_amt for the net written total, plus the fields
      // buildPendingReportCheck (inside liveBlockVolumeDollars) corroborates a
      // card against the book by name/phone AND date or amount — so fetch
      // date_sold + cancel_amt too, matching the server recompute's check.
      const reportRows: KombatReportRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("report_sales")
          .select(
            "sale_amt, cancel_amt, office, customer_name, phone, sales_count, wcc, report_month, date_sold",
          )
          .eq("report_month", month)
          .order("monday_item_id")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        reportRows.push(...((data ?? []) as unknown as KombatReportRow[]));
        if (!data || data.length < PAGE) break;
      }
      const reportTotal = companyWritten(reportRows, month);

      // Sold block cards for the month, same window as the server recompute.
      const monthEnd = nextMonthStartISO(month);
      const cards: BlockCard[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("block_cards")
          .select(CARD_COLUMNS)
          .gte("card_date", month)
          .lt("card_date", monthEnd)
          .order("monday_item_id")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        cards.push(...((data ?? []) as unknown as BlockCard[]));
        if (!data || data.length < PAGE) break;
      }
      const liveBlock = liveBlockVolumeDollars(cards, reportRows, rules);

      return reportTotal + liveBlock;
    },
  });

  useRealtimeInvalidate({
    channel: "kombat-month-live",
    tables: ["contest_ledger", "contest_proofs", "contest_bounties", "contest_rules"],
    invalidateKeys: [
      ["contest_ledger"],
      ["kombat_my_proofs"],
      ["contest_bounties"],
      ["contest_rules"],
      ["kombat_pending_proofs"],
    ],
  });

  // Live for everyone, no admin click (owner 2026-10-02): re-derive the ledger
  // on open and every couple of minutes while the tab is up. The server fn is
  // throttled, so many reps opening the tab collapse to one recompute; the
  // realtime subscription above then fans the fresh rows out to every other
  // open tab. Skipped while View-As browsing — a preview shouldn't drive it.
  useEffect(() => {
    if (isPreview) return;
    let alive = true;
    const tick = () => {
      void refreshKombatLedger()
        .then((r) => {
          if (alive && r.recomputed) {
            void qc.invalidateQueries({ queryKey: ["contest_ledger"] });
            void qc.invalidateQueries({ queryKey: ["kombat_company_written"] });
          }
        })
        .catch(() => {
          /* best-effort — a refresh hiccup must never break the tab */
        });
    };
    tick();
    const id = window.setInterval(tick, 120_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [qc, isPreview]);

  const ledger = useMemo(() => ledgerQuery.data ?? [], [ledgerQuery.data]);
  const totals = useMemo(() => totalsFromLedger(ledger), [ledger]);
  const repNames = useMemo(() => totals.map((t) => t.rep_name), [totals]);
  const matcher = useMemo(() => buildRepMatcher(displayName, repNames), [displayName, repNames]);
  const myTotals = matcher.matched ? totals.find((t) => t.rep_name === matcher.matched) : undefined;
  const myTotal = myTotals?.total ?? 0;
  const tier = tierFor(myTotal, rules);

  // Fighters: approved Street Fighter cartoons keyed by normalized rep name.
  const cartoons = useRepCartoons().data;

  // Your rank + your next opponent: the rep one rank ahead (chasing), or the
  // challenger right below when you're #1 (defending). Feeds YOUR NEXT FIGHT.
  const myRank = matcher.matched ? totals.findIndex((t) => t.rep_name === matcher.matched) + 1 : 0;
  const meFighter: Fighter | null = myTotals
    ? {
        name: myTotals.rep_name,
        total: myTotals.total,
        cartoon: cartoonFor(cartoons, myTotals.rep_name),
      }
    : null;
  const defending = myRank === 1;
  const rivalTotals = myRank >= 2 ? totals[myRank - 2] : myRank === 1 ? totals[1] : undefined;
  const rival: Fighter | null = rivalTotals
    ? {
        name: rivalTotals.rep_name,
        total: rivalTotals.total,
        cartoon: cartoonFor(cartoons, rivalTotals.rep_name),
      }
    : null;

  // K.O. flash the instant YOU climb past whoever was directly ahead.
  const [ko, setKo] = useState<{ seq: number; name: string } | null>(null);
  const koSeqRef = useRef(0);
  const prevRankRef = useRef<number | null>(null);
  const prevAheadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!matcher.matched || myRank <= 0) {
      prevRankRef.current = null;
      prevAheadRef.current = null;
      return;
    }
    const prevRank = prevRankRef.current;
    const prevAhead = prevAheadRef.current;
    if (prevRank !== null && myRank < prevRank && prevAhead) {
      koSeqRef.current += 1;
      setKo({ seq: koSeqRef.current, name: prevAhead.split(/\s+/)[0] || prevAhead });
    }
    prevRankRef.current = myRank;
    prevAheadRef.current = myRank >= 2 ? (totals[myRank - 2]?.rep_name ?? null) : null;
  }, [myRank, matcher.matched, totals]);

  // ── Eligibility (own data; RLS scopes both tables to the viewer) ──
  const purposeQuery = usePurposeProfile(userId ?? undefined);
  const testsQuery = useActivityTests(userId);
  const myLedger = useMemo(
    () => (matcher.matched ? ledger.filter((r) => r.rep_name === matcher.matched) : []),
    [ledger, matcher.matched],
  );
  const eligibility = eligibilityStatus(
    {
      purposeSubmitted: purposeQuery.data?.row?.status === "submitted",
      testDays: (testsQuery.data?.takes ?? []).map((t: { taken_on: string }) => t.taken_on),
      // Points count right away (owner 2026-10-02): any closed deal counts
      // unless it cancels; the month-end window only makes the count final.
      hasCountedSale: myLedger.some(
        (r) =>
          (SALE_CATEGORIES as readonly string[]).includes(r.category) && r.status !== "cancelled",
      ),
    },
    rules,
  );

  // ── Live feed + strike FX ──
  const feed = useMemo(
    () => [...ledger].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 25),
    [ledger],
  );
  const [fx, setFx] = useState<{ seq: number; points: number; rep: string; label: string } | null>(
    null,
  );
  const knownIds = useRef<Map<string, LedgerStatus> | null>(null);
  useEffect(() => {
    if (!ledgerQuery.isSuccess) return;
    const current = new Map(ledger.map((r) => [r.id, r.status]));
    const prev = knownIds.current;
    knownIds.current = current;
    if (prev === null) return; // first settle seeds silently
    let best: LedgerRow | null = null;
    for (const r of ledger) {
      if (prev.has(r.id) || r.status === "cancelled" || r.points <= 0) continue;
      if (!best || r.points > best.points) best = r;
    }
    for (const r of ledger) {
      if (
        r.status === "cancelled" &&
        prev.get(r.id) !== undefined &&
        prev.get(r.id) !== "cancelled"
      ) {
        rewardToast(`−${fmtPts(r.points)} pts — cancelled`, { vibrate: false });
        break;
      }
    }
    if (best) {
      const label = (best.meta?.label as string) ?? CATEGORY_LABELS[best.category] ?? best.category;
      setFx((f) => ({ seq: (f?.seq ?? 0) + 1, points: best!.points, rep: best!.rep_name, label }));
    }
  }, [ledger, ledgerQuery.isSuccess]);

  const written = writtenQuery.data ?? 0;
  const activeBounties = (bountiesQuery.data ?? []).filter(
    (b) => b.active && b.starts_on <= laTodayISO() && b.ends_on >= laTodayISO(),
  );

  // ── Belt-up ceremony ── when MY belt rises, drop the flourish once per
  // belt per device. Baseline in localStorage keyed by uid, seeded on the
  // first settle so an already-earned belt doesn't fire on page open.
  const [beltFx, setBeltFx] = useState<BeltUpFx | null>(null);
  const myTier = tierFor(myTotal, rules).current;
  const beltSeededRef = useRef(false);
  useEffect(() => {
    if (!ledgerQuery.isSuccess || !matcher.matched || !userId) return;
    const key = `ti_kombat_belt:${rules.contest.month}:${userId}`;
    const nowKey = myTier?.key ?? "";
    let prev = "";
    try {
      prev = localStorage.getItem(key) ?? "";
    } catch {
      /* private mode — degrade to in-session */
    }
    if (!beltSeededRef.current) {
      beltSeededRef.current = true;
      if (prev === "") {
        try {
          localStorage.setItem(key, nowKey);
        } catch {
          /* ignore */
        }
        return; // first settle seeds silently
      }
    }
    if (nowKey && nowKey !== prev && (myTier?.points ?? 0) > beltPoints(prev, rules)) {
      try {
        localStorage.setItem(key, nowKey);
      } catch {
        /* ignore */
      }
      setBeltFx((f) => ({
        seq: (f?.seq ?? 0) + 1,
        beltLabel: myTier!.label,
        cash:
          myTier!.cash *
          (written >= rules.prizes.unlock_threshold ? rules.prizes.unlock_multiplier : 1),
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTier?.key, ledgerQuery.isSuccess, matcher.matched, userId, written]);

  const [proofOpen, setProofOpen] = useState(false);
  const [detail, setDetail] = useState<LedgerRow | null>(null);

  if (ledgerQuery.isError) {
    return (
      <ArcadePanel title="Kombat Month" faction="kombat" status="alert">
        <p className="text-sm text-muted-foreground">
          The contest ledger isn't reachable — {String((ledgerQuery.error as Error).message)}
        </p>
      </ArcadePanel>
    );
  }

  return (
    <div className="relative">
      {/* Arena lights — drifting red/gold spotlights behind the whole tab. */}
      <ArenaBackdrop />
      <div className="relative z-10 space-y-4 md:space-y-6">
        {fx && <KombatStrikeFx key={fx.seq} fx={fx} onDone={() => setFx(null)} />}
        {beltFx && (
          <KombatBeltUpFx key={`belt-${beltFx.seq}`} fx={beltFx} onDone={() => setBeltFx(null)} />
        )}
        {ko && <KombatKoFlash key={`ko-${ko.seq}`} name={ko.name} onDone={() => setKo(null)} />}

        {/* Bounty banners */}
        {activeBounties.map((b) => (
          <div
            key={b.id}
            className="arcade-card border-kombat-gold/40 px-4 py-3 text-sm flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span className="font-display text-[10px] uppercase tracking-widest text-kombat-gold">
              Bounty live
            </span>
            <span className="font-semibold">{b.label}</span>
            <span className="text-muted-foreground">
              ×{b.multiplier} · through {b.ends_on}
            </span>
          </div>
        ))}

        {/* Reigning champion spotlight — the #1 fighter, front and center */}
        {totals[0] && (
          <div className="pop-panel relative flex items-center gap-3 overflow-hidden rounded-xl border-2 border-kombat-gold/60 bg-kombat-black px-4 py-3">
            <span aria-hidden className="pop-halftone" />
            <RepAvatar
              name={totals[0].rep_name}
              cartoon={cartoonFor(cartoons, totals[0].rep_name)}
              variant="full"
              rounded="lg"
              className="relative z-10 h-20 w-16 shrink-0"
              textClassName="text-lg"
              ring
            />
            <div className="relative z-10 min-w-0">
              <div className="font-display text-[10px] uppercase tracking-widest text-kombat-gold">
                Reigning champion <span className="kombat-crown">👑</span>
              </div>
              <div className="truncate text-lg font-bold">{totals[0].rep_name}</div>
              <div className="font-mono text-sm tabular-nums text-kombat-gold">
                {fmtPts(totals[0].total)} pts
              </div>
            </div>
          </div>
        )}

        {/* What you're fighting for — the premium prize flyer (live from rules) */}
        <KombatPrizeFlyer rules={rules} />

        {/* ① THE BELT — what you're fighting for + where you stand + the rules */}
        <KombatBeltLadder
          rules={rules}
          loading={ledgerQuery.isPending}
          matched={matcher.matched !== null}
          myTotals={myTotals}
          written={written}
          eligibility={eligibility}
          canSubmit={!!userId && !isPreview}
          onSubmitProof={() => setProofOpen(true)}
          totals={totals}
          cartoons={cartoons}
        />

        {/* YOUR NEXT FIGHT — you vs the rep one rank ahead (or defend at #1) */}
        <KombatNextFight
          matched={matcher.matched !== null}
          me={meFighter}
          rival={rival}
          defending={defending}
        />

        {/* ② THE SCORECARD — exactly what everything is worth */}
        <KombatScorecard rules={rules} />

        {/* ③ EVERYONE — the competition */}
        <KombatLeaderboard
          totals={totals}
          rules={rules}
          matcher={matcher}
          loading={ledgerQuery.isPending}
          cartoons={cartoons}
        />

        {/* Live feed */}
        <ArcadePanel
          title="Fight feed"
          faction="kombat"
          status="good"
          headline={
            <span className="flex items-center gap-1.5 font-display text-[10px] uppercase tracking-widest text-victory">
              <span className="kombat-live-dot inline-block h-1.5 w-1.5 rounded-full bg-victory" />
              Live
            </span>
          }
        >
          {feed.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet — go make it rain.</p>
          ) : (
            <ul className="space-y-1">
              {feed.map((r) => (
                // Only a newly-mounted top row animates in; existing rows just
                // slide down — the feed reads as a live fight ticker.
                <li key={r.id} className="animate-in fade-in slide-in-from-top-2 duration-500">
                  <button
                    type="button"
                    onClick={() => setDetail(r)}
                    className={
                      "w-full min-h-11 md:min-h-9 rounded-md border border-l-2 px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors hover:border-kombat-gold/40 " +
                      (r.status === "cancelled"
                        ? "border-border border-l-destructive/70"
                        : "border-border border-l-victory/70")
                    }
                  >
                    <span
                      className={
                        "w-14 shrink-0 text-right tabular-nums font-semibold " +
                        (r.status === "cancelled" ? "text-destructive" : "text-victory")
                      }
                    >
                      {r.status === "cancelled" ? `−${fmtPts(r.points)}` : `+${fmtPts(r.points)}`}
                    </span>
                    <RepAvatar
                      name={r.rep_name}
                      cartoon={cartoonFor(cartoons, r.rep_name)}
                      className="h-7 w-7"
                      textClassName="text-[0.6rem]"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{r.rep_name}</span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {(r.meta?.label as string) ?? CATEGORY_LABELS[r.category] ?? r.category}
                        {r.status === "cancelled" ? " · cancelled" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {r.occurred_on ?? ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ArcadePanel>

        {/* My ledger */}
        {matcher.matched && <MyLedgerPanel rows={myLedger} onOpen={setDetail} />}

        {/* Admin tools */}
        {isAdmin && !isPreview && (
          <>
            <KombatCartoonAdmin />
            <CanvasserCartoonAdmin />
            <KombatMonthAdmin
              rules={rules}
              totals={totals}
              ledger={ledger}
              written={written}
              bounties={bountiesQuery.data ?? []}
              onChanged={() => {
                void qc.invalidateQueries({ queryKey: ["contest_rules"] });
                void qc.invalidateQueries({ queryKey: ["contest_ledger"] });
                void qc.invalidateQueries({ queryKey: ["contest_bounties"] });
                void qc.invalidateQueries({ queryKey: ["kombat_admin_board"] });
              }}
            />
          </>
        )}

        {userId && (
          <ProofSheet open={proofOpen} onOpenChange={setProofOpen} userId={userId} rules={rules} />
        )}
        <LedgerDetailSheet row={detail} onClose={() => setDetail(null)} />
      </div>
    </div>
  );
}

function MyLedgerPanel({ rows, onOpen }: { rows: LedgerRow[]; onOpen: (r: LedgerRow) => void }) {
  const [openCat, setOpenCat] = useState<string | null>(null);
  const groups = useMemo(() => {
    const by = new Map<string, { rows: LedgerRow[]; locked: number; pending: number }>();
    for (const r of rows) {
      const g = by.get(r.category) ?? { rows: [], locked: 0, pending: 0 };
      g.rows.push(r);
      if (r.status === "locked") g.locked += r.points;
      else if (r.status === "pending") g.pending += r.points;
      by.set(r.category, g);
    }
    return [...by.entries()].sort(
      (a, b) => b[1].locked + b[1].pending - (a[1].locked + a[1].pending),
    );
  }, [rows]);
  return (
    <ArcadePanel title="My ledger" status="good">
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No points yet this month.</p>
      ) : (
        <div className="space-y-1.5">
          {groups.map(([cat, g]) => (
            <div key={cat} className="rounded-md border border-border">
              <button
                type="button"
                onClick={() => setOpenCat((c) => (c === cat ? null : cat))}
                className="w-full min-h-11 md:min-h-9 px-3 py-2 flex items-center gap-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-left font-medium">
                  {CATEGORY_LABELS[cat] ?? cat}
                  <span className="ml-1.5 text-xs text-muted-foreground">×{g.rows.length}</span>
                </span>
                <span className="tabular-nums font-semibold text-victory">
                  {fmtPts(g.locked + g.pending)}
                </span>
              </button>
              {openCat === cat && (
                <ul className="border-t border-border">
                  {g.rows
                    .sort((a, b) => ((a.occurred_on ?? "") < (b.occurred_on ?? "") ? 1 : -1))
                    .map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => onOpen(r)}
                          className="w-full min-h-11 md:min-h-9 px-3 py-2 flex items-center gap-2 text-sm hover:bg-surface"
                        >
                          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
                            {(r.meta?.customer as string) ??
                              (r.meta?.label as string) ??
                              r.source_id}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {r.occurred_on ?? ""}
                          </span>
                          <span
                            className={
                              "w-14 text-right tabular-nums " +
                              // Live and final points read the same — they all
                              // count (owner 2026-10-02); only cancels dim out.
                              (r.status === "cancelled"
                                ? "text-destructive line-through"
                                : "text-victory")
                            }
                          >
                            {fmtPts(r.points)}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </ArcadePanel>
  );
}

function LedgerDetailSheet({ row, onClose }: { row: LedgerRow | null; onClose: () => void }) {
  const meta = (row?.meta ?? {}) as Record<string, unknown>;
  const boardId = meta.board_id as string | undefined;
  const pulseId =
    row?.source_kind === "reload_pitch"
      ? ((meta.parent_item_id as string) ?? null)
      : row?.source_kind === "proof"
        ? null
        : (row?.source_id ?? null);
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="overflow-y-auto pb-safe">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-sm uppercase tracking-widest text-kombat-gold">
                {(meta.label as string) ?? CATEGORY_LABELS[row.category] ?? row.category}
              </SheetTitle>
              <SheetDescription>
                {row.rep_name} · {row.occurred_on ?? "no date"} ·{" "}
                {row.status === "cancelled" ? "cancelled" : row.status}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-2 px-4 pb-6 text-sm">
              <DetailLine
                k="Points"
                v={`${row.status === "cancelled" ? "−" : ""}${fmtPts(row.points)}`}
              />
              {typeof meta.customer === "string" && meta.customer && (
                <DetailLine k="Customer" v={meta.customer} />
              )}
              {typeof meta.office === "string" && meta.office && (
                <DetailLine k="Office" v={meta.office} />
              )}
              {typeof meta.card_points === "number" &&
                typeof meta.rep_count === "number" &&
                meta.rep_count > 1 && (
                  <DetailLine
                    k="Split"
                    v={`${fmtPts(meta.card_points as number)} card pts ÷ ${meta.rep_count} reps`}
                  />
                )}
              {typeof meta.bounty_multiplier === "number" && (
                <DetailLine k="Bounty" v={`×${meta.bounty_multiplier}`} />
              )}
              {typeof meta.note === "string" && meta.note && <DetailLine k="Note" v={meta.note} />}
              {typeof meta.cap_note === "string" && <DetailLine k="Cap" v={meta.cap_note} />}
              {row.locked_at && (
                <DetailLine k="Locked" v={new Date(row.locked_at).toLocaleString()} />
              )}
              {typeof meta.link_url === "string" && (
                <a
                  href={meta.link_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-neon underline underline-offset-2"
                >
                  Open link
                </a>
              )}
              {boardId && pulseId && (
                <a
                  href={`${MONDAY_HOST}/boards/${boardId}/pulses/${pulseId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-neon underline underline-offset-2"
                >
                  Open the Monday card
                </a>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailLine({ k, v }: { k: string; v: string }) {
  return (
    <p className="flex gap-3">
      <span className="w-20 shrink-0 text-[10px] font-display uppercase tracking-widest text-muted-foreground pt-0.5">
        {k}
      </span>
      <span className="min-w-0">{v}</span>
    </p>
  );
}

// ── Proof submission sheet (camera-friendly on iPhone) ───────────────────

const PROOF_HINTS: Record<ProofCategory, string> = {
  testimonial: "Short customer video saying what we did for them.",
  google_review: "Screenshot of the review that names you, plus the link.",
  referral_sit: "Who referred who — customer name and the date the referral sat.",
  before_after: "Both shots in one upload (collage or video walkthrough).",
  role_play: "Record a pitch or objection run — same as the Dojo.",
  gym_checkin: "Photo at the gym. One a day counts.",
};

function ProofSheet({
  open,
  onOpenChange,
  userId,
  rules,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: string;
  rules: KombatRules;
}) {
  const qc = useQueryClient();
  const [category, setCategory] = useState<ProofCategory>("testimonial");
  const [note, setNote] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [customer, setCustomer] = useState("");
  const [satOn, setSatOn] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const myProofs = useQuery({
    queryKey: ["kombat_my_proofs", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contest_proofs")
        .select("id, category, status, points_awarded, note, deny_reason, created_at")
        .eq("rep_id", userId)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: open,
  });

  const reset = () => {
    setNote("");
    setLinkUrl("");
    setCustomer("");
    setSatOn("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Add a photo or video — every proof needs one.");
      if (note.trim() === "") throw new Error("Add a note — the approver reads it.");
      if (category === "google_review" && linkUrl.trim() === "") {
        throw new Error("Paste the review link.");
      }
      if (category === "referral_sit" && (customer.trim() === "" || satOn === "")) {
        throw new Error("Referral proofs need the customer name and the date they sat.");
      }
      if (file.size > 200 * 1024 * 1024) throw new Error("Keep uploads under 200MB.");
      const ext = (file.name.split(".").pop() || (file.type.startsWith("video/") ? "mp4" : "jpg"))
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("contest-proofs")
        .upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (upErr) throw new Error(upErr.message);
      const { error } = await supabase.from("contest_proofs").insert({
        rep_id: userId,
        category,
        storage_path: path,
        note: note.trim(),
        link_url: linkUrl.trim() === "" ? null : linkUrl.trim(),
        customer_name: customer.trim() === "" ? null : customer.trim(),
        sat_on: satOn === "" ? null : satOn,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      rewardToast("Proof submitted — your manager will review it.");
      reset();
      void qc.invalidateQueries({ queryKey: ["kombat_my_proofs"] });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-h-[90dvh] overflow-y-auto pb-safe">
        <SheetHeader>
          <SheetTitle className="font-display text-sm uppercase tracking-widest text-kombat-gold">
            Submit proof
          </SheetTitle>
          <SheetDescription>
            Photo or video + a note. Owner/Manager approval mints the points (up to{" "}
            {rules.proofs.caps.total_per_month}/month from proofs).
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <div className="flex flex-wrap gap-1.5">
            {PROOF_CATEGORIES.map((c) => (
              <ArcadePill
                key={c}
                tone="kombat-gold"
                active={category === c}
                onClick={() => setCategory(c)}
              >
                {PROOF_LABELS[c]} · {rules.proofs.weights[c]} pt
                {rules.proofs.weights[c] === 1 ? "" : "s"}
              </ArcadePill>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{PROOF_HINTS[category]}</p>

          <div className="space-y-1.5">
            <Label htmlFor="kombat-proof-file">Photo / video</Label>
            <Input
              id="kombat-proof-file"
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              className="min-h-11 md:min-h-9 text-base md:text-xs"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>

          {category === "google_review" && (
            <div className="space-y-1.5">
              <Label htmlFor="kombat-proof-link">Review link</Label>
              <Input
                id="kombat-proof-link"
                inputMode="url"
                placeholder="https://g.co/…"
                className="min-h-11 md:min-h-9 text-base md:text-xs"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
              />
            </div>
          )}
          {category === "referral_sit" && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="kombat-proof-customer">Customer name</Label>
                <Input
                  id="kombat-proof-customer"
                  className="min-h-11 md:min-h-9 text-base md:text-xs"
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="kombat-proof-saton">Date sat</Label>
                <Input
                  id="kombat-proof-saton"
                  type="date"
                  className="min-h-11 md:min-h-9 text-base md:text-xs"
                  value={satOn}
                  onChange={(e) => setSatOn(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="kombat-proof-note">Note for the approver</Label>
            <Textarea
              id="kombat-proof-note"
              className="text-base md:text-xs"
              rows={3}
              placeholder="What is this, who's in it, where did it happen…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {submit.isError && (
            <p className="text-sm text-destructive">{(submit.error as Error).message}</p>
          )}
          <NeonButton
            tone="kombat-gold"
            className="w-full min-h-11"
            disabled={submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Uploading…" : "Send for approval"}
          </NeonButton>

          {(myProofs.data ?? []).length > 0 && (
            <div className="space-y-1.5 pt-2">
              <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                My submissions
              </p>
              <ul className="space-y-1">
                {(myProofs.data ?? []).map((p) => (
                  <li
                    key={p.id}
                    className="rounded-md border border-border px-3 py-2 text-sm flex items-center gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {PROOF_LABELS[p.category as ProofCategory] ?? p.category}
                      {p.status === "denied" && p.deny_reason && (
                        <span className="block text-xs text-destructive truncate">
                          Coach says: {p.deny_reason}
                        </span>
                      )}
                    </span>
                    <span
                      className={
                        "shrink-0 text-[10px] font-display uppercase tracking-widest " +
                        (p.status === "approved"
                          ? "text-victory"
                          : p.status === "denied"
                            ? "text-destructive"
                            : "text-muted-foreground")
                      }
                    >
                      {p.status === "approved" ? `+${fmtPts(p.points_awarded ?? 0)}` : p.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Strike FX: the SaleVictoryFx discipline in a feed-sized burst ────────
// Ref-latched finish (welcome-animation doctrine): parent re-renders from
// realtime refetches must never restart or orphan the overlay; every exit
// path funnels through one latched finish() that fires onDone exactly once.

function KombatStrikeFx({
  fx,
  onDone,
}: {
  fx: { points: number; rep: string; label: string };
  onDone: () => void;
}) {
  const onDoneRef = useRef(onDone);
  const fxRef = useRef(fx);
  useEffect(() => {
    onDoneRef.current = onDone;
    fxRef.current = fx;
  });
  const doneRef = useRef(false);
  const finish = useRef(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  }).current;

  useEffect(() => {
    const snap = fxRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rewardToast(`+${fmtPts(snap.points)} pts — ${snap.rep}`, {
      vibrate: reduced ? false : undefined,
    });
    if (reduced) {
      finish();
      return;
    }
    // Arcade coin + ka-ching the instant points land. Best-effort: the shared
    // AudioContext starts suspended on iOS and makeBeeper arms its own
    // one-time tap-to-unlock, so the very first hit may be silent until the
    // next tap — never throws, never blocks the visuals.
    const beep = makeBeeper();
    beep(880, 70, 0, "square"); // coin
    beep(1175, 90, 70, "square"); // coin, up a fourth
    beep(1568, 230, 160, "triangle"); // ka-ching shimmer tail
    if (snap.points >= 10) beep(2093, 190, 300, "triangle"); // big-hit sparkle
    let confettiCancelled = false;
    void import("canvas-confetti").then(({ default: confetti }) => {
      if (confettiCancelled) return;
      const GOLD = ["#f5c518", "#ffd24a", "#df2f4a", "#ffffff"];
      // A coin shape when the browser supports shapeFromText (confetti v1.9+);
      // gold discs otherwise. Garnish only — never let confetti throw.
      let coin: ReturnType<typeof confetti.shapeFromText> | undefined;
      try {
        coin = confetti.shapeFromText?.({ text: "🪙", scalar: 2 });
      } catch {
        coin = undefined;
      }
      // Punchy burst up from the hero…
      void confetti({
        particleCount: 90,
        spread: 78,
        startVelocity: 45,
        origin: { y: 0.7 },
        colors: GOLD,
        disableForReducedMotion: true,
      });
      // …then make it rain: coins tumbling down across the top.
      void confetti({
        particleCount: 50,
        spread: 120,
        startVelocity: 18,
        gravity: 0.9,
        ticks: 180,
        scalar: coin ? 1.6 : 1.1,
        origin: { y: -0.1 },
        colors: GOLD,
        shapes: coin ? [coin] : undefined,
        disableForReducedMotion: true,
      });
    });
    const t = window.setTimeout(finish, 2200);
    return () => {
      confettiCancelled = true;
      window.clearTimeout(t);
    };
  }, [finish]);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  return createPortal(
    <button
      type="button"
      aria-label="Dismiss"
      onClick={finish}
      className="fixed inset-0 z-[10030] flex items-center justify-center bg-transparent pointer-events-auto"
    >
      <span className="animate-in zoom-in-95 fade-in slide-in-from-bottom-2 duration-300 rounded-2xl border-2 border-kombat-gold/70 bg-kombat-black px-8 py-5 text-center shadow-[0_0_60px_-6px_var(--kombat-gold)]">
        <span className="block font-display text-[10px] uppercase tracking-[0.3em] text-kombat-red">
          Points scored
        </span>
        <span className="kombat-score-flare mt-1 block font-display text-kombat-gold tabular-nums leading-none">
          <span className="text-4xl">+{fmtPts(fx.points)}</span>
          <span className="ml-1 text-lg">PTS</span>
        </span>
        <span className="mt-2 block text-sm font-semibold">{fx.rep}</span>
        <span className="block text-xs text-muted-foreground">{fx.label}</span>
      </span>
    </button>,
    document.body,
  );
}
