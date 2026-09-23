// Purpose Leadership data — owner-only composition of the roster, every
// purpose profile, and the shared slices of each rep's answers. RLS is the
// boundary: these queries simply return fewer rows for anyone who isn't an
// owner. ~20–40 reps total, so everything aggregates client-side.
//
// LOUD REMINDER: purpose_whys has NO owner SELECT policy. The ONLY leadership
// read is the get_purpose_whys_for_leadership RPC — a direct .from() select
// silently returns zero rows for owners. Don't "simplify" that away.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { LeadershipStatus } from "@/lib/purpose/types";
import {
  isMissingMigration,
  purposeRpc,
  purposeTable,
  type PurposeAnswerRow,
  type PurposeBeliefsRow,
  type PurposeGoalRow,
  type PurposeIfThenRow,
  type PurposeLeadershipNoteRow,
  type PurposeProfileRow,
  type PurposeReflectionRow,
  type PurposeSafetyFlagRow,
  type PurposeWhyLeadershipRow,
} from "./usePurposeTable";

export type EligibleRep = {
  userId: string;
  displayName: string;
  isActive: boolean;
  isPlaceholder: boolean;
  isOwner: boolean;
};

export type LeadershipListRow = {
  rep: EligibleRep;
  profile: PurposeProfileRow | null;
  goals: Record<string, PurposeGoalRow>;
  beliefs: PurposeBeliefsRow | null;
  lifeAreas: string[];
  supportRequest: string[];
  coreValues: string[];
  openSafetyFlag: boolean;
};

export const purposeLeadershipListKey = () => ["purpose_leadership", "list"] as const;

