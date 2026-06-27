import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

export type AppRole = "owner" | "captain" | "canvasser";

export interface AuthState {
  loading: boolean;
  user: User | null;
  role: AppRole | null;
  teamId: string | null;
  displayName: string | null;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true, user: null, role: null, teamId: null, displayName: null,
  });

  useEffect(() => {
    let active = true;

    async function hydrate(user: User | null) {
      if (!user) {
        if (active) setState({ loading: false, user: null, role: null, teamId: null, displayName: null });
        return;
      }
      const [{ data: roles }, { data: profile }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", user.id),
        supabase.from("profiles").select("team_id, display_name").eq("id", user.id).maybeSingle(),
      ]);
      // priority owner > captain > canvasser
      const r = roles?.map((x) => x.role as AppRole) ?? [];
      const role: AppRole | null =
        r.includes("owner") ? "owner" : r.includes("captain") ? "captain" : r.includes("canvasser") ? "canvasser" : null;
      if (active) {
        setState({
          loading: false,
          user,
          role,
          teamId: profile?.team_id ?? null,
          displayName: profile?.display_name ?? user.email ?? null,
        });
      }
    }

    supabase.auth.getUser().then(({ data }) => hydrate(data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      hydrate(session?.user ?? null);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  return state;
}
