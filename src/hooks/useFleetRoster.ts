import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** One profile row as the board consumes it (dispatch membership). */
export type RosterProfile = {
  id: string;
  display_name: string | null;
  office_location: string | null;
  team_id: string | null;
  team_office: string | null;
  is_active: boolean | null;
  is_placeholder: boolean | null;
  suspension_tracked: boolean;
  created_at: string;
};

export type Van = {
  id: string;
  name: string;
  color: string | null;
  office_location: string | null;
};

/** The fleet-wide roster: profiles + role map, one fetch. Shares the
 *  ["fleet_dispatch","roster"] key with the dispatch board so the board,
 *  Manage Fleet, and the Move Players sheet can never disagree after a
 *  mutation — React Query dedupes on the key, so wherever this renders
 *  under the board it reads the already-warm cache. */
export function useDispatchRoster(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fleet_dispatch", "roster"],
    enabled: opts?.enabled ?? true,
    queryFn: async () => {
      const [profsR, rolesR] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id, display_name, office_location, team_id, is_active, is_placeholder, suspension_tracked, created_at, teams:team_id(office_location)",
          )
          .order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (profsR.error) throw profsR.error;
      if (rolesR.error) throw rolesR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      const profiles: RosterProfile[] = (
        (profsR.data ?? []) as Array<{
          id: string;
          display_name: string | null;
          office_location: string | null;
          team_id: string | null;
          is_active: boolean | null;
          is_placeholder: boolean | null;
          suspension_tracked: boolean;
          created_at: string;
          teams: { office_location: string | null } | null;
        }>
      ).map((p) => ({
        id: p.id,
        display_name: p.display_name,
        office_location: p.office_location,
        team_id: p.team_id,
        is_active: p.is_active,
        is_placeholder: p.is_placeholder,
        suspension_tracked: p.suspension_tracked,
        created_at: p.created_at,
        team_office: p.teams?.office_location ?? null,
      }));
      return { profiles, rolesByUser };
    },
  });
}

/** All vans, name-ordered — same ["fleet_dispatch","vans"] key as the board. */
export function useDispatchVans(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fleet_dispatch", "vans"],
    enabled: opts?.enabled ?? true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, name, color, office_location")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Van[];
    },
  });
}
