import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO, laMidnightUtcISO } from "@/lib/dates";

export type TodayLeads = {
  total: number;
  byTeam: Record<string, number>;
  byOffice: Record<string, number>;
};

// "Today" starts at midnight America/Los_Angeles, not viewer-local midnight.
function startOfTodayISO() {
  return laMidnightUtcISO(laTodayISO());
}

/**
 * Live aggregate of `lead_events` for today, grouped by team and office.
 * Subscribes to realtime INSERT/UPDATE/DELETE on lead_events and invalidates.
 */
export function useTodayLeads(): {
  data: TodayLeads;
  isLoading: boolean;
} {
  const qc = useQueryClient();

  const teamsQuery = useQuery({
    queryKey: ["teams", "with-office"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, office_id");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });

  const eventsQuery = useQuery({
    queryKey: ["lead_events", "today"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lead_events")
        .select("team_id, count")
        .gte("occurred_at", startOfTodayISO());
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5_000,
  });

  useEffect(() => {
    const channel = supabase
      .channel("lead_events-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lead_events" },
        () => {
          qc.invalidateQueries({ queryKey: ["lead_events", "today"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  const data = useMemo<TodayLeads>(() => {
    const teamToOffice = new Map<string, string | null>();
    for (const t of teamsQuery.data ?? []) {
      teamToOffice.set(t.id, t.office_id ?? null);
    }
    const byTeam: Record<string, number> = {};
    const byOffice: Record<string, number> = {};
    let total = 0;
    for (const row of eventsQuery.data ?? []) {
      const c = row.count ?? 0;
      total += c;
      byTeam[row.team_id] = (byTeam[row.team_id] ?? 0) + c;
      const officeId = teamToOffice.get(row.team_id) ?? null;
      if (officeId) byOffice[officeId] = (byOffice[officeId] ?? 0) + c;
    }
    return { total, byTeam, byOffice };
  }, [teamsQuery.data, eventsQuery.data]);

  return {
    data,
    isLoading: teamsQuery.isLoading || eventsQuery.isLoading,
  };
}
