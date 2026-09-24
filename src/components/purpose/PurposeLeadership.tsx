// §19 — Purpose Leadership home: the owner-only coaching command center.
// Summary cards, the launch control, the crisis strip, and the full rep
// table (desktop table + MobileCardList twin from the SAME precomputed
// rows). Renders inside `.purpose-surface` — calm navy, never arcade neon;
// red exists ONLY on the safety-flag strip.

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Telescope } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LeadershipStatus, Option } from "@/lib/purpose/types";
import {
  usePurposeLeadershipList,
  type LeadershipListRow,
} from "@/hooks/usePurposeLeadership";
import { usePurposeConfig, useSavePurposeConfig } from "@/hooks/usePurposeConfig";
import { useWeekCrmByName } from "@/hooks/usePurposeScoreboard";
import type { PurposeProfileRow } from "@/hooks/usePurposeTable";
import {
  CONSTRAINT_LABELS,
  CORE_VALUE_CHIPS,
  LIFE_AREA_LABELS,
  PRO_FOCUS_OPTIONS,
  SUPPORT_REQUEST_OPTIONS,
} from "@/data/purpose-workshop-content";
import { PurposeButton, PurposeCard, PurposeChip, PurposeLabel } from "./kit";
import { HowToUseThisWell } from "./HowToUseThisWell";
import {
  MobileCard,
  MobileCardHeader,
  MobileCardList,
  MobileStat,
  MobileStatGrid,
} from "@/components/arcade";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Shared display helpers (PurposeRepProfile / PurposeLeadershipActions import
// these — keep them here so the three leadership surfaces can't drift).
// ---------------------------------------------------------------------------

export const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const humanize = (slug: string) => slug.replace(/_/g, " ");

/** Works for both date-only strings (leadership_follow_up_date) and full
 *  timestamps (last_reviewed_at) — date-only gets a local-midnight anchor so
 *  it never shifts a day. */
export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const optionLabel = (opts: readonly Option[], slug: string | null | undefined) =>
  slug ? (opts.find((o) => o.value === slug)?.label ?? humanize(slug)) : null;

export const lifeAreaLabel = (slug: string | null | undefined) =>
  slug ? ((LIFE_AREA_LABELS as Record<string, string>)[slug] ?? humanize(slug)) : null;

export const constraintLabel = (slug: string | null | undefined) =>
  slug ? ((CONSTRAINT_LABELS as Record<string, string>)[slug] ?? humanize(slug)) : null;

export type RepCompletion = "not_started" | "in_progress" | "submitted";

export const completionOf = (profile: PurposeProfileRow | null): RepCompletion => {
  if (!profile || profile.status === "not_started") return "not_started";
  return profile.status === "submitted" ? "submitted" : "in_progress";
};

export const COMPLETION_LABELS: Record<RepCompletion, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
};

export const LEADERSHIP_STATUS_LABELS: Record<LeadershipStatus, string> = {
  needs_review: "Needs Review",
  follow_up_set: "Follow-up Set",
  discussed: "Discussed",
  ongoing: "Ongoing",
};

export function PurposeStatusPill({ completion }: { completion: RepCompletion }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs",
        completion === "submitted" && "border-[var(--purpose-tide)] text-[var(--purpose-tide)]",
        completion === "in_progress" && "border-[var(--purpose-sand)] text-[var(--purpose-sand)]",
        completion === "not_started" &&
          "border-[var(--purpose-line)] text-[var(--purpose-ink-dim)]",
      )}
    >
      {COMPLETION_LABELS[completion]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Local pieces
// ---------------------------------------------------------------------------

const LIFE_AREA_FILTER_OPTIONS: Option[] = Object.entries(LIFE_AREA_LABELS).map(
  ([value, label]) => ({ value, label }),
);
const CONSTRAINT_FILTER_OPTIONS: Option[] = Object.entries(CONSTRAINT_LABELS).map(
  ([value, label]) => ({ value, label }),
);

type CompletionFilter = "all" | RepCompletion;
type FollowUpFilter = "any" | "scheduled" | "overdue" | "none";
type SortKey = "name" | "status" | "target_date" | "follow_up" | "last_reviewed" | "week_volume";

const STATUS_CHIPS: { value: CompletionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "submitted", label: "Submitted" },
];

