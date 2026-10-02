// Weekly Action Plan tab (owner directive 2026-10-01): the rep's jobs in
// progress this week, from the Production board mirror — do-first pins,
// a Mon–Sun visit agenda, clustered "route", and per-job phase guidance.
// Everything on screen renders board data only (service, schedule, notes
// classification) — never invented project details. At-risk jobs show the
// recovery protocol and hold every ask (spec §6).
//
// Also the leadership detail surface: action-plans.tsx renders this same
// component for any picked board name (readOnly), so the rep and the
// leadership view can never disagree.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  Footprints,
  MapPin,
  RefreshCw,
  Route as RouteIcon,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, ArcadeSkeleton, NeonBar } from "@/components/arcade";
import { useWeeklyPlan } from "@/hooks/useWeeklyPlan";
import { useActivityTests } from "@/hooks/useActivityTests";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { claimedJipVisitsPerWeek } from "@/lib/activity-test";
import { rewardToast } from "@/lib/reward-toast";
import { getProductionSyncInfo } from "@/lib/production-jobs.functions";
import { addDaysISO, laDateTimeLabel, laTodayISO } from "@/lib/dates";
import {
  SUPPRESSED_ASKS,
  type AssembledJob,
  type VisitSlot,
  type WeeklyPlan,
} from "@/lib/action-plan";
import type { EffectiveStatus } from "@/lib/production-jobs";

const STATUS_PILL: Record<EffectiveStatus["status"], { label: string; cls: string }> = {
  happy: { label: "Happy", cls: "border-victory/50 text-victory" },
  neutral: { label: "Neutral", cls: "border-border text-muted-foreground" },
  at_risk: { label: "At risk", cls: "border-destructive/60 text-destructive" },
};

const STATE_CHIP: Record<string, string> = {
  starting_soon: "Starting soon",
  active: "Active",
  finishing: "Finishing",
  just_completed: "Just completed",
  post: "Follow-up",
};

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString("en-US", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    })
    .replace(",", "");

