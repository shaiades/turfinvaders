// Tidal Activity Test — data access. activity_tests isn't in the generated
// Database types until Lovable regenerates types.ts, so queries ride the
// same untyped escape hatch as the purpose tables (purposeTable/purposeRpc
// + isMissingMigration graceful fallback), cast on read.
//
// View As trap (verified): during a preview user.id stays the ADMIN's uid —
// only role/displayName are overridden. So the previewed rep's takes are
// resolved by profiles.display_name, and every write is guarded on
// isPreview INSIDE the mutation (the Goals-tab Enter-key precedent), never
// just on the button.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isMissingMigration, purposeRpc, purposeTable } from "@/hooks/usePurposeTable";
import { scoreActivityTest, TEST_VERSION, type ActivityAnswers } from "@/lib/activity-test";
import { MAX_SCORE } from "@/data/activity-test-content";
import { laTodayISO, laWeekStartISO } from "@/lib/dates";

export type ActivityTestRow = {
  id: string;
  rep_id: string;
  taken_on: string;
  source: "google_form" | "in_app";
  version: number;
  answers: ActivityAnswers;
  score: number;
  max_score: number;
  created_at: string;
};

export type ActivityTeamStats = {
  n: number;
  avg_score: number | null;
  best_score: number | null;
  my_rank: number | null;
  /** {question_key: {"yes": n, "no": m, "<option>": k}} across latest takes. */
  answer_counts: Record<string, Record<string, number>>;
};

export const activityTestsKey = (subjectId: string) => ["activity_tests", subjectId] as const;
export const activityTeamStatsKey = () => ["activity_team_stats"] as const;
export const activityTestsAllKey = () => ["activity_tests_all"] as const;

/** Whose test the panel shows. Normally the signed-in rep; under View As
 *  the previewed rep resolved by display_name (admin-tier read policy on
 *  activity_tests makes their rows readable). canWrite is false in preview
 *  — a retake would insert under the ADMIN's uid. */
export function useActivitySubject(
  userId: string | undefined,
  displayName: string | null,
  isPreview: boolean,
) {
  const previewName = (displayName ?? "").trim();
  const resolved = useQuery({
    enabled: isPreview && previewName.length > 0,
    queryKey: ["activity_subject", previewName],
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name")
        .ilike("display_name", previewName)
        .limit(2)
        .abortSignal(signal);
      if (error) throw error;
      // Exactly one match or we honestly don't know who's previewed.
      return data?.length === 1 ? data[0].id : null;
    },
  });

  if (!isPreview) return { subjectId: userId ?? null, canWrite: !!userId, resolving: false };
  return {
    subjectId: resolved.data ?? null,
    canWrite: false,
    resolving: resolved.isLoading,
  };
}

/** All takes for one rep, newest first. `latest` is takes[0]. */
export function useActivityTests(subjectId: string | null) {
  return useQuery({
    enabled: !!subjectId,
    queryKey: activityTestsKey(subjectId ?? ""),
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await purposeTable("activity_tests")
        .select("*")
        .eq("rep_id", subjectId!)
        .order("taken_on", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) {
        if (isMissingMigration(error)) return { takes: [], missingMigration: true } as const;
        throw error;
      }
      return {
        takes: (data ?? []) as unknown as ActivityTestRow[],
        missingMigration: false,
      } as const;
    },
  });
}

/** Aggregates-only team stats (SECURITY DEFINER RPC) — team avg / best /
 *  caller's rank / anonymous per-habit adoption. Null until the migration
 *  is applied. */
export function useActivityTeamStats(enabled = true) {
  return useQuery({
    enabled,
    queryKey: activityTeamStatsKey(),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await purposeRpc("get_activity_test_team_stats");
      if (error) {
        if (isMissingMigration(error)) return null;
        throw error;
      }
      return (data ?? null) as unknown as ActivityTeamStats | null;
    },
  });
}

/** Adoption count for one habit from team stats ("how many of the latest
 *  takes EARNED it" — reverse-scored habits count their correct answer). */
export function adoptionCount(
  stats: ActivityTeamStats | null | undefined,
  habitKey: string,
  correctAnswer: string,
): number | null {
  const counts = stats?.answer_counts?.[habitKey];
  if (!counts) return null;
  return counts[correctAnswer] ?? 0;
}

/** Submit an in-app retake. Scores via the ONE shared scorer; tolerates a
 *  same-day double submit (23505 — the UNIQUE is the backstop under the
 *  one-per-week client cap). */
export function useInsertActivityTest(userId: string | undefined, isPreview: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (answers: ActivityAnswers) => {
      // Guard HERE, not just on the button: a preview save would write the
      // previewed rep's answers under the ADMIN's own uid.
      if (isPreview || !userId) throw new Error("Retake is disabled while previewing.");
      const { score } = scoreActivityTest(answers);
      const { error } = await purposeTable("activity_tests").insert({
        rep_id: userId,
        taken_on: laTodayISO(),
        source: "in_app",
        version: TEST_VERSION,
        answers,
        score,
        max_score: MAX_SCORE,
      });
      if (error && (error as { code?: string }).code !== "23505") throw error;
      return score;
    },
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: activityTestsKey(userId) });
      qc.invalidateQueries({ queryKey: activityTeamStatsKey() });
      qc.invalidateQueries({ queryKey: activityTestsAllKey() });
    },
  });
}

/** Leadership: every take for every rep (admin-tier read), newest first.
 *  Callers pick latest-per-rep client-side. */
export function useAllActivityTests(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: activityTestsAllKey(),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await purposeTable("activity_tests")
        .select("*")
        .order("taken_on", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) {
        if (isMissingMigration(error)) return { takes: [], missingMigration: true } as const;
        throw error;
      }
      return {
        takes: (data ?? []) as unknown as ActivityTestRow[],
        missingMigration: false,
      } as const;
    },
  });
}

/** Latest take per rep_id from a newest-first list. */
export function latestTakeByRep(takes: readonly ActivityTestRow[]): Map<string, ActivityTestRow> {
  const map = new Map<string, ActivityTestRow>();
  for (const t of takes) if (!map.has(t.rep_id)) map.set(t.rep_id, t);
  return map;
}

/** The rep's own logged JIP visits for the current Mon–Sun LA week —
 *  the "field receipts" count. rep_job_visits is own-rows-only by design
 *  (the rep's breadcrumb, never compliance), so this is NEVER enabled in
 *  preview: the previewed rep's rows are unreadable and the admin's own
 *  would be a lie. */
export function useMyJipVisitsThisWeek(userId: string | undefined, enabled: boolean) {
  const weekStart = laWeekStartISO();
  return useQuery({
    enabled: enabled && !!userId,
    queryKey: ["rep_job_visits_week", weekStart, userId],
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase
        .from("rep_job_visits")
        .select("monday_item_id, visited_on")
        .eq("rep_id", userId!)
        .gte("visited_on", weekStart)
        .abortSignal(signal);
      if (error) throw error;
      return data ?? [];
    },
  });
}