const FOLLOW_UP_CHIPS: { value: FollowUpFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "scheduled", label: "Scheduled" },
  { value: "overdue", label: "Overdue" },
  { value: "none", label: "None" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "target_date", label: "Target date" },
  { value: "follow_up", label: "Follow-up date" },
  { value: "last_reviewed", label: "Last reviewed" },
  { value: "week_volume", label: "This week's volume" },
];

/** Small stat tile for the §19.1 summary grid. */
function SummaryTile({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--purpose-line)] bg-[var(--purpose-card)] p-3">
      <div
        className={cn(
          "tabular-nums",
          small ? "text-sm font-medium leading-snug" : "text-lg font-semibold leading-tight",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--purpose-ink-dim)]">
        {label}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly Option[];
}) {
  return (
    <div className="min-w-0">
      <PurposeLabel>{label}</PurposeLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="mt-1 min-h-11 w-full border-[var(--purpose-line)] bg-transparent text-left text-sm text-[var(--purpose-ink)]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value="all">All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Structured-category mode — never free text (spec §19.1). */
function modeOf(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** One precomputed row that feeds BOTH the desktop table and the mobile
 *  card twin — the house rule: same rows, two renderings. */
type DisplayRow = {
  userId: string;
  name: string;
  completion: RepCompletion;
  leadershipStatus: string | null;
  target: string | null;
  targetDate: string | null;
  lifeArea: string | null;
  coreWhy: string | null;
  barrier: string | null;
  proFocus: string | null;
  ceiling: number | null;
  weekSold: number | null;
  weekVolume: number | null;
  followUp: string | null;
  lastReviewed: string | null;
};

const statusRank: Record<RepCompletion, number> = {
  submitted: 0,
  in_progress: 1,
  not_started: 2,
};

export function PurposeLeadership() {
  const list = usePurposeLeadershipList(true);
  const configQuery = usePurposeConfig(true);
  // §19.2's CRM summary column: one aggregation over the shared block_cards
  // fetch, matched per roster name — a dash where the matcher can't place
  // someone, never a fabricated zero.
  const rosterNames = useMemo(
    () => (list.data?.rows ?? []).map((r) => r.rep.displayName),
    [list.data],
  );
  const weekCrm = useWeekCrmByName(rosterNames, true);
  const saveConfig = useSavePurposeConfig();

  const [showTest, setShowTest] = useState(false);
  const [confirming, setConfirming] = useState<null | "open" | "close">(null);
  const [statusFilter, setStatusFilter] = useState<CompletionFilter>("all");
  const [followFilter, setFollowFilter] = useState<FollowUpFilter>("any");
  const [moreOpen, setMoreOpen] = useState(false);
  const [lifeAreaFilter, setLifeAreaFilter] = useState("all");
  const [proFocusFilter, setProFocusFilter] = useState("all");
  const [beliefFilter, setBeliefFilter] = useState("all");
  const [coreValueFilter, setCoreValueFilter] = useState("all");
  const [supportFilter, setSupportFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");

  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const missingMigration = list.data?.missingMigration ?? false;
  const today = todayISO();

  // Owner rows are Tyler's and Shai's own walkthroughs — test profiles,
  // hidden from the table AND the aggregate counts unless revealed.
  const visible = useMemo(
    () => (showTest ? rows : rows.filter((r) => !r.rep.isOwner)),
    [rows, showTest],
  );

  const flagged = useMemo(() => visible.filter((r) => r.openSafetyFlag), [visible]);

  const stats = useMemo(() => {
    const completions = visible.map((r) => completionOf(r.profile));
    const proFocusMode = modeOf(visible.map((r) => r.goals["professional_focus"]?.life_area));
    const beliefMode = modeOf(visible.map((r) => r.beliefs?.primary_constraint_category));
    const supportMode = modeOf(visible.flatMap((r) => r.supportRequest));
    return {
      eligible: rows.filter((r) => !r.rep.isOwner).length,
      notStarted: completions.filter((c) => c === "not_started").length,
      inProgress: completions.filter((c) => c === "in_progress").length,
      submitted: completions.filter((c) => c === "submitted").length,
      needsReview: visible.filter((r) => r.profile?.leadership_status === "needs_review").length,
      followUpScheduled: visible.filter(
        (r) =>
          r.profile?.leadership_follow_up_date && r.profile.leadership_follow_up_date >= today,
      ).length,
      followUpOverdue: visible.filter(
        (r) => r.profile?.leadership_follow_up_date && r.profile.leadership_follow_up_date < today,
      ).length,
      proFocusMode: optionLabel(PRO_FOCUS_OPTIONS, proFocusMode) ?? "—",
      beliefMode: constraintLabel(beliefMode) ?? "—",
      supportMode: optionLabel(SUPPORT_REQUEST_OPTIONS, supportMode) ?? "—",
    };
  }, [visible, rows, today]);

  const display = useMemo(() => {
    const passes = (r: LeadershipListRow) => {
      const completion = completionOf(r.profile);
      if (statusFilter !== "all" && completion !== statusFilter) return false;
      const fu = r.profile?.leadership_follow_up_date ?? null;
      if (followFilter === "scheduled" && !(fu && fu >= today)) return false;
      if (followFilter === "overdue" && !(fu && fu < today)) return false;
      if (followFilter === "none" && fu) return false;
      if (lifeAreaFilter !== "all" && r.lifeAreas[0] !== lifeAreaFilter) return false;
      if (proFocusFilter !== "all" && r.goals["professional_focus"]?.life_area !== proFocusFilter)
        return false;
      if (beliefFilter !== "all" && r.beliefs?.primary_constraint_category !== beliefFilter)
        return false;
      if (coreValueFilter !== "all" && !r.coreValues.includes(coreValueFilter)) return false;
      if (supportFilter !== "all" && !r.supportRequest.includes(supportFilter)) return false;
      return true;
    };

    const out: DisplayRow[] = visible.filter(passes).map((r) => {
      const target = r.goals["target_1_year"] ?? null;
      const proFocus = r.goals["professional_focus"] ?? null;
      return {
        userId: r.rep.userId,
        name: r.rep.displayName,
        completion: completionOf(r.profile),
        leadershipStatus: r.profile?.leadership_status
          ? LEADERSHIP_STATUS_LABELS[r.profile.leadership_status]
          : null,
        target: target?.goal_description ?? null,
        targetDate: target?.target_date ?? null,
        lifeArea: lifeAreaLabel(r.lifeAreas[0] ?? null),
        coreWhy:
          r.coreValues.length > 0
            ? r.coreValues.map((v) => optionLabel(CORE_VALUE_CHIPS, v)).join(", ")
            : null,
        barrier: constraintLabel(r.beliefs?.primary_constraint_category ?? null),
        proFocus: optionLabel(PRO_FOCUS_OPTIONS, proFocus?.life_area ?? null),
        ceiling: r.beliefs?.current_ceiling_amount ?? null,
        weekSold: weekCrm?.get(r.rep.displayName)?.sold ?? null,
        weekVolume: weekCrm?.get(r.rep.displayName)?.revenue ?? null,
        followUp: r.profile?.leadership_follow_up_date ?? null,
        lastReviewed: r.profile?.last_reviewed_at ?? null,
      };
    });

    const cmpNullableAsc = (a: string | null, b: string | null, nullsLast = true) => {
      if (a === b) return 0;
      if (a === null) return nullsLast ? 1 : -1;
      if (b === null) return nullsLast ? -1 : 1;
      return a < b ? -1 : 1;
    };
    out.sort((a, b) => {
      let c = 0;
      if (sortKey === "status") c = statusRank[a.completion] - statusRank[b.completion];
      else if (sortKey === "target_date") c = cmpNullableAsc(a.targetDate, b.targetDate);
      else if (sortKey === "follow_up") c = cmpNullableAsc(a.followUp, b.followUp);
      // never-reviewed first — they're the ones waiting on you
      else if (sortKey === "last_reviewed") c = cmpNullableAsc(a.lastReviewed, b.lastReviewed, false);
      else if (sortKey === "week_volume") c = (b.weekVolume ?? -1) - (a.weekVolume ?? -1);
      return c !== 0 ? c : a.name.localeCompare(b.name);
    });
    return out;
  }, [
    visible,
    statusFilter,
    followFilter,
    lifeAreaFilter,
    proFocusFilter,
    beliefFilter,
    coreValueFilter,
    supportFilter,
    sortKey,
    today,
    weekCrm,
  ]);

  const config = configQuery.data;
  const confirmingOpen = confirming === "open";

  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full min-w-0 max-w-6xl px-4 pt-safe pb-16">
        {/* Header */}
        <div className="flex items-center gap-3 pt-7">
          <Telescope className="size-6 text-[var(--purpose-tide)]" aria-hidden />
          <h1 className="text-2xl">Purpose Leadership</h1>
        </div>
        <p className="mt-1 text-sm text-[var(--purpose-ink-dim)]">
          A coaching command center — every rep's direction and why.
        </p>

        {/* Crisis strip — the ONLY red on this page. */}
        {flagged.length > 0 && (
          <div className="mt-6 rounded-xl border border-red-500/70 bg-red-500/10 px-4 py-3">
            <p className="text-sm leading-relaxed text-red-200">
              A safety flag is open for{" "}
              {flagged.map((r, i) => (
                <span key={r.rep.userId}>
                  {i > 0 && ", "}
                  <Link
                    to="/purpose-leadership/$userId"
                    params={{ userId: r.rep.userId }}
                    className="font-medium underline underline-offset-2"
                  >
                    {r.rep.displayName}
                  </Link>
                </span>
              ))}
              . Check in personally today.
            </p>
          </div>
        )}

        {/* Launch control */}
        {config && !config.sales_rep_feature_enabled && (
          <PurposeCard className="mt-6">
            <h2 className="text-lg">My Purpose is not open to the sales team yet</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
              Reps don't see the My Purpose tab until you open it. You and Tyler can walk the
              workshop yourselves from the menu first — your own runs show up here as test
              profiles, not in the rep counts.
            </p>
            <div className="mt-4">
              <PurposeButton onClick={() => setConfirming("open")}>Open to sales team</PurposeButton>
            </div>
          </PurposeCard>
        )}
        {config?.sales_rep_feature_enabled && (
          <div className="mt-6 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[var(--purpose-line)] px-4 py-2">
            <p className="flex items-center gap-2 text-sm text-[var(--purpose-ink-dim)]">
              <span className="inline-block size-1.5 rounded-full bg-[var(--purpose-tide)]" aria-hidden />
              Live for the sales team
            </p>
            <PurposeButton tone="quiet" className="px-2 text-sm" onClick={() => setConfirming("close")}>
              Close it
            </PurposeButton>
          </div>
        )}

        <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
          {/* purpose-surface on the portal'd content so the kit's CSS vars
              resolve outside the page's scope div. */}
          <DialogContent className="purpose-surface border-[var(--purpose-line)]">
            <DialogHeader>
              <DialogTitle className="text-[var(--purpose-ink)]">
                {confirmingOpen
                  ? "Open My Purpose to the sales team?"
                  : "Close My Purpose to the sales team?"}
              </DialogTitle>
              <DialogDescription className="text-[var(--purpose-ink-dim)]">
                {confirmingOpen
                  ? "Every sales rep's app gains the My Purpose tab on their next open."
                  : "Reps lose the My Purpose tab until you open it again. Their saved answers are untouched."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <PurposeButton tone="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </PurposeButton>
              <PurposeButton
                disabled={saveConfig.isPending}
                onClick={() =>
                  saveConfig.mutate(
                    confirmingOpen
                      ? { sales_rep_feature_enabled: true, workshop_launch_mode: "live" }
                      : { sales_rep_feature_enabled: false, workshop_launch_mode: "pre_launch" },
                    { onSuccess: () => setConfirming(null) },
                  )
                }
              >
                {confirmingOpen ? "Open to sales team" : "Close it"}
              </PurposeButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="mt-6">
          <HowToUseThisWell />
        </div>

        {missingMigration ? (
          <PurposeCard className="mt-6">
            <p className="text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
              The My Purpose tables aren't in the database yet — run the migration first.
            </p>
          </PurposeCard>
        ) : list.isLoading ? (
          <p className="mt-8 text-sm text-[var(--purpose-ink-dim)]">Loading the roster…</p>
        ) : (
          <>
            {/* §19.1 summary cards — structured categories only, never free text. */}
            <div className="mt-6 grid grid-cols-2 gap-2 md:grid-cols-5">
              <SummaryTile label="Sales reps eligible" value={stats.eligible} />
              <SummaryTile label="Not started" value={stats.notStarted} />
              <SummaryTile label="In progress" value={stats.inProgress} />
              <SummaryTile label="Submitted" value={stats.submitted} />
              <SummaryTile label="Needs review" value={stats.needsReview} />
              <SummaryTile label="Follow-up scheduled" value={stats.followUpScheduled} />
              <SummaryTile label="Follow-up overdue" value={stats.followUpOverdue} />
              <SummaryTile label="Top professional focus" value={stats.proFocusMode} small />
              <SummaryTile label="Top limiting belief" value={stats.beliefMode} small />
              <SummaryTile label="Top support request" value={stats.supportMode} small />
            </div>

            {/* Filters */}
            <div className="mt-6 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <PurposeLabel className="mr-1 w-20 shrink-0">Status</PurposeLabel>
                {STATUS_CHIPS.map((c) => (
                  <PurposeChip
                    key={c.value}
                    selected={statusFilter === c.value}
                    onClick={() => setStatusFilter(c.value)}
                  >
                    {c.label}
                  </PurposeChip>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PurposeLabel className="mr-1 w-20 shrink-0">Follow-up</PurposeLabel>
                {FOLLOW_UP_CHIPS.map((c) => (
                  <PurposeChip
                    key={c.value}
                    selected={followFilter === c.value}
                    onClick={() => setFollowFilter(c.value)}
                  >
                    {c.label}
                  </PurposeChip>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                className="inline-flex min-h-11 items-center gap-1 text-sm text-[var(--purpose-ink-dim)] transition-colors hover:text-[var(--purpose-ink)]"
              >
                <ChevronDown
                  className={cn("size-4 transition-transform", moreOpen && "rotate-180")}
                  aria-hidden
                />
                More filters
              </button>
              {moreOpen && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <FilterSelect
                    label="Primary life area"
                    value={lifeAreaFilter}
                    onChange={setLifeAreaFilter}
                    options={LIFE_AREA_FILTER_OPTIONS}
                  />
                  <FilterSelect
                    label="Professional focus"
                    value={proFocusFilter}
                    onChange={setProFocusFilter}
                    options={PRO_FOCUS_OPTIONS}
                  />
                  <FilterSelect
                    label="Limiting belief"
                    value={beliefFilter}
                    onChange={setBeliefFilter}
                    options={CONSTRAINT_FILTER_OPTIONS}
                  />
                  <FilterSelect
                    label="Core value"
                    value={coreValueFilter}
                    onChange={setCoreValueFilter}
                    options={CORE_VALUE_CHIPS}
                  />
                  <FilterSelect
                    label="Support request"
                    value={supportFilter}
                    onChange={setSupportFilter}
                    options={SUPPORT_REQUEST_OPTIONS}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <PurposeLabel>Sort</PurposeLabel>
                  <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
                    <SelectTrigger className="min-h-11 w-44 border-[var(--purpose-line)] bg-transparent text-sm text-[var(--purpose-ink)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SORT_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="inline-flex min-h-11 select-none items-center gap-2 text-sm text-[var(--purpose-ink-dim)]">
                  <input
                    type="checkbox"
                    checked={showTest}
                    onChange={(e) => setShowTest(e.target.checked)}
                    className="size-4 accent-[var(--purpose-tide)]"
                  />
                  Show test profiles
                </label>
              </div>
            </div>

            {/* §19.2 rep table — desktop markup + mobile card twin, SAME rows. */}
            {display.length === 0 ? (
              <p className="mt-8 text-sm text-[var(--purpose-ink-dim)]">
                No reps match these filters.
              </p>
            ) : (
              <>
                <div className="mt-6 hidden min-w-0 md:block">
                  <div className="min-w-0 overflow-x-auto rounded-xl border border-[var(--purpose-line)]">
                    <table className="w-full min-w-[1100px] text-sm">
                      <thead>
                        <tr className="border-b border-[var(--purpose-line)] text-left">
                          {[
                            "Rep",
                            "Status",
                            "This week",
                            "One-year target",
                            "Target date",
                            "Primary life area",
                            "Core Why",
                            "Barrier / focus",
                            "Ceiling",
                            "Follow-up",
                            "Last reviewed",
                            "",
                          ].map((h, i) => (
                            <th
                              key={i}
                              className="whitespace-nowrap px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-[var(--purpose-ink-dim)]"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {display.map((r) => (
                          <tr
                            key={r.userId}
                            className="border-b border-[var(--purpose-line)] align-top last:border-0"
                          >
                            <td className="whitespace-nowrap px-3 py-3 font-medium">{r.name}</td>
                            <td className="px-3 py-3">
                              <PurposeStatusPill completion={r.completion} />
                              {r.leadershipStatus && (
                                <div className="mt-1 text-xs text-[var(--purpose-ink-dim)]">
                                  {r.leadershipStatus}
                                </div>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                              {r.weekVolume != null
                                ? `${r.weekSold ?? 0} sold · ${fmtMoney(r.weekVolume)}`
                                : "—"}
                            </td>
                            <td className="px-3 py-3">
                              <div className="max-w-[240px] truncate" title={r.target ?? undefined}>
                                {r.target ?? "—"}
                              </div>
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                              {fmtDate(r.targetDate)}
                            </td>
                            <td className="px-3 py-3">{r.lifeArea ?? "—"}</td>
                            <td className="px-3 py-3">
                              <div className="max-w-[180px]">{r.coreWhy ?? "—"}</div>
                            </td>
                            <td className="px-3 py-3">
                              <div className="max-w-[200px]">
                                {r.barrier ?? "—"}
                                {r.proFocus && (
                                  <div className="mt-0.5 text-xs text-[var(--purpose-ink-dim)]">
                                    {r.proFocus}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                              {r.ceiling != null ? fmtMoney(r.ceiling) : "—"}
                            </td>
                            <td
                              className={cn(
                                "whitespace-nowrap px-3 py-3 tabular-nums",
                                r.followUp && r.followUp < today && "text-[var(--purpose-sand)]",
                              )}
                            >
                              {fmtDate(r.followUp)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums text-[var(--purpose-ink-dim)]">
                              {fmtDate(r.lastReviewed)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 text-right">
                              <Link
                                to="/purpose-leadership/$userId"
                                params={{ userId: r.userId }}
                                className="text-[var(--purpose-tide)] hover:underline"
                              >
                                View
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <MobileCardList className="mt-6">
                  {display.map((r) => (
                    <Link
                      key={r.userId}
                      to="/purpose-leadership/$userId"
                      params={{ userId: r.userId }}
                      className="block"
                    >
                      <MobileCard className="border-[var(--purpose-line)] bg-[var(--purpose-card)]">
                        <MobileCardHeader
                          left={r.name}
                          right={<PurposeStatusPill completion={r.completion} />}
                        />
                        <MobileStatGrid cols={2}>
                          <MobileStat label="Target date" value={fmtDate(r.targetDate)} />
                          <MobileStat
                            label="Follow-up"
                            value={fmtDate(r.followUp)}
                            className={cn(
                              r.followUp && r.followUp < today && "text-[var(--purpose-sand)]",
                            )}
                          />
                          <MobileStat
                            label="Ceiling"
                            value={r.ceiling != null ? fmtMoney(r.ceiling) : "—"}
                          />
                          <MobileStat
                            label="This week"
                            value={r.weekVolume != null ? fmtMoney(r.weekVolume) : "—"}
                          />
                        </MobileStatGrid>
                        {r.target && (
                          <p className="line-clamp-2 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
                            {r.target}
                          </p>
                        )}
                      </MobileCard>
                    </Link>
                  ))}
                </MobileCardList>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
