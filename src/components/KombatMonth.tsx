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
import { laTodayISO } from "@/lib/dates";
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
  eligibilityStatus,
  fmtPts,
  mergeKombatRules,
  tierFor,
  totalsFromLedger,
  type KombatBounty,
  type KombatRules,
  type LedgerStatus,
  type ProofCategory,
} from "@/lib/kombat-month";
import { KombatMonthAdmin } from "@/components/KombatMonthAdmin";
import { KombatBeltLadder } from "@/components/KombatBeltLadder";
import { KombatScorecard } from "@/components/KombatScorecard";
import { KombatLeaderboard } from "@/components/KombatLeaderboard";
import { KombatBeltUpFx, type BeltUpFx } from "@/components/KombatBeltUpFx";

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
  // office zeroes a cancelled row's Sale Amt, so the sum is already net.
  const writtenQuery = useQuery({
    queryKey: ["kombat_company_written", month],
    queryFn: async (): Promise<number> => {
      let total = 0;
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("report_sales")
          .select("sale_amt")
          .eq("report_month", month)
          .order("monday_item_id")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        total += (data ?? []).reduce((s, r) => s + (r.sale_amt ?? 0), 0);
        if (!data || data.length < PAGE) break;
      }
      return total;
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

  const ledger = useMemo(() => ledgerQuery.data ?? [], [ledgerQuery.data]);
  const totals = useMemo(() => totalsFromLedger(ledger), [ledger]);
  const repNames = useMemo(() => totals.map((t) => t.rep_name), [totals]);
  const matcher = useMemo(() => buildRepMatcher(displayName, repNames), [displayName, repNames]);
  const myTotals = matcher.matched ? totals.find((t) => t.rep_name === matcher.matched) : undefined;
  const myTotal = myTotals?.total ?? 0;
  const tier = tierFor(myTotal, rules);

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
    <div className="space-y-4 md:space-y-6">
      {fx && <KombatStrikeFx key={fx.seq} fx={fx} onDone={() => setFx(null)} />}
      {beltFx && (
        <KombatBeltUpFx key={`belt-${beltFx.seq}`} fx={beltFx} onDone={() => setBeltFx(null)} />
      )}

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
      />

      {/* ② THE SCORECARD — exactly what everything is worth */}
      <KombatScorecard rules={rules} />

      {/* ③ EVERYONE — the competition */}
      <KombatLeaderboard
        totals={totals}
        rules={rules}
        matcher={matcher}
        loading={ledgerQuery.isPending}
      />

      {/* Live feed */}
      <ArcadePanel title="Points feed" status="good">
        {feed.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet — go make it rain.</p>
        ) : (
          <ul className="space-y-1">
            {feed.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setDetail(r)}
                  className="w-full min-h-11 md:min-h-9 rounded-md border border-border px-3 py-2 text-left text-sm flex items-center gap-2 hover:border-kombat-gold/40"
                >
                  <span
                    className={
                      "w-14 shrink-0 text-right tabular-nums font-semibold " +
                      (r.status === "cancelled" ? "text-destructive" : "text-victory")
                    }
                  >
                    {r.status === "cancelled" ? `−${fmtPts(r.points)}` : `+${fmtPts(r.points)}`}
                  </span>
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
      )}

      {userId && (
        <ProofSheet open={proofOpen} onOpenChange={setProofOpen} userId={userId} rules={rules} />
      )}
      <LedgerDetailSheet row={detail} onClose={() => setDetail(null)} />
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
    let confettiCancelled = false;
    void import("canvas-confetti").then(({ default: confetti }) => {
      if (confettiCancelled) return;
      void confetti({
        particleCount: 60,
        spread: 70,
        origin: { y: 0.7 },
        colors: ["#f5c518", "#df2f4a", "#ffffff"],
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
      <span className="animate-in zoom-in-50 fade-in duration-300 rounded-xl border border-kombat-gold/60 bg-background/95 px-6 py-4 text-center shadow-[0_0_40px_-8px_var(--kombat-gold)]">
        <span className="block font-display text-2xl text-kombat-gold tabular-nums">
          +{fmtPts(fx.points)} PTS
        </span>
        <span className="mt-1 block text-sm font-semibold">{fx.rep}</span>
        <span className="block text-xs text-muted-foreground">{fx.label}</span>
      </span>
    </button>,
    document.body,
  );
}