export function CloseKombatPlanTab({
  userId,
  displayName,
  isPreview,
  readOnly = false,
}: {
  /** Auth uid for "I went" rows; null renders read-only. */
  userId: string | null;
  /** The display name the plan is FOR (rep, View As preview, or a
   *  leadership-picked board name). */
  displayName: string | null;
  /** View As: render fully, write nothing (stamps, visits). */
  isPreview: boolean;
  /** Leadership detail mode: no visit buttons at all. */
  readOnly?: boolean;
}) {
  const { status, plan, matchedName, planWeekStart, anchorISO, isSundayPreview } =
    useWeeklyPlan(displayName);

  const syncInfo = useQuery({
    queryKey: ["production_sync_info"],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: () => getProductionSyncInfo(),
  });
  const lastSynced = syncInfo.data?.lastSyncedAt ?? null;
  const staleHours = lastSynced === null ? null : (Date.now() - Date.parse(lastSynced)) / 3_600_000;

  const canVisit = !isPreview && !readOnly && userId !== null;
  const todayISO = laTodayISO();
  const qc = useQueryClient();
  const visitsQuery = useQuery({
    queryKey: ["rep_job_visits", planWeekStart, userId],
    enabled: canVisit,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase
        .from("rep_job_visits")
        .select("monday_item_id, visited_on")
        .eq("rep_id", userId as string)
        .gte("visited_on", addDaysISO(planWeekStart, -7))
        .abortSignal(signal);
      if (error) throw error;
      return data ?? [];
    },
  });
  const visitedToday = useMemo(() => {
    const set = new Set<string>();
    for (const v of visitsQuery.data ?? []) {
      if (v.visited_on === todayISO) set.add(v.monday_item_id);
    }
    return set;
  }, [visitsQuery.data, todayISO]);

  const markVisit = useMutation({
    mutationFn: async (mondayItemId: string) => {
      // LA calendar date from the client, never the DB's UTC current_date.
      const { error } = await supabase.from("rep_job_visits").insert({
        monday_item_id: mondayItemId,
        rep_id: userId as string,
        visited_on: todayISO,
      });
      if (error && error.code !== "23505") throw error; // double-tap = already logged
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rep_job_visits", planWeekStart, userId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't log the visit"),
  });

  if (status === "loading") {
    return (
      <div className="space-y-4">
        <ArcadeSkeleton className="h-28" />
        <ArcadeSkeleton className="h-44" />
      </div>
    );
  }
  if (status === "error" || plan === null) {
    return (
      <ArcadePanel title="Weekly Action Plan" faction="kombat" status="alert">
        <p className="text-sm text-muted-foreground">
          Couldn't load the plan data. Pull to refresh, or try again in a minute.
        </p>
      </ArcadePanel>
    );
  }

  const jobById = new Map(plan.jobs.map((j) => [j.job.monday_item_id, j]));

  if (
    matchedName === null ||
    plan.jobs.length + plan.paused.length + plan.upcomingTbd.length === 0
  ) {
    return (
      <ArcadePanel title="Weekly Action Plan" faction="kombat" status="good">
        <p className="text-sm text-muted-foreground">
          {matchedName === null
            ? "No jobs on the Production board match this name right now."
            : "No jobs in progress this week."}{" "}
          New sales land here once production schedules them.
        </p>
        <LastUpdated lastSynced={lastSynced} staleHours={staleHours} />
      </ArcadePanel>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {isSundayPreview && (
        <p className="text-xs text-muted-foreground">
          Sunday preview — this is the plan for the upcoming week.
        </p>
      )}

      {/* Do first */}
      {plan.pinned.length > 0 && (
        <ArcadePanel title="Do first" faction="kombat" status="warn">
          <ul className="space-y-2">
            {plan.pinned.map((j) => (
              <li key={j.job.monday_item_id} className="flex items-start gap-2 text-sm">
                <AlertTriangle
                  className={`mt-0.5 w-4 h-4 shrink-0 ${j.pin?.kind === "recovery" ? "text-destructive" : "text-kombat-gold"}`}
                />
                <span className="min-w-0">
                  <span className="font-medium">{j.job.homeowner_name ?? "Unknown homeowner"}</span>
                  <span className="text-muted-foreground"> — {j.pin?.label}</span>
                </span>
              </li>
            ))}
          </ul>
        </ArcadePanel>
      )}

      {/* JIP Patrol — Power Level claim vs this week's field receipts */}
      {canVisit && userId !== null && (
        <JipPatrolStrip
          userId={userId}
          planWeekStart={planWeekStart}
          todayISO={todayISO}
          visits={visitsQuery.data}
        />
      )}

      {/* Mon–Sun agenda */}
      <ArcadePanel
        title="This week"
        faction="kombat"
        status="good"
        info={<CalendarDays className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />}
      >
        <Agenda agenda={plan.agenda} planWeekStart={planWeekStart} jobById={jobById} />
      </ArcadePanel>

      {/* Route */}
      {plan.route.length > 0 && (
        <ArcadePanel
          title={isSundayPreview || anchorISO > todayISO ? "Monday's route" : "Today's route"}
          faction="kombat"
          status="good"
          info={<RouteIcon className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />}
        >
          <div className="space-y-3">
            {plan.route.map((c, i) => (
              <div key={`${c.label}-${i}`} className="text-sm">
                <p className="font-display text-[10px] uppercase tracking-widest text-kombat-gold">
                  <MapPin className="inline w-3 h-3 mr-1 -mt-0.5" />
                  {c.label} · {c.jobIds.length} job{c.jobIds.length === 1 ? "" : "s"}
                </p>
                <ul className="mt-1 space-y-1">
                  {c.jobIds.map((id) => {
                    const j = jobById.get(id);
                    return j ? (
                      <li key={id} className="text-muted-foreground truncate">
                        {j.job.homeowner_name ?? id}
                        {j.job.address ? ` · ${j.job.address.split(",")[0]}` : ""}
                      </li>
                    ) : null;
                  })}
                </ul>
              </div>
            ))}
          </div>
        </ArcadePanel>
      )}

      {/* Job cards — card layout at every width (mobile-first; no wide table
          to twin, so no hidden md:block split needed) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {plan.jobs.map((j) => (
          <JobCard
            key={j.job.monday_item_id}
            j={j}
            canVisit={canVisit}
            visitedToday={visitedToday.has(j.job.monday_item_id)}
            onVisit={() => markVisit.mutate(j.job.monday_item_id)}
            visitPending={markVisit.isPending}
          />
        ))}
      </div>

      {/* Paused + upcoming TBD, collapsed out of the action path */}
      {plan.paused.length > 0 && (
        <details className="arcade-card px-5 py-1">
          <summary className="min-h-11 md:min-h-0 md:py-2 flex items-center cursor-pointer font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            Paused ({plan.paused.length})
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {plan.paused.map((j) => (
              <li key={j.job.monday_item_id}>
                {j.job.homeowner_name ?? j.job.monday_item_id}
                {j.job.delayed_until ? ` — delayed until ${j.job.delayed_until}` : " — delayed"}
              </li>
            ))}
          </ul>
        </details>
      )}
      {plan.upcomingTbd.length > 0 && (
        <details className="arcade-card px-5 py-1">
          <summary className="min-h-11 md:min-h-0 md:py-2 flex items-center cursor-pointer font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            Upcoming — date TBD ({plan.upcomingTbd.length})
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {plan.upcomingTbd.map((j) => (
              <li key={j.job.monday_item_id}>
                {j.job.homeowner_name ?? j.job.monday_item_id}
                {j.job.projects ? ` · ${j.job.projects}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <LastUpdated lastSynced={lastSynced} staleHours={staleHours} />
    </div>
  );
}

function LastUpdated({
  lastSynced,
  staleHours,
}: {
  lastSynced: string | null;
  staleHours: number | null;
}) {
  return (
    <div className="space-y-1">
      {staleHours !== null && staleHours > 26 && (
        <p className="text-xs text-warning">
          Data may be stale — the overnight refresh hasn't landed.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Last updated {lastSynced ? laDateTimeLabel(lastSynced) : "—"} · refreshes daily at 6 AM
      </p>
    </div>
  );
}

/** "JIP PATROL" — the rep's Power Level claim ("I visit my JIPs N times a
 *  week") held against this week's logged visit rows, as a pip rail. Only
 *  the signed-in rep ever sees it (parent gates on canVisit), so their own
 *  uid IS the test subject — no useActivitySubject resolution needed. Every
 *  number traces to a row: pips = rep_job_visits in the plan week, the
 *  target = the latest take's answer. Loading, missing migration, or a
 *  take with no claim → nothing, never a fabricated 0. */
function JipPatrolStrip({
  userId,
  planWeekStart,
  todayISO,
  visits,
}: {
  userId: string;
  planWeekStart: string;
  todayISO: string;
  visits: { monday_item_id: string; visited_on: string }[] | undefined;
}) {
  const testsQuery = useActivityTests(userId);
  const reduced = usePrefersReducedMotion();
  const [kaching, setKaching] = useState(false);
  const prevLogged = useRef<number | null>(null);

  const weekEnd = addDaysISO(planWeekStart, 6);
  const weekRows = useMemo(
    () => (visits ?? []).filter((v) => v.visited_on >= planWeekStart && v.visited_on <= weekEnd),
    [visits, planWeekStart, weekEnd],
  );
  const logged = weekRows.length;
  const hasToday = weekRows.some((v) => v.visited_on === todayISO);

  const takes = testsQuery.data?.takes;
  const latest = takes?.[0];
  const said = latest ? claimedJipVisitsPerWeek(latest.answers) : null;

  // Celebrate the markVisit that backs the claim: the refetched count
  // crossing from below `said` to `said`, once per rep-week.
  useEffect(() => {
    if (visits === undefined || said === null || said < 1) return;
    const prev = prevLogged.current;
    prevLogged.current = logged;
    if (prev === null || !(prev < said && logged >= said)) return;
    try {
      const key = `ti_jip_backed:${userId}:${planWeekStart}`;
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      /* storage blocked — still celebrate this once */
    }
    if (!reduced) setKaching(true);
    rewardToast("FIELD RECEIPTS", {
      description: "Logged visits just backed your Power Level claim.",
    });
  }, [visits, said, logged, userId, planWeekStart, reduced]);
  useEffect(() => {
    if (!kaching) return;
    const t = window.setTimeout(() => setKaching(false), 2600); // 1.2s × 2 beats
    return () => window.clearTimeout(t);
  }, [kaching]);

  if (visits === undefined) return null;
  if (testsQuery.isLoading || testsQuery.isError || !testsQuery.data) return null;
  if (testsQuery.data.missingMigration) return null;
  const noTest = testsQuery.data.takes.length === 0;
  if (!noTest && (said === null || said < 1)) return null;
  const target = noTest ? 0 : (said as number);

  const pipCount = Math.min(target, 10);
  const filled = Math.min(logged, pipCount);

  return (
    <Link
      to="/close-kombat"
      search={{ tab: "goals" }}
      hash="field-receipts"
      className={`flex items-center gap-2 rounded-lg border border-kombat-gold/40 bg-kombat-gold/5 px-3 py-1.5 min-h-11 md:min-h-9 ${kaching ? "kombat-kaching" : ""}`}
    >
      <Footprints className="w-4 h-4 text-kombat-gold shrink-0" aria-hidden />
      <span className="shrink-0 font-display text-[10px] uppercase tracking-widest text-kombat-gold">
        JIP Patrol
      </span>
      {noTest ? (
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
          Logged {logged} this week — take the test to set your target
        </span>
      ) : (
        <>
          <span
            className="min-w-0 flex-1 flex items-center gap-1"
            aria-label={`${logged} of ${target} claimed visits logged this week`}
          >
            {Array.from({ length: pipCount }, (_, i) => {
              const isFilled = i < filled;
              const emphasize = isFilled && hasToday && i === filled - 1;
              return (
                <span
                  key={i}
                  aria-hidden
                  className={`w-[7px] h-[7px] rounded-[2px] shrink-0 ${
                    isFilled ? "bg-kombat-gold" : "border border-border"
                  }`}
                  style={
                    isFilled
                      ? {
                          boxShadow: emphasize
                            ? "0 0 10px var(--kombat-gold), 0 0 3px var(--kombat-gold)"
                            : "0 0 6px var(--kombat-gold)",
                        }
                      : undefined
                  }
                />
              );
            })}
            {target > 10 && (
              <span className="text-[10px] tabular-nums text-muted-foreground">×{target}</span>
            )}
          </span>
          {logged >= target ? (
            <span className="shrink-0 text-[10px] font-display uppercase tabular-nums text-victory">
              Claim backed <Check className="inline w-3.5 h-3.5 -mt-0.5" aria-hidden />
            </span>
          ) : (
            <span className="shrink-0 text-[10px] font-display uppercase tabular-nums text-muted-foreground">
              {logged} of {target} — test says {target}
            </span>
          )}
        </>
      )}
    </Link>
  );
}

function Agenda({
  agenda,
  planWeekStart,
  jobById,
}: {
  agenda: VisitSlot[];
  planWeekStart: string;
  jobById: Map<string, AssembledJob>;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(planWeekStart, i));
  const byDay = new Map<string, VisitSlot[]>();
  for (const s of agenda) byDay.set(s.dateISO, [...(byDay.get(s.dateISO) ?? []), s]);
  const hasAny = agenda.length > 0;
  if (!hasAny) {
    return <p className="text-sm text-muted-foreground">No dated visits this week.</p>;
  }
  return (
    <div className="space-y-2">
      {days.map((d) => {
        const slots = byDay.get(d) ?? [];
        if (slots.length === 0) return null;
        return (
          <div key={d} className="flex gap-3 text-sm">
            <span className="w-16 shrink-0 font-display text-[10px] uppercase tracking-widest text-kombat-gold pt-0.5">
              {fmtDay(d)}
            </span>
            <ul className="min-w-0 flex-1 space-y-1">
              {slots.map((s, i) => {
                const name = jobById.get(s.jobId)?.job.homeowner_name ?? s.jobId;
                return (
                  <li key={`${s.jobId}-${i}`} className="text-muted-foreground">
                    <span className="text-foreground">{name}</span> — {s.label}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function JobCard({
  j,
  canVisit,
  visitedToday,
  onVisit,
  visitPending,
}: {
  j: AssembledJob;
  canVisit: boolean;
  visitedToday: boolean;
  onVisit: () => void;
  visitPending: boolean;
}) {
  const { job, timeline, guide, effective, sharedWith, reloadsAvailable } = j;
  const pill = STATUS_PILL[effective.status];
  const atRisk = effective.status === "at_risk";
  const progress =
    timeline.dayX !== null && timeline.dayY !== null
      ? Math.min(1, timeline.dayX / timeline.dayY)
      : null;

  return (
    <article className={`arcade-card p-4 space-y-3 ${atRisk ? "border-destructive/50" : ""}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-sm truncate">
            {job.homeowner_name ?? "Unknown homeowner"}
          </h3>
          <p className="text-xs text-muted-foreground truncate">
            {job.projects ?? "Project"}
            {job.address ? ` · ${job.address.split(",")[0]}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="px-2 py-0.5 rounded-full border text-[10px] font-display uppercase tracking-widest border-border text-muted-foreground">
            {STATE_CHIP[timeline.state] ?? timeline.state}
          </span>
          <span
            className={`px-2 py-0.5 rounded-full border text-[10px] font-display uppercase tracking-widest ${pill.cls}`}
          >
            {pill.label}
          </span>
        </div>
      </header>

      {/* Day X of Y */}
      {timeline.dayX !== null && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Day {timeline.dayX}
            {timeline.dayY !== null ? ` of ${timeline.dayY}` : " (end TBD)"} · {guide.title}
          </p>
          {progress !== null && <NeonBar pct={progress} accent="var(--kombat-gold)" />}
        </div>
      )}

      {/* Homeowner temperature */}
      {(job.homeowner_status_reason || atRisk || effective.source !== "auto") && (
        <p className="text-xs text-muted-foreground">
          {atRisk && <AlertTriangle className="inline w-3 h-3 mr-1 -mt-0.5 text-destructive" />}
          {effective.source === "override"
            ? "Leadership call: "
            : effective.source === "stale_override"
              ? "New notes since the leadership call: "
              : ""}
          {job.homeowner_status_reason ?? (atRisk ? "Flagged at risk" : "")}
          {job.homeowner_status_note_date ? ` (${job.homeowner_status_note_date})` : ""}
          {" · "}
          <span className="text-foreground">Confirm with production before your visit.</span>
        </p>
      )}

      {/* Visit guidance (recovery guide replaces phases on at-risk jobs) */}
      <div className="text-xs space-y-1">
        <p>
          <span className="text-kombat-gold font-display uppercase tracking-widest text-[10px]">
            Goal
          </span>{" "}
          {guide.goal}
        </p>
        <p className="text-muted-foreground">{guide.homeowner}</p>
        {guide.neighbors && <p className="text-muted-foreground">Neighbors: {guide.neighbors}</p>}
        {guide.capture && <p className="text-muted-foreground">Capture: {guide.capture}</p>}
      </div>

      {/* Opportunity pills */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-display uppercase tracking-widest">
        {job.advantage_plus && (
          <span
            className={`px-2 py-0.5 rounded-full border ${atRisk ? "border-border text-muted-foreground" : "border-kombat-gold/50 text-kombat-gold"}`}
          >
            Advantage+{atRisk ? " · hold" : ""}
          </span>
        )}
        {!atRisk &&
          reloadsAvailable.map((r) => (
            <span
              key={r}
              className="px-2 py-0.5 rounded-full border border-victory/50 text-victory"
            >
              Reload: {r}
            </span>
          ))}
        {atRisk && job.reloads && (
          <span className="px-2 py-0.5 rounded-full border border-border text-muted-foreground">
            Reloads on hold
          </span>
        )}
        {sharedWith.length > 0 && (
          <span className="px-2 py-0.5 rounded-full border border-border text-muted-foreground normal-case tracking-normal font-sans">
            <Users className="inline w-3 h-3 mr-1 -mt-0.5" />
            shared with {sharedWith.join(", ")}
          </span>
        )}
      </div>

      {/* At-risk: name the held asks so nothing slips out by habit */}
      {atRisk && (
        <p className="text-[11px] text-muted-foreground">
          Recovery visit — holding: {SUPPRESSED_ASKS.join(", ")}.
        </p>
      )}

      {/* Confirm-with-production chips from the mismatch rules */}
      {timeline.chips.length > 0 && (
        <ul className="space-y-0.5">
          {timeline.chips.map((c) => (
            <li key={c} className="text-[11px] text-warning">
              {c}
            </li>
          ))}
        </ul>
      )}

      {/* Auto-tracked outcomes (read-only V1) */}
      {(job.reviews_status || job.referral_status || job.reloaded) && (
        <p className="text-[11px] text-muted-foreground">
          Monday shows:{" "}
          {[
            job.reviews_status ? `reviews ${job.reviews_status}` : null,
            job.referral_status ? `referral ${job.referral_status}` : null,
            job.reloaded ? `reloaded ${job.reloaded}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {/* One-tap "I went" — the rep's own breadcrumb, never compliance */}
      {canVisit && (
        <button
          type="button"
          disabled={visitedToday || visitPending}
          onClick={onVisit}
          className={`w-full min-h-11 rounded border font-display text-[10px] uppercase tracking-widest transition-colors ${
            visitedToday
              ? "border-victory/50 text-victory cursor-default"
              : "border-border text-muted-foreground hover:text-foreground hover:border-kombat-gold/50"
          }`}
        >
          {visitedToday ? (
            <>
              <CheckCircle2 className="inline w-3.5 h-3.5 mr-1 -mt-0.5" /> Went today
            </>
          ) : (
            "I went today"
          )}
        </button>
      )}
    </article>
  );
}

/** Pinned-count badge inside the Plan tab trigger (react-query dedupes the
 *  underlying fetch with the tab itself). */
export function PlanTabBadge({ displayName }: { displayName: string | null }) {
  const { status, plan } = useWeeklyPlan(displayName);
  if (status !== "ready" || !plan || plan.pinned.length === 0) return null;
  return (
    <span
      aria-label={`${plan.pinned.length} do-first`}
      className="ml-1.5 inline-block min-w-4 h-4 px-1 rounded-full bg-kombat-red text-background text-[9px] leading-4 text-center align-middle"
    >
      {plan.pinned.length > 9 ? "9+" : plan.pinned.length}
    </span>
  );
}

export type { WeeklyPlan };
