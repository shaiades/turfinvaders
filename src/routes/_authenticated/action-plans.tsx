// /action-plans — ADMIN-tier (owner + office_staff) view of every rep's
// Weekly Action Plan (owner directive 2026-10-01 §13): pick a board rep
// name, see exactly what that rep sees (the same CloseKombatPlanTab), and
// correct a homeowner-status flag. Corrections write
// production_job_overrides (RLS: admin write, set_by = auth.uid()) with the
// newest note date as their basis — a newer production note makes the
// override stale and the auto status wins again (action-plan doctrine).
// rep_job_visits is deliberately NEVER rendered here (spec §12: visits are
// the rep's own breadcrumb, not compliance).

import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { requireRoleBeforeLoad, ADMIN_ROLES } from "@/lib/roles";
import { ArcadePanel, ArcadePill, ArcadeSkeleton, NeonButton } from "@/components/arcade";
import { CloseKombatPlanTab } from "@/components/CloseKombatPlanTab";
import { useProductionJobs, useProductionOverrides, planClock } from "@/hooks/useWeeklyPlan";
import { syncProduction } from "@/lib/production-jobs.functions";
import { buildWeeklyPlan, type PlanJob } from "@/lib/action-plan";
import { buildRepMatcher } from "@/lib/rep-identity";
import { normalizeName } from "@/lib/utils";
import {
  effectiveHomeownerStatus,
  noteDateLA,
  type HomeownerOverride,
  type HomeownerStatus,
  type NoteEntry,
} from "@/lib/production-jobs";

export const Route = createFileRoute("/_authenticated/action-plans")({
  head: () => ({ meta: [{ title: "Action Plans — Turf Invaders" }] }),
  beforeLoad: requireRoleBeforeLoad(ADMIN_ROLES),
  validateSearch: (search: Record<string, unknown>): { rep?: string } =>
    typeof search.rep === "string" && search.rep !== "" ? { rep: search.rep } : {},
  component: ActionPlansPage,
});

const STATUSES: HomeownerStatus[] = ["happy", "neutral", "at_risk"];
const STATUS_LABEL: Record<HomeownerStatus, string> = {
  happy: "Happy",
  neutral: "Neutral",
  at_risk: "At risk",
};