export function usePurposeLeadershipList(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: purposeLeadershipListKey(),
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<{ rows: LeadershipListRow[]; missingMigration: boolean }> => {
      // Roster first — eligible reps exist as rows even before they start
      // (a "Not started" line is the whole point of the launch dashboard).
      const [rolesRes, profilesRes] = await Promise.all([
        supabase.from("user_roles").select("user_id, role"),
        supabase.from("profiles").select("id, display_name, is_active, is_placeholder"),
      ]);
      if (rolesRes.error) throw rolesRes.error;
      if (profilesRes.error) throw profilesRes.error;

      const roleByUser = new Map<string, Set<string>>();
      for (const r of rolesRes.data ?? []) {
        const set = roleByUser.get(r.user_id) ?? new Set<string>();
        set.add(r.role as string);
        roleByUser.set(r.user_id, set);
      }
      const reps: EligibleRep[] = (profilesRes.data ?? [])
        .filter((p) => {
          const roles = roleByUser.get(p.id);
          if (!roles) return false;
          return roles.has("sales_rep") || roles.has("owner");
        })
        .filter((p) => p.is_active !== false && !p.is_placeholder)
        .map((p) => ({
          userId: p.id,
          displayName: p.display_name ?? "Unknown",
          isActive: p.is_active !== false,
          isPlaceholder: !!p.is_placeholder,
          isOwner: roleByUser.get(p.id)?.has("owner") ?? false,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      const [pRes, gRes, bRes, aRes, fRes] = await Promise.all([
        purposeTable("purpose_profiles").select("*"),
        purposeTable("purpose_goals").select("*"),
        purposeTable("purpose_beliefs").select("*"),
        purposeTable("purpose_answers")
          .select("*")
          .eq("is_current", true)
          .in("question_key", ["m3_life_areas", "m5_support_request"]),
        purposeTable("purpose_safety_flags").select("*").is("cleared_at", null),
      ]);
      if (pRes.error) {
        if (isMissingMigration(pRes.error)) return { rows: [], missingMigration: true };
        throw pRes.error;
      }
      for (const res of [gRes, bRes, aRes, fRes]) {
        if (res.error && !isMissingMigration(res.error)) throw res.error;
      }

      const profiles = (pRes.data ?? []) as unknown as PurposeProfileRow[];
      const goals = (gRes.data ?? []) as unknown as PurposeGoalRow[];
      const beliefs = (bRes.data ?? []) as unknown as PurposeBeliefsRow[];
      const answers = (aRes.data ?? []) as unknown as PurposeAnswerRow[];
      const flags = (fRes.data ?? []) as unknown as PurposeSafetyFlagRow[];

      const profileByUser = new Map(profiles.map((p) => [p.user_id, p]));

      // Level-6 core-value categories come only through the masked RPC —
      // one small call per submitted profile, in parallel.
      const submitted = profiles.filter((p) => p.workshop_completed);
      const whysByProfile = new Map<string, PurposeWhyLeadershipRow[]>();
      await Promise.all(
        submitted.map(async (p) => {
          const { data, error } = await purposeRpc("get_purpose_whys_for_leadership", {
            _purpose_profile_id: p.id,
          });
          if (!error && Array.isArray(data)) {
            whysByProfile.set(p.id, data as unknown as PurposeWhyLeadershipRow[]);
          }
        }),
      );

      const rows: LeadershipListRow[] = reps.map((rep) => {
        const profile = profileByUser.get(rep.userId) ?? null;
        const pid = profile?.id;
        const goalMap: Record<string, PurposeGoalRow> = {};
        for (const g of goals) if (g.purpose_profile_id === pid) goalMap[g.goal_type] = g;
        const b = beliefs.find((x) => x.purpose_profile_id === pid) ?? null;
        const lifeAreasRow = answers.find(
          (a) => a.purpose_profile_id === pid && a.question_key === "m3_life_areas",
        );
        const supportRow = answers.find(
          (a) => a.purpose_profile_id === pid && a.question_key === "m5_support_request",
        );
        const supportJson = (supportRow?.answer_value_json ?? null) as {
          selections?: string[];
        } | null;
        const level6 = pid ? whysByProfile.get(pid)?.find((w) => w.level_number === 6) : undefined;
        return {
          rep,
          profile,
          goals: goalMap,
          beliefs: b,
          lifeAreas: Array.isArray(lifeAreasRow?.answer_value_json)
            ? (lifeAreasRow!.answer_value_json as string[])
            : [],
          supportRequest: Array.isArray(supportJson?.selections) ? supportJson!.selections : [],
          coreValues: level6?.answer_categories_json ?? [],
          openSafetyFlag: flags.some((f) => f.purpose_profile_id === pid),
        };
      });

      return { rows, missingMigration: false };
    },
  });
}

// ---------------------------------------------------------------------------
// Individual rep detail
// ---------------------------------------------------------------------------

export const purposeLeadershipDetailKey = (userId: string) =>
  ["purpose_leadership", "detail", userId] as const;

export type LeadershipDetail = {
  profile: PurposeProfileRow | null;
  displayName: string;
  goals: Record<string, PurposeGoalRow>;
  beliefs: PurposeBeliefsRow | null;
  whys: PurposeWhyLeadershipRow[];
  ifThen: PurposeIfThenRow | null;
  answers: Record<string, PurposeAnswerRow>;
  reflections: PurposeReflectionRow[];
  notes: PurposeLeadershipNoteRow[];
  safetyFlags: PurposeSafetyFlagRow[];
};

export function usePurposeLeadershipDetail(userId: string | undefined) {
  return useQuery({
    enabled: !!userId,
    queryKey: purposeLeadershipDetailKey(userId ?? ""),
    staleTime: 15_000,
    retry: false,
    queryFn: async (): Promise<LeadershipDetail> => {
      const [profileRes, nameRes] = await Promise.all([
        purposeTable("purpose_profiles").select("*").eq("user_id", userId!).maybeSingle(),
        supabase.from("profiles").select("display_name").eq("id", userId!).maybeSingle(),
      ]);
      if (profileRes.error) throw profileRes.error;
      const profile = (profileRes.data ?? null) as unknown as PurposeProfileRow | null;
      const displayName = nameRes.data?.display_name ?? "Unknown";
      if (!profile) {
        return {
          profile: null,
          displayName,
          goals: {},
          beliefs: null,
          whys: [],
          ifThen: null,
          answers: {},
          reflections: [],
          notes: [],
          safetyFlags: [],
        };
      }
      const pid = profile.id;
      const [gRes, bRes, whysRes, itRes, aRes, rRes, nRes, fRes] = await Promise.all([
        purposeTable("purpose_goals").select("*").eq("purpose_profile_id", pid),
        purposeTable("purpose_beliefs").select("*").eq("purpose_profile_id", pid).maybeSingle(),
        purposeRpc("get_purpose_whys_for_leadership", { _purpose_profile_id: pid }),
        purposeTable("purpose_if_then_plans").select("*").eq("purpose_profile_id", pid).maybeSingle(),
        purposeTable("purpose_answers").select("*").eq("purpose_profile_id", pid).eq("is_current", true),
        purposeTable("purpose_reflections")
          .select("*")
          .eq("purpose_profile_id", pid)
          .order("created_at", { ascending: false })
          .limit(20),
        purposeTable("purpose_leadership_notes")
          .select("*")
          .eq("purpose_profile_id", pid)
          .order("created_at", { ascending: false }),
        purposeTable("purpose_safety_flags").select("*").eq("purpose_profile_id", pid),
      ]);
      for (const res of [gRes, itRes, aRes, rRes, nRes, fRes]) {
        if (res.error) throw res.error;
      }
      const goalMap: Record<string, PurposeGoalRow> = {};
      for (const g of (gRes.data ?? []) as unknown as PurposeGoalRow[]) goalMap[g.goal_type] = g;
      const answerMap: Record<string, PurposeAnswerRow> = {};
      for (const a of (aRes.data ?? []) as unknown as PurposeAnswerRow[])
        answerMap[a.question_key] = a;
      return {
        profile,
        displayName,
        goals: goalMap,
        beliefs: (bRes.data ?? null) as unknown as PurposeBeliefsRow | null,
        whys: Array.isArray(whysRes.data)
          ? (whysRes.data as unknown as PurposeWhyLeadershipRow[])
          : [],
        ifThen: (itRes.data ?? null) as unknown as PurposeIfThenRow | null,
        answers: answerMap,
        reflections: (rRes.data ?? []) as unknown as PurposeReflectionRow[],
        notes: (nRes.data ?? []) as unknown as PurposeLeadershipNoteRow[],
        safetyFlags: (fRes.data ?? []) as unknown as PurposeSafetyFlagRow[],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Leadership actions
// ---------------------------------------------------------------------------

export function useSaveLeadershipNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      purpose_profile_id: string;
      author_user_id: string;
      note_text: string;
      note_type: PurposeLeadershipNoteRow["note_type"];
      visible_to_rep: boolean;
    }) => {
      const { error } = await purposeTable("purpose_leadership_notes").insert(input);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purpose_leadership"] }),
  });
}

export function useUpdateLeadershipFields() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      purpose_profile_id: string;
      leadership_status?: LeadershipStatus | null;
      leadership_follow_up_date?: string | null;
      leadership_next_action?: string | null;
    }) => {
      const { purpose_profile_id, ...fields } = input;
      const { error } = await purposeTable("purpose_profiles")
        .update({ ...fields, last_reviewed_at: new Date().toISOString() })
        .eq("id", purpose_profile_id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purpose_leadership"] }),
  });
}

export function useResolveSafetyFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; action: "acknowledge" | "clear"; byUserId: string }) => {
      const patch =
        input.action === "acknowledge"
          ? { acknowledged_at: new Date().toISOString(), acknowledged_by: input.byUserId }
          : { cleared_at: new Date().toISOString(), cleared_by: input.byUserId };
      const { error } = await purposeTable("purpose_safety_flags").update(patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purpose_leadership"] }),
  });
}