function ActionPlansPage() {
  const { rep } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { user } = useAuth();
  const jobsQuery = useProductionJobs();
  const overridesQuery = useProductionOverrides();
  const qc = useQueryClient();
  const { planWeekStart, anchorISO } = planClock();

  // Roster check: board rep names with no sales_rep profile match get a
  // marker — that rep's plan (and popup) silently never reaches anyone.
  const profileNamesQuery = useQuery({
    queryKey: ["view-as-rep-names"],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<string[]> => {
      const { data: roleRows, error: rolesErr } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "sales_rep");
      if (rolesErr) throw rolesErr;
      const ids = [...new Set((roleRows ?? []).map((r) => r.user_id))];
      if (ids.length === 0) return [];
      const { data: profs, error: profErr } = await supabase
        .from("profiles")
        .select("display_name")
        .in("id", ids);
      if (profErr) throw profErr;
      return [...new Set((profs ?? []).map((p) => (p.display_name ?? "").trim()).filter(Boolean))];
    },
  });
  const roster = useMemo(() => {
    const jobs = jobsQuery.data ?? [];
    const overrides = new Map<string, HomeownerOverride>(
      (overridesQuery.data ?? []).map((o) => [
        o.monday_item_id,
        { homeowner_status: o.homeowner_status, based_on_note_date: o.based_on_note_date },
      ]),
    );
    const names = new Set<string>();
    for (const j of jobs) for (const r of j.reps) names.add(r);
    const allRepNames = [...names];
    // Profile match uses the SAME tiered matcher the rep's own plan uses —
    // exact equality here falsely flagged tier-2/3 matches ("Sancakli
    // Yakup" vs "Yakup Sancakli") as invisible (review 2026-10-01).
    const reachedBy = new Set<string>();
    for (const p of profileNamesQuery.data ?? []) {
      const m = buildRepMatcher(p, allRepNames).matched;
      if (m !== null) reachedBy.add(normalizeName(m));
    }
    return allRepNames
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const plan = buildWeeklyPlan({
          jobs,
          overrides,
          isMine: (r) => normalizeName(r) === normalizeName(name),
          anchorISO,
          planWeekStart,
        });
        return {
          name,
          jobs: plan.jobs.length,
          pinned: plan.pinned.length,
          atRisk: plan.jobs.filter((j) => j.effective.status === "at_risk").length,
          noPm: plan.jobs.filter((j) => j.job.pm_name === null).length,
          hasProfile: reachedBy.has(normalizeName(name)),
        };
      });
  }, [jobsQuery.data, overridesQuery.data, profileNamesQuery.data, anchorISO, planWeekStart]);

  const sync = useMutation({
    mutationFn: () => syncProduction(),
    onSuccess: (res) => {
      toast.success(
        `Production synced · ${res.kept} jobs${res.at_risk_alerts > 0 ? ` · ${res.at_risk_alerts} PM alert${res.at_risk_alerts === 1 ? "" : "s"}` : ""}`,
      );
      if (res.notes_failures > 0) {
        toast.warning(`${res.notes_failures} notes batch(es) failed — statuses preserved`);
      }
      qc.invalidateQueries({ queryKey: ["production_jobs"] });
      qc.invalidateQueries({ queryKey: ["production_job_overrides"] });
      qc.invalidateQueries({ queryKey: ["production_sync_info"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  const loading = jobsQuery.isLoading || overridesQuery.isLoading;

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-sm text-kombat-gold uppercase tracking-widest">
            Weekly Action Plans
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Every rep's jobs-in-progress plan · straight from the Monday Production board
          </p>
        </div>
        <NeonButton tone="kombat-gold" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <RefreshCw className={`w-4 h-4 ${sync.isPending ? "animate-spin" : ""}`} />
          Sync production
        </NeonButton>
      </div>

      {loading ? (
        <ArcadeSkeleton className="h-24" />
      ) : (
        <div className="flex flex-wrap gap-2">
          {roster.map((r) => (
            <ArcadePill
              key={r.name}
              tone="kombat-gold"
              active={rep === r.name}
              onClick={() => navigate({ search: { rep: r.name }, replace: true })}
              title={r.hasProfile ? undefined : "No sales-rep profile matches this board name"}
            >
              {r.name} · {r.jobs}
              {r.atRisk > 0 && <span className="ml-1 text-destructive">⚠{r.atRisk}</span>}
              {!r.hasProfile && <span className="ml-1 text-warning">∅</span>}
            </ArcadePill>
          ))}
          {roster.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No mirrored jobs yet — run "Sync production".
            </p>
          )}
        </div>
      )}
      {roster.some((r) => !r.hasProfile) && (
        <p className="text-[11px] text-warning">
          ∅ = no sales-rep profile matches that board name — that rep never sees this plan. Fix the
          profile display name (or the board) so the match lands.
        </p>
      )}
      {roster.some((r) => r.noPm > 0) && (
        <p className="text-[11px] text-warning">
          Some jobs have no PM on the board's Production column — at-risk alerts for them have
          nowhere to go. Tell production.
        </p>
      )}

      {rep ? (
        <>
          <OverridePanel rep={rep} jobs={jobsQuery.data ?? []} userId={user?.id ?? null} />
          {/* Exactly what the rep sees — same component, read-only. */}
          <CloseKombatPlanTab userId={null} displayName={rep} isPreview readOnly />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Pick a rep to see their plan.</p>
      )}
    </div>
  );
}

/** Homeowner-status correction (spec §13) + the admin-only raw notes the
 *  auto status was read from. */
function OverridePanel({
  rep,
  jobs,
  userId,
}: {
  rep: string;
  jobs: PlanJob[];
  userId: string | null;
}) {
  const qc = useQueryClient();
  const overridesQuery = useProductionOverrides();
  const myJobs = useMemo(
    () => jobs.filter((j) => j.reps.some((r) => normalizeName(r) === normalizeName(rep))),
    [jobs, rep],
  );
  const [openNotes, setOpenNotes] = useState<string | null>(null);
  const notesQuery = useQuery({
    queryKey: ["production_job_notes", openNotes],
    enabled: openNotes !== null,
    queryFn: async ({ signal }): Promise<NoteEntry[]> => {
      const { data, error } = await supabase
        .from("production_job_notes")
        .select("notes_digest")
        .eq("monday_item_id", openNotes as string)
        .abortSignal(signal)
        .maybeSingle();
      if (error) throw error;
      return ((data?.notes_digest ?? []) as NoteEntry[]).slice(0, 5);
    },
  });

  const setStatus = useMutation({
    mutationFn: async (input: { mondayItemId: string; status: HomeownerStatus | null }) => {
      if (input.status === null) {
        const { error } = await supabase
          .from("production_job_overrides")
          .delete()
          .eq("monday_item_id", input.mondayItemId);
        if (error) throw error;
        return;
      }
      const job = myJobs.find((j) => j.monday_item_id === input.mondayItemId);
      const { error } = await supabase.from("production_job_overrides").upsert(
        {
          monday_item_id: input.mondayItemId,
          homeowner_status: input.status,
          // Basis = the newest note the auto status saw; a newer note later
          // makes this override stale (auto wins again).
          based_on_note_date: job?.homeowner_status_note_date ?? null,
          set_by: userId as string,
          set_at: new Date().toISOString(),
        },
        { onConflict: "monday_item_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production_job_overrides"] });
      toast.success("Homeowner status updated");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save the override"),
  });

  if (myJobs.length === 0) return null;
  const overrideById = new Map((overridesQuery.data ?? []).map((o) => [o.monday_item_id, o]));

  return (
    <ArcadePanel title="Homeowner status — leadership corrections" faction="kombat" status="good">
      <ul className="space-y-3">
        {myJobs.map((j) => {
          const o = overrideById.get(j.monday_item_id);
          const eff = effectiveHomeownerStatus(
            j,
            o ? { homeowner_status: o.homeowner_status, based_on_note_date: o.based_on_note_date } : null,
          );
          return (
            <li key={j.monday_item_id} className="text-sm space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{j.homeowner_name ?? j.monday_item_id}</span>
                <span className="text-xs text-muted-foreground">
                  auto: {STATUS_LABEL[j.homeowner_status]}
                  {j.homeowner_status_note_date ? ` (${j.homeowner_status_note_date})` : ""}
                </span>
                {eff.source === "override" && (
                  <span className="text-xs text-kombat-gold">override active</span>
                )}
                {eff.source === "stale_override" && (
                  <span className="text-xs text-warning">
                    <AlertTriangle className="inline w-3 h-3 mr-0.5 -mt-0.5" />
                    override stale — newer notes
                  </span>
                )}
                {j.pm_name === null && (
                  <span className="text-xs text-warning">no PM on item</span>
                )}
              </div>
              {j.homeowner_status_reason && (
                <p className="text-xs text-muted-foreground">{j.homeowner_status_reason}</p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {STATUSES.map((s) => (
                  <ArcadePill
                    key={s}
                    size="sm"
                    tone="kombat-gold"
                    active={eff.source !== "auto" ? o?.homeowner_status === s : j.homeowner_status === s}
                    disabled={setStatus.isPending || userId === null}
                    onClick={() => setStatus.mutate({ mondayItemId: j.monday_item_id, status: s })}
                  >
                    {STATUS_LABEL[s]}
                  </ArcadePill>
                ))}
                {o && (
                  <button
                    type="button"
                    className="min-h-11 md:min-h-0 inline-flex items-center px-2 text-xs text-muted-foreground hover:text-foreground underline"
                    onClick={() => setStatus.mutate({ mondayItemId: j.monday_item_id, status: null })}
                  >
                    clear override
                  </button>
                )}
                <button
                  type="button"
                  className="min-h-11 md:min-h-0 inline-flex items-center px-2 text-xs text-muted-foreground hover:text-foreground underline"
                  onClick={() =>
                    setOpenNotes(openNotes === j.monday_item_id ? null : j.monday_item_id)
                  }
                >
                  {openNotes === j.monday_item_id ? "hide notes" : "notes"}
                </button>
              </div>
              {openNotes === j.monday_item_id && (
                <ul className="mt-1 space-y-1 border-l-2 border-border pl-3">
                  {(notesQuery.data ?? []).map((n, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      <span className="text-foreground">{noteDateLA(n.created_at) ?? "?"}</span>
                      {n.creator ? ` · ${n.creator}` : ""} — {n.body}
                    </li>
                  ))}
                  {notesQuery.isLoading && (
                    <li className="text-xs text-muted-foreground">Loading…</li>
                  )}
                  {notesQuery.isSuccess && (notesQuery.data ?? []).length === 0 && (
                    <li className="text-xs text-muted-foreground">No recent notes.</li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </ArcadePanel>
  );
}
